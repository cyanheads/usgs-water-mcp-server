/**
 * @fileoverview Request core for the USGS Water Data APIs: the OGC collections and the Statistics
 * API on `api.waterdata.usgs.gov`. Every request carries the server's User-Agent and, when
 * `USGS_API_KEY` is set, an `X-Api-Key` header; runs under the calling tool's one deadline with
 * retries; reads and validates its JSON body inside the retry closure (an unreadable complete body
 * fails at once, never re-sent); and pages through OGC `next` links and Statistics `next` tokens.
 * A 429 from either host closes that host's process-wide cooldown gate until its `Retry-After`.
 * @module services/waterdata/water-data-client
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import {
  JsonRpcErrorCode,
  McpError,
  serviceUnavailable,
  timeout,
} from '@cyanheads/mcp-ts-core/errors';
import { createPacer, fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { type RequestDeadline, startDeadline } from './request-deadline.js';
import {
  pausedHostError,
  SERVICE_NAME,
  toWaterDataError,
  type WaterDataHost,
} from './water-data-errors.js';

/** Base of every OGC collection: `${OGC_COLLECTIONS_URL}/<collection>/items`. */
const OGC_COLLECTIONS_URL = 'https://api.waterdata.usgs.gov/ogcapi/v1/collections';

/** Base of the Statistics API endpoints (`observationNormals`, `observationIntervals`). */
const STATISTICS_URL = 'https://api.waterdata.usgs.gov/statistics/v0';

/** The Statistics API endpoints this server reads. */
export type StatisticsEndpoint = 'observationIntervals' | 'observationNormals';

/** How one tool call's requests run. */
export interface WaterDataRequest {
  ctx: Context;
  /** The call's one budget, shared by every request it makes. */
  deadline: RequestDeadline;
  /** Label for retry logs and the `operation` on timeout data. */
  operation: string;
  /**
   * Cancellation for these requests: the caller's `ctx.signal`, or undefined for a load shared
   * between callers, which one caller's cancellation must not fail.
   */
  signal: AbortSignal | undefined;
}

/** One page of an OGC collection and the validated continuation, if any. */
export interface OgcPage<T> {
  features: T[];
  /** The upstream's `next` link, checked to stay on the same collection; null on the last page. */
  nextUrl: URL | null;
}

/** A tool call's requests: its cancellation signal and one fresh budget. */
export function startRequest(ctx: Context, operation: string): WaterDataRequest {
  return { ctx, deadline: startDeadline(), operation, signal: ctx.signal };
}

/**
 * Run one call's work on a request whose signal also fires when the work fails, so a failure in
 * one of its parallel requests or page walks stops the rest instead of leaving them running.
 */
export async function failFast<T>(
  request: WaterDataRequest,
  work: (request: WaterDataRequest) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const signal = request.signal
    ? AbortSignal.any([request.signal, controller.signal])
    : controller.signal;
  try {
    return await work({ ...request, signal });
  } catch (error) {
    controller.abort();
    throw error;
  }
}

/** Bytes of a non-2xx body kept for the classifier — whole JSON error bodies run ~200–400 bytes. */
const ERROR_BODY_LIMIT_BYTES = 4_096;

/** Retries per request inside the deadline, with backoff from 500 ms. */
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;

/**
 * One cooldown gate per host. A 429 closes it until the upstream's `Retry-After` (capped at the
 * hour the anonymous quota is counted over), so later requests wait — or fail fast when the gate
 * outlasts their deadline — instead of each drawing its own 429.
 */
const pacers = {
  ogc: createPacer({ name: 'usgs-water-ogc', cooldown: { baseMs: 1_000, maxMs: 3_600_000 } }),
  statistics: createPacer({
    name: 'usgs-water-statistics',
    cooldown: { baseMs: 1_000, maxMs: 3_600_000 },
  }),
} satisfies Record<WaterDataHost, unknown>;

const LinksSchema = z.array(z.object({ rel: z.string(), href: z.string() })).optional();

