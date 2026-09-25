/**
 * @fileoverview Test helpers for driving the real NWIS service layer against captured upstream
 * responses. Fixtures under `tests/fixtures/nwis/` are live WaterML-JSON and stat-service RDB
 * bodies, trimmed only where noted in the file name (e.g. `-0924` keeps the stat rows for
 * September 24, the calendar day the IV captures were taken on).
 * @module tests/helpers/nwis-fixtures
 */

import { readFileSync } from 'node:fs';
import type { FetchMockRoute } from '@cyanheads/mcp-ts-core/testing';
import { vi } from 'vitest';

/** Read a captured fixture body by file name. */
export function nwisFixture(name: string): string {
  return readFileSync(new URL(`../fixtures/nwis/${name}`, import.meta.url), 'utf8');
}

/** The query an NWIS route answers — anything else falls through to the harness's rejection. */
export interface NwisRouteSpec {
  endpoint: 'dv' | 'iv' | 'stat';
  /** Fixture file served as the response body. */
  fixture: string;
  parameterCd: string;
  sites: string;
  /** Required `statCd` query value; omitted means the request must carry none. */
  statCd?: string;
}

/**
 * A fetch-mock route matching one NWIS request by endpoint, sites, parameterCd, and statCd, and
 * answering with the named fixture. Matching on the parsed query rather than the raw URL keeps a
 * test independent of parameter order, while still failing loudly on a request the test did not
 * anticipate — an unexpected statCd included.
 */
export function nwisRoute(spec: NwisRouteSpec): FetchMockRoute {
  return {
    method: 'GET',
    match: (request) => {
      const url = new URL(request.url);
      return (
        url.pathname === `/nwis/${spec.endpoint}/` &&
        url.searchParams.get('sites') === spec.sites &&
        url.searchParams.get('parameterCd') === spec.parameterCd &&
        (url.searchParams.get('statCd') ?? undefined) === spec.statCd
      );
    },
    respond: () => new Response(nwisFixture(spec.fixture), { status: 200 }),
  };
}

/**
 * A route answering the same request as {@link nwisRoute} with a body and status of the test's
 * choosing instead of the fixture. `once` removes the route after its first match, so a route
 * registered after it serves the retry.
 */
export function nwisBodyRoute(
  spec: NwisRouteSpec,
  body: string,
  { status = 200, once = false }: { once?: boolean; status?: number } = {},
): FetchMockRoute {
  return { ...nwisRoute(spec), once, respond: () => new Response(body, { status }) };
}

/** The first `bytes` of a fixture — a WaterML-JSON body NWIS cut off mid-document. */
export function truncatedFixture(name: string, bytes = 1_000): string {
  return nwisFixture(name).slice(0, bytes);
}

/**
 * Fake-clock time that clears the NWIS service's whole retry ladder — three backoffs from 500 ms,
 * doubling, each at most 25% over with jitter: 4,375 ms in all — while staying short of the 30 s
 * per-request timeout.
 */
const RETRY_LADDER_MS = 10_000;

/**
 * Settle an operation that runs the NWIS service's retry path under fake timers
 * (`vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })`), advancing the clock past every
 * backoff. The outcome is captured before the clock moves, so a rejection is never reported as
 * unhandled mid-advance; it is rethrown here.
 */
export async function afterRetries<T>(operation: Promise<T>): Promise<T> {
  const settled = operation.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await vi.advanceTimersByTimeAsync(RETRY_LADDER_MS);
  const outcome = await settled;
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

/** The text of every text block in a tool result's `content[]`, joined. */
export function allText(content: readonly { type: string; text?: string }[]): string {
  return content.map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('\n');
}
