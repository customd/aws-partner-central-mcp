// Tests for response formatting: truncation, approval rendering, json mode.
// Run: node test/format.test.mjs

import assert from "node:assert/strict";
import { formatAgentResponse } from "../server/tools/format.js";
import { CHARACTER_LIMIT, MAX_STRUCTURED_EVENTS } from "../server/constants.js";

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
  assert.match(r.text, /\*\*Status:\*\* ✅ complete/);
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
  // The tool_use_id is genuinely unavailable at this point (recovery already ran and
  // found nothing), so the note must point at the two routes that don't need one —
  // NOT at get_session, which cannot supply what isn't there.
  assert.match(r.text, /partner_central_send_message/);
  assert.match(r.text, /partner_central_respond_to_approval/);
  assert.doesNotMatch(r.text, /partner_central_get_session/);
  assert.match(r.text, /partner_central_respond_to_approval/);
});

test("markdown: activity trace renders as a collapsed details block when shown", () => {
  const parsed = {
    text: "You have 98 open opportunities.",
    status: "complete",
    isError: false,
    raw: {},
    activity: [
      { kind: "tool_use", name: "analyze_pipeline", activity: "analyzing pipeline", detail: '{"stage":["Prospect"]}' },
      { kind: "tool_result", name: "analyze_pipeline", status: "success", detail: '{"total_matched":98}' },
      { kind: "tool_use", name: "opportunity_creator", detail: "{}" },
    ],
  };
  const shown = formatAgentResponse(parsed, "markdown", true);
  assert.match(shown.text, /<details>/);
  assert.match(shown.text, /Agent activity — 3 steps/);
  // friendly labels, not raw snake_case
  assert.match(shown.text, /Analyzing pipeline/);
  assert.match(shown.text, /Opportunity creator/); // humanized from a name with no activity label
  assert.ok(!/analyze_pipeline|opportunity_creator/.test(shown.text), "no snake_case names in rendered trace");
  // raw names still retained in structured output for programmatic use
  assert.ok(Array.isArray(shown.structured.activity));
  assert.equal(shown.structured.activity[0].name, "analyze_pipeline");

  const hidden = formatAgentResponse(parsed, "markdown", false);
  assert.ok(!/<details>/.test(hidden.text), "no details block when show_activity is false");
  assert.ok(Array.isArray(hidden.structured.activity));
});

test("json: returns the raw payload", () => {
  const r = formatAgentResponse(
    { text: "hi", isError: false, raw: { sessionId: "s", foo: 1 } },
    "json",
  );
  assert.match(r.text, /"foo": 1/);
  assert.equal(r.structured.text, "hi");
});

test("markdown: opportunity IDs are linked for the AWS catalog", () => {
  const r = formatAgentResponse(
    { text: "See opportunity O7000000 for details.", status: "complete", isError: false, raw: {} },
    "markdown",
    true,
    "AWS",
  );
  assert.match(
    r.text,
    /\[O7000000\]\(https:\/\/us-east-1\.console\.aws\.amazon\.com\/partnercentral\/opportunities\/O7000000\)/,
  );
  assert.ok(Array.isArray(r.structured.opportunity_links));
  assert.equal(r.structured.opportunity_links[0].id, "O7000000");
});

test("markdown: opportunity IDs are NOT linked for the Sandbox catalog", () => {
  const r = formatAgentResponse(
    { text: "See opportunity O7000000 for details.", status: "complete", isError: false, raw: {} },
    "markdown",
    true,
    "Sandbox",
  );
  assert.ok(!/\]\(https:\/\//.test(r.text), "no markdown link for Sandbox");
  assert.equal(r.structured.opportunity_links, undefined);
});

test("structuredContent no longer carries the raw payload", () => {
  const r = formatAgentResponse(
    { text: "hi", status: "complete", isError: false, raw: { sessionId: "s", secret: 1 } },
    "markdown",
  );
  assert.equal(r.structured.raw, undefined);
});

test("get_session: oversized result is capped under the client tool-result limit", () => {
  // A large session (big rendered text + many/large events) must not be returned
  // whole — the client rejects results over its token cap and shunts them to an
  // unreachable temp file. The COMBINED (text + structuredContent) size must fit.
  const events = Array.from({ length: 60 }, (_, i) => ({
    data: { role: "assistant", content: "z".repeat(2000) },
    n: i,
  }));
  const r = formatAgentResponse(
    { text: "y".repeat(80_000), status: "complete", sessionId: "session-1", isError: false, raw: {}, events },
    "markdown",
  );
  const combined = r.text.length + JSON.stringify(r.structured).length;
  assert.ok(combined <= CHARACTER_LIMIT, `combined ${combined} should be <= ${CHARACTER_LIMIT}`);
  assert.equal(r.structured.truncated, true);
});

test("get_session: structuredContent events are capped to the most recent N", () => {
  const events = Array.from({ length: 100 }, (_, i) => ({ data: { role: "user", content: "hi" }, n: i }));
  const r = formatAgentResponse(
    { text: "short transcript", status: "complete", sessionId: "s", isError: false, raw: {}, events },
    "markdown",
  );
  assert.ok(Array.isArray(r.structured.events));
  assert.ok(r.structured.events.length <= MAX_STRUCTURED_EVENTS, `events ${r.structured.events.length} <= ${MAX_STRUCTURED_EVENTS}`);
  assert.equal(r.structured.events_truncated, true);
  assert.equal(r.structured.event_count, 100);
  // the most-recent events are kept (last one survives)
  assert.equal(r.structured.events[r.structured.events.length - 1].n, 99);
});

test("approval_requests survive truncation of an oversized result", () => {
  // The approval tool_use_id is load-bearing for the write loop — it must never be
  // dropped even when the transcript is truncated for size.
  const r = formatAgentResponse(
    {
      text: "y".repeat(80_000),
      status: "requires_approval",
      sessionId: "s",
      isError: false,
      raw: {},
      approvalRequests: [
        { toolUseId: "tooluse_keepme", toolName: "update_opportunity_enhanced", parameters: { Identifier: "O1" } },
      ],
    },
    "markdown",
  );
  assert.equal(r.structured.truncated, true);
  assert.ok(Array.isArray(r.structured.approval_requests));
  assert.equal(r.structured.approval_requests[0].tool_use_id, "tooluse_keepme");
});

test("markdown: status line shows an emoji for known statuses", () => {
  const approval = formatAgentResponse(
    { text: "Proposed.", status: "requires_approval", isError: false, raw: {} },
    "markdown",
  );
  assert.match(approval.text, /\*\*Status:\*\* ⚠️ requires_approval/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
