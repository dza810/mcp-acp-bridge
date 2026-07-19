import { execSync } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ProcessManager } from "./ProcessManager.js";
import type { ProcessManagerOptions } from "./ProcessManager.js";
import { AcpClient } from "./acp/AcpClient.js";
import { SessionStore } from "./SessionStore.js";
import { GeminiProvider } from "./providers/GeminiProvider.js";
import { OpenCodeProvider } from "./providers/OpenCodeProvider.js";
import type { AcpProvider } from "./providers/types.js";

interface ProviderRuntime {
  manager: ProcessManager;
  client: AcpClient;
  store: SessionStore;
}

function commandExists(cmd: string): boolean {
  try {
    execSync(`command -v "${cmd}"`, { stdio: "ignore" });
    return true;
  } catch { return false; }
}

function setupProvider(
  server: McpServer,
  options: ProcessManagerOptions,
  provider: AcpProvider,
  tag: string,
): ProviderRuntime | null {
  const cmd = options.command ?? provider.name;
  if (process.env[`DISABLE_${provider.name.toUpperCase().replace("-", "_")}`] === "1") {
    process.stderr.write(`[${tag}] ${provider.name} disabled via environment\n`);
    return null;
  }
  if (!commandExists(cmd)) {
    process.stderr.write(`[${tag}] ${provider.name} not found (${cmd}), skipping\n`);
    return null;
  }

  const manager = new ProcessManager(options);
  const client = new AcpClient(manager, provider);
  const store = new SessionStore();

  manager.on("restarting", ({ attempt, delayMs }: { attempt: number; delayMs: number }) => {
    process.stderr.write(`[${tag}] ${provider.name} restarting (attempt ${attempt}, delay ${delayMs}ms)\n`);
    store.clear();
    setTimeout(async () => {
      try {
        await client.initialize();
        process.stderr.write(`[${tag}] ${provider.name} re-initialized after restart\n`);
      } catch (e) {
        process.stderr.write(`[${tag}] re-initialize failed after restart: ${e}\n`);
      }
    }, delayMs + 800);
  });

  manager.on("error", (err: Error) => {
    process.stderr.write(`[${tag}] ${provider.name} fatal: ${err.message}\n`);
  });

  async function getOrCreateSession(sessionId?: string): Promise<string> {
    if (sessionId) {
      const entry = store.get(sessionId);
      if (entry) return entry.acpSessionId;
      await client.loadSession(sessionId, process.cwd());
      store.set(sessionId, sessionId);
      return sessionId;
    }
    const acpId = await client.newSession(process.cwd());
    store.set(acpId, acpId);
    return acpId;
  }

  const prefix = provider.name.replace("-cli", "");

  server.registerTool(
    `${prefix}_new_session`,
    {
      description: `Create a new ${provider.name} conversation session. Returns a session_id to use with ${prefix}_chat.`,
      inputSchema: z.object({}),
    },
    async () => {
      const acpId = await client.newSession(process.cwd());
      store.set(acpId, acpId);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ session_id: acpId }) }],
      };
    },
  );

  server.registerTool(
    `${prefix}_chat`,
    {
      description:
        `Send a message to ${provider.name} and receive a response. ` +
        `Provide session_id to continue an existing conversation; omit to start a new one.`,
      inputSchema: z.object({
        message: z.string().describe("The prompt to send"),
        session_id: z.string().optional().describe("Session ID from ${prefix}_new_session"),
      }),
    },
    async ({ message, session_id }: { message: string; session_id?: string }) => {
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

  server.registerTool(
    `${prefix}_list_sessions`,
    {
      description: `List all active ${provider.name} sessions managed by this MCP server.`,
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

  return { manager, client, store };
}

const server = new McpServer({
  name: "mcp-acp-bridge",
  version: "0.1.0",
});

const gemini = setupProvider(
  server,
  { command: process.env.GEMINI_PATH ?? "gemini", args: ["--acp"] },
  new GeminiProvider(),
  "mcp-acp-bridge",
);

const opencode = setupProvider(
  server,
  { command: process.env.OPENCODE_PATH ?? "opencode", args: ["acp"] },
  new OpenCodeProvider(),
  "mcp-acp-bridge",
);

async function main(): Promise<void> {
  const runtimes = [gemini, opencode].filter((r): r is ProviderRuntime => r !== null);

  for (const rt of runtimes) {
    rt.manager.start();
  }

  await new Promise((r) => setTimeout(r, 500));

  await Promise.allSettled(
    runtimes.map((rt) =>
      rt.client.initialize().catch((e) => {
        process.stderr.write(`[mcp-acp-bridge] ${rt.client.providerName} initialize failed: ${e}\n`);
      }),
    ),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const names = runtimes.map((r) => r.client.providerName).join(", ");
  process.stderr.write(`[mcp-acp-bridge] MCP server running (${names || "no providers"})\n`);

  process.on("SIGINT", async () => {
    await Promise.all(runtimes.map((r) => r.manager.stop()));
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await Promise.all(runtimes.map((r) => r.manager.stop()));
    process.exit(0);
  });
}

main().catch((err) => {
  process.stderr.write(`[mcp-acp-bridge] fatal: ${err}\n`);
  process.exit(1);
});
