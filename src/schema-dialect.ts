import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/**
 * Strip the `$schema` dialect declaration from the tool schemas we advertise.
 *
 * WHY (hard-won — a total outage, see CLAUDE.md gotcha #15): we use Zod v3, so the
 * SDK's `toJsonSchemaCompat` takes its v3 branch and calls `zodToJsonSchema` with no
 * `target`, which defaults to draft-07 and stamps
 * `"$schema": "http://json-schema.org/draft-07/schema#"` onto EVERY inputSchema and
 * outputSchema. Hosts that validate tool schemas with an Ajv 2020-12 instance reject
 * that dialect outright and refuse to call the tool at all:
 *
 *   Tool 'partner_central_verify_connection' has an invalid outputSchema:
 *   JSON Schema declares an unsupported dialect ("$schema": draft-07).
 *
 * That fails BEFORE the handler runs, so it takes out all 5 tools at once. Upgrading
 * the SDK does not help: it hardcodes draft-7 on the Zod v4 path too.
 *
 * We OMIT `$schema` rather than declaring 2020-12, because omitting it lets each host
 * apply its own default dialect. Our schemas only use keywords whose meaning is
 * identical in draft-07 and 2020-12 (type, properties, required, enum, default,
 * description, minLength, maxLength, pattern, items, maxItems, additionalProperties),
 * so they validate correctly under either. Declaring 2020-12 instead would break the
 * mirror-image host that only understands draft-07.
 *
 * Applied at the transport boundary so it covers every response the SDK generates,
 * now and after any SDK upgrade, without reaching into SDK internals.
 */

/** JSON-Schema-ish object we may need to clean. */
type SchemaLike = Record<string, unknown>;

function withoutDialect(schema: unknown): unknown {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return schema;
  }
  const { $schema: _dialect, ...rest } = schema as SchemaLike;
  return rest;
}

/**
 * Return a copy of an outgoing JSON-RPC message with `$schema` removed from each
 * advertised tool's input/output schema. Any other message is returned untouched.
 */
export function stripSchemaDialect<T>(message: T): T {
  const msg = message as unknown as { result?: { tools?: unknown } } | null;
  if (msg === null || typeof msg !== "object") return message;
  const tools = msg.result?.tools;
  if (!Array.isArray(tools)) return message;

  const cleaned = tools.map((tool) => {
    if (tool === null || typeof tool !== "object") return tool;
    const t = tool as SchemaLike;
    const next: SchemaLike = { ...t };
    if (t.inputSchema !== undefined) next.inputSchema = withoutDialect(t.inputSchema);
    if (t.outputSchema !== undefined) next.outputSchema = withoutDialect(t.outputSchema);
    return next;
  });

  return {
    ...(message as object),
    result: { ...(msg.result as object), tools: cleaned },
  } as T;
}

/**
 * Wrap a transport so every outgoing message passes through stripSchemaDialect.
 * Returns the same transport instance (its `send` is replaced), so it can be handed
 * straight to `server.connect()`.
 */
export function withCompatibleSchemaDialect<T extends Transport>(transport: T): T {
  const originalSend = transport.send.bind(transport);
  transport.send = (message, options) => originalSend(stripSchemaDialect(message), options);
  return transport;
}
