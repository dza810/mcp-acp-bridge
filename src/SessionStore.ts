export interface SessionEntry {
  acpSessionId: string;
  createdAt: Date;
}

export class SessionStore {
  private sessions = new Map<string, SessionEntry>();

  set(mcpSessionId: string, acpSessionId: string): void {
    this.sessions.set(mcpSessionId, { acpSessionId, createdAt: new Date() });
  }

  get(mcpSessionId: string): SessionEntry | undefined {
    return this.sessions.get(mcpSessionId);
  }

  delete(mcpSessionId: string): boolean {
    return this.sessions.delete(mcpSessionId);
  }

  has(mcpSessionId: string): boolean {
    return this.sessions.has(mcpSessionId);
  }

  list(): Array<{ sessionId: string } & SessionEntry> {
    return Array.from(this.sessions.entries()).map(([sessionId, entry]) => ({
      sessionId,
      ...entry,
    }));
  }
}
