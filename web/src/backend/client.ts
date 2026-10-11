// Talks to the MemoryAnchor backend over the same contract Anki Desktop uses
// between its webview and rslib: POST /_anki/<method> with a protobuf body and
// Content-Type: application/binary.
//
// The page is served by the backend itself, so requests are origin-relative and
// no CORS is involved. The bearer token is injected into the webview by the
// native shell — it is deliberately not baked into the served HTML, because the
// loopback port is reachable by any other app on the device.

import { fromBinary, toBinary, type DescMessage, type MessageShape } from "@bufbuild/protobuf";
import { BackendErrorSchema, BackendError_Kind } from "../gen/anki/backend_pb.js";

declare global {
  interface Window {
    __MEMORYANCHOR__?: {
      token?: string;
      baseUrl?: string;
      /** Absolute directory the shell reserved for collection files. */
      dataDir?: string;
    };
  }
}

export class BackendError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    /** Anki's error category, when the failure came from rslib. */
    readonly kind?: BackendError_Kind,
  ) {
    super(body || `backend returned ${status}`);
    this.name = "BackendError";
  }

  /** True when retrying later might succeed. */
  get isTransient(): boolean {
    return (
      this.kind === BackendError_Kind.NETWORK_ERROR ||
      this.kind === BackendError_Kind.SYNC_OTHER_ERROR
    );
  }
}

/**
 * rslib reports failures as a protobuf BackendError carrying a localised,
 * user-facing message. Read it rather than showing the raw bytes.
 */
async function errorFrom(response: Response): Promise<BackendError> {
  const buffer = await response.arrayBuffer().catch(() => null);
  if (buffer) {
    try {
      const decoded = fromBinary(BackendErrorSchema, new Uint8Array(buffer));
      if (decoded.message) {
        return new BackendError(response.status, decoded.message, decoded.kind);
      }
    } catch {
      // Not a BackendError - fall through to treating the body as text.
    }
    const text = new TextDecoder().decode(buffer).trim();
    if (text) {
      return new BackendError(response.status, text);
    }
  }
  return new BackendError(response.status, `backend returned ${response.status}`);
}

/// Thrown when the shell did not inject credentials — i.e. the page is open
/// somewhere other than the app's webview.
export class NotConfiguredError extends Error {
  constructor() {
    super("no backend token; this page must be opened by the MemoryAnchor shell");
    this.name = "NotConfiguredError";
  }
}

export function config(): { token: string; baseUrl: string } {
  const injected = window.__MEMORYANCHOR__;
  if (!injected?.token) {
    throw new NotConfiguredError();
  }
  return { token: injected.token, baseUrl: injected.baseUrl ?? "" };
}

export function isConfigured(): boolean {
  return Boolean(window.__MEMORYANCHOR__?.token);
}

/// Absolute path the shell reserved for collection files. rslib resolves
/// relative paths against the process working directory, which is not
/// meaningful on iOS, so the shell must supply this.
export function dataDir(): string {
  const dir = window.__MEMORYANCHOR__?.dataDir;
  if (!dir) {
    throw new NotConfiguredError();
  }
  return dir;
}

/** Calls one backend method, encoding the request and decoding the response. */
export async function call<Req extends DescMessage, Resp extends DescMessage>(
  method: string,
  requestSchema: Req,
  request: MessageShape<Req>,
  responseSchema: Resp,
  signal?: AbortSignal,
): Promise<MessageShape<Resp>> {
  const { token, baseUrl } = config();
  const response = await fetch(`${baseUrl}/_anki/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/binary",
      Authorization: `Bearer ${token}`,
    },
    body: toBinary(requestSchema, request) as BodyInit,
    signal,
  });

  if (!response.ok) {
    throw await errorFrom(response);
  }
  return fromBinary(responseSchema, new Uint8Array(await response.arrayBuffer()));
}

export interface Health {
  ok: boolean;
  anki: string;
  memoryanchor: string;
}

/** Liveness plus which rslib build is linked into the app. */
export async function health(signal?: AbortSignal): Promise<Health> {
  const { token, baseUrl } = config();
  const response = await fetch(`${baseUrl}/_anki/healthz`, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  if (!response.ok) {
    throw await errorFrom(response);
  }
  return (await response.json()) as Health;
}
