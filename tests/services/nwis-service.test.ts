/**
 * @fileoverview Tests for the NWIS service layer's WaterML and stat parsing, run against captured
 * upstream responses through a strict fetch mock — the real request building, retry wrapper, and
 * parser all execute. Any request the test did not route is rejected.
 * @module tests/services/nwis-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  type FetchMockHarness,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyNwisFailure,
  getReadings,
  getSeries,
  getStats,
} from '@/services/nwis/nwis-service.js';
import { captureError } from '../helpers/error-contract.js';
import {
  afterRetries,
  nwisBodyRoute,
  nwisRoute,
  truncatedFixture,
} from '../helpers/nwis-fixtures.js';

let http: FetchMockHarness;

beforeEach(() => {
  http = createFetchMock();
  http.install();
});

afterEach(() => {
  http.restore();
});

describe('WaterML parsing — single method, single statistic (characterization)', () => {
  it('reads an IV series with one method block', async () => {
    http.route(
      nwisRoute({
        endpoint: 'iv',
        sites: '01646500',
        parameterCd: '00060',
        fixture: 'iv-01646500-00060.json',
      }),
    );
    const series = await getReadings(
      { sites: ['01646500'], parameterCds: ['00060'] },
      createMockContext(),
    );

    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({
      siteNumber: '01646500',
      siteName: 'POTOMAC RIVER NEAR WASH, DC LITTLE FALLS PUMP STA',
      parameterCd: '00060',
      parameterName: 'Streamflow, ft³/s',
      unitCode: 'ft3/s',
    });
    expect(series[0]?.values).toHaveLength(11);
    expect(series[0]?.values[0]).toEqual({
      dateTime: '2026-09-24T22:00:00.000-04:00',
      value: '3510',
      qualifiers: ['P'],
    });
  });

  it('reads one series per site from a multi-site IV response', async () => {
    http.route(
      nwisRoute({
        endpoint: 'iv',
        sites: '01646500,01638500',
        parameterCd: '00060',
        fixture: 'iv-01638500-01646500-00060.json',
      }),
    );
    const series = await getReadings(
      { sites: ['01646500', '01638500'], parameterCds: ['00060'] },
      createMockContext(),
    );

    expect(series.map((s) => [s.siteNumber, s.values.length])).toEqual([
      ['01638500', 12],
      ['01646500', 11],
    ]);
  });

  it('reads a DV series with one statistic and one method block', async () => {
    http.route(
      nwisRoute({
        endpoint: 'dv',
        sites: '01646500',
        parameterCd: '00060',
        fixture: 'dv-01646500-00060-20240101-20240110.json',
      }),
    );
    const series = await getSeries(
      {
        site: '01646500',
        parameterCd: '00060',
        startDate: '2024-01-01',
        endDate: '2024-01-10',
        seriesType: 'daily',
      },
      createMockContext(),
    );

    expect(series).toHaveLength(1);
    expect(series[0]?.values).toHaveLength(10);
    expect(series[0]?.values[0]?.value).toBe('8930');
    expect(series[0]?.values.at(-1)?.value).toBe('39000');
  });

  it('parses the stat table percentiles for a calendar day', async () => {
    http.route(
      nwisRoute({
        endpoint: 'stat',
        sites: '01646500',
        parameterCd: '00060',
        fixture: 'stat-01646500-00060-0924.rdb',
      }),
    );
    const stats = await getStats('01646500', '00060', createMockContext());

    expect(stats.rows).toHaveLength(1);
    expect(stats.rows[0]).toMatchObject({
      monthNu: 9,
      dayNu: 24,
      beginYr: 1930,
      endYr: 2025,
      p05: 751,
      p50: 2110,
      p95: 26400,
    });
  });

  it('parses a stat response that matched nothing as an empty table', async () => {
    http.route(
      nwisRoute({
        endpoint: 'stat',
        sites: '12036400',
        parameterCd: '00060',
        fixture: 'stat-12036400-00060-empty.rdb',
      }),
    );
    const stats = await getStats('12036400', '00060', createMockContext());
    expect(stats.rows).toEqual([]);
  });
});

describe('WaterML parsing — every method block is read (#43)', () => {
  it('keeps the populated second block when the first is empty', async () => {
    http.route(
      nwisRoute({
        endpoint: 'iv',
        sites: '12036400',
        parameterCd: '00060',
        fixture: 'iv-12036400-00060.json',
      }),
    );
    const series = await getReadings(
      { sites: ['12036400'], parameterCds: ['00060'] },
      createMockContext(),
    );

    // The empty "[(2)]" block is dropped because its sibling carries values.
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({
      methodId: '306966',
      methodDescription: null,
      statCd: '00000',
    });
    expect(series[0]?.values.map((v) => v.value)).toEqual(['4.19', '4.19', '4.42', '4.42']);
  });

  it('emits one series per populated method block, each naming its method', async () => {
    http.route(
      nwisRoute({
        endpoint: 'iv',
        sites: '12056500',
        parameterCd: '00010',
        fixture: 'iv-12056500-00010.json',
      }),
    );
    const series = await getReadings(
      { sites: ['12056500'], parameterCds: ['00010'] },
      createMockContext(),
    );

    expect(
      series.map((s) => ({ id: s.methodId, desc: s.methodDescription, n: s.values.length })),
    ).toEqual([
      { id: '150723', desc: null, n: 7 },
      { id: '352066', desc: 'QWsonde-EXO, [From QW Sonde]', n: 6 },
    ]);
    expect(series[1]?.values[0]?.value).toBe('11.6');
  });

  it('keeps one empty series when every block of a timeSeries is empty', async () => {
    http.route(
      nwisRoute({
        endpoint: 'iv',
        sites: '01589485',
        parameterCd: '00010',
        fixture: 'iv-01589485-00010.json',
      }),
    );
    const series = await getReadings(
      { sites: ['01589485'], parameterCds: ['00010'] },
      createMockContext(),
    );

    expect(series).toEqual([
      expect.objectContaining({
        siteNumber: '01589485',
        methodId: '168298',
        methodDescription: 'Upper',
        values: [],
      }),
    ]);
  });

  it('reads every statistic × method of a multi-statistic DV response', async () => {
    http.route(
      nwisRoute({
        endpoint: 'dv',
        sites: '01646500',
        parameterCd: '00010',
        fixture: 'dv-01646500-00010-20190901-20190905.json',
      }),
    );
    const series = await getSeries(
      {
        site: '01646500',
        parameterCd: '00010',
        startDate: '2019-09-01',
        endDate: '2019-09-05',
        seriesType: 'daily',
      },
      createMockContext(),
    );

    // Three statistics × five method blocks, less the empty discontinued-sonde block in each.
    expect(series).toHaveLength(12);
    expect(series.map((s) => s.statCd)).toEqual([
      ...Array(4).fill('00001'),
      ...Array(4).fill('00002'),
      ...Array(4).fill('00003'),
    ]);
    expect(series.map((s) => s.statName)).toContain('Mean');
    const sondeMean = series.find((s) => s.methodId === '300173');
    expect(sondeMean).toMatchObject({
      statCd: '00003',
      statName: 'Mean',
      methodDescription: 'From multiparameter sonde',
    });
    expect(sondeMean?.values.map((v) => v.value)).toEqual(['26.6', '26.9', '26.9', '27.6', '27.6']);
  });

  it('gives a timeSeries with no method block one empty, unnamed series', async () => {
    // Not observed live, but the WaterML schema allows it — the series must still surface.
    http.route({
      method: 'GET',
      match: () => true,
      respond: () =>
        Response.json({
          value: {
            timeSeries: [
              {
                name: 'USGS:01646500:00060:00000',
                sourceInfo: { siteName: 'X', siteCode: [{ value: '01646500' }] },
                variable: {
                  variableCode: [{ value: '00060' }],
                  variableName: 'Streamflow, ft&#179;/s',
                  unit: { unitCode: 'ft3/s' },
                },
                values: [],
              },
            ],
          },
        }),
    });
    const series = await getReadings({ sites: ['01646500'] }, createMockContext());

    // No `options` block: the statistic falls back to the fourth segment of the series name.
    expect(series).toEqual([
      expect.objectContaining({
        methodId: null,
        methodDescription: null,
        statCd: '00000',
        values: [],
      }),
    ]);
  });
});

describe('statCd forwarding', () => {
  it('forwards statCd on a daily request', async () => {
    http.route(
      nwisRoute({
        endpoint: 'dv',
        sites: '01646500',
        parameterCd: '00010',
        statCd: '00003',
        fixture: 'dv-01646500-00010-20190901-20190905-stat00003.json',
      }),
    );
    const series = await getSeries(
      {
        site: '01646500',
        parameterCd: '00010',
        startDate: '2019-09-01',
        endDate: '2019-09-05',
        seriesType: 'daily',
        statCd: '00003',
      },
      createMockContext(),
    );

    expect(new Set(series.map((s) => s.statCd))).toEqual(new Set(['00003']));
    expect(http.calls).toHaveLength(1);
  });

  it('never sends statCd to the IV service, which rejects the keyword', async () => {
    http.route(
      nwisRoute({
        endpoint: 'iv',
        sites: '12056500',
        parameterCd: '00010',
        fixture: 'iv-12056500-00010.json',
      }),
    );
    await getSeries(
      {
        site: '12056500',
        parameterCd: '00010',
        startDate: '2026-09-24',
        endDate: '2026-09-24',
        seriesType: 'instantaneous',
        statCd: '00000',
      },
      createMockContext(),
    );

    expect(new URL(http.calls[0]?.request.url ?? '').searchParams.has('statCd')).toBe(false);
  });
});

describe('stat table series identity', () => {
  it('reads ts_id and loc_web_ds for each stat row', async () => {
    http.route(
      nwisRoute({
        endpoint: 'stat',
        sites: '01646500',
        parameterCd: '00010',
        fixture: 'stat-01646500-00010-0924.rdb',
      }),
    );
    const stats = await getStats('01646500', '00010', createMockContext());

    expect(stats.rows.map((r) => [r.tsId, r.seriesDescription])).toEqual([
      ['68481', '4.1 ft from riverbed (middle), [Discontinued]'],
      ['68484', '1.0 ft from riverbed (bottom), [Discontinued]'],
      ['68487', '7.1 ft from riverbed (top), [Discontinued]'],
      ['68514', 'From multiparameter sonde, [Discontinued]'],
      ['300173', 'From multiparameter sonde'],
    ]);
  });

  it('reads a blank loc_web_ds as null', async () => {
    http.route(
      nwisRoute({
        endpoint: 'stat',
        sites: '12056500',
        parameterCd: '00010',
        fixture: 'stat-12056500-00010-0924.rdb',
      }),
    );
    const stats = await getStats('12056500', '00010', createMockContext());
    expect(stats.rows[0]).toMatchObject({ tsId: '148577', seriesDescription: null });
  });
});

describe('no-data sentinel (#45)', () => {
  /** Captured IV response for a seasonal gage: every record is `-999999` qualified `Ssn`. */
  const SEASONAL_IV = {
    endpoint: 'iv',
    sites: '12024000',
    parameterCd: '00060',
    fixture: 'iv-12024000-00060.json',
  } as const;

  it("maps a value equal to the series' noDataValue to missing, keeping dateTime and qualifiers", async () => {
    http.route(nwisRoute(SEASONAL_IV));
    const series = await getReadings(
      { sites: ['12024000'], parameterCds: ['00060'] },
      createMockContext(),
    );

    expect(series).toHaveLength(1);
    expect(series[0]?.values).toHaveLength(8);
    expect(series[0]?.values[0]).toEqual({
      dateTime: '2026-09-24T19:45:00.000-07:00',
      value: '',
      qualifiers: ['P', 'Ssn'],
    });
    expect(series[0]?.values.every((v) => v.value === '')).toBe(true);
  });

  it('maps the sentinel in a daily-values response', async () => {
    http.route(
      nwisRoute({
        endpoint: 'dv',
        sites: '12024000',
        parameterCd: '00060',
        fixture: 'dv-12024000-00060-20260910-20260924.json',
      }),
    );
    const series = await getSeries(
      {
        site: '12024000',
        parameterCd: '00060',
        startDate: '2026-09-10',
        endDate: '2026-09-24',
        seriesType: 'daily',
      },
      createMockContext(),
    );

    expect(series).toHaveLength(1);
    expect(series[0]?.values).toHaveLength(14);
    expect(series[0]?.values.map((v) => v.value)).toEqual(Array(14).fill(''));
    expect(series[0]?.values[0]).toEqual({
      dateTime: '2026-09-10T00:00:00.000',
      value: '',
      qualifiers: ['P', 'Ssn'],
    });
  });

  it("leaves a real measurement alone in a batch that also carries another site's sentinel", async () => {
    http.route(
      nwisRoute({
        endpoint: 'iv',
        sites: '01646500,12024000',
        parameterCd: '00060',
        fixture: 'iv-01646500-12024000-00060.json',
      }),
    );
    const series = await getReadings(
      { sites: ['01646500', '12024000'], parameterCds: ['00060'] },
      createMockContext(),
    );

    const bySite = new Map(series.map((s) => [s.siteNumber, s]));
    expect(bySite.get('01646500')?.values.at(-1)).toEqual({
      dateTime: '2026-09-24T23:50:00.000-04:00',
      value: '3510',
      qualifiers: ['P'],
    });
    expect(bySite.get('12024000')?.values.map((v) => v.value)).toEqual(Array(7).fill(''));
  });
});

