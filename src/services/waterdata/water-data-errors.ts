/**
 * @fileoverview Error classification for the USGS Water Data APIs (the OGC collections and the
 * Statistics API). One choke point turns an HTTP failure into a typed error by reading the
 * upstream's own error body; another maps a typed error onto the failure reasons the tools declare.
 * @module services/waterdata/water-data-errors
 */

import { z } from '@cyanheads/mcp-ts-core';
import {
  configurationError,
  JsonRpcErrorCode,
  McpError,
  rateLimited,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';

/** The two hosts behind `api.waterdata.usgs.gov`, each with its own anonymous rate limit. */
export type WaterDataHost = 'ogc' | 'statistics';

/** Name used in every message this module writes. */
export const SERVICE_NAME: Record<WaterDataHost, string> = {
  ogc: 'USGS Water Data OGC API',
  statistics: 'USGS Water Data Statistics API',
};

/** A failure mapped onto the reason vocabulary every network-calling tool declares. */
export interface WaterDataFailure {
  /**
   * Deadline and retry diagnostics for a timeout; `retryable: false` for a deterministic upstream
   * fault, which overrides the `retryable: true` the tools declare for `upstream_error`.
   */
  data?: McpError['data'];
  /** The message to report — for `invalid_request`, the upstream's own description. */
  message: string;
  reason: 'invalid_request' | 'upstream_error' | 'upstream_timeout';
}

/**
 * Map an error raised by the Water Data client onto the reason its calling tool declares.
 * `Timeout` keeps its deadline and retry data; `ValidationError` is a request the upstream
 * rejected (its description is in the message); `ServiceUnavailable` is an upstream fault or an
 * unreadable response, keeping `retryable: false` when the fault is deterministic — an unreadable
 * or misshapen 200 body, a bad continuation, a 404 or other non-retryable 4xx, a 501. Returns null
 * for everything else — rate limits (`RateLimited`, carrying `retryAfter`), a rejected or missing
 * `USGS_API_KEY` (`ConfigurationError`), caller cancellation, and unclassified throws — which
 * callers rethrow unchanged.
 */
export function classifyWaterDataFailure(err: unknown): WaterDataFailure | null {
  if (!(err instanceof McpError)) return null;
  if (err.code === JsonRpcErrorCode.Timeout) {
    return { reason: 'upstream_timeout', message: err.message, data: err.data };
  }
  if (err.code === JsonRpcErrorCode.ValidationError) {
    return { reason: 'invalid_request', message: err.message };
  }
  if (err.code === JsonRpcErrorCode.ServiceUnavailable) {
    return {
      reason: 'upstream_error',
      message: err.message,
      ...(err.data?.retryable === false ? { data: { retryable: false } } : {}),
    };
  }
  return null;
}

/** What the upstream said about a failure, from whichever body shape it sent. */
interface UpstreamReason {
  code?: string;
  message?: string;
}

/**
 * The error bodies the hosts send. The api.data.gov gateway in front of both answers rate-limit
 * and key failures as `{ error: { code, message } }`; the OGC collections answer a bad request as
 * `{ code, description }`; FastAPI validation (Statistics, 422) answers `{ detail }`. The Statistics
 * API otherwise writes text/plain such as `400 - Bad request`.
 */
const ErrorBodySchema = z.union([
  z.object({ error: z.object({ code: z.string(), message: z.string().optional() }) }),
  z.object({ code: z.string(), description: z.string().optional() }),
  z.object({
    detail: z.union([
      z.string(),
      z.array(
        z.object({
          loc: z.array(z.union([z.string(), z.number()])).optional(),
          msg: z.string(),
        }),
      ),
    ]),
  }),
]);

/** Read the upstream's stated reason from a captured error body; HTML pages say nothing usable. */
function readUpstreamReason(body: unknown): UpstreamReason {
  if (typeof body !== 'string') return {};
  const text = body.trim();
  if (text === '' || text.startsWith('<')) return {};
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // text/plain — the Statistics API prefixes its status: "400 - Bad request".
    const prefixed = /^\d{3} - /.test(text.slice(0, 6));
    return { message: prefixed ? text.slice(6) : text };
  }
  const parsed = ErrorBodySchema.safeParse(json);
  if (!parsed.success) return {};
  const value = parsed.data;
  if ('error' in value) {
    return {
      code: value.error.code,
      ...(value.error.message ? { message: value.error.message } : {}),
    };
  }
  if ('code' in value) {
    return { code: value.code, ...(value.description ? { message: value.description } : {}) };
  }
  const detail =
    typeof value.detail === 'string'
      ? value.detail
      : value.detail
          .map((issue) => {
            const field = issue.loc?.filter((part) => part !== 'query').join('.');
            return field ? `${field}: ${issue.msg}` : issue.msg;
          })
          .join('; ');
  return { message: detail };
}

/** Whole seconds from a `Retry-After` value; an HTTP-date is passed through as written. */
function readRetryAfter(value: unknown): number | string | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.ceil(value);
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const seconds = Number(value.trim());
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : value.trim();
}

/** The status a `fetchWithTimeout` failure carries, when it reached an HTTP response. */
function responseStatus(error: McpError): number | undefined {
  const status = error.data?.status;
  return typeof status === 'number' ? status : undefined;
}

