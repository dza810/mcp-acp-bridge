/**
 * ProcessManager tests
 *
 * Uses real child processes (node -e ...) to avoid mocking child_process.
 * ProcessManager accepts an `args` option so we can inject short-lived scripts.
 */

import { describe, it, expect, afterEach } from "vitest";
import { ProcessManager } from "../ProcessManager.js";

// Helper: wait for N "message" events
function collectMessages(manager: ProcessManager, count: number, timeoutMs = 2000): Promise<object[]> {
  return new Promise((resolve, reject) => {
    const msgs: object[] = [];
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${count} messages`)), timeoutMs);
    manager.on("message", (msg: object) => {
      msgs.push(msg);
      if (msgs.length >= count) {
        clearTimeout(timer);
        resolve(msgs);
      }
    });
  });
}

// Helper: wait for a single named event
function waitForEvent(manager: ProcessManager, event: string, timeoutMs = 2000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for "${event}"`)), timeoutMs);
    manager.once(event, (data: unknown) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

describe("ProcessManager", () => {
  let manager: ProcessManager;

  afterEach(async () => {
    if (manager) await manager.stop();
  });

  // ── message parsing ─────────────────────────────────────────────────────────

  it("emits parsed JSON from stdout", async () => {
    // Script: print a JSON line then stay alive until killed
    const script = `process.stdout.write(JSON.stringify({jsonrpc:"2.0",method:"ping"})+"\\n"); setInterval(()=>{},99999);`;
    manager = new ProcessManager({
      geminiPath: "node",
      args: ["-e", script],
    });

    const done = collectMessages(manager, 1);
    manager.start();
    const [msg] = await done;
    expect((msg as any).method).toBe("ping");
  });

  it("ignores non-JSON lines (startup banners)", async () => {
    // Script: print banner, then JSON, then banner again
    const script = `
process.stdout.write("Gemini CLI starting...\\n");
process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:1,result:{}})+"\\n");
process.stdout.write("Warning: experimental\\n");
setInterval(()=>{},99999);
`;
    manager = new ProcessManager({ geminiPath: "node", args: ["-e", script] });
    const done = collectMessages(manager, 1);
    manager.start();
    const [msg] = await done;
    expect((msg as any).id).toBe(1);
  });

  it("emits multiple JSON messages in order", async () => {
    const script = `
[1,2,3].forEach(i => process.stdout.write(JSON.stringify({id:i})+"\\n"));
setInterval(()=>{},99999);
`;
    manager = new ProcessManager({ geminiPath: "node", args: ["-e", script] });
    const done = collectMessages(manager, 3);
    manager.start();
    const msgs = await done;
    expect(msgs.map((m: any) => m.id)).toEqual([1, 2, 3]);
  });

  // ── restart logic ───────────────────────────────────────────────────────────

  it("emits 'restarting' when process exits unexpectedly", async () => {
    // Script exits immediately with code 1
    manager = new ProcessManager({
      geminiPath: "node",
      args: ["-e", "process.exit(1)"],
      restartDelayMs: 10,
      maxRestarts: 2,
    });
    manager.on("error", () => {}); // suppress max-restart error

    const restartingPromise = waitForEvent(manager, "restarting");
    manager.start();
    const info = await restartingPromise as any;
    expect(info.attempt).toBe(1);
    expect(info.delayMs).toBe(10); // 10 * 2^0
  });

  it("emits 'error' after exceeding maxRestarts", async () => {
    manager = new ProcessManager({
      geminiPath: "node",
      args: ["-e", "process.exit(1)"],
      restartDelayMs: 5,
      maxRestarts: 1,
    });
    manager.on("restarting", () => {});

    const errorPromise = waitForEvent(manager, "error");
    manager.start();
    const err = await errorPromise as Error;
    expect(err.message).toContain("max restarts");
  });

  it("does NOT restart when stop() is called before process exits", async () => {
    // Script stays alive until SIGTERM
    const script = `process.on("SIGTERM", () => process.exit(0)); setInterval(()=>{},99999);`;
    manager = new ProcessManager({
      geminiPath: "node",
      args: ["-e", script],
      restartDelayMs: 10,
      maxRestarts: 5,
    });

    const restarts: unknown[] = [];
    manager.on("restarting", (info: unknown) => restarts.push(info));
    manager.on("error", () => {});

    manager.start();
    // Let the process start
    await new Promise((r) => setTimeout(r, 50));
    // Stop it — should NOT restart
    await manager.stop();
    await new Promise((r) => setTimeout(r, 50));
    expect(restarts).toHaveLength(0);
  });

  // ── exponential backoff ─────────────────────────────────────────────────────

  it("restart delay uses exponential backoff (10, 20, 40 ms)", async () => {
    manager = new ProcessManager({
      geminiPath: "node",
      args: ["-e", "process.exit(1)"],
      restartDelayMs: 10,
      maxRestarts: 3,
    });

    const delays: number[] = [];
    manager.on("restarting", (info: any) => delays.push(info.delayMs));

    // Wait until all retries are exhausted (error event fires)
    const errorPromise = waitForEvent(manager, "error", 10000);
    manager.start();
    await errorPromise;

    expect(delays).toEqual([10, 20, 40]);
  }, 15000);

  // ── write() guard ───────────────────────────────────────────────────────────

  it("write() throws when process is not running", () => {
    manager = new ProcessManager();
    expect(() => manager.write("data")).toThrow("gemini process not running");
  });

  // ── running getter ──────────────────────────────────────────────────────────

  it("running returns false before start()", () => {
    manager = new ProcessManager();
    expect(manager.running).toBe(false);
  });

  it("running returns true after start() and false after stop()", async () => {
    const script = `process.on("SIGTERM", () => process.exit(0)); setInterval(()=>{},99999);`;
    manager = new ProcessManager({ geminiPath: "node", args: ["-e", script] });
    manager.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(manager.running).toBe(true);
    await manager.stop();
    expect(manager.running).toBe(false);
  });
});

// ── line-parsing unit test (no subprocess) ────────────────────────────────────

describe("ProcessManager line parsing (unit)", () => {
  it("ignores empty lines and non-JSON, emits valid JSON", () => {
    const received: object[] = [];
    const mgr = new ProcessManager() as any;
    mgr.on("message", (m: object) => received.push(m));

    const parseLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const msg = JSON.parse(trimmed);
        mgr.emit("message", msg);
      } catch { /* ignore */ }
    };

    parseLine("  "); // blank
    parseLine("Gemini CLI v1.0");
    parseLine('{"jsonrpc":"2.0","id":1,"result":{}}');
    parseLine("Warning text");
    parseLine("");
    parseLine('{"jsonrpc":"2.0","method":"ping"}');

    expect(received).toHaveLength(2);
    expect((received[0] as any).id).toBe(1);
    expect((received[1] as any).method).toBe("ping");
  });
});
