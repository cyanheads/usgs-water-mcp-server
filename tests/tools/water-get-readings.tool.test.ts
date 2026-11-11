/**
 * @fileoverview Tests for water_get_readings tool — instantaneous real-time values.
 * Mocks the observations service's readers to avoid live API calls; the failure classifier and
 * `carriesValues` stay real, and a Water Data fake rejects any request that leaks past the mock.
 * @module tests/tools/water-get-readings.tool.test
 */

import {
  configurationError,
  JsonRpcErrorCode,
  rateLimited,
  serviceUnavailable,
  timeout,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waterGetReadings } from '@/mcp-server/tools/definitions/water-get-readings.tool.js';
import type { NwisTimeSeries } from '@/services/waterdata/types.js';
import { allText, textContent } from '../helpers/content-block.js';
import { contractError, declaredRecovery } from '../helpers/error-contract.js';
import { createWaterDataFake, type WaterDataFake } from '../helpers/water-data-fake.js';

const recovery = (reason: string) => declaredRecovery(waterGetReadings.errors, reason);

// Stub the network readers; keep the real carriesValues — the series cap ranks with it.
vi.mock('@/services/waterdata/observations.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/waterdata/observations.js')>()),
  getReadings: vi.fn(),
  getSeries: vi.fn(),
}));

import { getReadings } from '@/services/waterdata/observations.js';

const mockGetReadings = vi.mocked(getReadings);

let water: WaterDataFake;

/** An OGC time-series ID, the value methodId carries. */
const TIME_SERIES_ID = '063be3d188fc43859c6436f021a9a31f';

const MOCK_SERIES: NwisTimeSeries[] = [
  {
    siteNumber: '01646500',
    siteName: 'POTOMAC RIVER NEAR WASH, DC LITTLE FALLS PUMP STA',
    parameterCd: '00060',
    parameterName: 'Discharge, cubic feet per second',
    unitCode: 'ft3/s',
    methodId: TIME_SERIES_ID,
    methodDescription: null,
    statCd: '00000',
    statName: null,
    values: [
      { dateTime: '2026-06-04T14:00:00-04:00', value: '7660', qualifiers: ['P'] },
      { dateTime: '2026-06-04T14:15:00-04:00', value: '7700', qualifiers: ['P'] },
    ],
  },
];

/** The documented per-series cap on returned value records. */
const VALUES_CAP = 10;