describe('a response body that is not valid WaterML-JSON (#46)', () => {
  const POTOMAC_IV = {
    endpoint: 'iv',
    sites: '01646500',
    parameterCd: '00060',
    fixture: 'iv-01646500-00060.json',
  } as const;
  const POTOMAC_DV = {
    endpoint: 'dv',
    sites: '01646500',
    parameterCd: '00060',
    fixture: 'dv-01646500-00060-20240101-20240110.json',
  } as const;

  const readPotomac = () =>
    getReadings({ sites: ['01646500'], parameterCds: ['00060'] }, createMockContext());
  const seriesPotomac = () =>
    getSeries(
      {
        site: '01646500',
        parameterCd: '00060',
        startDate: '2024-01-01',
        endDate: '2024-01-10',
        seriesType: 'daily',
      },
      createMockContext(),
    );

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries an HTTP 503 and returns the next good response (characterization)', async () => {
    http.route(
      nwisBodyRoute(POTOMAC_IV, 'Service Unavailable', { status: 503, once: true }),
      nwisRoute(POTOMAC_IV),
    );
    const series = await afterRetries(readPotomac());

    expect(http.calls).toHaveLength(2);
    expect(series[0]?.values).toHaveLength(11);
  });

  it('surfaces a persistent HTTP 503 as upstream_error after four attempts (characterization)', async () => {
    http.route(nwisBodyRoute(POTOMAC_IV, 'Service Unavailable', { status: 503 }));
    const error = await captureError(() => afterRetries(readPotomac()));

    expect(http.calls).toHaveLength(4);
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(classifyNwisFailure(error)?.reason).toBe('upstream_error');
  });

  it('retries a truncated IV body and returns the next good response, parsed as usual', async () => {
    http.route(
      nwisBodyRoute(POTOMAC_IV, truncatedFixture(POTOMAC_IV.fixture), { once: true }),
      nwisRoute(POTOMAC_IV),
    );
    const series = await afterRetries(readPotomac());

    expect(http.calls).toHaveLength(2);
    expect(series).toHaveLength(1);
    expect(series[0]?.values).toHaveLength(11);
    expect(series[0]?.values[0]).toEqual({
      dateTime: '2026-09-24T22:00:00.000-04:00',
      value: '3510',
      qualifiers: ['P'],
    });
  });

  it('retries a truncated DV body and returns the next good response, parsed as usual', async () => {
    http.route(
      nwisBodyRoute(POTOMAC_DV, truncatedFixture(POTOMAC_DV.fixture), { once: true }),
      nwisRoute(POTOMAC_DV),
    );
    const series = await afterRetries(seriesPotomac());

    expect(http.calls).toHaveLength(2);
    expect(series[0]?.values.map((v) => v.value).slice(0, 2)).toEqual(['8930', '7760']);
  });

  it('fails a persistently truncated IV body as upstream_error after four attempts', async () => {
    http.route(nwisBodyRoute(POTOMAC_IV, truncatedFixture(POTOMAC_IV.fixture)));
    const error = await captureError(() => afterRetries(readPotomac()));

    expect(http.calls).toHaveLength(4);
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect((error as McpError).message).toContain('not valid WaterML-JSON');
    expect(classifyNwisFailure(error)?.reason).toBe('upstream_error');
  });

  it('fails a persistently truncated DV body as upstream_error after four attempts', async () => {
    http.route(nwisBodyRoute(POTOMAC_DV, truncatedFixture(POTOMAC_DV.fixture)));
    const error = await captureError(() => afterRetries(seriesPotomac()));

    expect(http.calls).toHaveLength(4);
    expect(classifyNwisFailure(error)?.reason).toBe('upstream_error');
  });

  it.each([
    ['an empty body', ''],
    ['an HTML page', '<!DOCTYPE html><html><body>Gateway error</body></html>'],
    ['JSON null', 'null'],
    ['a JSON object with no timeSeries document', '{"error":"backend unavailable"}'],
  ])('treats %s at HTTP 200 as the same transient failure', async (_label, body) => {
    http.route(nwisBodyRoute(POTOMAC_IV, body));
    const error = await captureError(() => afterRetries(readPotomac()));

    expect(http.calls).toHaveLength(4);
    expect(classifyNwisFailure(error)?.reason).toBe('upstream_error');
  });
});
