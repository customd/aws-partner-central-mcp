import { z } from "zod";

/**
 * Output schema shared by send_message, get_session, and respond_to_approval.
 * Mirrors the structuredContent produced by tools/format.ts buildStructured().
 * Fields beyond `text` are conditional, so they are optional; `raw` is the
 * full upstream payload and is intentionally untyped.
 */
export const AgentResponseOutputSchema = z.object({
  text: z.string().describe("Human-readable rendering of the agent's reply."),
  session_id: z
    .string()
    .optional()
    .describe("Session ID — pass to a later call to continue the conversation."),
  status: z
    .string()
    .optional()
    .describe("Agent status: 'complete', 'requires_approval', or 'error'."),
  events: z
    .array(z.unknown())
    .optional()
    .describe("Conversation transcript events (get_session only; most-recent subset when large)."),
  events_truncated: z
    .boolean()
    .optional()
    .describe("True when only a subset of events is included (the full transcript is in `text`)."),
  event_count: z.number().optional().describe("Total number of events in the session."),
  approval_requests: z
    .array(
      z.object({
        tool_use_id: z.string(),
        tool_name: z.string().optional(),
        parameters: z.record(z.unknown()).optional(),
      }),
    )
    .optional()
    .describe(
      "Pending write operations awaiting approval. Respond with partner_central_respond_to_approval.",
    ),
  activity: z
    .array(
      z.object({
        kind: z.string(),
        name: z.string().optional(),
        activity: z.string().optional(),
        status: z.string().optional(),
        detail: z.string().optional(),
      }),
    )
    .optional()
    .describe("Trace of the agent's internal tool/thinking steps."),
  session_id_inferred: z
    .boolean()
    .optional()
    .describe("True when no session_id was supplied and the catalog's most recent session was used."),
  is_error: z.boolean().optional(),
  truncated: z.boolean().optional(),
  original_length: z.number().optional(),
  opportunity_links: z
    .array(z.object({ id: z.string(), url: z.string() }))
    .optional()
    .describe("Opportunities referenced in the reply, linked to the AWS console."),
});

export const VerifyConnectionOutputSchema = z.object({
  ok: z.boolean(),
  catalog: z.string(),
  session_id: z.string().optional(),
  agent_status: z.string().optional(),
  preview: z.string().optional(),
  error: z.string().optional(),
  config: z
    .object({
      sso_start_url: z.string(),
      account_id: z.string(),
      role_name: z.string(),
      region: z.string().describe("Region Partner Central requests are signed for (us-east-1)."),
      sso_region: z.string().describe("Region of the user's IAM Identity Center instance."),
      default_catalog: z.string(),
    })
    .optional()
    .describe("Effective configuration (account ID masked) so the user can confirm or correct setup."),
});

export const SelectAccountOutputSchema = z.object({
  ok: z.boolean(),
  account_id: z.string().describe("The selected AWS account ID (masked)."),
  role_name: z.string().describe("The selected permission-set / role name."),
});
