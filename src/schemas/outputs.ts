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
    .describe("Conversation transcript events (get_session only)."),
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
  is_error: z.boolean().optional(),
  truncated: z.boolean().optional(),
  original_length: z.number().optional(),
  raw: z.unknown(),
});

export const VerifyConnectionOutputSchema = z.object({
  ok: z.boolean(),
  catalog: z.string(),
  session_id: z.string().optional(),
  agent_status: z.string().optional(),
  preview: z.string().optional(),
  error: z.string().optional(),
});
