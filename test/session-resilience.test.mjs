// Regression tests for the "session_id arrives absent" failure class.
//
// Background: MCP hosts normalize the advertised JSON Schema under a size budget
// and drop the `required` array (observed: Claude Desktop and the remote-devices
// bridge also strip `pattern`/`minLength` and some descriptions). `session_id`
// then reads as optional to the calling model, which omits it — which used to make
// get_session fail with a pre-handler Zod error (-32602 "session_id Required") and
// made send_message silently start a brand-new session every turn. See CLAUDE.md
// gotcha #12.
//
// These tests pin: (1) session_id is no longer enforced before the handler runs,
// (2) an omitted session_id resolves to the catalog's most recent session and says
// so, (3) with nothing to fall back to the caller gets actionable guidance rather
// than a Zod dump, (4) a requires_approval reply carries the recovered tool_use_id
// so the approval flow needs no second round-trip, (5) respond_to_approval
// re-resolves an omitted/stale tool_use_id but refuses to guess between several.
//
// Fake client throughout — no AWS, no filesystem, no MCP server.
// Run: node test/session-resilience.test.mjs

import assert from "node:assert/strict";
import {
  runGetSession,
  runRespondToApproval,
  runSendMessage,
  resolveSessionId,
} from "../server/tools/index.js";
import { SessionMemory } from "../server/services/session-memory.js";
import { CHARACTER_LIMIT } from "../server/constants.js";
import {
  GetSessionInputSchema,
  RespondToApprovalInputSchema,
} from "../server/schemas/inputs.js";

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    pass += 1;
  } catch (err) {
    console.error(`  FAIL  ${name}\n        ${err.message}`);
    fail += 1;
  }
}