/** Build a mock IV series carrying `count` value records for one site+parameter. */
function makeSeries(count: number, siteNumber = '01646500'): NwisTimeSeries {
  return {
    siteNumber,
    siteName: 'POTOMAC RIVER NEAR WASH, DC LITTLE FALLS PUMP STA',
    parameterCd: '00060',
    parameterName: 'Discharge, cubic feet per second',
    unitCode: 'ft3/s',
    methodId: TIME_SERIES_ID,
    methodDescription: null,
    statCd: '00000',
    statName: null,
    values: Array.from({ length: count }, (_, i) => ({
      dateTime: `2026-06-04T${String(i % 24).padStart(2, '0')}:00:00-04:00`,
      value: String(7000 + i),
      qualifiers: ['P'],
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  water = createWaterDataFake();
  water.install();
});

afterEach(() => {
  water.restore();
});

describe('waterGetReadings', () => {
  it('returns readings with site+parameter records', async () => {
    mockGetReadings.mockResolvedValue(MOCK_SERIES);
    const ctx = createMockContext({ errors: waterGetReadings.errors });
    const input = waterGetReadings.input.parse({ sites: ['01646500'], parameterCd: ['00060'] });
    const result = await waterGetReadings.handler(input, ctx);
    expect(result.total).toBe(1);
    expect(result.readings[0]?.siteNumber).toBe('01646500');
    expect(result.readings[0]?.parameterCd).toBe('00060');
    expect(result.readings[0]?.values).toHaveLength(2);
    expect(result.readings[0]?.values[0]?.qualifiers).toContain('P');
  });

  it('throws no_data_for_parameter when no requested site returns a series', async () => {
    mockGetReadings.mockResolvedValue([]);
    const result = await runToolContract(waterGetReadings, {
      sites: ['99999999'],
      parameterCd: ['00060'],
    });
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        message:
          'No requested site returned an instantaneous series for parameterCd 00060 — each site either does not exist or has no such series.',
        data: { reason: 'no_data_for_parameter', recovery: recovery('no_data_for_parameter') },
      },
    });
    const text = allText(result.content);
    expect(text).toContain(recovery('no_data_for_parameter').hint);
    expect(text).toContain('water_get_site_data_catalog');
    expect(text).not.toContain('water_find_sites');
  });

  it('names no parameter in no_data_for_parameter when parameterCd was omitted', async () => {
    mockGetReadings.mockResolvedValue([]);
    await expect(contractError(waterGetReadings, { sites: ['99999999'] })).resolves.toMatchObject({
      message:
        'No requested site returned an instantaneous series — each site either does not exist or has no such series.',
    });
  });

  it('points no_data_for_parameter recovery at the site data catalog, never water_find_sites (#52)', () => {
    const { hint } = recovery('no_data_for_parameter');
    expect(hint).toContain('water_get_site_data_catalog');
    expect(hint).toContain('not_found');
    expect(hint).toContain('endDate');
    expect(hint).not.toContain('water_find_sites');
  });

  it('maps an upstream rejection to invalid_request, keeping the upstream message', async () => {
    // The core's message carries the upstream's own description, which names what it rejected.
    mockGetReadings.mockRejectedValue(
      validationError('USGS Water Data OGC API rejected the request: Invalid ISO 8601 duration', {
        reason: 'invalid_request',
        upstreamStatus: 400,
        upstreamCode: 'InvalidQuery',
      }),
    );
    await expect(contractError(waterGetReadings, { sites: ['01646500'] })).resolves.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: 'USGS Water Data OGC API rejected the request: Invalid ISO 8601 duration',
      data: { reason: 'invalid_request', recovery: recovery('invalid_request') },
    });
  });

  it('maps an upstream fault to upstream_error', async () => {
    mockGetReadings.mockRejectedValue(
      serviceUnavailable('USGS Water Data OGC API answered HTTP 503 (failed after 4 attempts)', {
        reason: 'upstream_error',
        upstreamStatus: 503,
      }),
    );
    await expect(contractError(waterGetReadings, { sites: ['01646500'] })).resolves.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_error', recovery: recovery('upstream_error') },
    });
  });

  it('maps a spent call budget to upstream_timeout, keeping its deadline diagnostics', async () => {
    const message =
      'water_get_readings ran out of the 45000 ms budget for this call after 2 attempts.';
    mockGetReadings.mockRejectedValue(
      timeout(message, {
        reason: 'retry_deadline_exceeded',
        deadlineMs: 45_000,
        elapsedMs: 45_010,
        retryAttempts: 2,
        operation: 'water_get_readings',
      }),
    );
    const result = await runToolContract(waterGetReadings, { sites: ['01646500'] });
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.Timeout,
        message,
        data: {
          reason: 'upstream_timeout',
          recovery: recovery('upstream_timeout'),
          deadlineMs: 45_000,
          retryAttempts: 2,
          operation: 'water_get_readings',
        },
      },
    });
    expect(allText(result.content)).toContain(recovery('upstream_timeout').hint);
  });

  it.each([
    [
      'a rate limit',
      rateLimited(
        'USGS Water Data OGC API rate limit reached (OVER_RATE_LIMIT). Retry after 120 s.',
        {
          reason: 'rate_limited',
          retryAfter: 120,
          recovery: { hint: 'Wait the retryAfter interval before calling again.' },
        },
      ),
      JsonRpcErrorCode.RateLimited,
      'rate_limited',
    ],
    [
      'a rejected API key',
      configurationError(
        'USGS Water Data OGC API rejected the configured USGS_API_KEY (API_KEY_INVALID).',
        {
          reason: 'api_key_rejected',
          recovery: { hint: 'The server operator must replace USGS_API_KEY.' },
        },
      ),
      JsonRpcErrorCode.ConfigurationError,
      'api_key_rejected',
    ],
  ])('passes %s through unchanged', async (_case, error, code, reason) => {
    mockGetReadings.mockRejectedValue(error);
    await expect(contractError(waterGetReadings, { sites: ['01646500'] })).resolves.toMatchObject({
      code,
      message: error.message,
      data: { reason, recovery: error.data?.['recovery'] },
    });
  });

  it('rethrows an unclassified error rather than guessing a reason', async () => {
    mockGetReadings.mockRejectedValue(new TypeError('fetch failed'));
    const ctx = createMockContext({ errors: waterGetReadings.errors });
    const input = waterGetReadings.input.parse({ sites: ['01646500'] });
    await expect(waterGetReadings.handler(input, ctx)).rejects.toThrow('fetch failed');
  });

  it("rethrows a failure unclassified once the caller's signal has aborted", async () => {
    // A timeout that lands after the caller cancelled is the cancellation, not an upstream fault.
    const controller = new AbortController();
    controller.abort(new DOMException('Caller cancelled the request', 'AbortError'));
    const raised = timeout(
      'water_get_readings ran out of the 45000 ms budget for this call after 1 attempt.',
      {
        reason: 'retry_deadline_exceeded',
      },
    );
    mockGetReadings.mockRejectedValue(raised);
    const ctx = createMockContext({ errors: waterGetReadings.errors, signal: controller.signal });
    const input = waterGetReadings.input.parse({ sites: ['01646500'] });
    await expect(waterGetReadings.handler(input, ctx)).rejects.toBe(raised);
  });

  it('sends one request descriptor per call: its own 45 s budget, the caller signal, the tool name', async () => {
    mockGetReadings.mockResolvedValue(MOCK_SERIES);
    const controller = new AbortController();
    const ctx = createMockContext({ errors: waterGetReadings.errors, signal: controller.signal });
    await waterGetReadings.handler(
      waterGetReadings.input.parse({ sites: ['01646500', '14211720'], parameterCd: ['00060'] }),
      ctx,
    );
    expect(mockGetReadings).toHaveBeenCalledTimes(1);
    const [params, request] = mockGetReadings.mock.calls[0]!;
    expect(params).toEqual({
      sites: ['01646500', '14211720'],
      period: 'PT2H',
      parameterCds: ['00060'],
    });
    expect(request).toMatchObject({
      ctx,
      operation: 'water_get_readings',
      signal: controller.signal,
    });
    expect(request.deadline.budgetMs).toBe(45_000);
    expect(request.deadline.remainingMs()).toBeGreaterThan(0);
  });

  it('omits parameterCds when parameterCd is omitted', async () => {
    mockGetReadings.mockResolvedValue(MOCK_SERIES);
    await runToolContract(waterGetReadings, { sites: ['01646500'], period: 'P1D' });
    expect(mockGetReadings.mock.calls[0]?.[0]).toEqual({ sites: ['01646500'], period: 'P1D' });
  });

  it('formats readings as markdown with values', () => {
    const result = {
      readings: MOCK_SERIES.map((s) => ({ ...s, totalValues: s.values.length })),
      total: 1,
      totalSeries: 1,
      truncated: false,
      missingSites: [],
    };
    const blocks = waterGetReadings.format!(result);
    const text = textContent(blocks[0]);
    expect(text).toContain('01646500');
    expect(text).toContain('Discharge, cubic feet per second');
    expect(text).toContain('00060');
    expect(text).toContain('ft3/s');
    expect(text).toContain('7700');
    expect(text).toContain('[P]');
  });

  it('supports multi-site batch input', async () => {
    mockGetReadings.mockResolvedValue([
      ...MOCK_SERIES,
      { ...MOCK_SERIES[0]!, siteNumber: '14211720' },
    ]);
    const ctx = createMockContext({ errors: waterGetReadings.errors });
    const input = waterGetReadings.input.parse({ sites: ['01646500', '14211720'] });
    const result = await waterGetReadings.handler(input, ctx);
    expect(result.total).toBe(2);
  });

  it('populates query enrichment on successful result', async () => {
    mockGetReadings.mockResolvedValue(MOCK_SERIES);
    const ctx = createMockContext({ errors: waterGetReadings.errors });
    const input = waterGetReadings.input.parse({
      sites: ['01646500'],
      parameterCd: ['00060'],
      period: 'P1D',
    });
    await waterGetReadings.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment).toMatchObject({
      query: expect.objectContaining({
        sites: ['01646500'],
        parameterCd: ['00060'],
        period: 'P1D',
      }),
    });
  });

  describe('value cap', () => {
    it('caps values per series in structuredContent and reports the true count', async () => {
      // A P1D lookback at this site returns ~250 records upstream; the handler must not pass the
      // whole series through structuredContent just because format() only shows a preview.
      mockGetReadings.mockResolvedValue([makeSeries(277)]);
      const ctx = createMockContext({ errors: waterGetReadings.errors });
      const input = waterGetReadings.input.parse({
        sites: ['01646500'],
        parameterCd: ['00060'],
        period: 'P1D',
      });
      const result = await waterGetReadings.handler(input, ctx);

      expect(result.readings[0]?.values).toHaveLength(VALUES_CAP);
      expect(result.readings[0]?.totalValues).toBe(277);
      expect(result.truncated).toBe(true);
    });

    it('keeps the most recent records when capping', async () => {
      mockGetReadings.mockResolvedValue([makeSeries(277)]);
      const ctx = createMockContext({ errors: waterGetReadings.errors });
      const input = waterGetReadings.input.parse({ sites: ['01646500'], period: 'P1D' });
      const result = await waterGetReadings.handler(input, ctx);

      // makeSeries values ascend from 7000, so the newest record is 7000 + 276.
      expect(result.readings[0]?.values.at(-1)?.value).toBe('7276');
      expect(result.readings[0]?.values[0]?.value).toBe(String(7000 + 277 - VALUES_CAP));
    });

    it('leaves a series at or under the cap untouched', async () => {
      mockGetReadings.mockResolvedValue([makeSeries(VALUES_CAP)]);
      const ctx = createMockContext({ errors: waterGetReadings.errors });
      const input = waterGetReadings.input.parse({ sites: ['01646500'] });
      const result = await waterGetReadings.handler(input, ctx);

      expect(result.readings[0]?.values).toHaveLength(VALUES_CAP);
      expect(result.readings[0]?.totalValues).toBe(VALUES_CAP);
      expect(result.truncated).toBe(false);
    });

    it('reports the same record count in structuredContent and format()', async () => {
      mockGetReadings.mockResolvedValue([makeSeries(277)]);
      const ctx = createMockContext({ errors: waterGetReadings.errors });
      const input = waterGetReadings.input.parse({ sites: ['01646500'], period: 'P1D' });
      const result = await waterGetReadings.handler(input, ctx);
      const text = textContent(waterGetReadings.format!(result)[0]);

      expect(text).toContain(`showing the latest ${VALUES_CAP} of 277 records`);
      expect(text).toContain('truncated');
      expect(text).toContain('water_get_series');
    });
  });

  describe('partial batches', () => {
    it('names requested sites that returned no series', async () => {
      mockGetReadings.mockResolvedValue([makeSeries(2, '01646500')]);
      const ctx = createMockContext({ errors: waterGetReadings.errors });
      const input = waterGetReadings.input.parse({
        sites: ['01646500', '99999999'],
        parameterCd: ['00060'],
      });
      const result = await waterGetReadings.handler(input, ctx);

      expect(result.total).toBe(1);
      expect(result.missingSites).toEqual(['99999999']);
    });

    it('renders missing sites in format(), pointing at the site data catalog (#52)', async () => {
      mockGetReadings.mockResolvedValue([makeSeries(2, '01646500')]);
      const ctx = createMockContext({ errors: waterGetReadings.errors });
      const input = waterGetReadings.input.parse({ sites: ['01646500', '99999999'] });
      const result = await waterGetReadings.handler(input, ctx);
      const text = textContent(waterGetReadings.format!(result)[0]);

      expect(text).toContain(
        '**No series returned for:** 99999999 — check each with water_get_site_data_catalog: not_found means no such site, an empty series list means it never measured the parameter.',
      );
      expect(text).not.toContain('water_find_sites');
    });

    it('describes missingSites with the site data catalog, never water_find_sites (#52)', () => {
      const description = waterGetReadings.output.shape.missingSites.description ?? '';
      expect(description).toContain('water_get_site_data_catalog');
      expect(description).toContain('totalValues 0');
      expect(description).not.toContain('water_find_sites');
    });

    it('returns a sensor that reported nothing in the period beside a missing site (#52)', async () => {
      // The #52 shape: a discontinued gage and a site number that does not exist.
      mockGetReadings.mockResolvedValue([
        { ...makeSeries(0, '12120000'), siteName: 'MERCER CREEK NEAR BELLEVUE, WA' },
      ]);
      const result = await runToolContract(waterGetReadings, {
        sites: ['12120000', '99999999'],
        parameterCd: ['00060'],
      });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        readings: [{ siteNumber: '12120000', values: [], totalValues: 0 }],
        total: 1,
        totalSeries: 1,
        truncated: false,
        missingSites: ['99999999'],
      });
      const text = allText(result.content);
      expect(text).toContain(
        '### MERCER CREEK NEAR BELLEVUE, WA (12120000) — Discharge, cubic feet per second | code: 00060 | unit: ft3/s',
      );
      expect(text).toContain('*(0 records in this period)*');
      expect(text).toContain('**No series returned for:** 99999999');
    });

    it('returns every series of an all-dormant batch instead of failing (#52)', async () => {
      mockGetReadings.mockResolvedValue([makeSeries(0, '12120000'), makeSeries(0, '12122500')]);
      const result = await runToolContract(waterGetReadings, {
        sites: ['12120000', '12122500'],
        parameterCd: ['00060'],
        period: 'P7D',
      });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        readings: [
          { siteNumber: '12120000', totalValues: 0 },
          { siteNumber: '12122500', totalValues: 0 },
        ],
        total: 2,
        missingSites: [],
      });
      expect(allText(result.content).split('\n')[0]).toBe('**2 time series**');
    });

    it('keeps the shape of a mixed batch: the dormant site as a zero-value series (#52)', async () => {
      mockGetReadings.mockResolvedValue([makeSeries(0, '01484719'), makeSeries(3, '01646500')]);
      const result = await runToolContract(waterGetReadings, {
        sites: ['01484719', '01646500'],
        parameterCd: ['00060'],
      });

      expect(result.structuredContent).toMatchObject({
        readings: [
          { siteNumber: '01484719', totalValues: 0 },
          { siteNumber: '01646500', totalValues: 3 },
        ],
        missingSites: [],
      });
    });

    it('leaves missingSites empty when every requested site returns data', async () => {
      mockGetReadings.mockResolvedValue([makeSeries(2, '01646500'), makeSeries(2, '14211720')]);
      const ctx = createMockContext({ errors: waterGetReadings.errors });
      const input = waterGetReadings.input.parse({ sites: ['01646500', '14211720'] });
      const result = await waterGetReadings.handler(input, ctx);

      expect(result.missingSites).toEqual([]);
    });
  });

  describe('result header (characterization)', () => {
    async function header(series: NwisTimeSeries[]) {
      mockGetReadings.mockResolvedValue(series);
      const result = await runToolContract(waterGetReadings, { sites: ['01646500'] });
      return allText(result.content).split('\n')[0];
    }

    it('states the series count alone when nothing was capped', async () => {
      expect(await header([makeSeries(2)])).toBe('**1 time series**');
    });

    it('keeps the record caption when a series was capped at 10 records', async () => {
      expect(await header([makeSeries(277)])).toBe(
        '**1 time series** *(truncated — each series shows its latest 10 records; use water_get_series for full history)*',
      );
    });
  });

  /** The documented cap on the number of series one call returns. */
  const SERIES_CAP = 100;

  /** A 8-digit site number for index `i`. */
  const siteNo = (i: number) => String(10_000_000 + i);

  /** One series for a site and parameter, carrying `count` records. */
  function seriesFor(site: string, parameterCd: string, count = 2): NwisTimeSeries {
    return { ...makeSeries(count, site), parameterCd, siteName: `SITE ${site}` };
  }

  type ReadingsResult = {
    missingSites: string[];
    readings: { parameterCd: string; siteNumber: string; totalValues: number }[];
    total: number;
    totalSeries: number;
    truncated: boolean;
  };

  async function readings(series: NwisTimeSeries[], sites: string[], parameterCd?: string[]) {
    mockGetReadings.mockResolvedValue(series);
    const result = await runToolContract(waterGetReadings, {
      sites,
      ...(parameterCd ? { parameterCd } : {}),
    });
    expect(result.isError).toBeFalsy();
    return {
      structured: result.structuredContent as ReadingsResult,
      text: allText(result.content),
    };
  }

  describe('series cap', () => {
    it(`keeps every site when ${SERIES_CAP} sites return two series each`, async () => {
      const sites = Array.from({ length: SERIES_CAP }, (_, i) => siteNo(i));
      const upstream = sites.flatMap((s) => [seriesFor(s, '00060'), seriesFor(s, '00065')]);
      const { structured, text } = await readings(upstream, sites);

      expect(structured).toMatchObject({
        total: SERIES_CAP,
        totalSeries: 2 * SERIES_CAP,
        truncated: true,
        missingSites: [],
      });
      expect(new Set(structured.readings.map((r) => r.siteNumber)).size).toBe(SERIES_CAP);
      // Round-robin gives each site one slot, so each keeps its first series.
      expect(structured.readings.every((r) => r.parameterCd === '00060')).toBe(true);
      expect(text.split('\n')[0]).toBe(
        `**${SERIES_CAP} of ${2 * SERIES_CAP} time series** *(truncated — capped at ${SERIES_CAP} series; pass parameterCd to choose which parameters return, or split the sites across calls)*`,
      );
      expect(text).not.toContain('latest 10 records;');
    });

    it("fills later rounds site by site and keeps the service's order", async () => {
      // Three sites × 50 series: 33 full rounds (99 series), then the first site's 34th.
      const sites = [siteNo(1), siteNo(2), siteNo(3)];
      const params = Array.from({ length: 50 }, (_, i) => String(i).padStart(5, '0'));
      const upstream = sites.flatMap((s) => params.map((p) => seriesFor(s, p)));
      const { structured } = await readings(upstream, sites);

      expect(structured.total).toBe(SERIES_CAP);
      expect(structured.totalSeries).toBe(150);
      const kept = structured.readings.map((r) => `${r.siteNumber}:${r.parameterCd}`);
      expect(kept).toEqual([
        ...params.slice(0, 34).map((p) => `${sites[0]}:${p}`),
        ...params.slice(0, 33).map((p) => `${sites[1]}:${p}`),
        ...params.slice(0, 33).map((p) => `${sites[2]}:${p}`),
      ]);
    });

    it('gives a site with one slot its valued series over an earlier empty one', async () => {
      const sites = Array.from({ length: SERIES_CAP }, (_, i) => siteNo(i));
      const upstream = sites.flatMap((s, i) =>
        i === 0 ? [seriesFor(s, '00010', 0), seriesFor(s, '00060', 3)] : [seriesFor(s, '00060')],
      );
      const { structured } = await readings(upstream, sites);

      expect(structured.totalSeries).toBe(SERIES_CAP + 1);
      expect(structured.readings[0]).toMatchObject({
        siteNumber: siteNo(0),
        parameterCd: '00060',
        totalValues: 3,
      });
    });

    it("drops a site's empty series before its valued ones", async () => {
      // One site, 101 series: the empty one ranks last within the site and is the one dropped.
      const site = siteNo(0);
      const params = Array.from({ length: SERIES_CAP + 1 }, (_, i) => String(i).padStart(5, '0'));
      const upstream = params.map((p, i) => seriesFor(site, p, i === 0 ? 0 : 1));
      const { structured } = await readings(upstream, [site]);

      expect(structured.readings.map((r) => r.parameterCd)).toEqual(params.slice(1));
    });

    it('ranks a series whose every record is missing with the empty ones (#45)', async () => {
      // Site 0's first series holds records, but the upstream reported each as no data (seasonal gage).
      const sites = Array.from({ length: SERIES_CAP }, (_, i) => siteNo(i));
      const allMissing: NwisTimeSeries = {
        ...seriesFor(sites[0]!, '00010', 3),
        values: Array.from({ length: 3 }, (_, i) => ({
          dateTime: `2026-06-04T0${i}:00:00-04:00`,
          value: '',
          qualifiers: ['P', 'Ssn'],
        })),
      };
      const upstream = sites.flatMap((s, i) =>
        i === 0 ? [allMissing, seriesFor(s, '00060', 2)] : [seriesFor(s, '00060')],
      );
      const { structured } = await readings(upstream, sites);

      expect(structured.totalSeries).toBe(SERIES_CAP + 1);
      expect(structured.readings[0]).toMatchObject({
        siteNumber: siteNo(0),
        parameterCd: '00060',
        totalValues: 2,
      });
    });

    it('names both caps when series and records were both capped', async () => {
      const sites = Array.from({ length: SERIES_CAP }, (_, i) => siteNo(i));
      const upstream = sites.flatMap((s) => [seriesFor(s, '00060', 12), seriesFor(s, '00065')]);
      const { structured, text } = await readings(upstream, sites);

      expect(structured.truncated).toBe(true);
      expect(text.split('\n')[0]).toBe(
        `**${SERIES_CAP} of ${2 * SERIES_CAP} time series** *(truncated — capped at ${SERIES_CAP} series, and each series shows its latest 10 records; pass parameterCd to choose which parameters return, or split the sites across calls; use water_get_series for full history)*`,
      );
    });

    it(`returns exactly ${SERIES_CAP} series uncapped`, async () => {
      const sites = Array.from({ length: SERIES_CAP }, (_, i) => siteNo(i));
      const { structured, text } = await readings(
        sites.map((s) => seriesFor(s, '00060')),
        sites,
      );

      expect(structured).toMatchObject({
        total: SERIES_CAP,
        totalSeries: SERIES_CAP,
        truncated: false,
      });
      expect(text.split('\n')[0]).toBe(`**${SERIES_CAP} time series**`);
    });

    it('lists only the sites that returned nothing as missing when the cap applies', async () => {
      // 99 sites return two series each (198 > cap); the 100th returns none.
      const sites = Array.from({ length: SERIES_CAP }, (_, i) => siteNo(i));
      const upstream = sites
        .slice(0, -1)
        .flatMap((s) => [seriesFor(s, '00060'), seriesFor(s, '00065')]);
      const { structured, text } = await readings(upstream, sites);

      expect(structured.total).toBe(SERIES_CAP);
      expect(structured.missingSites).toEqual([siteNo(SERIES_CAP - 1)]);
      expect(text).toContain(`**No series returned for:** ${siteNo(SERIES_CAP - 1)}`);
    });

    it('reports totalSeries equal to total for a parameterCd-filtered call under the cap', async () => {
      const { structured, text } = await readings(
        [makeSeries(2, '01646500'), makeSeries(2, '14211720')],
        ['01646500', '14211720'],
        ['00060'],
      );

      expect(structured).toMatchObject({ total: 2, totalSeries: 2, truncated: false });
      expect(text.split('\n')[0]).toBe('**2 time series**');
    });

    it('rejects more than 100 sites at the schema', () => {
      const sites = Array.from({ length: SERIES_CAP + 1 }, (_, i) => siteNo(i));
      expect(() => waterGetReadings.input.parse({ sites })).toThrow();
    });
  });

  describe('input validation', () => {
    it('rejects a malformed period at Zod parse level, before any upstream call', () => {
      expect(() =>
        waterGetReadings.input.parse({ sites: ['01646500'], period: 'not-a-duration' }),
      ).toThrow();
      expect(mockGetReadings).not.toHaveBeenCalled();
    });

    it('rejects a negative period (the upstream refuses these)', () => {
      expect(() =>
        waterGetReadings.input.parse({ sites: ['01646500'], period: 'P-T2H' }),
      ).toThrow();
    });

    it('accepts ISO 8601 durations the upstream supports', () => {
      for (const period of ['PT2H', 'P1D', 'P7D', 'PT15M', 'P1Y2M3DT4H5M6S']) {
        expect(() => waterGetReadings.input.parse({ sites: ['01646500'], period })).not.toThrow();
      }
    });

    it('rejects a non-numeric site number at Zod parse level', () => {
      expect(() => waterGetReadings.input.parse({ sites: ['BADSITE'] })).toThrow();
    });

    it('rejects a site number outside 8–15 digits', () => {
      expect(() => waterGetReadings.input.parse({ sites: ['1646500'] })).toThrow();
      expect(() => waterGetReadings.input.parse({ sites: ['0164650012345678'] })).toThrow();
    });

    it('rejects a parameter code that is not exactly 5 digits', () => {
      expect(() =>
        waterGetReadings.input.parse({ sites: ['01646500'], parameterCd: ['BAD'] }),
      ).toThrow();
      expect(() =>
        waterGetReadings.input.parse({ sites: ['01646500'], parameterCd: ['0006'] }),
      ).toThrow();
      expect(() =>
        waterGetReadings.input.parse({ sites: ['01646500'], parameterCd: ['000600'] }),
      ).toThrow();
    });
  });

  describe('definition language matches what the observations service emits (#32)', () => {
    const reading = waterGetReadings.output.shape.readings.element.shape;
    const qualifier = reading.values.element.shape.qualifiers.element;

    it('gives parameterName, unitCode, and methodDescription examples the service produces', () => {
      expect(reading.parameterName.description).toContain('"Discharge, cubic feet per second"');
      expect(reading.unitCode.description).toContain('"deg C"');
      expect(reading.methodDescription.description).toContain(
        '"From multiparameter sonde, [Discontinued]"',
      );
      const fields = JSON.stringify(
        Object.fromEntries(Object.entries(reading).map(([key, field]) => [key, field.description])),
      );
      for (const stale of ['Streamflow', 'ft³/s', '°C', 'AUXILIARY GAGE']) {
        expect(fields).not.toContain(stale);
      }
    });

    it('says a qualifier word with no code passes through as written', () => {
      expect(qualifier.description).toContain('"OTHERAGENCY"');
    });

    it('names the order the service returns series in', () => {
      const description = waterGetReadings.output.shape.readings.description ?? '';
      expect(description).toContain('ordered by site number, parameter code');
      expect(description).not.toContain('in the order the upstream returned them');
    });

    it('states the 1,100-day period the upstream accepts', () => {
      const description = waterGetReadings.input.shape.period.description ?? '';
      expect(description).toContain(
        'At most 1,100 days (e.g. "P3Y"); a longer period is refused upstream.',
      );
    });
  });
});
