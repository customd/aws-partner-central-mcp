// Smoke test: spawn the built server over stdio and confirm it advertises all
// expected tools with input/output schemas and annotations. No AWS network
// calls are made (initialize + tools/list are handled locally), so dummy
// (valid-format) config is fine.
//
// Run: node scripts/smoke-tools-list.mjs

import { spawn } from "node:child_process";
import process from "node:process";

const EXPECTED = [
  "partner_central_send_message",
  "partner_central_respond_to_approval",
  "partner_central_get_session",
  "partner_central_verify_connection",
];

const child = spawn("node", ["server/index.js"], {
  stdio: ["pipe", "pipe", "inherit"],
  env: {
    ...process.env,
    AWS_SSO_START_URL: "https://example.awsapps.com/start",
    AWS_SSO_ACCOUNT_ID: "123456789012",
    AWS_SSO_ROLE_NAME: "TestRole",
    AWS_REGION: "us-east-1",
    PARTNER_CENTRAL_DEFAULT_CATALOG: "Sandbox",
    LOG_LEVEL: "warn",
  },
});

const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");

let buffer = "";
const pending = new Map();
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

const rpc = (id, method, params) =>
  new Promise((resolve) => {
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });

function fail(msg) {
  console.error(`  FAIL  ${msg}`);
  child.kill();
  process.exit(1);
}

try {
  const init = await rpc(1, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "smoke", version: "1.0.0" },
  });
  if (!init.result) fail("initialize returned no result");
  console.log(`  PASS  initialize (server: ${init.result.serverInfo?.name})`);

  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

  const list = await rpc(2, "tools/list", {});
  const tools = list.result?.tools ?? [];
  const names = tools.map((t) => t.name).sort();
  if (names.length !== EXPECTED.length) {
    fail(`expected ${EXPECTED.length} tools, got ${names.length}: ${names.join(", ")}`);
  }
  for (const want of EXPECTED) {
    if (!names.includes(want)) fail(`missing tool: ${want}`);
  }
  console.log(`  PASS  tools/list advertises all ${EXPECTED.length} tools`);

  for (const t of tools) {
    if (!t.inputSchema) fail(`${t.name}: no inputSchema`);
    if (!t.outputSchema) fail(`${t.name}: no outputSchema`);
    if (!t.annotations || typeof t.annotations.readOnlyHint !== "boolean") {
      fail(`${t.name}: missing readOnlyHint annotation`);
    }
    console.log(
      `  PASS  ${t.name} (readOnly=${t.annotations.readOnlyHint}, destructive=${t.annotations.destructiveHint})`,
    );
  }

  // Sanity: the write-executing tool must be flagged destructive.
  const approve = tools.find((t) => t.name === "partner_central_respond_to_approval");
  if (approve.annotations.destructiveHint !== true) {
    fail("respond_to_approval must be destructiveHint:true");
  }
  console.log("  PASS  respond_to_approval is destructiveHint:true");

  console.log("\nAll smoke checks passed.");
  child.kill();
  process.exit(0);
} catch (err) {
  fail(`unexpected error: ${err.message}`);
}