/** How to recover from a rate limit, depending on whether this server already sends a key. */
function rateLimitHint(keyConfigured: boolean): string {
  return keyConfigured
    ? 'Wait the retryAfter interval before calling again. This server already sends its USGS_API_KEY; the limit belongs to that key.'
    : 'Wait the retryAfter interval before calling again. The server operator can raise the limit by setting USGS_API_KEY to a free key from https://api.waterdata.usgs.gov/signup/.';
}

/** A 429, rebuilt with the wait and limit the upstream stated. `retryAfter` is copied, never dropped. */
function rateLimitError(
  error: McpError,
  host: WaterDataHost,
  upstream: UpstreamReason,
  keyConfigured: boolean,
): McpError {
  const retryAfter = readRetryAfter(error.data?.retryAfter);
  const headers = error.data?.headers as Record<string, unknown> | undefined;
  const limit = Number(headers?.['x-ratelimit-limit']);
  const limitText = Number.isInteger(limit)
    ? ` The limit is ${limit} requests per hour ${keyConfigured ? "for this server's USGS_API_KEY" : 'per IP address without an API key'}.`
    : '';
  const waitText = retryAfter === undefined ? '' : ` Retry after ${retryAfter} s.`;
  return rateLimited(
    `${SERVICE_NAME[host]} rate limit reached (${upstream.code ?? 'HTTP 429'}).${limitText}${waitText}`,
    {
      reason: 'rate_limited',
      ...(retryAfter === undefined ? {} : { retryAfter }),
      ...(upstream.code ? { upstreamCode: upstream.code } : {}),
      ...(Number.isInteger(limit) ? { rateLimitPerHour: limit } : {}),
      recovery: { hint: rateLimitHint(keyConfigured) },
    },
    { cause: error },
  );
}

/**
 * The error a paused host reports while its cooldown gate is closed after a 429 — the same shape
 * as the 429 itself, so a caller sees one rate-limit error whichever request drew it.
 */
export function pausedHostError(
  host: WaterDataHost,
  retryAfter: number,
  keyConfigured: boolean,
  cause: unknown,
): McpError {
  return rateLimited(
    `${SERVICE_NAME[host]} rate limit reached: requests are paused for ${retryAfter} s after an HTTP 429.`,
    {
      reason: 'rate_limited',
      retryAfter,
      recovery: { hint: rateLimitHint(keyConfigured) },
    },
    { cause },
  );
}

/**
 * Turn a `fetchWithTimeout` HTTP failure into the error this server reports, reading the
 * upstream's error body (which the framework keeps server-side). Runs inside the retry closure, so
 * the codes it picks decide what is retried: a 429 stays `RateLimited` with `retryAfter` (retried
 * only when the wait fits the deadline); a rejected key, a rejected request, and any other 4xx
 * fail at once, as does a 501; other 5xx and gateway timeouts are left transient. Errors without an HTTP status —
 * network faults, timeouts, cancellation — pass through unchanged.
 */
export function toWaterDataError(
  error: unknown,
  host: WaterDataHost,
  keyConfigured: boolean,
): unknown {
  if (!(error instanceof McpError)) return error;
  const status = responseStatus(error);
  if (status === undefined) return error;
  const service = SERVICE_NAME[host];
  const upstream = readUpstreamReason(error.data?.body);
  const upstreamCode = upstream.code ? { upstreamCode: upstream.code } : {};
  if (status === 429) return rateLimitError(error, host, upstream, keyConfigured);
  if (upstream.code?.startsWith('API_KEY_')) {
    return configurationError(
      keyConfigured
        ? `${service} rejected the configured USGS_API_KEY (${upstream.code}).`
        : `${service} refused a request sent without an API key (${upstream.code}).`,
      {
        reason: 'api_key_rejected',
        ...upstreamCode,
        recovery: {
          hint: keyConfigured
            ? 'The server operator must replace USGS_API_KEY with a valid key from https://api.waterdata.usgs.gov/signup/, or unset it to send requests without a key.'
            : 'The server operator must set USGS_API_KEY to a valid api.data.gov key, free from https://api.waterdata.usgs.gov/signup/.',
        },
      },
      { cause: error },
    );
  }
  if (status === 400 || status === 422) {
    return validationError(
      `${service} rejected the request: ${upstream.message ?? `HTTP ${status}`}`,
      { reason: 'invalid_request', upstreamStatus: status, ...upstreamCode },
      { cause: error },
    );
  }
  if (error.code === JsonRpcErrorCode.Timeout) return error;
  const detail = upstream.message ? `: ${upstream.message}` : '.';
  if (status >= 500) {
    return serviceUnavailable(
      `${service} answered HTTP ${status}${detail}`,
      {
        reason: 'upstream_error',
        upstreamStatus: status,
        ...(error.data?.retryAfter === undefined ? {} : { retryAfter: error.data.retryAfter }),
        // A 501 is the one 5xx the framework marks deterministic; it keeps that mark.
        ...(error.data?.retryable === false ? { retryable: false } : {}),
      },
      { cause: error },
    );
  }
  return serviceUnavailable(
    `${service} answered HTTP ${status}${detail}`,
    { reason: 'upstream_error', upstreamStatus: status, retryable: false, ...upstreamCode },
    { cause: error },
  );
}
