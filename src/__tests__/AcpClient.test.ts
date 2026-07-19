import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { AcpClient } from "../acp/AcpClient.js";
import { GeminiProvider } from "../providers/GeminiProvider.js";
import type { ProcessManager } from "../ProcessManager.js";

class FakeProcessManager extends EventEmitter {
  written: string[] = [];

  write(data: string): void {
    this.written.push(data);
  }

  injectMessage(msg: object): void {
    this.emit("message", msg);
  }

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
  const client = new AcpClient(fake as unknown as ProcessManager, new GeminiProvider());
  return { client, fake };
}

function autoRespond(fake: FakeProcessManager, result: object): void {
  const originalWrite = fake.write.bind(fake);
  fake.write = (data: string) => {
    originalWrite(data);
    const req = JSON.parse(data.trim());
    if ("id" in req && "method" in req) {
      fake.write = originalWrite;
      setImmediate(() =>
        fake.injectMessage({ jsonrpc: "2.0", id: req.id, result }),
      );
    }
  };
}

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
    fake.injectMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s1", type: "text", text: "hello" },
    });
  });

  it("routes incoming request (id + method) to incoming handler (fs/read_text_file)", async () => {
    const { client, fake } = makeClient();
    fake.injectMessage({
      jsonrpc: "2.0",
      id: 99,
      method: "fs/read_text_file",
      params: { path: import.meta.filename },
    });

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

describe("AcpClient#prompt buffering", () => {
  function setupPromptSession(fake: FakeProcessManager, acpSessionId: string) {
    const orig = fake.write.bind(fake);
    fake.write = (data: string) => {
      orig(data);
      const req = JSON.parse(data.trim());
      if (req.method === "session/prompt") {
        fake.write = orig;
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
    const { client, fake } = makeClient();
    const orig = fake.write.bind(fake);
    fake.write = (data: string) => {
      orig(data);
      const req = JSON.parse(data.trim());
      if (req.method === "session/prompt") {
        fake.write = orig;
        setImmediate(() => {
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

describe("AcpClient fs callbacks", () => {
  it("fs/write_text_file writes a file then fs/read_text_file reads it back", async () => {
    const { client, fake } = makeClient();
    const tmpPath = `/tmp/acp-test-${Date.now()}.txt`;

    fake.injectMessage({ jsonrpc: "2.0", id: 1, method: "fs/write_text_file", params: { path: tmpPath, content: "hello test" } });
    await new Promise((r) => setTimeout(r, 100));

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

    const p1 = client.listSessions();
    const p2 = client.listSessions();
    const p3 = client.listSessions();

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

describe("AcpClient sessionLoad error handling", () => {
  it("rejects with ACP error when session does not exist on disk", async () => {
    const { client, fake } = makeClient();
    const orig = fake.write.bind(fake);
    fake.write = (data: string) => {
      orig(data);
      const req = JSON.parse(data.trim());
      if (req.method === "session/load") {
        fake.write = orig;
        setImmediate(() =>
          fake.injectMessage({
            jsonrpc: "2.0",
            id: req.id,
            error: { code: -32602, message: "Session not found" },
          }),
        );
      }
    };

    await expect(client.loadSession("nonexistent-uuid")).rejects.toThrow("Session not found");
  });

  it("does NOT enter replay mode when sessionLoad fails", async () => {
    const { client, fake } = makeClient();
    const orig = fake.write.bind(fake);
    fake.write = (data: string) => {
      orig(data);
      const req = JSON.parse(data.trim());
      if (req.method === "session/load") {
        fake.write = orig;
        setImmediate(() =>
          fake.injectMessage({
            jsonrpc: "2.0",
            id: req.id,
            error: { code: -32602, message: "Session not found" },
          }),
        );
      }
    };

    await client.loadSession("nonexistent-uuid").catch(() => {});

    const orig2 = fake.write.bind(fake);
    fake.write = (data: string) => {
      orig2(data);
      const req = JSON.parse(data.trim());
      if (req.method === "session/prompt") {
        fake.write = orig2;
        setImmediate(() => {
          fake.injectMessage(makeTextUpdate("s-clean", "response"));
          fake.injectMessage(makeTurnComplete("s-clean"));
          fake.injectMessage({ jsonrpc: "2.0", id: req.id, result: {} });
        });
      }
    };
    const result = await client.prompt("s-clean", "hello");
    expect(result).toBe("response");
  });
});

describe("AcpClient sessionLoad replay skip", () => {
  function setupLoad(
    fake: FakeProcessManager,
    sessionId: string,
    newPromptText: string,
    oldAgentChunks: string[],
    newAgentChunks: string[],
  ) {
    const orig = fake.write.bind(fake);
    fake.write = (data: string) => {
      orig(data);
      const req = JSON.parse(data.trim());

      if (req.method === "session/load") {
        fake.write = orig;
        setImmediate(() => {
          fake.injectMessage({ jsonrpc: "2.0", id: req.id, result: { modes: {}, models: {} } });
          const orig2 = fake.write.bind(fake);
          fake.write = (data2: string) => {
            orig2(data2);
            const req2 = JSON.parse(data2.trim());
            if (req2.method === "session/prompt") {
              fake.write = orig2;
              setImmediate(() => {
                fake.injectMessage({
                  jsonrpc: "2.0", method: "session/update",
                  params: { sessionId, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "old user message" } } },
                });
                for (const text of oldAgentChunks) {
                  fake.injectMessage({
                    jsonrpc: "2.0", method: "session/update",
                    params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
                  });
                }
                fake.injectMessage({
                  jsonrpc: "2.0", method: "session/update",
                  params: { sessionId, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: newPromptText } } },
                });
                for (const text of newAgentChunks) {
                  fake.injectMessage(makeTextUpdate(sessionId, text));
                }
                fake.injectMessage(makeTurnComplete(sessionId));
                fake.injectMessage({ jsonrpc: "2.0", id: req2.id, result: {} });
              });
            }
          };
        });
      }
    };
  }

  it("discards old agent chunks and returns only new response", async () => {
    const { client, fake } = makeClient();
    setupLoad(fake, "s-load", "new question", ["old answer 1", " old answer 2"], ["fresh"]);

    await client.loadSession("s-load");
    const result = await client.prompt("s-load", "new question");

    expect(result).toBe("fresh");
    expect(result).not.toContain("old");
  });

  it("works with multi-chunk user_message boundary (split across notifications)", async () => {
    const { client, fake } = makeClient();
    const orig = fake.write.bind(fake);
    fake.write = (data: string) => {
      orig(data);
      const req = JSON.parse(data.trim());
      if (req.method === "session/load") {
        setImmediate(() => {
          fake.injectMessage({ jsonrpc: "2.0", id: req.id, result: { modes: {}, models: {} } });
          fake.write = orig;
          const orig2 = fake.write.bind(fake);
          fake.write = (data2: string) => {
            orig2(data2);
            const req2 = JSON.parse(data2.trim());
            if (req2.method === "session/prompt") {
              fake.write = orig2;
              setImmediate(() => {
                fake.injectMessage(makeTextUpdate("s-split", "stale"));
                fake.injectMessage({
                  jsonrpc: "2.0", method: "session/update",
                  params: { sessionId: "s-split", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "split" } } },
                });
                fake.injectMessage({
                  jsonrpc: "2.0", method: "session/update",
                  params: { sessionId: "s-split", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: " prompt" } } },
                });
                fake.injectMessage(makeTextUpdate("s-split", "new answer"));
                fake.injectMessage(makeTurnComplete("s-split"));
                fake.injectMessage({ jsonrpc: "2.0", id: req2.id, result: {} });
              });
            }
          };
        });
      }
    };

    await client.loadSession("s-split");
    const result = await client.prompt("s-split", "split prompt");

    expect(result).toBe("new answer");
    expect(result).not.toContain("stale");
  });

  it("normal session (no load) captures all chunks without replay skip", async () => {
    const { client, fake } = makeClient();
    const orig = fake.write.bind(fake);
    fake.write = (data: string) => {
      orig(data);
      const req = JSON.parse(data.trim());
      if (req.method === "session/prompt") {
        fake.write = orig;
        setImmediate(() => {
          fake.injectMessage(makeTextUpdate("s-normal", "part1"));
          fake.injectMessage(makeTextUpdate("s-normal", " part2"));
          fake.injectMessage(makeTurnComplete("s-normal"));
          fake.injectMessage({ jsonrpc: "2.0", id: req.id, result: {} });
        });
      }
    };
    const result = await client.prompt("s-normal", "hi");
    expect(result).toBe("part1 part2");
  });

  it("second prompt after loaded session is no longer in replay mode", async () => {
    const { client, fake } = makeClient();
    setupLoad(fake, "s-second", "first question", ["old"], ["first answer"]);

    await client.loadSession("s-second");
    await client.prompt("s-second", "first question");

    const orig = fake.write.bind(fake);
    fake.write = (data: string) => {
      orig(data);
      const req = JSON.parse(data.trim());
      if (req.method === "session/prompt") {
        fake.write = orig;
        setImmediate(() => {
          fake.injectMessage(makeTextUpdate("s-second", "second answer"));
          fake.injectMessage(makeTurnComplete("s-second"));
          fake.injectMessage({ jsonrpc: "2.0", id: req.id, result: {} });
        });
      }
    };
    const result = await client.prompt("s-second", "follow-up");
    expect(result).toBe("second answer");
  });
});

describe("AcpClient process exit handling", () => {
  it("rejects all pending requests when process exits", async () => {
    const { client, fake } = makeClient();

    const pending1 = client.listSessions();
    const pending2 = client.listSessions();

    fake.emit("exit", { code: 1, signal: null });

    await expect(pending1).rejects.toThrow(/exited/);
    await expect(pending2).rejects.toThrow(/exited/);
  });

  it("prompt() rejects mid-flight when process exits", async () => {
    const { client, fake } = makeClient();

    const promptPromise = client.prompt("s1", "hello");

    fake.emit("exit", { code: null, signal: "SIGKILL" });

    await expect(promptPromise).rejects.toThrow(/exited/);
  });

  it("after process exit, a new request can still be sent (new process cycle)", async () => {
    const { client, fake } = makeClient();

    fake.emit("exit", { code: 0, signal: null });

    autoRespond(fake, { sessions: [{ sessionId: "new" }] });
    const result = await client.listSessions();
    expect(result.sessions[0].sessionId).toBe("new");
  });

  it("update buffer and turnResolvers are cleared on exit (no stale data in next prompt)", async () => {
    const { client, fake } = makeClient();

    const orig = fake.write.bind(fake);
    fake.write = (data: string) => {
      orig(data);
      const req = JSON.parse(data.trim());
      if (req.method === "session/prompt" && req.params?.sessionId === "s-stale") {
        fake.write = orig;
        setImmediate(() => {
          fake.injectMessage(makeTextUpdate("s-stale", "stale-chunk"));
          fake.emit("exit", { code: 1, signal: null });
        });
      }
    };

    const stalePromise = client.prompt("s-stale", "first").catch(() => {});
    await stalePromise;

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
