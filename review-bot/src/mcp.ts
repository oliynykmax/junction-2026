// MCP servers as durable tools for code mode: each server's tools become
// `mcp__<server>__<tool>`, callable from code mode scripts only.

import {
  createMcpToolName,
  limitMcpContent,
  McpClient,
  type McpHttpServerConfig,
  mcpNamespace,
  normalizeMcpInputSchema,
  StreamableHttpTransport,
  type Tool,
  toLlmContent,
  validateMcpServerConfig,
} from "@earendil-works/pi-mcp";
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode";
import {
  defineExtension,
  defineTool,
  type Extension,
} from "@earendil-works/pi-durable";

const CONNECT_TIMEOUT_MS = 8_000;
const CALL_TIMEOUT_S = 60;

type Server = { name: string; config: McpHttpServerConfig };

export function mcpServers(raw: Record<string, unknown> | undefined): Server[] {
  const servers: Server[] = [];
  for (const [name, entry] of Object.entries(raw ?? {})) {
    const result = validateMcpServerConfig(name, entry);
    if (result.kind !== "http") {
      console.warn(
        `mcp ${name}: ${result.kind === "invalid" ? result.error : "stdio servers cannot run on Workers"}`,
      );
      continue;
    }
    if (result.config.enabled !== false)
      servers.push({ name, config: result.config });
  }
  return servers;
}

export function mcpNamespaces(servers: Server[]): CodemodeNamespace[] {
  return servers.map(({ name, config }) => ({
    name,
    description: config.description,
    prefix: `${mcpNamespace(name)}__`,
  }));
}

function connector({ config }: Server): () => Promise<McpClient> {
  let client: Promise<McpClient> | null = null;
  return () => {
    if (!client) {
      const mcp = new McpClient({
        name: "j26-review-bot",
        version: "1.0.0",
        requestTimeoutMs: (config.timeout ?? CALL_TIMEOUT_S) * 1000,
      });
      mcp.onClose(() => {
        client = null;
      });
      client = mcp
        .connect(
          new StreamableHttpTransport({
            url: config.url,
            headers: config.headers,
            openGetStream: false,
          }),
        )
        .then(
          () => mcp,
          (error) => {
            client = null;
            throw error;
          },
        );
    }
    return client;
  };
}

/** Rejects once `ms` passes; a connect that hangs ends later at its request timeout. */
function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Connects to every server and lists its tools. A server that does not answer
 * within CONNECT_TIMEOUT_MS is left out of this run's tools.
 */
export async function mcpExtension(servers: Server[]): Promise<Extension> {
  const taken = new Set<string>();
  const listed = await Promise.all(
    servers.map(async (server) => {
      const client = connector(server);
      try {
        const tools = await within(
          CONNECT_TIMEOUT_MS,
          client().then((c) => c.listTools()),
        );
        return { server, client, tools };
      } catch (error) {
        console.warn(`mcp ${server.name}: tools unavailable: ${error}`);
        return { server, client, tools: [] as Tool[] };
      }
    }),
  );

  const tools = listed.flatMap(({ server, client, tools }) =>
    tools.map((tool) => {
      const name = createMcpToolName(server.name, tool.name, (n) =>
        taken.has(n),
      );
      taken.add(name);
      return defineTool({
        name,
        description: tool.description ?? tool.title ?? tool.name,
        parameters: normalizeMcpInputSchema(tool.inputSchema),
        callers: ["tools"],
        replay: tool.annotations?.readOnlyHint ? "safe" : "unsafe",
        execute: async (args, _api, context) => {
          const mcp = await client();
          const result = await mcp.callTool(
            tool.name,
            args as Record<string, unknown>,
            { signal: context.abortSignal },
          );
          const { content } = await limitMcpContent(toLlmContent(result));
          return { output: content, isError: result.isError === true };
        },
      });
    }),
  );

  return defineExtension({ name: "mcp", tools });
}
