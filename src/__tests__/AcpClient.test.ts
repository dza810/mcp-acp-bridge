/**
 * AcpClient tests
 *
 * We avoid spawning real processes by injecting a FakeProcessManager —
 * an EventEmitter with a write() spy — instead of the real ProcessManager.
 *
 * Most bug-prone areas covered:
 *  1. #onMessage dispatch: response vs incoming-request vs notification
 *  2. session/update buffering and turn_complete / error resolution
 *  3. Concurrent sessions don't interfere with each other
 *  4. fs/read_text_file and fs/write_text_file callbacks
 *  5. session/request_permission auto-approve
 *  6. Pending request rejection on ACP error response
 *  7. Boundary: zero text updates before turn_complete
 *  8. Boundary: turn_complete arrives before session/prompt response
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { AcpClient } from "../acp/AcpClient.js";
import type { ProcessManager } from "../ProcessManager.js";

// ── helpers ──────────────────────────────────────────────────────────────────

class FakeProcessManager extends EventEmitter {
  written: string[] = [];

  write(data: string): void {
    this.written.push(data);
  }

  /** Push a raw JSON-RPC message as if it came from gemini stdout. */
  injectMessage(msg: object): void {
    this.emit("message", msg);
  }

  /** Parse all written lines and return them as objects. */
  get writtenMessages(): object[] {
    return this.written.map((line) => JSON.parse(line.trim()));
  }

  get lastWritten(): object {
    const msgs = this.writtenMessages;
    return msgs[msgs.length - 1];
  }
}

function makeClient(): { client: AcpClient; fake: FakeProcessManager } {
  const fake = new FakeProcessManager();
  const client = new AcpClient(fake as unknown as ProcessManager);
  return { client, fake };
}

/** Simulate the server responding to the next outgoing request with a result. */
function autoRespond(fake: FakeProcessManager, result: object): void {
  // Watch for the next write, extract the id, and inject a response.
  const originalWrite = fake.write.bind(fake);
  fake.write = (data: string) => {
    originalWrite(data);
    const req = JSON.parse(data.trim());
    if ("id" in req && "method" in req) {
      fake.write = originalWrite; // restore
      setImmediate(() =>
        fake.injectMessage({ jsonrpc: "2.0", id: req.id, result }),
      );
    }
  };
}

// ── session/update wire-format helpers ───────────────────────────────────────

function makeTextUpdate(sessionId: string, text: string) {
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    },
  };
}

function makeTurnComplete(sessionId: string) {
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update: { sessionUpdate: "turn_complete" } },
  };
}

function makeErrorUpdate(sessionId: string, error: string) {
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update: { sessionUpdate: "error", error } },
  };
}

// ── dispatch tests ────────────────────────────────────────────────────────────

describe("AcpClient#onMessage dispatch", () => {
  it("routes message with id+result to response handler (resolves pending)", async () => {
    const { client, fake } = makeClient();
    autoRespond(fake, { protocolVersion: 1, agentInfo: { name: "gemini", version: "1" }, agentCapabilities: {} });
    await expect(client.initialize()).resolves.toBeUndefined();
  });

  it("routes message with id+error to response handler (rejects pending)", async () => {
    const { client, fake } = makeClient();
    const orig = fake.write.bind(fake);
    fake.write = (data: string) => {
      orig(data);
      const req = JSON.parse(data.trim());
      if ("id" in req) {
        fake.write = orig;
        setImmediate(() =>
          fake.injectMessage({
            jsonrpc: "2.0",
            id: req.id,
            error: { code: -32000, message: "auth required" },
          }),
        );
      }
    };
    await expect(client.initialize()).rejects.toThrow("auth required");
  });

  it("routes notification (no id, has method) to notification handler", () => {
    const { client, fake } = makeClient();
    // No pending prompt — update should be silently buffered then dropped
    fake.injectMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s1", type: "text", text: "hello" },
    });
    // No throw, no error emitted
  });

  it("routes incoming request (id + method) to incoming handler (fs/read_text_file)", async () => {
    const { client, fake } = makeClient();

    // Inject an incoming fs/read request from the agent
    fake.injectMessage({
      jsonrpc: "2.0",
      id: 99,
      method: "fs/read_text_file",
      params: { path: import.meta.filename }, // read this test file itself
    });

    // fs.readFile is async — give it time to complete
    await new Promise((r) => setTimeout(r, 100));

    const response = fake.writtenMessages.find(
      (m: any) => m.id === 99 && "result" in m,
    ) as any;
    expect(response).toBeDefined();
    expect(typeof response.result.content).toBe("string");
    expect(response.result.content.length).toBeGreaterThan(0);
  });

  it("incoming request for unknown method responds with error", async () => {
    const { client, fake } = makeClient();
    fake.injectMessage({
      jsonrpc: "2.0",
      id: 77,
      method: "terminal/create",
      params: {},
    });

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const response = fake.writtenMessages.find(
      (m: any) => m.id === 77 && "error" in m,
    ) as any;
    expect(response).toBeDefined();
    expect(response.error.code).toBe(-32603);
  });
});

