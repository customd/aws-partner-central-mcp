export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: Date;
}

export interface SsoConfig {
  startUrl: string;
  accountId: string;
  roleName: string;
  region: string;
}

export interface PartnerCentralConfig {
  endpoint: string;
  region: string;
  defaultCatalog: string;
  sso: SsoConfig;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: number | string;
  result?: T;
  error?: JsonRpcError;
}

/**
 * The raw `result` field of a JSON-RPC tools/call response from the AWS
 * Partner Central endpoint. It is shaped as a standard MCP tool result:
 * a `content` array whose first item is a text block containing a
 * JSON-stringified agent payload. See response-parser.ts for unwrapping.
 */
export interface McpToolResultEnvelope {
  content: Array<{
    type: string;
    text?: string;
    [key: string]: unknown;
  }>;
  isError?: boolean;
}

/**
 * A `document` content block referencing a file uploaded to the ephemeral
 * S3 bucket. This is the exact shape the AWS endpoint expects (see the
 * Tools Reference "File attachment" example).
 */
export interface DocumentContentBlock {
  type: "document";
  filename: string;
  s3Uri: string;
}

export interface TextContentBlock {
  type: "text";
  text: string;
}

export interface ToolApprovalResponseBlock {
  type: "tool_approval_response";
  toolUseId: string;
  decision: "approve" | "reject" | "override";
  message?: string;
}

export type ContentBlock =
  | TextContentBlock
  | DocumentContentBlock
  | ToolApprovalResponseBlock;

/**
 * A pending write operation the agent wants the user to approve, surfaced when
 * a sendMessage response has status "requires_approval". Extracted from
 * `tool_approval_request` content blocks.
 */
export interface ApprovalRequest {
  toolUseId: string;
  toolName?: string;
  parameters?: Record<string, unknown>;
}

/**
 * One step in the agent's internal activity trace — an internal tool
 * invocation ("serverToolUse", incl. the agent's "thinking" steps) or its
 * result ("serverToolResult"). Surfaced as an expandable trace so users can
 * see how the agent reached its answer.
 */
export interface AgentActivityStep {
  kind: "tool_use" | "tool_result";
  name?: string;
  /** displayToolActivity label for a tool_use, e.g. "analyzing pipeline". */
  activity?: string;
  /** status for a tool_result, e.g. "success". */
  status?: string;
  /** Truncated input (tool_use) or output (tool_result) for context. */
  detail?: string;
}

/**
 * A normalized, ready-to-render view of an agent response, produced by
 * response-parser.ts after unwrapping the MCP envelope and parsing the
 * inner JSON. Tool handlers consume this shape — not the raw envelope.
 */
export interface NormalizedAgentResponse {
  sessionId?: string;
  status?: string;
  /** Best-effort human-readable rendering of the agent's reply. */
  text: string;
  /** Session-transcript events when the underlying call was getSession. */
  events?: SessionEvent[];
  /** Ordered trace of the agent's internal tool/thinking steps. */
  activity?: AgentActivityStep[];
  /**
   * Pending write operations awaiting approval (status "requires_approval").
   * Empty/undefined when no approval is needed.
   */
  approvalRequests?: ApprovalRequest[];
  /** True if the upstream tool result was flagged isError. */
  isError: boolean;
  /** The raw parsed inner payload, for response_format='json' rendering. */
  raw: unknown;
}

export interface SessionEvent {
  session_id?: string;
  agent_id?: string | null;
  timestamp?: string;
  message_id?: string;
  data?: Record<string, unknown>;
}
