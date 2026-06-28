import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ProcessManager } from "./ProcessManager.js";
import { AcpClient } from "./acp/AcpClient.js";
import { SessionStore } from "./SessionStore.js";

const manager = new ProcessManager({
  geminiPath: process.env.GEMINI_PATH ?? "gemini",
});
const client = new AcpClient(manager);
const store = new SessionStore();

manager.on("restarting", ({ attempt, delayMs }: { attempt: number; delayMs: number }) => {
  process.stderr.write(`[mcp-gemini-cli] gemini restarting (attempt ${attempt}, delay ${delayMs}ms)\n`);
  // Sessions tied to the dead process are invalid — clear them so callers get a clear error
  store.clear();
  // Re-initialize after the new process has had time to start (restart delay + startup buffer)
  setTimeout(async () => {
    try {
      await client.initialize();
      process.stderr.write("[mcp-gemini-cli] gemini re-initialized after restart\n");
    } catch (e) {
      process.stderr.write(`[mcp-gemini-cli] re-initialize failed after restart: ${e}\n`);
    }
  }, delayMs + 800);
});

manager.on("error", (err: Error) => {
  process.stderr.write(`[mcp-gemini-cli] fatal: ${err.message}\n`);
});

async function getOrCreateSession(sessionId?: string): Promise<string> {
  if (sessionId) {
    const entry = store.get(sessionId);
    if (!entry) throw new Error(`Unknown session_id: ${sessionId}`);
    // Persistent process keeps session state in memory — no session/resume needed
    return entry.acpSessionId;
  }
  const acpId = await client.sessionNew(process.cwd());
  store.set(acpId, acpId);
  return acpId;
}

const server = new McpServer({
  name: "mcp-gemini-cli",
  version: "0.1.0",
});

// ── gemini_new_session ───────────────────────────────────────────────────────

server.registerTool(
  "gemini_new_session",
  {
    description: "Create a new Gemini conversation session. Returns a session_id to use with gemini_chat.",
    inputSchema: z.object({}),
  },
  async () => {
    const acpId = await client.sessionNew(process.cwd());
    store.set(acpId, acpId);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ session_id: acpId }) }],
    };
  },
);

// ── gemini_chat ──────────────────────────────────────────────────────────────

server.registerTool(
  "gemini_chat",
  {
    description:
      "Send a message to Gemini and receive a response. " +
      "Provide session_id to continue an existing conversation; omit to start a new one.",
    inputSchema: z.object({
      message: z.string().describe("The prompt to send to Gemini"),
      session_id: z.string().optional().describe("Session ID from gemini_new_session"),
    }),
  },
  async ({ message, session_id }) => {
    const acpId = await getOrCreateSession(session_id);
    const response = await client.prompt(acpId, message);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ session_id: acpId, response }),
        },
      ],
    };
  },
);

// ── gemini_list_sessions ─────────────────────────────────────────────────────

server.registerTool(
  "gemini_list_sessions",
  {
    description: "List all active Gemini sessions managed by this MCP server.",
    inputSchema: z.object({}),
  },
  async () => {
    const sessions = store.list().map((s) => ({
      session_id: s.sessionId,
      created_at: s.createdAt.toISOString(),
    }));
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ sessions }) }],
    };
  },
);

// ── gemini_clear_session ─────────────────────────────────────────────────────

server.registerTool(
  "gemini_clear_session",
  {
    description: "Delete a Gemini session and its conversation history.",
    inputSchema: z.object({
      session_id: z.string().describe("Session ID to delete"),
    }),
  },
  async ({ session_id }) => {
    const entry = store.get(session_id);
    if (!entry) throw new Error(`Unknown session_id: ${session_id}`);

    // session/delete is not implemented in all gemini-cli versions;
    // remove from local store regardless.
    try {
      await client.sessionDelete(entry.acpSessionId);
    } catch {
      // best-effort — gemini-cli will GC sessions via its own retention policy
    }
    store.delete(session_id);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ deleted: session_id }) }],
    };
  },
);

// ── startup ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  manager.start();

  // Wait briefly for gemini --acp to be ready before sending initialize
  await new Promise((r) => setTimeout(r, 500));
  await client.initialize();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[mcp-gemini-cli] MCP server running\n");

  process.on("SIGINT", () => manager.stop().then(() => process.exit(0)));
  process.on("SIGTERM", () => manager.stop().then(() => process.exit(0)));
}

main().catch((err) => {
  process.stderr.write(`[mcp-gemini-cli] fatal: ${err}\n`);
  process.exit(1);
});