// ── session/update buffering ──────────────────────────────────────────────────

describe("AcpClient#prompt buffering", () => {
  function setupPromptSession(fake: FakeProcessManager, acpSessionId: string) {
    // Intercept writes: answer session/prompt with a result, then inject updates
    const orig = fake.write.bind(fake);
    fake.write = (data: string) => {
      orig(data);
      const req = JSON.parse(data.trim());
      if (req.method === "session/prompt") {
        fake.write = orig;
        // Inject updates then turn_complete, then the prompt response
        setImmediate(() => {
          fake.injectMessage(makeTextUpdate(acpSessionId, "Hello"));
          fake.injectMessage(makeTextUpdate(acpSessionId, ", world"));
          fake.injectMessage(makeTurnComplete(acpSessionId));
          fake.injectMessage({ jsonrpc: "2.0", id: req.id, result: {} });
        });
      }
    };
  }

  it("collects multiple text updates in order", async () => {
    const { client, fake } = makeClient();
    setupPromptSession(fake, "s1");
    const result = await client.prompt("s1", "hi");
    expect(result).toBe("Hello, world");
  });

  it("returns empty string when no text updates arrive before turn_complete", async () => {
    const { client, fake } = makeClient();
    const orig = fake.write.bind(fake);
    fake.write = (data: string) => {
      orig(data);
      const req = JSON.parse(data.trim());
      if (req.method === "session/prompt") {
        fake.write = orig;
        setImmediate(() => {
          fake.injectMessage(makeTurnComplete("s1"));
          fake.injectMessage({ jsonrpc: "2.0", id: req.id, result: {} });
        });
      }
    };
    const result = await client.prompt("s1", "hi");
    expect(result).toBe("");
  });

  it("appends error message when update type is error", async () => {
    const { client, fake } = makeClient();
    const orig = fake.write.bind(fake);
    fake.write = (data: string) => {
      orig(data);
      const req = JSON.parse(data.trim());
      if (req.method === "session/prompt") {
        fake.write = orig;
        setImmediate(() => {
          fake.injectMessage(makeTextUpdate("s2", "Partial"));
          fake.injectMessage(makeErrorUpdate("s2", "context limit"));
          fake.injectMessage({ jsonrpc: "2.0", id: req.id, result: {} });
        });
      }
    };
    const result = await client.prompt("s2", "hi");
    expect(result).toContain("Partial");
    expect(result).toContain("context limit");
  });

  it("turn_complete before session/prompt response still resolves correctly", async () => {
    // turn_complete arrives first, then the JSON-RPC response
    const { client, fake } = makeClient();
    const orig = fake.write.bind(fake);
    fake.write = (data: string) => {
      orig(data);
      const req = JSON.parse(data.trim());
      if (req.method === "session/prompt") {
        fake.write = orig;
        setImmediate(() => {
          // turn_complete BEFORE the response
          fake.injectMessage(makeTextUpdate("s3", "early"));
          fake.injectMessage(makeTurnComplete("s3"));
          fake.injectMessage({ jsonrpc: "2.0", id: req.id, result: {} });
        });
      }
    };
    const result = await client.prompt("s3", "hi");
    expect(result).toBe("early");
  });
});

