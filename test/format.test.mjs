// Tests for response formatting: truncation, approval rendering, json mode.
// Run: node test/format.test.mjs

import assert from "node:assert/strict";
import { formatAgentResponse } from "../server/tools/format.js";

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

test("markdown: long text is truncated and flagged", () => {
  const big = "x".repeat(120_000);
  const r = formatAgentResponse({ text: big, isError: false, raw: {} }, "markdown");
  assert.equal(r.structured.truncated, true);
  assert.equal(r.structured.original_length, 120_000);
  assert.match(r.text, /truncated from/);
  assert.ok(r.text.length < 120_000);
});

test("markdown: short text is not truncated", () => {
  const r = formatAgentResponse(
    { text: "hello", status: "complete", sessionId: "session-1", isError: false, raw: {} },
    "markdown",
  );
  assert.equal(r.structured.truncated, undefined);
  assert.match(r.text, /\*\*Status:\*\* complete/);
  assert.match(r.text, /hello/);
});

test("markdown: approval request rendered with id + instructions", () => {
  const r = formatAgentResponse(
    {
      text: "Proposed update to O1.",
      status: "requires_approval",
      sessionId: "session-1",
      isError: false,
      raw: {},
      approvalRequests: [
        { toolUseId: "tu-1", toolName: "update_opportunity", parameters: { expectedRevenue: 250000 } },
      ],
    },
    "markdown",
  );
  assert.match(r.text, /requires your approval/i);
  assert.match(r.text, /tu-1/);
  assert.match(r.text, /partner_central_respond_to_approval/);
  assert.match(r.text, /expectedRevenue/);
  assert.ok(Array.isArray(r.structured.approval_requests));
  assert.equal(r.structured.approval_requests[0].tool_use_id, "tu-1");
});

test("markdown: requires_approval without a structured id shows the generic note", () => {
  const r = formatAgentResponse(
    {
      text: "I'd like to update opportunity O1 — close date 2026-03-31.",
      status: "requires_approval",
      sessionId: "session-1",
      isError: false,
      raw: {},
    },
    "markdown",
  );
  assert.match(r.text, /needs your approval/i);
  assert.match(r.text, /partner_central_get_session/);
  assert.match(r.text, /partner_central_respond_to_approval/);
});

test("json: returns the raw payload", () => {
  const r = formatAgentResponse(
    { text: "hi", isError: false, raw: { sessionId: "s", foo: 1 } },
    "json",
  );
  assert.match(r.text, /"foo": 1/);
  assert.equal(r.structured.text, "hi");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
