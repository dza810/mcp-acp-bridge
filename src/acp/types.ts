// ACP (Agent Client Protocol) v1 type definitions
// Protocol: JSON-RPC 2.0 over stdio (newline-delimited JSON)

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

// ── initialize ──────────────────────────────────────────────────────────────

export interface InitializeParams {
  protocolVersion: number;
  clientInfo: { name: string; version: string };
  clientCapabilities: ClientCapabilities;
}

export interface ClientCapabilities {
  fs?: { readTextFile?: boolean; writeTextFile?: boolean };
  terminal?: boolean;
}

export interface AgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
  sessionCapabilities?: { close?: boolean; delete?: boolean; list?: boolean; resume?: boolean };
  mcpCapabilities?: { http?: boolean; sse?: boolean };
  auth?: { logout?: boolean };
}

export interface InitializeResult {
  protocolVersion: number;
  agentInfo: { name: string; version: string };
  agentCapabilities: AgentCapabilities;
}

// ── session/new ─────────────────────────────────────────────────────────────

export interface SessionNewParams {
  workspacePath?: string;
}

export interface SessionNewResult {
  sessionId: string;
}

// ── session/resume ───────────────────────────────────────────────────────────

export interface SessionResumeParams {
  sessionId: string;
}

// ── session/prompt ───────────────────────────────────────────────────────────

export interface PromptPart {
  text: string;
}

export interface PromptParams {
  sessionId: string;
  prompt: { parts: PromptPart[] };
}

export interface PromptResult {
  // final result after all session/update notifications
  turnId?: string;
}

// ── session/update (notification: agent → client) ───────────────────────────

export interface SessionUpdateParams {
  sessionId: string;
  turnId?: string;
  type: "text" | "tool_call" | "tool_result" | "turn_complete" | "error";
  text?: string;
  toolCall?: unknown;
  toolResult?: unknown;
  error?: string;
}

// ── session/list ─────────────────────────────────────────────────────────────

export interface SessionInfo {
  sessionId: string;
  workspacePath?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface SessionListResult {
  sessions: SessionInfo[];
}

// ── session/delete ────────────────────────────────────────────────────────────

export interface SessionDeleteParams {
  sessionId: string;
}

// ── session/close ─────────────────────────────────────────────────────────────

export interface SessionCloseParams {
  sessionId: string;
}

// ── session/request_permission (notification: agent → client) ────────────────

export interface PermissionOption {
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
  label?: string;
}

export interface RequestPermissionParams {
  sessionId: string;
  requestId: string;
  toolCall: unknown;
  options: PermissionOption[];
}

// ── fs/* (requests: agent → client) ─────────────────────────────────────────

export interface FsReadTextFileParams {
  path: string;
}

export interface FsReadTextFileResult {
  content: string;
}

export interface FsWriteTextFileParams {
  path: string;
  content: string;
}
