import { SignatureV4 } from "@smithy/signature-v4";
import { HttpRequest } from "@smithy/protocol-http";
import { Sha256 } from "@aws-crypto/sha256-js";

import type { AwsCredentials } from "../types.js";

export interface SignedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export interface SignParams {
  url: string;
  method: "POST" | "GET";
  body?: string;
  service: string;
  region: string;
  credentials: AwsCredentials;
  extraHeaders?: Record<string, string>;
}

export async function signRequest(params: SignParams): Promise<SignedRequest> {
  const url = new URL(params.url);
  const port = url.port ? parseInt(url.port, 10) : undefined;

  const baseHeaders: Record<string, string> = {
    host: url.host,
    "content-type": "application/json",
    accept: "application/json",
    ...(params.extraHeaders ?? {}),
  };

  const request = new HttpRequest({
    method: params.method,
    protocol: url.protocol,
    hostname: url.hostname,
    ...(port !== undefined ? { port } : {}),
    path: url.pathname + url.search,
    headers: baseHeaders,
    body: params.body,
  });

  const signer = new SignatureV4({
    service: params.service,
    region: params.region,
    credentials: {
      accessKeyId: params.credentials.accessKeyId,
      secretAccessKey: params.credentials.secretAccessKey,
      sessionToken: params.credentials.sessionToken,
    },
    sha256: Sha256,
  });

  const signed = await signer.sign(request);

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(signed.headers)) {
    if (typeof value === "string") headers[key] = value;
  }

  return {
    url: params.url,
    method: signed.method,
    headers,
    body: typeof signed.body === "string" ? signed.body : (params.body ?? ""),
  };
}
