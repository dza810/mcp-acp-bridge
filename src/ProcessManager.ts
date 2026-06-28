import { spawn, ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";

export interface ProcessManagerOptions {
  geminiPath?: string;
  /** Override the default ["--acp"] args (useful for testing). */
  args?: string[];
  maxRestarts?: number;
  restartDelayMs?: number;
}

export class ProcessManager extends EventEmitter {
  private proc: ChildProcess | null = null;
  private restartCount = 0;
  private stopping = false;

  private readonly geminiPath: string;
  private readonly spawnArgs: string[];
  private readonly maxRestarts: number;
  private readonly restartDelayMs: number;

  constructor(options: ProcessManagerOptions = {}) {
    super();
    this.geminiPath = options.geminiPath ?? "gemini";
    this.spawnArgs = options.args ?? ["--acp"];
    this.maxRestarts = options.maxRestarts ?? 5;
    this.restartDelayMs = options.restartDelayMs ?? 1000;
  }

  start(): void {
    this.stopping = false;
    this.restartCount = 0;
    this.#spawn();
  }

  #spawn(): void {
    const proc = spawn(this.geminiPath, this.spawnArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc = proc;

    const rl = createInterface({ input: proc.stdout! });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const msg = JSON.parse(trimmed);
        this.emit("message", msg);
      } catch {
        // non-JSON output from gemini-cli (startup banners etc.) — ignore
      }
    });

    proc.stderr!.on("data", (chunk: Buffer) => {
      this.emit("stderr", chunk.toString());
    });

    proc.on("exit", (code, signal) => {
      this.proc = null;
      this.emit("exit", { code, signal });

      if (!this.stopping && this.restartCount < this.maxRestarts) {
        this.restartCount++;
        const delay = this.restartDelayMs * 2 ** (this.restartCount - 1);
        this.emit("restarting", { attempt: this.restartCount, delayMs: delay });
        setTimeout(() => this.#spawn(), delay);
      } else if (!this.stopping) {
        this.emit("error", new Error(`gemini --acp exited and exceeded max restarts (${this.maxRestarts})`));
      }
    });

    proc.on("error", (err) => {
      this.emit("error", err);
    });
  }

  write(data: string): void {
    if (!this.proc?.stdin) throw new Error("gemini process not running");
    this.proc.stdin.write(data);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (!this.proc) return;

    return new Promise((resolve) => {
      const proc = this.proc!;
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
      }, 3000);

      proc.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });

      proc.kill("SIGTERM");
    });
  }

  get running(): boolean {
    return this.proc !== null;
  }
}
