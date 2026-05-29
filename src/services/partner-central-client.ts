import {
  DEFAULT_ENDPOINT,
  ERROR_CODE,
  INTEGRATOR,
  MAX_RETRY_ATTEMPTS,
  REQUEST_TIMEOUT_MS,
  RETRY_BASE_DELAY_MS,
  SERVICE_NAME,
  SOURCE_PRODUCT,
} from "../constants.js";
import { logger } from "../logger.js";
import type { AccountRoleSelection, ElicitAccountRole } from "./account-role.js";
import { uploadDocument, validateAttachmentPaths } from "./attachment-uploader.js";
import { signRequest } from "./signer.js";
import { SsoCredentialResolver } from "./sso-auth.js";
import type {
  DocumentContentBlock,
  JsonRpcRequest,
  JsonRpcResponse,
  PartnerCentralConfig,
} from "../types.js";

export interface PartnerCentralClientOptions {
  /** Picker used to resolve an ambiguous account/role (e.g. an elicitation dropdown). */
  elicit?: ElicitAccountRole;
}

export class PartnerCentralError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    public readonly httpStatus?: number,
    public readonly data?: unknown,
    public readonly isNetworkError = false,
  ) {
    super(message);
    this.name = "PartnerCentralError";
  }
}

interface SendOptions {
  signal?: AbortSignal;
}

type RetryDecision = "none" | "retry" | "reauth";

function isRetryableHttpStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

