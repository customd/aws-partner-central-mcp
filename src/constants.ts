export const SERVICE_NAME = "partnercentral-agents-mcp";
export const DEFAULT_ENDPOINT = "https://partnercentral-agents-mcp.us-east-1.api.aws/mcp";
export const DEFAULT_REGION = "us-east-1";

/**
 * AWS-recommended client-identification metadata sent in the `_meta` field of
 * every tools/call request, so AWS can attribute traffic to this integration.
 * See: "Signing your calls with MCP header" (Method 1) in the AWS docs.
 */
export const INTEGRATOR = "Custom D";
export const SOURCE_PRODUCT = "AWS Partner Central Claude Extension";

/** Allowed hostname suffix for the Partner Central MCP endpoint (SSRF guard). */
export const ENDPOINT_ALLOWED_HOST_SUFFIX = ".api.aws";

export const CATALOG_AWS = "AWS";
export const CATALOG_SANDBOX = "Sandbox";

export const VALID_CATALOGS = [CATALOG_AWS, CATALOG_SANDBOX] as const;
export type Catalog = (typeof VALID_CATALOGS)[number];

export const CHARACTER_LIMIT = 100_000;

// The agent can take a while for document-heavy or multi-step operations, so
// the per-request timeout is generous. Rate limits (2 sendMessage/min) make
// long single requests the norm rather than the exception.
export const REQUEST_TIMEOUT_MS = 120_000;
export const MAX_RETRY_ATTEMPTS = 3;
export const RETRY_BASE_DELAY_MS = 1000;

export const SERVER_NAME = "aws-partner-central-mcp-server";
export const SERVER_VERSION = "1.0.2";

export const CRED_REFRESH_WINDOW_MS = 60_000;

// ---------------------------------------------------------------------------
// File attachment / document upload (see AWS "File upload" config reference)
// ---------------------------------------------------------------------------

/** AWS-managed ephemeral bucket that backs `document` content blocks. */
export const ATTACHMENT_S3_BUCKET =
  "aws-partner-central-marketplace-ephemeral-writeonly-files";

export const MAX_ATTACHMENTS_PER_MESSAGE = 3;
export const ATTACHMENT_IMAGE_SIZE_LIMIT = 3_750_000; // 3.75 MB
export const ATTACHMENT_DOC_SIZE_LIMIT = 4_500_000; // 4.5 MB

/** Allowed attachment extensions (lower-case, no leading dot). */
export const ATTACHMENT_ALLOWED_EXTENSIONS = [
  "doc",
  "docx",
  "pdf",
  "png",
  "jpeg",
  "jpg",
  "xlsx",
  "csv",
  "txt",
] as const;

/** Extensions treated as images for the (smaller) image size limit. */
export const ATTACHMENT_IMAGE_EXTENSIONS = ["png", "jpeg", "jpg"] as const;

// ---------------------------------------------------------------------------
// Documented JSON-RPC error codes (Partner Central agents MCP).
// Used for actionable error messages and the retry policy.
// ---------------------------------------------------------------------------
export const ERROR_CODE = {
  AUTHENTICATION_FAILURE: -32001,
  TOOL_PERMISSION_DENIED: -31004,
  ACCESS_DENIED: -32002,
  LIMIT_EXCEEDED: -32004,
  RESOURCE_NOT_FOUND: -30001,
  INVALID_REQUEST: -32600,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;
