/**
 * @fileoverview NWIS deadlines and caller cancellation through the real fetch/retry seam.
 * @module tests/services/nwis-timeout.test
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { createWorkerHandler } from '@cyanheads/mcp-ts-core/worker';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waterSiteResource } from '@/mcp-server/resources/definitions/water-site.resource.js';
import { waterFindSites } from '@/mcp-server/tools/definitions/water-find-sites.tool.js';
import { waterGetConditions } from '@/mcp-server/tools/definitions/water-get-conditions.tool.js';
import { waterGetReadings } from '@/mcp-server/tools/definitions/water-get-readings.tool.js';
import { waterGetSeries } from '@/mcp-server/tools/definitions/water-get-series.tool.js';
import { classifyNwisFailure, getReadings } from '@/services/nwis/nwis-service.js';
import { captureError, declaredRecovery } from '../helpers/error-contract.js';
import { allText, nwisFixture } from '../helpers/nwis-fixtures.js';

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A real fetch-shaped wait that settles only when its supplied signal fires. */
function stalledFetch(body = false) {
  const fetch = vi.fn((_url: unknown, init?: RequestInit) => {
    const signal = init?.signal;
    if (!signal) throw new Error('Expected the fetch deadline signal.');
    if (body) {
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              signal.addEventListener('abort', () => controller.error(signal.reason), {
                once: true,
              });
            },
          }),
        ),
      );
    }
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

async function settle<T>(operation: Promise<T>, ms = 130_000) {
  const outcome = operation.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await vi.advanceTimersByTimeAsync(ms);
  return outcome;
}

describe('NWIS timeout and cancellation semantics', () => {
  it.each([false, true])(
    'preserves timeout retries and metadata (body=%s, characterization)',
    async (body) => {
      const fetch = stalledFetch(body);
      const outcome = await settle(getReadings({ sites: ['01646500'] }, createMockContext()));
      expect(fetch).toHaveBeenCalledTimes(4);
      expect(outcome).toMatchObject({
        error: {
          code: JsonRpcErrorCode.Timeout,
          data: { errorSource: 'FetchTimeout', retryAttempts: 4, operation: 'getReadings' },
        },
      });
    },
  );

  it.each(['AbortError', 'TimeoutError'])(
    'does not retry a caller %s (characterization)',
    async (name) => {
      const fetch = stalledFetch();
      const controller = new AbortController();
      const pending = captureError(() =>
        getReadings({ sites: ['01646500'] }, createMockContext({ signal: controller.signal })),
      );
      await vi.advanceTimersByTimeAsync(0);
      controller.abort(new DOMException('Caller stopped the request', name));
      const error = await pending;
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(error).toMatchObject({
        code:
          name === 'TimeoutError' ? JsonRpcErrorCode.Timeout : JsonRpcErrorCode.RequestCancelled,
        message: expect.stringContaining(name === 'TimeoutError' ? 'caller' : 'aborted'),
        data: { errorSource: name === 'TimeoutError' ? 'FetchSignalTimeout' : 'FetchAborted' },
      });
      if (name === 'TimeoutError')
        expect(classifyNwisFailure(error)).toMatchObject({
          reason: 'upstream_timeout',
          data: { errorSource: 'FetchSignalTimeout' },
        });
      else expect(classifyNwisFailure(error)).toBeNull();
    },
  );

  it.each([false, true])(
    'classifies a real timeout without losing its metadata (body=%s)',
    async (body) => {
      stalledFetch(body);
      const outcome = await settle(getReadings({ sites: ['01646500'] }, createMockContext()));
      expect('error' in outcome && classifyNwisFailure(outcome.error)).toMatchObject({
        reason: 'upstream_timeout',
        data: { errorSource: 'FetchTimeout', retryAttempts: 4, operation: 'getReadings' },
      });
    },
  );
});

const callers = [
  { tool: waterFindSites, input: { stateCd: 'MD' }, operation: 'findSites' },
  { tool: waterGetReadings, input: { sites: ['01646500'] }, operation: 'getReadings' },
  {
    tool: waterGetSeries,
    input: {
      site: '01646500',
      parameterCd: '00060',
      startDate: '2024-01-01',
      endDate: '2024-01-10',
    },
    operation: 'getSeries',
  },
  {
    tool: waterGetConditions,
    input: { site: '01646500', parameterCd: '00060' },
    operation: 'getReadings',
  },
];