/** Sleep that rejects promptly if the caller-supplied signal aborts. */
async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw new PartnerCentralError("Request aborted during retry backoff");
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new PartnerCentralError("Request aborted during retry backoff"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class PartnerCentralClient {
  private requestId = 0;
  private readonly resolver: SsoCredentialResolver;

  constructor(
    private readonly config: PartnerCentralConfig,
    options: PartnerCentralClientOptions = {},
  ) {
    this.resolver = new SsoCredentialResolver(config.sso, options.elicit);
  }

  /** The effective account/role once resolved — for surfacing in diagnostics. */
  getResolvedIdentity(): AccountRoleSelection | null {
    return this.resolver.getResolvedIdentity();
  }

  private nextId(): number {
    this.requestId += 1;
    return this.requestId;
  }

  async callTool<T = unknown>(
    toolName: string,
    args: Record<string, unknown>,
    options: SendOptions = {},
  ): Promise<T> {
    const payload: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: this.nextId(),
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args,
        // AWS-recommended client identification (Method 1: _meta on tools/call).
        _meta: { integrator: INTEGRATOR, sourceProduct: SOURCE_PRODUCT },
      },
    };
    return this.invoke<T>(payload, options);
  }

  /**
   * Upload local files to the ephemeral S3 bucket and return `document`
   * content blocks ready to embed in a sendMessage call. Shares the single
   * credential resolver so no extra auth round-trip is incurred.
   */
  async uploadDocuments(filePaths: string[]): Promise<DocumentContentBlock[]> {
    validateAttachmentPaths(filePaths);
    // resolve() also resolves the effective account/role; uploads go under the
    // resolved account-ID prefix in the ephemeral bucket.
    const credentials = await this.resolver.resolve();
    const accountId =
      this.resolver.getResolvedIdentity()?.accountId ?? this.config.sso.accountId;
    if (!accountId) {
      throw new PartnerCentralError(
        "Could not determine the AWS account ID for the attachment upload.",
      );
    }
    const blocks: DocumentContentBlock[] = [];
    for (const filePath of filePaths) {
      blocks.push(
        await uploadDocument({
          credentials,
          region: this.config.region,
          accountId,
          filePath,
        }),
      );
    }
    return blocks;
  }

  private async invoke<T>(
    payload: JsonRpcRequest,
    options: SendOptions = {},
  ): Promise<T> {
    let lastError: unknown;
    let reauthAttempted = false;
    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt += 1) {
      if (options.signal?.aborted) {
        throw new PartnerCentralError("Request aborted before send");
      }
      try {
        return await this.invokeOnce<T>(payload, options);
      } catch (err) {
        lastError = err;
        const decision = this.classifyRetry(err, reauthAttempted);
        if (decision === "none" || attempt === MAX_RETRY_ATTEMPTS) {
          throw err;
        }
        if (decision === "reauth") {
          reauthAttempted = true;
          this.resolver.invalidate();
          logger.warn(
            "Authentication failure from Partner Central — refreshing credentials and retrying",
            { method: payload.method },
          );
        }
        // Exponential backoff with jitter: delay in [exp/2, exp].
        const exp = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        const delay = exp / 2 + Math.random() * (exp / 2);
        logger.warn(
          `Retrying Partner Central request (attempt ${attempt + 1}/${MAX_RETRY_ATTEMPTS})`,
          {
            method: payload.method,
            delayMs: Math.round(delay),
            reason: decision,
            error: (err as Error).message,
          },
        );
        await sleep(delay, options.signal);
      }
    }
    throw lastError as Error;
  }

  /**
   * Decide how to handle a failed attempt. "reauth" evicts cached credentials
   * and retries (used once for auth failures); "retry" backs off and retries;
   * "none" propagates the error.
   */
  private classifyRetry(err: unknown, reauthAttempted: boolean): RetryDecision {
    if (!(err instanceof PartnerCentralError)) return "none";
    if (err.isNetworkError) return "retry";
    // A JSON-RPC error rides on an HTTP 200 response, so its `code` is the
    // meaningful signal and must be checked BEFORE httpStatus — otherwise the
    // httpStatus===200 branch would short-circuit every code-based decision.
    if (err.code !== undefined) {
      if (err.code === ERROR_CODE.AUTHENTICATION_FAILURE) {
        return reauthAttempted ? "none" : "reauth";
      }
      if (
        err.code === ERROR_CODE.INTERNAL_ERROR ||
        err.code === ERROR_CODE.LIMIT_EXCEEDED
      ) {
        return "retry";
      }
      return "none";
    }
    if (err.httpStatus !== undefined) {
      if (err.httpStatus === 401 || err.httpStatus === 403) {
        return reauthAttempted ? "none" : "reauth";
      }
      return isRetryableHttpStatus(err.httpStatus) ? "retry" : "none";
    }
    return "none";
  }

  private async invokeOnce<T>(
    payload: JsonRpcRequest,
    options: SendOptions,
  ): Promise<T> {
    // Assign a fresh JSON-RPC id per attempt (cheap defense against any
    // upstream request de-duplication keyed on id).
    payload.id = this.nextId();

    const credentials = await this.resolver.resolve();
    const body = JSON.stringify(payload);

    const signed = await signRequest({
      url: this.config.endpoint || DEFAULT_ENDPOINT,
      method: "POST",
      body,
      service: SERVICE_NAME,
      region: this.config.region,
      credentials,
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const linkedAbort = options.signal
      ? linkAbortSignals(options.signal, controller.signal)
      : null;
    const linkedSignal = linkedAbort ? linkedAbort.signal : controller.signal;

    let text: string;
    let status: number;
    try {
      let response: Response;
      try {
        response = await fetch(signed.url, {
          method: signed.method,
          headers: signed.headers,
          body: signed.body,
          signal: linkedSignal,
        });
      } catch (err) {
        if ((err as { name?: string }).name === "AbortError") {
          throw new PartnerCentralError(
            `Request to Partner Central timed out after ${REQUEST_TIMEOUT_MS}ms`,
            undefined,
            undefined,
            undefined,
            true,
          );
        }
        throw new PartnerCentralError(
          `Network error calling Partner Central: ${(err as Error).message}`,
          undefined,
          undefined,
          undefined,
          true,
        );
      }

      status = response.status;
      // The timeout (and any caller abort) intentionally still covers the body
      // read below, so a server that sends headers then stalls the body cannot
      // hang the call indefinitely.
      try {
        text = await response.text();
      } catch (err) {
        if ((err as { name?: string }).name === "AbortError") {
          throw new PartnerCentralError(
            `Partner Central response body read timed out after ${REQUEST_TIMEOUT_MS}ms`,
            undefined,
            status,
            undefined,
            true,
          );
        }
        throw new PartnerCentralError(
          `Failed to read Partner Central response body: ${(err as Error).message}`,
          undefined,
          status,
          undefined,
          true,
        );
      }
    } finally {
      clearTimeout(timeout);
      // Detach listeners on the caller-supplied signal so a repeated request
      // with the same parent signal does not leak listeners.
      linkedAbort?.dispose();
    }

    if (status < 200 || status >= 300) {
      throw new PartnerCentralError(
        `Partner Central returned HTTP ${status}: ${truncate(text, 500)}`,
        undefined,
        status,
        text,
      );
    }

    let parsed: JsonRpcResponse<T>;
    try {
      parsed = JSON.parse(text) as JsonRpcResponse<T>;
    } catch {
      throw new PartnerCentralError(
        `Partner Central returned non-JSON response: ${truncate(text, 500)}`,
        undefined,
        status,
        text,
      );
    }

    if (parsed.error) {
      throw new PartnerCentralError(
        parsed.error.message || "Partner Central returned a JSON-RPC error",
        parsed.error.code,
        status,
        parsed.error.data,
      );
    }

    if (parsed.result === undefined) {
      throw new PartnerCentralError(
        "Partner Central returned a JSON-RPC response without a result",
      );
    }

    return parsed.result;
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `...[truncated ${text.length - max} chars]`;
}

interface LinkedAbort {
  signal: AbortSignal;
  dispose: () => void;
}

function linkAbortSignals(a: AbortSignal, b: AbortSignal): LinkedAbort {
  if (a.aborted) return { signal: a, dispose: () => {} };
  if (b.aborted) return { signal: b, dispose: () => {} };
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  a.addEventListener("abort", abort, { once: true });
  b.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      a.removeEventListener("abort", abort);
      b.removeEventListener("abort", abort);
    },
  };
}
