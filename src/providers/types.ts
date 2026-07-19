import type {
  InitializeParams,
  SessionUpdateParams,
  ContentBlock,
} from "../acp/types.js";

export interface SessionContext {
  sessionId: string;
  bufferText(text: string): void;
  signalTurnDone(): void;
  signalError(msg: string): void;
}

export type SessionOp =
  | "initialize" | "new" | "load" | "resume" | "list" | "prompt";

export interface AcpProvider {
  readonly name: string;

  methodName(op: SessionOp): string;
  supportsOperation(op: SessionOp): boolean;

  initializeParams(): InitializeParams;
  authenticate?(request: (method: string, params: unknown) => Promise<unknown>): Promise<void>;

  handleSessionUpdate(params: SessionUpdateParams, ctx: SessionContext): void;
  handleIncomingRequest?(method: string, params: unknown): Promise<unknown | undefined>;
  formatPrompt(message: string): ContentBlock[];
}
