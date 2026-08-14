// Regression tests for the draft-07 dialect outage (CLAUDE.md gotcha #15).
//
// We use Zod v3, so the SDK's toJsonSchemaCompat takes its v3 branch and calls
// zodToJsonSchema with no `target`, stamping "$schema": draft-07 onto every input and
// output schema. Hosts that validate tool schemas with an Ajv 2020-12 instance reject
// that dialect and refuse to call the tool at all:
//
//   Tool 'partner_central_verify_connection' has an invalid outputSchema:
//   JSON Schema declares an unsupported dialect ("$schema": draft-07).
//
// That happens before any handler runs, so it took out all 5 tools simultaneously.
// stripSchemaDialect removes the declaration at the transport boundary. These tests
// pin that it is removed, that NOTHING else about the schemas changes, and that the
// message is not mutated in place.
// Run: node test/schema-dialect.test.mjs

import assert from "node:assert/strict";
import { stripSchemaDialect } from "../server/schema-dialect.js";

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    pass += 1;
  } catch (err) {
    console.error(`  FAIL  ${name}\n        ${err.message}`);
    fail += 1;
  }
}

const DRAFT7 = "http://json-schema.org/draft-07/schema#";

function toolsListMessage() {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      tools: [
        {
          name: "partner_central_get_session",
          description: "…",
          inputSchema: {
            type: "object",
            properties: {
              session_id: { type: "string", minLength: 1, pattern: "^[A-Za-z0-9_-]+$" },
            },
            additionalProperties: false,
            $schema: DRAFT7,
          },
          outputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
            $schema: DRAFT7,
          },
          annotations: { title: "Get Conversation Session", readOnlyHint: true },
        },
      ],
    },
  };
}

test("removes $schema from both inputSchema and outputSchema", () => {
  const out = stripSchemaDialect(toolsListMessage());
  const tool = out.result.tools[0];
  assert.equal(tool.inputSchema.$schema, undefined);
  assert.equal(tool.outputSchema.$schema, undefined);
  assert.equal(JSON.stringify(out).includes("$schema"), false);
});

test("preserves every other schema keyword", () => {
  const tool = stripSchemaDialect(toolsListMessage()).result.tools[0];
  assert.deepEqual(tool.inputSchema, {
    type: "object",
    properties: {
      session_id: { type: "string", minLength: 1, pattern: "^[A-Za-z0-9_-]+$" },
    },
    additionalProperties: false,
  });
  assert.deepEqual(tool.outputSchema, {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  });
});

test("preserves non-schema tool fields (name, description, annotations)", () => {
  const tool = stripSchemaDialect(toolsListMessage()).result.tools[0];
  assert.equal(tool.name, "partner_central_get_session");
  assert.equal(tool.description, "…");
  assert.deepEqual(tool.annotations, { title: "Get Conversation Session", readOnlyHint: true });
});

test("does not mutate the original message", () => {
  const original = toolsListMessage();
  stripSchemaDialect(original);
  assert.equal(original.result.tools[0].inputSchema.$schema, DRAFT7, "input must be untouched");
});

test("a tool with no outputSchema is handled", () => {
  const msg = toolsListMessage();
  delete msg.result.tools[0].outputSchema;
  const tool = stripSchemaDialect(msg).result.tools[0];
  assert.equal("outputSchema" in tool, false, "must not invent an outputSchema");
  assert.equal(tool.inputSchema.$schema, undefined);
});

test("non-tools messages pass through untouched", () => {
  for (const msg of [
    { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "hi" }] } },
    { jsonrpc: "2.0", id: 3, error: { code: -32602, message: "nope" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
  ]) {
    assert.deepEqual(stripSchemaDialect(msg), msg);
  }
});

test("malformed shapes do not throw", () => {
  assert.doesNotThrow(() => {
    stripSchemaDialect(null);
    stripSchemaDialect(undefined);
    stripSchemaDialect("string");
    stripSchemaDialect({ result: { tools: "not-an-array" } });
    stripSchemaDialect({ result: { tools: [null, 42, {}] } });
  });
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