describe('NWIS caller timeout contracts', () => {
  it('forwards a caller deadline without retrying at the definition boundary', async () => {
    const fetch = stalledFetch();
    const controller = new AbortController();
    const ctx = createMockContext({ signal: controller.signal, errors: waterGetReadings.errors });
    const pending = captureError(() =>
      waterGetReadings.handler(waterGetReadings.input.parse({ sites: ['01646500'] }), ctx),
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new DOMException('Caller deadline', 'TimeoutError'));
    expect(await pending).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'upstream_timeout', errorSource: 'FetchSignalTimeout' },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retains framework cancellation settling for an expired request signal', async () => {
    const fetch = stalledFetch();
    const controller = new AbortController();
    const pending = runToolContract(
      waterGetReadings,
      { sites: ['01646500'] },
      { context: { signal: controller.signal } },
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new DOMException('Caller deadline', 'TimeoutError'));
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.RequestCancelled,
        message: expect.stringContaining('caller'),
      },
    });
    expect(allText(result.content)).toContain('timed out on the caller');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(callers)(
    '$tool.name forwards timeout diagnostics and recovery on both surfaces',
    async ({ tool, input, operation }) => {
      stalledFetch();
      const outcome = await settle(runToolContract(tool, input));
      expect('value' in outcome).toBe(true);
      if (!('value' in outcome)) throw outcome.error;
      const result = outcome.value;
      const recovery = declaredRecovery(tool.errors, 'upstream_timeout');
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.Timeout,
          data: {
            reason: 'upstream_timeout',
            errorSource: 'FetchTimeout',
            retryAttempts: 4,
            operation,
            recovery,
          },
        },
      });
      expect(allText(result.content)).toContain('(reason upstream_timeout · retryable)');
      expect(allText(result.content)).toContain(recovery.hint);
    },
  );

  it.each(callers)(
    '$tool.name preserves caller cancellation text and code',
    async ({ tool, input }) => {
      const fetch = stalledFetch();
      const controller = new AbortController();
      const pending = runToolContract(tool, input, { context: { signal: controller.signal } });
      await vi.advanceTimersByTimeAsync(0);
      const attempts = fetch.mock.calls.length;
      controller.abort(new DOMException('Caller cancelled the request', 'AbortError'));
      const result = await pending;
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.RequestCancelled },
      });
      expect(allText(result.content)).toMatch(/aborted|cancelled/i);
      await vi.advanceTimersByTimeAsync(130_000);
      expect(fetch).toHaveBeenCalledTimes(attempts);
    },
  );

  it('forwards site-resource timeout diagnostics with its recovery hint', async () => {
    stalledFetch();
    const handler = createWorkerHandler({
      name: 'usgs-water-mcp-server',
      title: 'usgs-water-mcp-server',
      tools: [],
      resources: [waterSiteResource],
    });
    const outcome = await settle(
      handler.fetch(
        new Request('http://localhost/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'MCP-Protocol-Version': '2026-07-28',
            'Mcp-Method': 'resources/read',
            'Mcp-Name': 'usgs-water://site/01646500',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'resources/read',
            params: {
              uri: 'usgs-water://site/01646500',
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': { name: 'timeout-test', version: '1' },
                'io.modelcontextprotocol/clientCapabilities': {},
              },
            },
          }),
        }),
        {},
        { waitUntil: () => undefined, passThroughOnException: () => undefined } as never,
      ),
    );
    if (!('value' in outcome)) throw outcome.error;
    const body = await outcome.value.text();
    expect(outcome.value.status, body).toBe(200);
    const payload = body.startsWith('{')
      ? body
      : body
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('');
    const response = JSON.parse(payload);
    expect(response).toMatchObject({
      error: {
        code: JsonRpcErrorCode.Timeout,
        data: {
          reason: 'upstream_timeout',
          errorSource: 'FetchTimeout',
          retryAttempts: 4,
          operation: 'getSiteInfo',
          recovery: declaredRecovery(waterSiteResource.errors, 'upstream_timeout'),
        },
      },
    });
  });

  it('preserves resource caller cancellation without retrying', async () => {
    const fetch = stalledFetch();
    const controller = new AbortController();
    const ctx = createMockContext({ signal: controller.signal, errors: waterSiteResource.errors });
    const pending = captureError(() => waterSiteResource.handler({ siteId: '01646500' }, ctx));
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new DOMException('Caller cancelled the request', 'AbortError'));
    expect(await pending).toMatchObject({
      code: JsonRpcErrorCode.RequestCancelled,
      message: expect.stringContaining('aborted'),
      data: { errorSource: 'FetchAborted' },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps a successful current reading when only historical statistics time out (characterization)', async () => {
    const stalled = stalledFetch();
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) =>
      new URL(url).pathname === '/nwis/iv/'
        ? Promise.resolve(new Response(nwisFixture('iv-01646500-00060.json')))
        : stalled(url, init),
    );
    const outcome = await settle(
      runToolContract(waterGetConditions, { site: '01646500', parameterCd: '00060' }),
    );
    expect(outcome).toMatchObject({
      value: {
        structuredContent: {
          currentValue: '3510',
          historicalContext: null,
          historicalContextStatus: 'unavailable',
        },
      },
    });
    if (!('value' in outcome)) throw outcome.error;
    expect(outcome.value.isError).toBeFalsy();
    expect(allText(outcome.value.content)).toContain('3510');
    expect(allText(outcome.value.content)).toContain('statistics service call failed');
    expect(stalled).toHaveBeenCalledTimes(4);
  });
});