// ── concurrent sessions ───────────────────────────────────────────────────────

describe("AcpClient concurrent sessions", () => {
  it("updates for different sessions do not interfere", async () => {
    const { client, fake } = makeClient();

    let reqIdA: number | string | undefined;
    let reqIdB: number | string | undefined;
    const orig = fake.write.bind(fake);

    fake.write = (data: string) => {
      orig(data);
      const req = JSON.parse(data.trim());
      if (req.method === "session/prompt") {
        if (req.params.sessionId === "sA") reqIdA = req.id;
        if (req.params.sessionId === "sB") reqIdB = req.id;

        if (reqIdA !== undefined && reqIdB !== undefined) {
          fake.write = orig;
          setImmediate(() => {
            // Interleave updates from both sessions
            fake.injectMessage(makeTextUpdate("sA", "A1"));
            fake.injectMessage(makeTextUpdate("sB", "B1"));
            fake.injectMessage(makeTextUpdate("sA", "A2"));
            fake.injectMessage(makeTextUpdate("sB", "B2"));
            fake.injectMessage(makeTurnComplete("sA"));
            fake.injectMessage(makeTurnComplete("sB"));
            fake.injectMessage({ jsonrpc: "2.0", id: reqIdA, result: {} });
            fake.injectMessage({ jsonrpc: "2.0", id: reqIdB, result: {} });
          });
        }
      }
    };

    const [resultA, resultB] = await Promise.all([
      client.prompt("sA", "hello A"),
      client.prompt("sB", "hello B"),
    ]);

    expect(resultA).toBe("A1A2");
    expect(resultB).toBe("B1B2");
  });
});

// ── fs/* callbacks ────────────────────────────────────────────────────────────

describe("AcpClient fs callbacks", () => {
  it("fs/write_text_file writes a file then fs/read_text_file reads it back", async () => {
    const { client, fake } = makeClient();
    const tmpPath = `/tmp/acp-test-${Date.now()}.txt`;

    // Write
    fake.injectMessage({ jsonrpc: "2.0", id: 1, method: "fs/write_text_file", params: { path: tmpPath, content: "hello test" } });
    await new Promise((r) => setTimeout(r, 100));

    // Read
    fake.injectMessage({ jsonrpc: "2.0", id: 2, method: "fs/read_text_file", params: { path: tmpPath } });
    await new Promise((r) => setTimeout(r, 100));

    const readResponse = fake.writtenMessages.find((m: any) => m.id === 2 && "result" in m) as any;
    expect(readResponse.result.content).toBe("hello test");
  });

  it("fs/read_text_file on missing file responds with error", async () => {
    const { client, fake } = makeClient();
    fake.injectMessage({ jsonrpc: "2.0", id: 3, method: "fs/read_text_file", params: { path: "/nonexistent/path/file.txt" } });
    await new Promise((r) => setTimeout(r, 100));

    const response = fake.writtenMessages.find((m: any) => m.id === 3) as any;
    expect(response.error).toBeDefined();
    expect(response.error.code).toBe(-32603);
  });
});

// ── session/request_permission ────────────────────────────────────────────────

describe("AcpClient session/request_permission", () => {
  it("always responds with allow_once", async () => {
    const { client, fake } = makeClient();
    fake.injectMessage({
      jsonrpc: "2.0",
      id: 10,
      method: "session/request_permission",
      params: {
        sessionId: "s1",
        requestId: "req-abc",
        toolCall: { name: "shell_exec", args: { cmd: "ls" } },
        options: [
          { kind: "allow_once" },
          { kind: "reject_once" },
        ],
      },
    });

    await new Promise((r) => setTimeout(r, 50));

    const response = fake.writtenMessages.find((m: any) => m.id === 10 && "result" in m) as any;
    expect(response.result.decision).toBe("allow_once");
    expect(response.result.requestId).toBe("req-abc");
  });
});

