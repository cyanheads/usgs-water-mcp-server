/**
 * @fileoverview water_get_series driven end to end against captured NWIS DV and IV responses —
 * the real service layer and WaterML parser run behind a strict fetch mock, and results are
 * asserted on the assembled tool result. DataCanvas stays disabled here; staging and table naming
 * are covered in water-get-series.tool.test.ts.
 * @module tests/tools/water-get-series.upstream.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  type FetchMockHarness,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waterGetSeries } from '@/mcp-server/tools/definitions/water-get-series.tool.js';
import { declaredRecovery } from '../helpers/error-contract.js';
import {
  afterRetries,
  allText,
  nwisBodyRoute,
  nwisFixture,
  nwisRoute,
  truncatedFixture,
} from '../helpers/nwis-fixtures.js';

type OtherSeries = {
  methodDescription: string | null;
  methodId: string | null;
  recordCount: number;
  statCd: string;
  statName: string | null;
};
type Series = {
  methodDescription?: string | null;
  methodId?: string | null;
  otherSeries?: OtherSeries[];
  statCd?: string;
  statName?: string | null;
  totalRecords: number;
  truncated: boolean;
  values: { dateTime: string; qualifiers: string[]; value: string }[];
};

const TEMPERATURE_2019 = {
  site: '01646500',
  parameterCd: '00010',
  startDate: '2019-09-01',
  endDate: '2019-09-05',
} as const;

let http: FetchMockHarness;

beforeEach(() => {
  http = createFetchMock();
  http.install();
});

afterEach(() => {
  http.restore();
});

/** Route the unfiltered multi-statistic DV capture. */
function routeAllStatistics() {
  http.route(
    nwisRoute({
      endpoint: 'dv',
      sites: '01646500',
      parameterCd: '00010',
      fixture: 'dv-01646500-00010-20190901-20190905.json',
    }),
  );
}

/** Route the DV capture NWIS returns when asked for statCd=00003. */
function routeMeanOnly() {
  http.route(
    nwisRoute({
      endpoint: 'dv',
      sites: '01646500',
      parameterCd: '00010',
      statCd: '00003',
      fixture: 'dv-01646500-00010-20190901-20190905-stat00003.json',
    }),
  );
}

