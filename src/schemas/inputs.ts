import { z } from "zod";
import {
  CATALOG_AWS,
  CATALOG_SANDBOX,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "../constants.js";

export const CatalogSchema = z
  .enum([CATALOG_AWS, CATALOG_SANDBOX])
  .describe(
    "Which Partner Central catalog to use. 'AWS' is production data; 'Sandbox' is for testing. Sessions are scoped per catalog and cannot be reused across catalogs.",
  );

export const ResponseFormatSchema = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe(
    "Output format: 'markdown' for a human-readable rendering, 'json' for the raw structured response.",
  );

export const ShowActivitySchema = z
  .boolean()
  .default(true)
  .describe(
    "Include a collapsed, expandable trace of the agent's internal tool steps and 'thinking' in the reply (markdown only). Set false to omit it.",
  );

const SessionIdSchema = z
  .string()
  .min(1, "session_id must not be empty")
  .max(256, "session_id is too long")
  .regex(
    /^[A-Za-z0-9_-]+$/,
    "session_id has an unexpected format (expected 'session-<uuid>')",
  );

export const SendMessageInputSchema = z
  .object({
    message: z
      .string()
      .min(1, "message must not be empty")
      .max(10_000, "message must be 10,000 characters or fewer")
      .describe(
        "The natural-language instruction or question for the Partner Central agent (e.g. 'List my open opportunities', 'Show invitations from last week', 'Create an opportunity from the attached proposal').",
      ),
    attachments: z
      .array(z.string().min(1))
      .max(
        MAX_ATTACHMENTS_PER_MESSAGE,
        `at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message`,
      )
      .optional()
      .describe(
        `Absolute local file paths to attach for the agent to analyze (e.g. a proposal PDF, meeting transcript, or spreadsheet). Up to ${MAX_ATTACHMENTS_PER_MESSAGE} files. Allowed types: doc, docx, pdf, png, jpeg, xlsx, csv, txt. Documents up to 4.5 MB, images up to 3.75 MB. Files are uploaded to an AWS ephemeral bucket — never attach files containing secrets or credentials.`,
      ),
    catalog: CatalogSchema.optional().describe(
      "Override the default catalog for this request. Omit to use the server's configured default. Note: sessions are catalog-scoped.",
    ),
    session_id: SessionIdSchema.optional().describe(
      "Continue an existing conversation. Sessions expire 48 hours after creation. Must match the catalog the session was created in.",
    ),
    response_format: ResponseFormatSchema,
    show_activity: ShowActivitySchema,
  })
  .strict();

export type SendMessageInput = z.infer<typeof SendMessageInputSchema>;

export const GetSessionInputSchema = z
  .object({
    session_id: SessionIdSchema.describe(
      "The session identifier returned by a previous send_message call. Sessions are catalog-scoped.",
    ),
    catalog: CatalogSchema.optional().describe(
      "Catalog the session was created in. Omit to use the server's configured default.",
    ),
    response_format: ResponseFormatSchema,
  })
  .strict();

export type GetSessionInput = z.infer<typeof GetSessionInputSchema>;

export const RespondToApprovalInputSchema = z
  .object({
    session_id: SessionIdSchema.describe(
      "The session that returned status 'requires_approval'. Required.",
    ),
    tool_use_id: z
      .string()
      .min(1, "tool_use_id is required")
      .describe(
        "The toolUseId from the approval request the agent returned (status 'requires_approval').",
      ),
    decision: z
      .enum(["approve", "reject", "override"])
      .describe(
        "'approve' executes the proposed write as-is; 'reject' cancels it (use message to explain); 'override' executes with modified instructions supplied in message.",
      ),
    message: z
      .string()
      .max(10_000)
      .optional()
      .describe(
        "Required for 'override' and recommended for 'reject': the correction or reason. Ignored for 'approve'.",
      ),
    catalog: CatalogSchema.optional().describe(
      "Catalog the session belongs to. Omit to use the server's configured default.",
    ),
    response_format: ResponseFormatSchema,
    show_activity: ShowActivitySchema,
  })
  .strict();

export type RespondToApprovalInput = z.infer<typeof RespondToApprovalInputSchema>;

export const VerifyConnectionInputSchema = z
  .object({
    catalog: CatalogSchema.optional().describe(
      "Catalog to verify against. Omit to use the configured default catalog. The check is a read-only lookup of a non-existent session, so it creates nothing in any catalog.",
    ),
  })
  .strict();

export type VerifyConnectionInput = z.infer<typeof VerifyConnectionInputSchema>;

export const SelectAccountInputSchema = z
  .object({
    account_id: z
      .string()
      .regex(/^\d{12}$/, "account_id must be a 12-digit AWS account ID")
      .describe("The 12-digit AWS account ID to use, chosen from the options the extension listed."),
    role_name: z
      .string()
      .min(1, "role_name is required")
      .max(64, "role_name is too long")
      .describe(
        "The permission-set / role name to use in that account (e.g. 'PartnerCentral-Executives').",
      ),
  })
  .strict();

export type SelectAccountInput = z.infer<typeof SelectAccountInputSchema>;