/** The call's budget ran out — before a request could start, or during the retry ladder. */
function deadlineExceeded(request: WaterDataRequest, retryAttempts: number, cause?: unknown) {
  const { deadline, operation } = request;
  const when =
    retryAttempts === 0
      ? 'before its request could start'
      : `after ${retryAttempts} attempt${retryAttempts === 1 ? '' : 's'}`;
  return timeout(
    `${operation} ran out of the ${deadline.budgetMs} ms budget for this call ${when}.`,
    {
      reason: 'retry_deadline_exceeded',
      deadlineMs: deadline.budgetMs,
      elapsedMs: deadline.elapsedMs(),
      retryAttempts,
      operation,
    },
    cause === undefined ? undefined : { cause },
  );
}

function isRetryDeadline(error: unknown): error is McpError {
  return (
    error instanceof McpError &&
    error.code === JsonRpcErrorCode.Timeout &&
    error.data?.reason === 'retry_deadline_exceeded'
  );
}

function isPacerShed(error: unknown): error is McpError {
  return (
    error instanceof McpError &&
    error.code === JsonRpcErrorCode.RateLimited &&
    error.data?.reason === 'pacer_shed'
  );
}

/** First Zod issue as `path: message` — enough to say which field broke. */
function issueSummary(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'unexpected shape';
  const path = issue.path.join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

/** Parse a fully read 200 body. Both failures are deterministic, so neither is retried. */
function parseBody<S extends z.ZodType>(
  text: string,
  schema: S,
  host: WaterDataHost,
  operation: string,
): z.infer<S> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    throw serviceUnavailable(
      `${SERVICE_NAME[host]} sent a response that is not JSON (${operation}).`,
      { reason: 'upstream_error', retryable: false, bodyLength: text.length },
      { cause },
    );
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw serviceUnavailable(
      `${SERVICE_NAME[host]} sent an unexpected response (${operation}): ${issueSummary(parsed.error)}.`,
      { reason: 'upstream_error', retryable: false },
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

/**
 * Send one GET within the call's deadline — paced per host, retried on transient failures,
 * classified at the HTTP boundary, and parsed against `schema` — and return the parsed body.
 */
async function requestJson<S extends z.ZodType>(
  host: WaterDataHost,
  url: URL,
  schema: S,
  request: WaterDataRequest,
): Promise<z.infer<S>> {
  const { ctx, deadline, operation, signal } = request;
  if (deadline.remainingMs() <= 0) throw deadlineExceeded(request, 0);
  const cfg = getServerConfig();
  const keyConfigured = cfg.apiKey !== undefined;
  const headers: Record<string, string> = {
    'User-Agent': cfg.userAgent,
    Accept: 'application/json',
    ...(cfg.apiKey === undefined ? {} : { 'X-Api-Key': cfg.apiKey }),
  };

  const send = async (attemptSignal: AbortSignal): Promise<z.infer<S>> => {
    let response: Response;
    try {
      response = await fetchWithTimeout(
        url.href,
        Math.min(cfg.requestTimeoutMs, deadline.remainingMs()),
        ctx,
        {
          headers,
          signal: attemptSignal,
          expectedStatuses: [400, 404, 422, 429],
          errorBodyLimit: ERROR_BODY_LIMIT_BYTES,
          errorHeaders: ['x-ratelimit-limit'],
        },
      );
    } catch (error) {
      throw toWaterDataError(error, host, keyConfigured);
    }
    return parseBody(await response.text(), schema, host, operation);
  };

  try {
    return await withRetry(
      async (attempt) => {
        try {
          return await pacers[host].run(() => send(attempt.signal), {
            signal: attempt.signal,
            maxWaitMs: deadline.remainingMs(),
          });
        } catch (error) {
          if (!isPacerShed(error)) throw error;
          const retryAfter = Number(error.data?.retryAfter);
          throw pausedHostError(host, retryAfter, keyConfigured, error);
        }
      },
      {
        operation,
        context: ctx,
        ...(signal === undefined ? {} : { signal }),
        deadlineMs: deadline.remainingMs(),
        maxRetries: MAX_RETRIES,
        baseDelayMs: BASE_DELAY_MS,
      },
    );
  } catch (error) {
    if (isRetryDeadline(error)) {
      throw deadlineExceeded(request, Number(error.data?.retryAttempts ?? 1), error);
    }
    throw error;
  }
}

/** The items URL of one collection, always asking for JSON. */
export function ogcItemsUrl(collection: string, query: URLSearchParams): URL {
  const url = new URL(`${OGC_COLLECTIONS_URL}/${encodeURIComponent(collection)}/items`);
  for (const [key, value] of query) url.searchParams.append(key, value);
  url.searchParams.set('f', 'json');
  return url;
}

/**
 * Read one OGC page at `url` (an {@link ogcItemsUrl} or a prior page's `nextUrl`). A `next` link
 * must stay on the same collection, and a page that carries one must carry features — anything
 * else is an upstream fault, never followed.
 */
export async function fetchOgcPage<F extends z.ZodType>(
  collection: string,
  url: URL,
  featureSchema: F,
  request: WaterDataRequest,
): Promise<OgcPage<z.infer<F>>> {
  const page = await requestJson(
    'ogc',
    url,
    z.object({ features: z.array(featureSchema), links: LinksSchema }),
    request,
  );
  const next = page.links?.find((link) => link.rel === 'next');
  if (!next) return { features: page.features, nextUrl: null };
  const expected = ogcItemsUrl(collection, new URLSearchParams());
  let nextUrl: URL;
  try {
    nextUrl = new URL(next.href);
  } catch (cause) {
    throw serviceUnavailable(
      `${SERVICE_NAME.ogc} sent an unreadable continuation (${request.operation}).`,
      { reason: 'upstream_error', retryable: false },
      { cause },
    );
  }
  if (nextUrl.origin !== expected.origin || nextUrl.pathname !== expected.pathname) {
    throw serviceUnavailable(
      `${SERVICE_NAME.ogc} sent a continuation outside the ${collection} collection (${request.operation}).`,
      { reason: 'upstream_error', retryable: false },
    );
  }
  if (page.features.length === 0) {
    throw serviceUnavailable(
      `${SERVICE_NAME.ogc} sent an empty page that still has a continuation (${request.operation}).`,
      { reason: 'upstream_error', retryable: false },
    );
  }
  return { features: page.features, nextUrl };
}

/**
 * Every feature of an OGC query, following `next` links to the last page. Each page draws on the
 * call's deadline; the deadline, not a page count, bounds the walk.
 */
export async function fetchOgcItems<F extends z.ZodType>(
  collection: string,
  query: URLSearchParams,
  featureSchema: F,
  request: WaterDataRequest,
): Promise<z.infer<F>[]> {
  const features: z.infer<F>[] = [];
  const visited = new Set<string>();
  let url: URL | null = ogcItemsUrl(collection, query);
  while (url) {
    visited.add(url.href);
    const page: OgcPage<z.infer<F>> = await fetchOgcPage(collection, url, featureSchema, request);
    features.push(...page.features);
    if (page.nextUrl && visited.has(page.nextUrl.href)) {
      throw serviceUnavailable(
        `${SERVICE_NAME.ogc} sent a continuation back to a page already read (${request.operation}).`,
        { reason: 'upstream_error', retryable: false },
      );
    }
    url = page.nextUrl;
  }
  return features;
}

/**
 * Every feature of a Statistics API query, passing each page's `next` token back as
 * `next_token` until a page carries none. Multi-value parameters go in `query` as repeated pairs.
 * The API takes no `f` parameter (it rejects one with HTTP 400) and `MM-DD` dates only.
 */
export async function fetchStatistics<F extends z.ZodType>(
  endpoint: StatisticsEndpoint,
  query: URLSearchParams,
  featureSchema: F,
  request: WaterDataRequest,
): Promise<z.infer<F>[]> {
  const schema = z.object({ features: z.array(featureSchema), next: z.string().nullish() });
  const features: z.infer<F>[] = [];
  const tokens = new Set<string>();
  let token: string | undefined;
  do {
    const url = new URL(`${STATISTICS_URL}/${endpoint}`);
    for (const [key, value] of query) url.searchParams.append(key, value);
    if (token) url.searchParams.set('next_token', token);
    const page: z.infer<typeof schema> = await requestJson('statistics', url, schema, request);
    features.push(...page.features);
    token = page.next ?? undefined;
    if (token && (tokens.has(token) || page.features.length === 0)) {
      throw serviceUnavailable(
        `${SERVICE_NAME.statistics} sent a continuation that does not advance (${request.operation}).`,
        { reason: 'upstream_error', retryable: false },
      );
    }
    if (token) tokens.add(token);
  } while (token);
  return features;
}