/** Wrap an agent payload the way the live endpoint does: JSON inside content[0].text. */
function envelope(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

/**
 * Fake PartnerCentralClient. `replies` maps tool name -> function(args) -> envelope.
 * Every call is recorded so tests can assert what was forwarded upstream.
 */
function makeCtx(replies, { defaultCatalog = "Sandbox", memory = new SessionMemory() } = {}) {
  const calls = [];
  return {
    calls,
    memory,
    ctx: {
      defaultCatalog,
      memory,
      client: {
        callTool: async (name, args) => {
          calls.push({ name, args });
          const reply = replies[name];
          if (!reply) throw new Error(`unexpected call to ${name}`);
          return reply(args);
        },
        uploadDocuments: async () => [],
      },
    },
  };
}

const SESSION = "session-11111111-2222-3333-4444-555555555555";

// --- 1. The schema no longer hard-rejects a missing session_id -----------------

await test("get_session schema accepts input with no session_id (host stripped `required`)", () => {
  const parsed = GetSessionInputSchema.safeParse({});
  assert.equal(parsed.success, true, "must reach the handler, not fail pre-handler validation");
});

await test("get_session schema still rejects a malformed session_id when one IS given", () => {
  const parsed = GetSessionInputSchema.safeParse({ session_id: "not a valid id!" });
  assert.equal(parsed.success, false);
});

await test("respond_to_approval schema accepts input with no session_id / tool_use_id", () => {
  const parsed = RespondToApprovalInputSchema.safeParse({ decision: "approve" });
  assert.equal(parsed.success, true);
});

// --- 2. resolveSessionId ------------------------------------------------------

await test("resolveSessionId: a supplied id wins over remembered state", () => {
  const memory = new SessionMemory();
  memory.remember("Sandbox", "session-remembered");
  const { ctx } = makeCtx({}, { memory });
  assert.deepEqual(resolveSessionId(ctx, "Sandbox", SESSION), {
    sessionId: SESSION,
    inferred: false,
  });
});

await test("resolveSessionId: memory is per-catalog and never mixes them", () => {
  const memory = new SessionMemory();
  memory.remember("Sandbox", "session-sandbox");
  const { ctx } = makeCtx({}, { memory });
  assert.deepEqual(resolveSessionId(ctx, "Sandbox", undefined), {
    sessionId: "session-sandbox",
    inferred: true,
  });
  assert.equal(resolveSessionId(ctx, "AWS", undefined), null, "AWS must not see the Sandbox session");
});

// --- 3. Omitted session_id resolves, or explains itself ----------------------

await test("send_message remembers its session; get_session then works with no session_id", async () => {
  const { ctx, calls } = makeCtx({
    sendMessage: () => envelope({ sessionId: SESSION, status: "complete", content: [{ text: "hi" }] }),
    getSession: () => envelope({ sessionId: SESSION, status: "complete", events: [] }),
  });

  await runSendMessage(ctx, { message: "hello", response_format: "markdown", show_activity: false });

  const res = await runGetSession(ctx, { response_format: "markdown" });
  assert.ok(!res.isError, `expected success, got: ${res.content[0].text}`);
  const getCall = calls.find((c) => c.name === "getSession");
  assert.equal(getCall.args.sessionId, SESSION, "must target the remembered session");
  assert.equal(res.structuredContent.session_id_inferred, true, "must flag the inference");
  assert.match(res.content[0].text, /No session_id was given/, "must tell the user it inferred");
});

await test("get_session: an inferred session must NOT corrupt response_format:'json'", async () => {
  const memory = new SessionMemory();
  memory.remember("Sandbox", SESSION);
  const { ctx } = makeCtx(
    { getSession: () => envelope({ sessionId: SESSION, status: "complete", events: [] }) },
    { memory },
  );
  const res = await runGetSession(ctx, { response_format: "json" });
  assert.ok(!res.isError);
  // The inference notice is markdown; prepending it to json output would break parsing.
  assert.doesNotThrow(() => JSON.parse(res.content[0].text), "json output must stay parseable");
  assert.equal(res.structuredContent.session_id_inferred, true, "still flagged in structuredContent");
});

await test("get_session: the inference notice counts against CHARACTER_LIMIT", async () => {
  const memory = new SessionMemory();
  memory.remember("Sandbox", SESSION);
  const { ctx } = makeCtx(
    {
      getSession: () =>
        envelope({
          sessionId: SESSION,
          status: "complete",
          content: [{ text: "y".repeat(200_000) }],
        }),
    },
    { memory },
  );
  const res = await runGetSession(ctx, { response_format: "markdown" });
  const combined = res.content[0].text.length + JSON.stringify(res.structuredContent).length;
  assert.ok(
    combined <= CHARACTER_LIMIT,
    `combined result ${combined} must stay within CHARACTER_LIMIT ${CHARACTER_LIMIT}`,
  );
  assert.match(res.content[0].text, /No session_id was given/, "notice survives truncation");
});

await test("get_session with no session_id and nothing remembered returns actionable guidance", async () => {
  const { ctx, calls } = makeCtx({});
  const res = await runGetSession(ctx, { response_format: "markdown" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /partner_central_send_message/, "must say how to get a session_id");
  assert.equal(calls.length, 0, "must not call upstream with an undefined sessionId");
});

await test("send_message forwards a supplied session_id upstream (continuation)", async () => {
  const { ctx, calls } = makeCtx({
    sendMessage: () => envelope({ sessionId: SESSION, status: "complete", content: [{ text: "ok" }] }),
  });
  await runSendMessage(ctx, {
    message: "follow up",
    session_id: SESSION,
    response_format: "markdown",
    show_activity: false,
  });
  assert.equal(calls[0].args.sessionId, SESSION, "sessionId must reach sendMessage");
});

// --- 4. tool_use_id is recovered so approvals need no second round-trip ------

const TOOL_USE_ID = "tooluse_abc123";

/** A getSession in TOOL_REQUEST state, carrying the pending request as an event. */
function pendingSession(ids = [TOOL_USE_ID]) {
  return envelope({
    sessionId: SESSION,
    stateType: "TOOL_REQUEST",
    events: [
      {
        data: {
          role: "assistant",
          content: ids.map((id) => ({
            tool_use_id: id,
            name: "update_opportunity_enhanced",
            input: { Identifier: "O2100000", Title: "New title" },
          })),
        },
      },
    ],
  });
}

await test("send_message: requires_approval reply is enriched with the recovered tool_use_id", async () => {
  const { ctx, calls } = makeCtx({
    // Live shape: prose only, no structured tool_use_id (CLAUDE.md gotcha #3).
    sendMessage: () =>
      envelope({
        sessionId: SESSION,
        status: "requires_approval",
        content: [{ text: "I will update the Title. Approve?" }],
      }),
    getSession: () => pendingSession(),
  });

  const res = await runSendMessage(ctx, {
    message: "set Title to New title and proceed",
    response_format: "markdown",
    show_activity: false,
  });

  assert.ok(!res.isError, `expected success, got: ${res.content[0].text}`);
  assert.deepEqual(
    res.structuredContent.approval_requests.map((a) => a.tool_use_id),
    [TOOL_USE_ID],
    "the first response must already carry the tool_use_id",
  );
  assert.match(res.content[0].text, new RegExp(TOOL_USE_ID));
  assert.ok(
    calls.some((c) => c.name === "getSession"),
    "must read the pending request back from the session",
  );
});

await test("send_message: a 'complete' reply is NOT charged an extra getSession", async () => {
  const { ctx, calls } = makeCtx({
    sendMessage: () => envelope({ sessionId: SESSION, status: "complete", content: [{ text: "done" }] }),
  });
  await runSendMessage(ctx, { message: "list opps", response_format: "markdown", show_activity: false });
  assert.deepEqual(calls.map((c) => c.name), ["sendMessage"], "recovery must only run for approvals");
});

await test("send_message: reply still returned when approval recovery fails", async () => {
  const { ctx } = makeCtx({
    sendMessage: () =>
      envelope({ sessionId: SESSION, status: "requires_approval", content: [{ text: "Approve?" }] }),
    getSession: () => {
      throw new Error("throttled");
    },
  });
  const res = await runSendMessage(ctx, {
    message: "do it",
    response_format: "markdown",
    show_activity: false,
  });
  assert.ok(!res.isError, "a failed recovery must not turn a usable reply into an error");
  assert.match(res.content[0].text, /needs your approval/);
});

// --- 5. respond_to_approval re-resolves, but will not guess ------------------

await test("respond_to_approval: omitted tool_use_id is re-resolved from the session", async () => {
  const memory = new SessionMemory();
  memory.remember("Sandbox", SESSION);
  const { ctx, calls } = makeCtx(
    {
      getSession: () => pendingSession(),
      sendMessage: () => envelope({ sessionId: SESSION, status: "complete", content: [{ text: "Updated." }] }),
    },
    { memory },
  );

  const res = await runRespondToApproval(ctx, { decision: "approve", response_format: "markdown" });
  assert.ok(!res.isError, `expected success, got: ${res.content[0].text}`);
  const send = calls.find((c) => c.name === "sendMessage");
  assert.equal(send.args.sessionId, SESSION);
  assert.deepEqual(send.args.content, [
    { type: "tool_approval_response", toolUseId: TOOL_USE_ID, decision: "approve" },
  ]);
});

await test("respond_to_approval: refuses to guess between multiple pending writes", async () => {
  const memory = new SessionMemory();
  memory.remember("Sandbox", SESSION);
  const { ctx, calls } = makeCtx({ getSession: () => pendingSession(["tooluse_a", "tooluse_b"]) }, { memory });

  const res = await runRespondToApproval(ctx, { decision: "approve", response_format: "markdown" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /tooluse_a/);
  assert.match(res.content[0].text, /tooluse_b/);
  assert.ok(!calls.some((c) => c.name === "sendMessage"), "must not approve anything while ambiguous");
});

await test("respond_to_approval: explains when nothing is awaiting approval", async () => {
  const memory = new SessionMemory();
  memory.remember("Sandbox", SESSION);
  const { ctx } = makeCtx(
    { getSession: () => envelope({ sessionId: SESSION, status: "complete", events: [] }) },
    { memory },
  );
  const res = await runRespondToApproval(ctx, { decision: "approve", response_format: "markdown" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /no write awaiting approval/);
});

await test("respond_to_approval: an explicit tool_use_id skips the lookup entirely", async () => {
  const { ctx, calls } = makeCtx({
    sendMessage: () => envelope({ sessionId: SESSION, status: "complete", content: [{ text: "Updated." }] }),
  });
  const res = await runRespondToApproval(ctx, {
    session_id: SESSION,
    tool_use_id: TOOL_USE_ID,
    decision: "approve",
    response_format: "markdown",
  });
  assert.ok(!res.isError);
  assert.deepEqual(calls.map((c) => c.name), ["sendMessage"], "no getSession needed when the id is given");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