describe('water_get_series against captured NWIS responses', () => {
  it('returns a single-statistic, single-method daily series whole (characterization)', async () => {
    http.route(
      nwisRoute({
        endpoint: 'dv',
        sites: '01646500',
        parameterCd: '00060',
        fixture: 'dv-01646500-00060-20240101-20240110.json',
      }),
    );
    const result = await runToolContract(waterGetSeries, {
      site: '01646500',
      parameterCd: '00060',
      startDate: '2024-01-01',
      endDate: '2024-01-10',
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Series;
    expect(structured).toMatchObject({ totalRecords: 10, truncated: false });
    expect(structured.values[0]).toEqual({
      dateTime: '2024-01-01T00:00:00.000',
      value: '8930',
      qualifiers: ['A'],
    });
    const text = allText(result.content);
    expect(text).toContain('**Series type:** daily | **Total records:** 10');
    expect(text).toContain('- 2024-01-10T00:00:00.000: **39000** ft3/s [A]');
  });

  describe('statistic and method selection (#43)', () => {
    it('returns the daily mean by default, not the first statistic NWIS lists', async () => {
      routeAllStatistics();
      const result = await runToolContract(waterGetSeries, TEMPERATURE_2019);

      const structured = result.structuredContent as Series;
      expect(structured).toMatchObject({ statCd: '00003', statName: 'Mean', totalRecords: 5 });
      // Every mean method holds 5 records; the tie goes to the first in response order.
      expect(structured).toMatchObject({
        methodId: '68481',
        methodDescription: '4.1 ft from riverbed (middle), [Discontinued]',
      });
      expect(structured.values.map((v) => v.value)).toEqual([
        '26.7',
        '27.0',
        '27.0',
        '27.7',
        '27.7',
      ]);

      const text = allText(result.content);
      expect(text).toContain(
        '**Statistic:** Mean (statCd 00003) | **Method:** 4.1 ft from riverbed (middle), [Discontinued] | **Method ID:** 68481',
      );
      expect(text).toContain('- 2019-09-01T00:00:00.000: **26.7** deg C [A]');
    });

    it('discloses every other statistic × method on both surfaces', async () => {
      routeAllStatistics();
      const result = await runToolContract(waterGetSeries, TEMPERATURE_2019);

      const others = (result.structuredContent as Series).otherSeries ?? [];
      expect(others).toHaveLength(11);
      expect(others).toContainEqual({
        statCd: '00003',
        statName: 'Mean',
        methodId: '300173',
        methodDescription: 'From multiparameter sonde',
        recordCount: 5,
      });
      expect(others).toContainEqual(
        expect.objectContaining({ statCd: '00001', statName: 'Maximum', methodId: '68479' }),
      );
      expect(allText(result.content)).toContain(
        'Mean (statCd 00003), From multiparameter sonde (methodId 300173), 5 records',
      );
    });

    it('forwards statCd and selects the requested method', async () => {
      routeMeanOnly();
      const result = await runToolContract(waterGetSeries, {
        ...TEMPERATURE_2019,
        statCd: '00003',
        methodId: '300173',
      });

      const structured = result.structuredContent as Series;
      expect(structured).toMatchObject({
        statCd: '00003',
        methodId: '300173',
        methodDescription: 'From multiparameter sonde',
      });
      expect(structured.values.map((v) => v.value)).toEqual([
        '26.6',
        '26.9',
        '26.9',
        '27.6',
        '27.6',
      ]);
      expect(structured.otherSeries?.map((s) => s.methodId)).toEqual(['68481', '68484', '68487']);
      expect(allText(result.content)).toContain('statCd=00003, methodId=300173');
    });

    it('resolves a methodId from another statistic without a statCd', async () => {
      routeAllStatistics();
      const result = await runToolContract(waterGetSeries, {
        ...TEMPERATURE_2019,
        methodId: '68479',
      });

      expect(result.structuredContent).toMatchObject({
        statCd: '00001',
        statName: 'Maximum',
        methodId: '68479',
        values: expect.arrayContaining([expect.objectContaining({ value: '29.0' })]),
      });
    });

    it('treats empty-string statCd and methodId as omitted', async () => {
      routeAllStatistics();
      const result = await runToolContract(waterGetSeries, {
        ...TEMPERATURE_2019,
        statCd: '',
        methodId: '',
      });

      expect(result.structuredContent).toMatchObject({ statCd: '00003', methodId: '68481' });
      expect(new URL(http.calls[0]?.request.url ?? '').searchParams.has('statCd')).toBe(false);
    });

    it('accepts statCd "00000" on an instantaneous series without sending it upstream', async () => {
      http.route(
        nwisRoute({
          endpoint: 'iv',
          sites: '12056500',
          parameterCd: '00010',
          fixture: 'iv-12056500-00010.json',
        }),
      );
      const result = await runToolContract(waterGetSeries, {
        site: '12056500',
        parameterCd: '00010',
        startDate: '2026-09-24',
        endDate: '2026-09-24',
        seriesType: 'instantaneous',
        statCd: '00000',
      });

      // Most records wins: the unnamed method holds 7, the QW sonde 6.
      expect(result.structuredContent).toMatchObject({
        statCd: '00000',
        statName: null,
        methodId: '150723',
        totalRecords: 7,
        otherSeries: [
          {
            statCd: '00000',
            statName: null,
            methodId: '352066',
            methodDescription: 'QWsonde-EXO, [From QW Sonde]',
            recordCount: 6,
          },
        ],
      });
    });
  });

  describe('selection errors', () => {
    it('reports method_not_found with the methods that do exist', async () => {
      routeMeanOnly();
      const result = await runToolContract(waterGetSeries, {
        ...TEMPERATURE_2019,
        statCd: '00003',
        methodId: '68479',
      });

      expect(result.isError).toBe(true);
      const error = (
        result.structuredContent as { error: { code: number; data: Record<string, unknown> } }
      ).error;
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data['reason']).toBe('method_not_found');
      const hint = (error.data['recovery'] as { hint: string }).hint;
      expect(hint).toContain('statCd 00003, methodId 300173 (From multiparameter sonde)');
      expect(hint).not.toContain('68479');

      const text = allText(result.content);
      expect(text).toContain('methodId "68479"');
      expect(text).toContain('(reason method_not_found)');
    });

    it('rejects a malformed statCd before any NWIS request', async () => {
      const result = await runToolContract(waterGetSeries, { ...TEMPERATURE_2019, statCd: 'mean' });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.ValidationError, data: { reason: 'invalid_stat_cd' } },
      });
      expect(allText(result.content)).toContain('"00003" (mean)');
      expect(http.calls).toHaveLength(0);
    });

    it('rejects a daily statCd on an instantaneous series before any NWIS request', async () => {
      const result = await runToolContract(waterGetSeries, {
        ...TEMPERATURE_2019,
        seriesType: 'instantaneous',
        statCd: '00003',
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'stat_cd_for_instantaneous' },
        },
      });
      expect(allText(result.content)).toContain('set seriesType to "daily"');
      expect(http.calls).toHaveLength(0);
    });

    it('reports no_data_for_range, naming the statistic, when NWIS has none for a requested statCd', async () => {
      http.route({
        method: 'GET',
        match: (request) => new URL(request.url).searchParams.get('statCd') === '00008',
        respond: () => Response.json({ value: { timeSeries: [] } }),
      });
      const result = await runToolContract(waterGetSeries, {
        ...TEMPERATURE_2019,
        statCd: '00008',
      });

      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'no_data_for_range' } },
      });
      expect(allText(result.content)).toContain('no daily statistic 00008');
    });
  });
});

