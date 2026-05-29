#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { ConfigError, loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { registerTools } from "./tools/index.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`\n[aws-partner-central-mcp] Configuration error: ${err.message}\n\n`);
      process.exit(2);
    }
    throw err;
  }

  // Mask the account ID — only the last 4 digits are logged for support
  // correlation; the full ID is not written to stderr.
  const maskedAccountId = config.sso.accountId.replace(/\d(?=\d{4})/g, "*");
  logger.info("Starting aws-partner-central-mcp-server", {
    version: SERVER_VERSION,
    region: config.region,
    defaultCatalog: config.defaultCatalog,
    accountId: maskedAccountId,
  });

  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  registerTools(server, config);

  const transport = new StdioServerTransport();

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down`);
    // Await an orderly close so in-flight JSON-RPC responses are flushed
    // before the process exits. server.close() also closes the transport.
    void server
      .close()
      .catch((err: unknown) =>
        logger.warn("Error during shutdown", { error: (err as Error).message }),
      )
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await server.connect(transport);
  logger.info("Server connected over stdio and ready for MCP requests");
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`\n[aws-partner-central-mcp] Fatal error: ${message}\n`);
  process.exit(1);
});
