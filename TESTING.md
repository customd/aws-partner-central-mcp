# Sandbox Acceptance Test

Run this after installing **`aws-partner-central.mcpb` (v1.0.0)** in Claude Desktop with
**Default Catalog = `Sandbox`**. Each step is a prompt you give Claude; the *expected result*
confirms a capability. The `Sandbox` catalog is isolated from production partner data, so
writes here are safe.

> Automated unit + protocol coverage (55 tests + a stdio `tools/list` smoke test) already
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
- Expect: status **`requires_approval`** with the proposed fields and an approval id. **Nothing is written yet.**
- Then approve: **"Approve it."** → Claude calls `partner_central_respond_to_approval` (approve) → the write executes in Sandbox.

## 6. Approval — reject / override path
- Trigger another change (e.g. **"Update that opportunity's monthly spend to $20k."**), then:
  - **"Reject — leave it at $40k."** → write cancelled, no change; or
  - **"Override: set it to $25k and stage Qualified."** → executes the corrected version.

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
