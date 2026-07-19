import { EventEmitter } from "node:events";
import { ProcessManager } from "../ProcessManager.js";
import type { AcpProvider, SessionContext } from "../providers/types.js";
import type {
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  InitializeResult,
  AgentCapabilities,
  SessionUpdateParams,
  SessionListResult,
} from "./types.js";

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

export class AcpClient extends EventEmitter {
  private readonly manager: ProcessManager;
  private readonly provider: AcpProvider;
  private nextId = 1;
  private pending = new Map<string | number, PendingRequest>();
  private agentCapabilities: AgentCapabilities = {};

  private updateBuffers = new Map<string, string[]>();
  private turnResolvers = new Map<string, () => void>();
  private replayingSessions = new Set<string>();
  private replayUserAccum = new Map<string, string>();
  private replayExpected = new Map<string, string>();

  constructor(manager: ProcessManager, provider: AcpProvider) {
    super();
    this.manager = manager;
    this.provider = provider;
    this.manager.on("message", (msg: JsonRpcMessage) => this.#onMessage(msg));
    this.manager.on("stderr", (text: string) => {
      process.stderr.write(`[${provider.name}] ${text}`);
    });
    this.manager.on("exit", ({ code, signal }: { code: number | null; signal: string | null }) => {
      this.#drainPending(
        new Error(`${provider.name} process exited (code=${code}, signal=${signal})`),
      );
    });
  }

