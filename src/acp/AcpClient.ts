import fs from "node:fs/promises";
import { EventEmitter } from "node:events";
import { ProcessManager } from "../ProcessManager.js";
import type {
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  InitializeParams,
  InitializeResult,
  AgentCapabilities,
  SessionNewParams,
  SessionNewResult,
  SessionResumeParams,
  SessionUpdateParams,
  SessionListResult,
  SessionDeleteParams,
  SessionCloseParams,
  PromptParams,
  RequestPermissionParams,
  FsReadTextFileParams,
  FsReadTextFileResult,
  FsWriteTextFileParams,
} from "./types.js";

const PROTOCOL_VERSION = 1;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

export class AcpClient extends EventEmitter {
  private readonly manager: ProcessManager;
  private nextId = 1;
  private pending = new Map<string | number, PendingRequest>();
  private agentCapabilities: AgentCapabilities = {};

  // Buffers text from session/update notifications keyed by sessionId
  private updateBuffers = new Map<string, string[]>();
  // Resolvers waiting for turn_complete per sessionId
  private turnResolvers = new Map<string, () => void>();

  constructor(manager: ProcessManager) {
    super();
    this.manager = manager;
    this.manager.on("message", (msg: JsonRpcMessage) => this.#onMessage(msg));
    this.manager.on("stderr", (text: string) => {
      process.stderr.write(`[gemini-cli] ${text}`);
    });
  }

  async initialize(): Promise<void> {
    const params: InitializeParams = {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: "mcp-gemini-cli", version: "0.1.0" },
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      },
    };
    const result = (await this.#request("initialize", params)) as InitializeResult;
    this.agentCapabilities = result.agentCapabilities ?? {};
  }

  async sessionNew(params: SessionNewParams = {}): Promise<string> {
    const result = (await this.#request("session/new", params)) as SessionNewResult;
    return result.sessionId;
  }

  async sessionResume(sessionId: string): Promise<void> {
    const params: SessionResumeParams = { sessionId };
    await this.#request("session/resume", params);
  }

  async sessionList(): Promise<SessionListResult> {
    return (await this.#request("session/list", {})) as SessionListResult;
  }

  async sessionDelete(sessionId: string): Promise<void> {
    const params: SessionDeleteParams = { sessionId };
    await this.#request("session/delete", params);
  }

  async sessionClose(sessionId: string): Promise<void> {
    const params: SessionCloseParams = { sessionId };
    await this.#request("session/close", params);
  }

  // Send a prompt and collect all session/update text until turn_complete.
  async prompt(sessionId: string, message: string): Promise<string> {
    this.updateBuffers.set(sessionId, []);

    const turnDone = new Promise<void>((resolve) => {
      this.turnResolvers.set(sessionId, resolve);
    });

    const params: PromptParams = {
      sessionId,
      prompt: { parts: [{ text: message }] },
    };

    await this.#request("session/prompt", params);
    await turnDone;

    const chunks = this.updateBuffers.get(sessionId) ?? [];
    this.updateBuffers.delete(sessionId);
    return chunks.join("");
  }

  // ── Incoming message dispatch ─────────────────────────────────────────────

  #onMessage(msg: JsonRpcMessage): void {
    const hasId = "id" in msg;
    const hasMethod = "method" in msg;
    const hasResult = "result" in msg;
    const hasError = "error" in msg;

    if (hasId && (hasResult || hasError)) {
      // Response to one of our outgoing requests
      this.#handleResponse(msg as JsonRpcResponse);
    } else if (hasId && hasMethod) {
      // Incoming request from agent (e.g. fs/read_text_file, session/request_permission)
      void this.#handleIncomingRequest(msg as JsonRpcRequest);
    } else {
      // Notification from agent (no id, has method)
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
      default:
        // Unknown notification — ignore
        break;
    }
  }

  #onSessionUpdate(params: SessionUpdateParams): void {
    const { sessionId, type, text } = params;

    if (type === "text" && text) {
      const buf = this.updateBuffers.get(sessionId);
      if (buf) buf.push(text);
    }

    if (type === "turn_complete" || type === "error") {
      if (type === "error" && params.error) {
        // Still resolve — caller gets whatever text was accumulated plus error note
        const buf = this.updateBuffers.get(sessionId);
        if (buf) buf.push(`\n[error: ${params.error}]`);
      }
      const resolve = this.turnResolvers.get(sessionId);
      if (resolve) {
        this.turnResolvers.delete(sessionId);
        resolve();
      }
    }
  }

  // Handle requests that the agent sends to us (fs/*, session/request_permission)
  async #handleIncomingRequest(req: JsonRpcRequest): Promise<void> {
    try {
      const result = await this.#dispatchIncoming(req.method, req.params);
      this.#respond(req.id, result);
    } catch (err) {
      this.#respondError(req.id, -32603, String(err));
    }
  }

  async #dispatchIncoming(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "fs/read_text_file": {
        const { path } = params as FsReadTextFileParams;
        const content = await fs.readFile(path, "utf8");
        return { content } satisfies FsReadTextFileResult;
      }
      case "fs/write_text_file": {
        const { path, content } = params as FsWriteTextFileParams;
        await fs.writeFile(path, content, "utf8");
        return {};
      }
      case "session/request_permission": {
        // Auto-approve with allow_once
        const p = params as RequestPermissionParams;
        return { requestId: p.requestId, decision: "allow_once" };
      }
      default:
        throw new Error(`Unsupported incoming method: ${method}`);
    }
  }

  // ── JSON-RPC 2.0 helpers ──────────────────────────────────────────────────

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
}
