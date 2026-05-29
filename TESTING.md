# Sandbox Acceptance Test

Run this after installing **`aws-partner-central.mcpb` (v1.0.1)** in Claude Desktop with
**Default Catalog = `Sandbox`**. Each step is a prompt you give Claude; the *expected result*
confirms a capability. The `Sandbox` catalog is isolated from production partner data, so
writes here are safe.

> Automated unit + protocol coverage (65 tests + a stdio `tools/list` smoke test) already
> passes in CI/locally; this checklist validates the live end-to-end behaviour that needs a
> real AWS Partner Central session.

## 0. Setup
- [ ] Install the `.mcpb`, set **Default Catalog = Sandbox**, Log Level `info`.
- [ ] First tool call opens your browser for AWS IAM Identity Center → **Allow access**.

## 1. Connection (auth + SigV4 + endpoint)
- Prompt: **"Verify my Partner Central connection."**
- Expect: ✅ "connection verified", catalog `Sandbox`, a `session-…` id, and a short agent reply.

## 2. Basic agent interaction (read)
- Prompt: **"What can you help me with?"**
- Expect: the agent describes opportunities / funding / insights; status `complete`.

## 3. Read live data
- Prompt: **"List my open opportunities."**
- Expect: a list (may be empty in Sandbox) with no error.

## 4. File attachment  ← key new capability
- Create a small file, e.g. `~/Desktop/test-notes.txt` with a few lines of fake meeting notes.
- Prompt: **"Here are my meeting notes — summarise them and tell me which opportunity they fit."** and attach `~/Desktop/test-notes.txt`.
- Expect: the agent reads the file and responds.
- ⚠️ Requires the SSO role to allow `s3:PutObject` on `aws-partner-central-marketplace-ephemeral-writeonly-files/<account-id>/*`. If you get an "Attachment error … upload" message, grant that permission and retry. (Confirming this is itself a valid test outcome.)

## 5. Write + human-in-the-loop approval  ← key new capability
- Prompt: **"Create a Sandbox opportunity for Acme Corp — Redshift migration, ~$40k/mo spend, close end of Q3."**
- The agent gathers/validates fields over one or more turns, then returns status **`requires_approval`** and describes the proposed opportunity in its reply. **Nothing is written yet.**
- Approve in **either** way:
  - **Conversational:** just reply **"Approve — create it."** (the agent honors the instruction), or
  - **Structured:** Claude calls `partner_central_get_session` to read `approval_requests[].tool_use_id`, then `partner_central_respond_to_approval` (approve).
- Then the write executes in Sandbox.

## 6. Approval — reject / override path
- At a `requires_approval` step:
  - **"Reject — don't create it."** → write cancelled, nothing changes; or
  - **"Change the spend to $25k and stage to Qualified, then proceed."** → the agent revises and re-proposes for approval.

---

## Live results — 2026-05-29 (Sandbox, v1.0.1 build)
Driven end-to-end against the live endpoint:
- ✅ **Connection / auth / SigV4 / endpoint** — `verify_connection` OK.
- ✅ **Read** — agent answered a capability query.
- ✅ **File attachment** — a local `.txt` uploaded to the ephemeral S3 bucket and the agent summarised it (`s3:PutObject` is permitted for the role).
- ✅ **Write gate** — "create opportunity" reached status `requires_approval` (no write performed).
- ✅ **Reject** — `respond_to_approval` (decision `reject`) was accepted; the agent confirmed it would **not** create the opportunity. Nothing was written.

**Protocol note (docs vs. reality):** the AWS Tools Reference shows a `tool_approval_request` content block with `toolUseId`. In practice (non-streaming), the `requires_approval` *response* carries only the proposal prose; the structured request (`tool_use_id` / `name` / `input`) is delivered via the SSE stream and is also retrievable via `get_session` (`stateType: TOOL_REQUEST`). This extension therefore (a) surfaces the proposal + a how-to-approve note on `send_message`, and (b) recovers the pending `tool_use_id` from `get_session` so `respond_to_approval` can target it. Approval also works conversationally.

## 7. Session continuation
- Ask Claude to note the `session_id`, then in a later turn: **"Get the transcript for session `<id>`."**
- Expect: the conversation transcript is returned.

## 8. Error handling (optional)
- Reuse a Sandbox `session_id` with `catalog: AWS` → expect a clear `InvalidRequest` / cross-catalog message rather than a crash.

---

### Pass criteria
- [ ] 1–3 succeed (auth + read)
- [ ] 4 succeeds, or fails with the actionable S3-permission message (then fixed)
- [ ] 5 returns `requires_approval` and only writes after explicit approval
- [ ] 6 reject/override behave as described
- [ ] 7 transcript retrieval works
- [ ] No unhandled crashes; errors are human-readable
