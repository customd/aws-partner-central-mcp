export const SERVICE_NAME = "partnercentral-agents-mcp";
export const DEFAULT_ENDPOINT = "https://partnercentral-agents-mcp.us-east-1.api.aws/mcp";
/**
 * Region of the Partner Central endpoint — the region requests are SIGNED for.
 * Partner Central is us-east-1 only, and this must always match the endpoint host
 * (see regionFromEndpoint in config.ts), never the user's SSO region.
 */
export const DEFAULT_REGION = "us-east-1";

/**
 * Default region of the user's IAM Identity Center instance. This is INDEPENDENT of
 * DEFAULT_REGION: an Identity Center directory can live in any region (e.g.
 * eu-central-1) while Partner Central itself stays us-east-1 — the two must not be
 * conflated. Overridden by AWS_SSO_REGION / the `sso_region` install setting.
 */
export const DEFAULT_SSO_REGION = "us-east-1";

/**
 * Base URL for deep-linking to an opportunity in the AWS Partner Central
 * console. Partner Central is us-east-1 only (the Selling API has no other
 * region), so the console host is pinned to us-east-1 and NO `region=` query
 * param is needed — the opportunity resolves by its `O…` ID alone. Final link:
 * `${BASE}/<opportunityId>`.
 */
export const PARTNER_CENTRAL_CONSOLE_OPPORTUNITY_BASE =
  "https://us-east-1.console.aws.amazon.com/partnercentral/opportunities";

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

/**
 * Hard cap on the COMBINED size (rendered text + serialized structuredContent) of
 * a single tool result, as a conservative proxy for the MCP client's tool-result
 * token cap (~25k tokens in Claude Desktop / co-work). Above this the client
 * rejects the result ("exceeds maximum allowed tokens") and shunts it to a temp
 * file the sandboxed agent often can't read — so we must trim BEFORE returning.
 * 40k chars ≈ <25k tokens even for dense JSON. `format.ts` enforces it by capping
 * events and truncating text while always preserving status/approval_requests.
 */
export const CHARACTER_LIMIT = 40_000;

/** Max conversation events mirrored into structuredContent (get_session can have hundreds). */
export const MAX_STRUCTURED_EVENTS = 20;

// The agent can take a while for document-heavy or multi-step operations, so
// the per-request timeout is generous. Rate limits (2 sendMessage/min) make
// long single requests the norm rather than the exception.
export const REQUEST_TIMEOUT_MS = 120_000;
export const MAX_RETRY_ATTEMPTS = 3;
export const RETRY_BASE_DELAY_MS = 1000;

// Throttling needs a much deeper backoff than transient errors: sendMessage is
// limited to ~2/min, so the token bucket refills only ~every 30s. A short retry
// (≈1-3s) can never clear it, so throttle retries climb toward the refill window.
// Observed live recovery in bulk runs was ~20-30s. (See the HTTP 400 "Rate
// exceeded" throttle gotcha — the live shape differs from the documented -32004.)
export const THROTTLE_BASE_DELAY_MS = 8_000;
export const THROTTLE_MAX_DELAY_MS = 20_000;

export const SERVER_NAME = "aws-partner-central-mcp-server";
export const SERVER_VERSION = "1.0.11";

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