  #drainPending(err: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(err);
    }
    this.pending.clear();
    this.turnResolvers.clear();
    this.updateBuffers.clear();
    this.replayingSessions.clear();
    this.replayUserAccum.clear();
    this.replayExpected.clear();
  }

  async initialize(): Promise<void> {
    const params = this.provider.initializeParams();
    const result = (await this.#request(
      this.provider.methodName("initialize"),
      params,
    )) as InitializeResult;
    this.agentCapabilities = result.agentCapabilities ?? {};

    if (result.authMethods && result.authMethods.length > 0) {
      const request = (method: string, p: unknown) => this.#request(method, p);
      await this.provider.authenticate?.(request);
    }
  }

  async newSession(cwd = process.cwd()): Promise<string> {
    const result = (await this.#request(
      this.provider.methodName("new"),
      { cwd, mcpServers: [] },
    )) as { sessionId: string };
    return result.sessionId;
  }

  async loadSession(sessionId: string, cwd = process.cwd()): Promise<void> {
    await this.#request(
      this.provider.methodName("load"),
      { sessionId, cwd, mcpServers: [] },
    );
    this.replayingSessions.add(sessionId);
    this.replayUserAccum.set(sessionId, "");
  }

  async resumeSession(sessionId: string): Promise<void> {
    await this.#request(
      this.provider.methodName("resume"),
      { sessionId },
    );
  }

  async listSessions(): Promise<SessionListResult> {
    const result = (await this.#request(
      this.provider.methodName("list"),
      {},
    )) as any;
    return { sessions: result.sessions ?? [] };
  }

  async prompt(sessionId: string, message: string): Promise<string> {
    this.updateBuffers.set(sessionId, []);

    if (this.replayingSessions.has(sessionId)) {
      this.replayExpected.set(sessionId, message);
      this.replayUserAccum.set(sessionId, "");
    }

    const turnDone = new Promise<void>((resolve) => {
      this.turnResolvers.set(sessionId, resolve);
    });

    const params = {
      sessionId,
      prompt: this.provider.formatPrompt(message),
    };

    await Promise.race([
      this.#request(this.provider.methodName("prompt"), params),
      turnDone,
    ]);

    this.turnResolvers.delete(sessionId);
    this.replayingSessions.delete(sessionId);
    this.replayUserAccum.delete(sessionId);
    this.replayExpected.delete(sessionId);

    const chunks = this.updateBuffers.get(sessionId) ?? [];
    this.updateBuffers.delete(sessionId);
    return chunks.join("");
  }

  #onMessage(msg: JsonRpcMessage): void {
    const hasId = "id" in msg;
    const hasMethod = "method" in msg;
    const hasResult = "result" in msg;
    const hasError = "error" in msg;

    if (hasId && (hasResult || hasError)) {
      this.#handleResponse(msg as JsonRpcResponse);
    } else if (hasId && hasMethod) {
      void this.#handleIncomingRequest(msg as JsonRpcRequest);
    } else {
      this.#handleNotification(msg as JsonRpcNotification);
    }
  }

  #handleResponse(msg: JsonRpcResponse): void {
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (msg.error) {
      pending.reject(new Error(`ACP error ${msg.error.code}: ${msg.error.message}`));
    } else {
      pending.resolve(msg.result);
    }
  }

  #handleNotification(msg: JsonRpcNotification): void {
    switch (msg.method) {
      case "session/update":
        this.#onSessionUpdate(msg.params as SessionUpdateParams);
        break;
    }
  }

  #onSessionUpdate(params: SessionUpdateParams): void {
    const { sessionId, update } = params;
    const kind = update?.sessionUpdate;

    if (this.replayingSessions.has(sessionId)) {
      if (kind === "user_message_chunk" && update.content?.text) {
        const accum = (this.replayUserAccum.get(sessionId) ?? "") + update.content.text;
        this.replayUserAccum.set(sessionId, accum);
        const expected = this.replayExpected.get(sessionId);
        if (expected && accum.includes(expected)) {
          this.replayingSessions.delete(sessionId);
          this.replayUserAccum.delete(sessionId);
          this.replayExpected.delete(sessionId);
        }
      } else if (kind === "turn_complete" || kind === "error") {
        if (kind === "error" && update.error) {
          const buf = this.updateBuffers.get(sessionId);
          if (buf) buf.push(`\n[error: ${update.error}]`);
        }
        const resolve = this.turnResolvers.get(sessionId);
        if (resolve) { this.turnResolvers.delete(sessionId); resolve(); }
      }
      return;
    }

    this.provider.handleSessionUpdate(params, this.#createContext(sessionId));
  }

  #createContext(sessionId: string): SessionContext {
    return {
      sessionId,
      bufferText: (text) => {
        const buf = this.updateBuffers.get(sessionId);
        if (buf) buf.push(text);
      },
      signalTurnDone: () => {
        const resolve = this.turnResolvers.get(sessionId);
        if (resolve) { this.turnResolvers.delete(sessionId); resolve(); }
      },
      signalError: (msg) => {
        const buf = this.updateBuffers.get(sessionId);
        if (buf) buf.push(`\n[error: ${msg}]`);
        const resolve = this.turnResolvers.get(sessionId);
        if (resolve) { this.turnResolvers.delete(sessionId); resolve(); }
      },
    };
  }

  async #handleIncomingRequest(req: JsonRpcRequest): Promise<void> {
    try {
      const result = await this.provider.handleIncomingRequest?.(req.method, req.params);
      if (result !== undefined) {
        this.#respond(req.id, result);
      } else {
        this.#respondError(req.id, -32603, `Unsupported incoming method: ${req.method}`);
      }
    } catch (err) {
      this.#respondError(req.id, -32603, String(err));
    }
  }

  #request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
      this.manager.write(JSON.stringify(msg) + "\n");
    });
  }

  #respond(id: string | number, result: unknown): void {
    const msg: JsonRpcResponse = { jsonrpc: "2.0", id, result };
    this.manager.write(JSON.stringify(msg) + "\n");
  }

  #respondError(id: string | number, code: number, message: string): void {
    const msg: JsonRpcResponse = { jsonrpc: "2.0", id, error: { code, message } };
    this.manager.write(JSON.stringify(msg) + "\n");
  }

  get capabilities(): AgentCapabilities {
    return this.agentCapabilities;
  }

  get providerName(): string {
    return this.provider.name;
  }
}
