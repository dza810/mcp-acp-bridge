import fs from "node:fs/promises";
import type {
  InitializeParams,
  SessionUpdateParams,
  ContentBlock,
  FsReadTextFileParams,
  FsReadTextFileResult,
  FsWriteTextFileParams,
  RequestPermissionParams,
} from "../acp/types.js";
import type { AcpProvider, SessionContext, SessionOp } from "./types.js";

export class OpenCodeProvider implements AcpProvider {
  readonly name = "opencode";

  methodName(op: SessionOp): string {
    switch (op) {
      case "initialize": return "initialize";
      case "new":   return "session/new";
      case "load":  return "session/load";
      case "resume": return "session/resume";
      case "list":  return "session/list";
      case "prompt": return "session/prompt";
    }
  }

  supportsOperation(op: SessionOp): boolean {
    switch (op) {
      case "new": case "load": case "resume": case "list": case "prompt": case "initialize":
        return true;
    }
  }

  initializeParams(): InitializeParams {
    return {
      protocolVersion: 1,
      clientInfo: { name: "mcp-acp-bridge", version: "0.1.0" },
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      },
    };
  }

  async authenticate(): Promise<void> {
    // opencode may advertise auth methods (e.g. "opencode auth login").
    // Headless MCP mode: skip auth and let the agent decide how to handle it.
  }

  handleSessionUpdate(params: SessionUpdateParams, ctx: SessionContext): void {
    const { update } = params;
    const kind = update?.sessionUpdate;

    switch (kind) {
      case "agent_message_chunk":
        if (update.content?.text) ctx.bufferText(update.content.text);
        break;
      case "turn_complete":
        ctx.signalTurnDone();
        break;
      case "error":
        if (update.error) ctx.bufferText(`\n[error: ${update.error}]`);
        ctx.signalTurnDone();
        break;
    }
  }

  async handleIncomingRequest(method: string, params: unknown): Promise<unknown | undefined> {
    switch (method) {
      case "fs/read_text_file": {
        const { path } = params as FsReadTextFileParams;
        const content = await fs.readFile(path, "utf8");
        return { content } as FsReadTextFileResult;
      }
      case "fs/write_text_file": {
        const { path, content } = params as FsWriteTextFileParams;
        await fs.writeFile(path, content, "utf8");
        return {} as Record<string, never>;
      }
      case "session/request_permission": {
        const p = params as RequestPermissionParams;
        return { requestId: p.requestId, decision: "allow_once" };
      }
      default:
        return undefined;
    }
  }

  formatPrompt(message: string): ContentBlock[] {
    return [{ type: "text", text: message }];
  }
}
