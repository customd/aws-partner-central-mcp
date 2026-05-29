// Tests for the documented "inline" response shape and the approval workflow.
// Complements response-parser.test.mjs (which covers the "stringified" shape).
// Run: node test/response-parser-v2.test.mjs

import assert from "node:assert/strict";
import { parseAgentResponse } from "../server/services/response-parser.js";

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

// --- Documented inline form: sessionId/status at the envelope top level,
//     content[] blocks carry plain text directly. ---
const inline = {
  content: [{ type: "text", text: "I found 12 open opportunities in Q1 2026." }],
  sessionId: "session-550e8400-e29b-41d4-a716-446655440000",
  status: "complete",
};

test("inline: sessionId read from top level", () => {
  assert.equal(
    parseAgentResponse(inline).sessionId,
    "session-550e8400-e29b-41d4-a716-446655440000",
  );
});

test("inline: status complete", () => {
  assert.equal(parseAgentResponse(inline).status, "complete");
});

test("inline: extracts plain text", () => {
  assert.equal(parseAgentResponse(inline).text, "I found 12 open opportunities in Q1 2026.");
});

test("inline: no approval requests", () => {
  assert.equal(parseAgentResponse(inline).approvalRequests, undefined);
});

// --- Human-in-the-loop approval (requires_approval) ---
const approval = {
  content: [
    {
      type: "text",
      text: "I'd like to update opportunity O1234567890 with new revenue. Please approve.",
    },
    {
      type: "tool_approval_request",
      toolUseId: "tool-use-98765",
      toolName: "update_opportunity_enhanced",
      parameters: {
        opportunityId: "O1234567890",
        expectedRevenue: 300000,
        stage: "Qualified",
      },
    },
  ],
  sessionId: "session-550e8400-e29b-41d4-a716-446655440000",
  status: "requires_approval",
};

test("approval: status requires_approval", () => {
  assert.equal(parseAgentResponse(approval).status, "requires_approval");
});

test("approval: extracts the approval request", () => {
  const p = parseAgentResponse(approval);
  assert.ok(Array.isArray(p.approvalRequests));
  assert.equal(p.approvalRequests.length, 1);
  assert.equal(p.approvalRequests[0].toolUseId, "tool-use-98765");
  assert.equal(p.approvalRequests[0].toolName, "update_opportunity_enhanced");
  assert.equal(p.approvalRequests[0].parameters.expectedRevenue, 300000);
});

test("approval: assistant text excludes the control block", () => {
  const p = parseAgentResponse(approval);
  assert.match(p.text, /I'd like to update opportunity O1234567890/);
  assert.ok(!/tool_approval_request/.test(p.text));
});

// --- Approval inside the "stringified" inner payload (live-style) ---
const wrappedApproval = {
  content: [
    {
      type: "text",
      text: JSON.stringify({
        sessionId: "session-abc",
        status: "requires_approval",
        content: [
          { type: "ASSISTANT_RESPONSE", content: { text: "Confirm this write?" } },
          { type: "tool_approval_request", toolUseId: "tu-1", toolName: "create_opportunity" },
        ],
      }),
    },
  ],
};

test("wrapped approval: status + request extracted from inner payload", () => {
  const p = parseAgentResponse(wrappedApproval);
  assert.equal(p.status, "requires_approval");
  assert.equal(p.sessionId, "session-abc");
  assert.equal(p.approvalRequests?.length, 1);
  assert.equal(p.approvalRequests[0].toolUseId, "tu-1");
  assert.match(p.text, /Confirm this write\?/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
