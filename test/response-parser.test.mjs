// Quick parity test against captured live Partner Central response shapes.
// Run: node test/response-parser.test.mjs

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

// Fixture 1: real sendMessage response shape (captured live 2026-05-25)
const sendMessageResult = {
  content: [
    {
      type: "text",
      text: JSON.stringify({
        role: "assistant",
        timestamp: "2026-05-25T12:00:06.775194+00:00",
        sessionId: "session-16f66027-470f-4161-b676-aac6bc58da15",
        content: [
          {
            type: "ASSISTANT_RESPONSE",
            content: {
              text: "I can help you with AWS Partner Central opportunities, funding programs, and customer insights.",
            },
            timestamp: "2026-05-25T12:00:06.643839+00:00",
          },
        ],
        status: "complete",
      }),
    },
  ],
};

test("sendMessage: extracts sessionId from inner JSON", () => {
  const p = parseAgentResponse(sendMessageResult);
  assert.equal(p.sessionId, "session-16f66027-470f-4161-b676-aac6bc58da15");
});

test("sendMessage: extracts status", () => {
  const p = parseAgentResponse(sendMessageResult);
  assert.equal(p.status, "complete");
});

test("sendMessage: extracts ASSISTANT_RESPONSE text", () => {
  const p = parseAgentResponse(sendMessageResult);
  assert.equal(
    p.text,
    "I can help you with AWS Partner Central opportunities, funding programs, and customer insights.",
  );
});

test("sendMessage: isError flag is false", () => {
  const p = parseAgentResponse(sendMessageResult);
  assert.equal(p.isError, false);
});

test("sendMessage: raw is the parsed inner object", () => {
  const p = parseAgentResponse(sendMessageResult);
  assert.ok(p.raw && typeof p.raw === "object");
  assert.equal(p.raw.sessionId, "session-16f66027-470f-4161-b676-aac6bc58da15");
});

// Fixture 2: real getSession response shape (captured live 2026-05-25)
const getSessionResult = {
  content: [
    {
      type: "text",
      text: JSON.stringify({
        createdAt: "2026-05-25T12:00:06.694231+00:00",
        sequenceNumber: 3,
        variables: {
          sequenceNumber: 3,
          awsAccountId: "123456789012",
          stateType: "END_TURN",
          principalId: "AROA000000000000XXXXX:test-user@example.com",
        },
        stateType: "END_TURN",
        lastActivity: "2026-05-25T12:00:06.694231+00:00",
        eventCount: 3,
        sessionId: "session-16f66027-470f-4161-b676-aac6bc58da15",
        events: [
          {
            session_id: "session-16f66027-470f-4161-b676-aac6bc58da15",
            agent_id: "general_helper",
            timestamp: "2026-05-25T12:00:04.754409+00:00",
            message_id: "ca593eb8-4774-43f6-b156-a30f65dce2ad",
            data: {
              role: "user",
              content: [
                {
                  text: "What categories of questions can you help me with? Reply in one short sentence.",
                  type: "text",
                },
              ],
            },
          },
          {
            session_id: "session-16f66027-470f-4161-b676-aac6bc58da15",
            agent_id: "general_helper",
            timestamp: "2026-05-25T12:00:06.643667+00:00",
            data: {
              role: "assistant",
              content:
                "I can help you with AWS Partner Central opportunities, funding programs, and customer insights.",
            },
          },
          {
            session_id: "session-16f66027-470f-4161-b676-aac6bc58da15",
            agent_id: null,
            timestamp: "2026-05-25T12:00:06.694212+00:00",
            data: {},
          },
        ],
      }),
    },
  ],
};

test("getSession: extracts sessionId", () => {
  const p = parseAgentResponse(getSessionResult);
  assert.equal(p.sessionId, "session-16f66027-470f-4161-b676-aac6bc58da15");
});

test("getSession: status falls back to stateType", () => {
  const p = parseAgentResponse(getSessionResult);
  assert.equal(p.status, "END_TURN");
});

test("getSession: exposes events array", () => {
  const p = parseAgentResponse(getSessionResult);
  assert.ok(Array.isArray(p.events));
  assert.equal(p.events.length, 3);
});

test("getSession: renders user + assistant turns into text", () => {
  const p = parseAgentResponse(getSessionResult);
  assert.match(p.text, /\*\*user:\*\* What categories/);
  assert.match(p.text, /\*\*assistant:\*\* I can help you/);
});

// Defensive: degenerate inputs
test("null input does not throw", () => {
  const p = parseAgentResponse(null);
  assert.equal(p.text, "");
  assert.equal(p.sessionId, undefined);
});

test("envelope with non-JSON text returns text as-is", () => {
  const p = parseAgentResponse({
    content: [{ type: "text", text: "just a string, not JSON" }],
  });
  assert.equal(p.text, "just a string, not JSON");
});

test("envelope with isError=true sets the flag", () => {
  const p = parseAgentResponse({
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ status: "failed" }) }],
  });
  assert.equal(p.isError, true);
  assert.equal(p.status, "failed");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