describe('the NWIS no-data sentinel (#45)', () => {
  it('returns a seasonal gage record as missing with its qualifiers, never as a magnitude', async () => {
    http.route(
      nwisRoute({
        endpoint: 'dv',
        sites: '12024000',
        parameterCd: '00060',
        fixture: 'dv-12024000-00060-20260910-20260924.json',
      }),
    );
    const result = await runToolContract(waterGetSeries, {
      site: '12024000',
      parameterCd: '00060',
      startDate: '2026-09-10',
      endDate: '2026-09-24',
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Series;
    expect(structured.totalRecords).toBe(14);
    expect(structured.values.at(-1)).toEqual({
      dateTime: '2026-09-23T00:00:00.000',
      value: '',
      qualifiers: ['P', 'Ssn'],
    });
    expect(structured.values.every((v) => v.value === '')).toBe(true);

    const text = allText(result.content);
    expect(text).not.toContain('-999999');
    expect(text).toContain('- 2026-09-23T00:00:00.000: no data [P,Ssn]');
  });

  /**
   * The captured single-series Potomac discharge response (10 daily means, method 68478), re-shaped
   * per test into several statistics and methods. A block marked `missing` holds the series'
   * no-data value (-999999) in every record, qualified [P,Dis], the way NWIS reports a
   * discontinued sensor.
   */
  describe('default selection over series that hold no measured value', () => {
    type Block = { methodID: number; missing?: boolean; records: number };
    type Statistic = { blocks: Block[]; statCd: string; statName: string };
    type ValueRecord = { dateTime: string; qualifiers: string[]; value: string };
    type TimeSeries = {
      name: string;
      values: { method: { methodDescription: string; methodID: number }[]; value: ValueRecord[] }[];
      variable: { options: { option: { name: string; optionCode: string; value: string }[] } };
    };

    const POTOMAC_DISCHARGE = {
      site: '01646500',
      parameterCd: '00060',
      startDate: '2024-01-01',
      endDate: '2024-01-10',
    } as const;

    function routeStatistics(statistics: Statistic[]) {
      const captured = JSON.parse(nwisFixture('dv-01646500-00060-20240101-20240110.json')) as {
        value: { timeSeries: TimeSeries[] };
      };
      const template = captured.value.timeSeries[0];
      if (!template) throw new Error('Fixture lost its timeSeries.');
      const records = template.values[0]?.value ?? [];
      captured.value.timeSeries = statistics.map((stat) => ({
        ...template,
        name: `USGS:01646500:00060:${stat.statCd}`,
        variable: {
          ...template.variable,
          options: {
            option: [{ name: 'Statistic', optionCode: stat.statCd, value: stat.statName }],
          },
        },
        values: stat.blocks.map((block) => ({
          ...template.values[0],
          method: [{ methodDescription: '', methodID: block.methodID }],
          value: records
            .slice(0, block.records)
            .map((r) => (block.missing ? { ...r, value: '-999999', qualifiers: ['P', 'Dis'] } : r)),
        })),
      }));
      http.route(
        nwisBodyRoute(
          {
            endpoint: 'dv',
            sites: '01646500',
            parameterCd: '00060',
            fixture: 'dv-01646500-00060-20240101-20240110.json',
          },
          JSON.stringify(captured),
        ),
      );
    }

    it('picks the method with the most records when every method measures (characterization)', async () => {
      routeStatistics([
        {
          statCd: '00003',
          statName: 'Mean',
          blocks: [
            { methodID: 1, records: 3 },
            { methodID: 2, records: 6 },
          ],
        },
      ]);
      const result = await runToolContract(waterGetSeries, POTOMAC_DISCHARGE);

      expect(result.structuredContent).toMatchObject({ methodId: '2', totalRecords: 6 });
      expect(allText(result.content)).toContain('**Method ID:** 2');
    });

    it('keeps the default pick when every series is all no-data (characterization)', async () => {
      routeStatistics([
        {
          statCd: '00001',
          statName: 'Maximum',
          blocks: [{ methodID: 11, records: 10, missing: true }],
        },
        {
          statCd: '00003',
          statName: 'Mean',
          blocks: [
            { methodID: 1, records: 4, missing: true },
            { methodID: 2, records: 10, missing: true },
          ],
        },
      ]);
      const result = await runToolContract(waterGetSeries, POTOMAC_DISCHARGE);

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as Series;
      expect(structured).toMatchObject({ statCd: '00003', methodId: '2', totalRecords: 10 });
      expect(structured.values.every((v) => v.value === '')).toBe(true);
      expect(allText(result.content)).toContain('- 2024-01-10T00:00:00.000: no data [P,Dis]');
    });

    it('still returns an all-no-data method the caller names (characterization)', async () => {
      routeStatistics([
        {
          statCd: '00003',
          statName: 'Mean',
          blocks: [
            { methodID: 1, records: 10, missing: true },
            { methodID: 2, records: 3 },
          ],
        },
      ]);
      const result = await runToolContract(waterGetSeries, { ...POTOMAC_DISCHARGE, methodId: '1' });

      const structured = result.structuredContent as Series;
      expect(structured).toMatchObject({ methodId: '1', totalRecords: 10 });
      expect(structured.values.every((v) => v.value === '')).toBe(true);
    });

    it('prefers a measuring method over an all-no-data sibling with more records', async () => {
      routeStatistics([
        {
          statCd: '00003',
          statName: 'Mean',
          blocks: [
            { methodID: 1, records: 10, missing: true },
            { methodID: 2, records: 3 },
          ],
        },
      ]);
      const result = await runToolContract(waterGetSeries, POTOMAC_DISCHARGE);

      const structured = result.structuredContent as Series;
      expect(structured).toMatchObject({ statCd: '00003', methodId: '2', totalRecords: 3 });
      expect(structured.values.map((v) => v.value)).toEqual(['8930', '7760', expect.any(String)]);
      expect(structured.otherSeries).toEqual([
        {
          statCd: '00003',
          statName: 'Mean',
          methodId: '1',
          methodDescription: null,
          recordCount: 10,
        },
      ]);

      const text = allText(result.content);
      expect(text).toContain('**Method ID:** 2');
      expect(text).toContain('- 2024-01-01T00:00:00.000: **8930** ft3/s [A]');
      expect(text).toContain('Mean (statCd 00003), (no description) (methodId 1), 10 records');
      expect(text).not.toContain('no data');
    });

    it('falls back to a measuring statistic when the mean series is all no-data', async () => {
      routeStatistics([
        {
          statCd: '00001',
          statName: 'Maximum',
          blocks: [{ methodID: 11, records: 5 }],
        },
        {
          statCd: '00003',
          statName: 'Mean',
          blocks: [{ methodID: 1, records: 10, missing: true }],
        },
      ]);
      const result = await runToolContract(waterGetSeries, POTOMAC_DISCHARGE);

      const structured = result.structuredContent as Series;
      expect(structured).toMatchObject({
        statCd: '00001',
        statName: 'Maximum',
        methodId: '11',
        totalRecords: 5,
      });
      expect(structured.otherSeries).toEqual([
        expect.objectContaining({ statCd: '00003', methodId: '1', recordCount: 10 }),
      ]);

      const text = allText(result.content);
      expect(text).toContain('**Statistic:** Maximum (statCd 00001)');
      expect(text).toContain('- 2024-01-01T00:00:00.000: **8930** ft3/s [A]');
    });
  });
});

describe('a truncated NWIS response body (#46)', () => {
  const POTOMAC_DV = {
    endpoint: 'dv',
    sites: '01646500',
    parameterCd: '00060',
    fixture: 'dv-01646500-00060-20240101-20240110.json',
  } as const;
  const INPUT = {
    site: '01646500',
    parameterCd: '00060',
    startDate: '2024-01-01',
    endDate: '2024-01-10',
  } as const;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('recovers when the retry returns a whole body', async () => {
    http.route(
      nwisBodyRoute(POTOMAC_DV, truncatedFixture(POTOMAC_DV.fixture), { once: true }),
      nwisRoute(POTOMAC_DV),
    );
    const result = await afterRetries(runToolContract(waterGetSeries, INPUT));

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ totalRecords: 10, truncated: false });
    expect(allText(result.content)).toContain('- 2024-01-10T00:00:00.000: **39000** ft3/s [A]');
  });

  it('fails as upstream_error with its recovery hint when every attempt is truncated', async () => {
    http.route(nwisBodyRoute(POTOMAC_DV, truncatedFixture(POTOMAC_DV.fixture)));
    const result = await afterRetries(runToolContract(waterGetSeries, INPUT));

    expect(http.calls).toHaveLength(4);
    expect(result.isError).toBe(true);
    const recovery = declaredRecovery(waterGetSeries.errors, 'upstream_error');
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_error', recovery },
      },
    });
    const text = allText(result.content);
    expect(text).toContain('(reason upstream_error · retryable)');
    expect(text).toContain(recovery.hint);
  });
});