// ── pending request management ────────────────────────────────────────────────

describe("AcpClient pending request management", () => {
  it("multiple in-flight requests resolve independently", async () => {
    const { client, fake } = makeClient();
    const orig = fake.write.bind(fake);
    const capturedIds: (string | number)[] = [];

    fake.write = (data: string) => {
      orig(data);
      const req = JSON.parse(data.trim());
      if ("id" in req) capturedIds.push(req.id);
    };

    // Fire 3 requests without responding yet
    const p1 = client.sessionList();
    const p2 = client.sessionList();
    const p3 = client.sessionList();

    // Now respond in reverse order
    const [id1, id2, id3] = capturedIds;
    fake.injectMessage({ jsonrpc: "2.0", id: id3, result: { sessions: [{ sessionId: "c" }] } });
    fake.injectMessage({ jsonrpc: "2.0", id: id1, result: { sessions: [{ sessionId: "a" }] } });
    fake.injectMessage({ jsonrpc: "2.0", id: id2, result: { sessions: [{ sessionId: "b" }] } });

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1.sessions[0].sessionId).toBe("a");
    expect(r2.sessions[0].sessionId).toBe("b");
    expect(r3.sessions[0].sessionId).toBe("c");
  });
});

// ── process exit / drain ──────────────────────────────────────────────────────

describe("AcpClient process exit handling", () => {
  it("rejects all pending requests when process exits", async () => {
    const { client, fake } = makeClient();

    // Start a request without responding
    const pending1 = client.sessionList();
    const pending2 = client.sessionList();

    // Simulate process exit
    fake.emit("exit", { code: 1, signal: null });

    await expect(pending1).rejects.toThrow(/exited/);
    await expect(pending2).rejects.toThrow(/exited/);
  });

  it("prompt() rejects mid-flight when process exits", async () => {
    const { client, fake } = makeClient();

    // Start a prompt that will never get a response
    const promptPromise = client.prompt("s1", "hello");

    // Simulate process exit before any response
    fake.emit("exit", { code: null, signal: "SIGKILL" });

    await expect(promptPromise).rejects.toThrow(/exited/);
  });

  it("after process exit, a new request can still be sent (new process cycle)", async () => {
    const { client, fake } = makeClient();

    // Trigger exit to drain pending
    fake.emit("exit", { code: 0, signal: null });

    // New request sent to (simulated) new process — should still work
    autoRespond(fake, { sessions: [{ sessionId: "new" }] });
    const result = await client.sessionList();
    expect(result.sessions[0].sessionId).toBe("new");
  });

  it("update buffer and turnResolvers are cleared on exit (no stale data in next prompt)", async () => {
    const { client, fake } = makeClient();

    // Start a prompt that injects one text chunk before the exit fires
    const orig = fake.write.bind(fake);
    fake.write = (data: string) => {
      orig(data);
      const req = JSON.parse(data.trim());
      if (req.method === "session/prompt" && req.params?.sessionId === "s-stale") {
        fake.write = orig;
        setImmediate(() => {
          fake.injectMessage(makeTextUpdate("s-stale", "stale-chunk"));
          // NO turn_complete — process dies here
          fake.emit("exit", { code: 1, signal: null });
        });
      }
    };

    const stalePromise = client.prompt("s-stale", "first").catch(() => {});
    await stalePromise;

    // Now send a second prompt to a different session — must NOT contain stale chunk
    const orig2 = fake.write.bind(fake);
    fake.write = (data: string) => {
      orig2(data);
      const req = JSON.parse(data.trim());
      if (req.method === "session/prompt") {
        fake.write = orig2;
        setImmediate(() => {
          fake.injectMessage(makeTextUpdate("s-fresh", "clean"));
          fake.injectMessage(makeTurnComplete("s-fresh"));
          fake.injectMessage({ jsonrpc: "2.0", id: req.id, result: {} });
        });
      }
    };
    const result = await client.prompt("s-fresh", "second");
    expect(result).toBe("clean");
  });
});
