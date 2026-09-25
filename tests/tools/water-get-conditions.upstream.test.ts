/**
 * @fileoverview water_get_conditions driven end to end against captured NWIS IV and stat
 * responses — the real service layer, WaterML parser, and RDB parser run behind a strict fetch
 * mock, and results are asserted on the assembled tool result.
 * @module tests/tools/water-get-conditions.upstream.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  type FetchMockHarness,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waterGetConditions } from '@/mcp-server/tools/definitions/water-get-conditions.tool.js';
import { declaredRecovery } from '../helpers/error-contract.js';
import {
  afterRetries,
  allText,
  nwisBodyRoute,
  nwisFixture,
  nwisRoute,
  truncatedFixture,
} from '../helpers/nwis-fixtures.js';

type Conditions = {
  currentDateTime: string;
  currentValue: string;
  historicalContext: {
    methodMatched?: boolean;
    p50: number | null;
    percentileClass: string;
    periodOfRecord: string;
    statSeriesDescription?: string | null;
    statSeriesId?: string | null;
  } | null;
  historicalContextStatus: string;
  methodDescription?: string | null;
  methodId?: string | null;
  note?: string;
};

let http: FetchMockHarness;

beforeEach(() => {
  http = createFetchMock();
  http.install();
});

afterEach(() => {
  http.restore();
});

/** Route one site+parameter's IV capture and its stat table, then run the tool. */
async function conditionsFor(
  site: string,
  parameterCd: string,
  ivFixture: string,
  statFixture: string,
) {
  http.route(
    nwisRoute({ endpoint: 'iv', sites: site, parameterCd, fixture: ivFixture }),
    nwisRoute({ endpoint: 'stat', sites: site, parameterCd, fixture: statFixture }),
  );
  const result = await runToolContract(waterGetConditions, { site, parameterCd });
  return {
    result,
    structured: result.structuredContent as Conditions,
    text: allText(result.content),
  };
}

describe('water_get_conditions against captured NWIS responses', () => {
  it('ranks a single-method reading against its stat row (characterization)', async () => {
    const { result, structured, text } = await conditionsFor(
      '01646500',
      '00060',
      'iv-01646500-00060.json',
      'stat-01646500-00060-0924.rdb',
    );

    expect(result.isError).toBeFalsy();
    expect(structured).toMatchObject({
      currentValue: '3510',
      currentDateTime: '2026-09-24T22:50:00.000-04:00',
      historicalContextStatus: 'available',
      historicalContext: { percentileClass: 'normal', periodOfRecord: '1930–2025', p50: 2110 },
    });
    expect(text).toContain('**Current value:** 3510 ft3/s [P]');
    expect(text).toContain(
      '**Condition:** normal — 25th–75th percentile | **Period of record:** 1930–2025',
    );
  });

  describe('multiple method blocks (#43)', () => {
    it('reports the reading held in a second method block instead of failing', async () => {
      const { result, structured, text } = await conditionsFor(
        '12036400',
        '00060',
        'iv-12036400-00060.json',
        'stat-12036400-00060-empty.rdb',
      );

      expect(result.isError).toBeFalsy();
      expect(structured).toMatchObject({
        currentValue: '4.42',
        currentDateTime: '2026-09-24T19:45:00.000-07:00',
        methodId: '306966',
        methodDescription: null,
        historicalContext: null,
        historicalContextStatus: 'no_record',
      });
      expect(text).toContain('**Method:** (no description) | **Method ID:** 306966');
    });

    it("ranks against the reporting sensor's own percentiles, matched by description", async () => {
      // Four discontinued sensors precede the live sonde in both the IV and stat responses; the
      // first stat series in the table is a sensor retired in 2019.
      const { structured, text } = await conditionsFor(
        '01646500',
        '00010',
        'iv-01646500-00010.json',
        'stat-01646500-00010-0924.rdb',
      );

      expect(structured).toMatchObject({
        currentValue: '19.9',
        methodId: '252060',
        methodDescription: 'From multiparameter sonde',
        historicalContextStatus: 'available',
        historicalContext: {
          periodOfRecord: '2019–2025',
          p50: 21.5,
          percentileClass: 'normal',
          statSeriesId: '300173',
          statSeriesDescription: 'From multiparameter sonde',
          methodMatched: true,
        },
      });
      expect(text).toContain('**Period of record:** 2019–2025');
      expect(text).toContain(
        '**Percentile series:** From multiparameter sonde | **Stat series ID:** 300173 | matched to the reported method by description',
      );
    });

    it('uses the most recent reading across methods, not the first block', async () => {
      // Block "" last reads 20:30; the QW sonde block last reads 20:15.
      const { structured } = await conditionsFor(
        '12056500',
        '00010',
        'iv-12056500-00010.json',
        'stat-12056500-00010-0924.rdb',
      );

      expect(structured).toMatchObject({
        currentValue: '10.0',
        currentDateTime: '2026-09-24T20:30:00.000-07:00',
        methodId: '150723',
        historicalContext: {
          statSeriesId: '148577',
          methodMatched: true,
          periodOfRecord: '1990–2025',
        },
      });
    });

    it('prefers the sensor its stat series is described as over a newer unmatched sensor', async () => {
      // The QW sonde reports a quarter hour after the unlabeled sensor here; the lone stat series
      // (blank description) is the unlabeled sensor's. Ranking the sonde against it would swap the
      // sensor behind the answer with whichever one reported last.
      const iv = JSON.parse(nwisFixture('iv-12056500-00010.json')) as {
        value: { timeSeries: { values: { value: { dateTime: string }[] }[] }[] };
      };
      const unlabeled = iv.value.timeSeries[0]?.values[0];
      if (!unlabeled) throw new Error('Fixture lost its unlabeled block.');
      unlabeled.value = unlabeled.value.filter((v) => v.dateTime < '2026-09-24T20:15');
      http.route(
        nwisBodyRoute(
          { endpoint: 'iv', sites: '12056500', parameterCd: '00010', fixture: '' },
          JSON.stringify(iv),
        ),
        nwisRoute({
          endpoint: 'stat',
          sites: '12056500',
          parameterCd: '00010',
          fixture: 'stat-12056500-00010-0924.rdb',
        }),
      );
      const result = await runToolContract(waterGetConditions, {
        site: '12056500',
        parameterCd: '00010',
      });

      expect(result.structuredContent).toMatchObject({
        currentValue: '10.0',
        currentDateTime: '2026-09-24T20:00:00.000-07:00',
        methodId: '150723',
        historicalContext: { statSeriesId: '148577', methodMatched: true },
      });
    });

    it('ranks against the stat series whose description matches apart from its bracketed label', async () => {
      // The stat table labels the two gages "[BASE GAGE]" and "AUXILIARY GAGE, [AUXILIARY GAGE]";
      // IV calls them "" and "AUXILIARY GAGE". Both gages last read at 20:00.
      const { structured, text } = await conditionsFor(
        '12396500',
        '00065',
        'iv-12396500-00065.json',
        'stat-12396500-00065-0924.rdb',
      );

      expect(structured).toMatchObject({
        currentValue: '87.99',
        methodId: '151590',
        methodDescription: null,
        historicalContextStatus: 'available',
        historicalContext: {
          percentileClass: 'above-normal',
          statSeriesId: '149574',
          statSeriesDescription: '[BASE GAGE]',
          methodMatched: false,
        },
      });
      expect(structured.note).toContain('[BASE GAGE]');
      expect(text).toContain('**Stat series ID:** 149574');
      expect(text).toContain(structured.note ?? '(missing note)');
    });

    it('declines to rank when several stat series exist and none is identified', async () => {
      // The captured gages relabeled so no stat series description matches either one, even with
      // the stat table's bracketed labels set aside. Both last read at 20:00; the first block wins.
      const iv = JSON.parse(nwisFixture('iv-12396500-00065.json')) as {
        value: { timeSeries: { values: { method: { methodDescription: string }[] }[] }[] };
      };
      for (const [i, block] of (iv.value.timeSeries[0]?.values ?? []).entries()) {
        const method = block.method[0];
        if (method) method.methodDescription = i === 0 ? 'LEFT BANK' : 'RIGHT BANK';
      }
      http.route(
        nwisBodyRoute(
          { endpoint: 'iv', sites: '12396500', parameterCd: '00065', fixture: '' },
          JSON.stringify(iv),
        ),
        nwisRoute({
          endpoint: 'stat',
          sites: '12396500',
          parameterCd: '00065',
          fixture: 'stat-12396500-00065-0924.rdb',
        }),
      );
      const result = await runToolContract(waterGetConditions, {
        site: '12396500',
        parameterCd: '00065',
      });
      const structured = result.structuredContent as Conditions;
      const text = allText(result.content);

      expect(structured).toMatchObject({
        currentValue: '87.99',
        methodId: '151590',
        methodDescription: 'LEFT BANK',
        historicalContext: null,
        historicalContextStatus: 'no_matching_method',
      });
      expect(structured.note).toContain('[BASE GAGE] [ts_id 149574]');
      expect(structured.note).toContain('AUXILIARY GAGE, [AUXILIARY GAGE] [ts_id 149575]');
      expect(text).toContain('**Historical context status:** no_matching_method');
      expect(text).toContain('[BASE GAGE] [ts_id 149574]');
    });

    /**
     * #44: stat series 300173 publishes p25 19.5 and p75 23.7 for September 24 with p05, p10, and
     * p95 blank. The captured sonde reading (19.9) sits inside the quartiles; the IV body is
     * re-served with the sonde's latest value replaced to place a reading outside them.
     */
    describe('against a stat series with blank outer percentiles', () => {
      async function withSondeReading(value: string) {
        const iv = JSON.parse(nwisFixture('iv-01646500-00010.json')) as {
          value: { timeSeries: { values: { value: { value: string }[] }[] }[] };
        };
        const sonde = iv.value.timeSeries[0]?.values.at(-1)?.value.at(-1);
        if (!sonde) throw new Error('Fixture lost its sonde block.');
        sonde.value = value;
        http.route(
          {
            method: 'GET',
            match: (request) => new URL(request.url).pathname === '/nwis/iv/',
            respond: () => new Response(JSON.stringify(iv), { status: 200 }),
          },
          nwisRoute({
            endpoint: 'stat',
            sites: '01646500',
            parameterCd: '00010',
            fixture: 'stat-01646500-00010-0924.rdb',
          }),
        );
        const result = await runToolContract(waterGetConditions, {
          site: '01646500',
          parameterCd: '00010',
        });
        return {
          structured: result.structuredContent as Conditions & {
            historicalContext: { percentileLabel: string } | null;
          },
          text: allText(result.content),
        };
      }

      it('reports a reading above p75 as above-normal, naming the blank 95th', async () => {
        const { structured, text } = await withSondeReading('24.0');
        expect(structured.historicalContext).toMatchObject({
          statSeriesId: '300173',
          percentileClass: 'above-normal',
          percentileLabel: '≥ 75th percentile; 95th not published',
          p25: 19.5,
          p75: 23.7,
          p95: null,
        });
        expect(text).toContain(
          '**Condition:** above-normal — ≥ 75th percentile; 95th not published |',
        );
      });

      it('reports a reading below p25 as below-normal, naming the blank 10th', async () => {
        const { structured, text } = await withSondeReading('19.0');
        expect(structured.historicalContext).toMatchObject({
          percentileClass: 'below-normal',
          percentileLabel: '< 25th percentile; 10th not published',
          p05: null,
          p10: null,
        });
        expect(text).toContain(
          '**Condition:** below-normal — < 25th percentile; 10th not published |',
        );
      });
    });

    it('ranks against a lone stat series whose description differs, and says it is unmatched', async () => {
      const { structured, text } = await conditionsFor(
        '14233500',
        '00060',
        'iv-14233500-00060.json',
        'stat-14233500-00060-0924.rdb',
      );

      expect(structured).toMatchObject({
        currentValue: '674',
        methodId: '152130',
        methodDescription: '[(2)]',
        historicalContextStatus: 'available',
        historicalContext: {
          percentileClass: 'record-low',
          statSeriesId: '150441',
          statSeriesDescription: null,
          methodMatched: false,
        },
      });
      expect(text).toContain('not matched to the reported method');
    });
  });
});

describe('a truncated NWIS IV response body (#46)', () => {
  const POTOMAC_IV = {
    endpoint: 'iv',
    sites: '01646500',
    parameterCd: '00060',
    fixture: 'iv-01646500-00060.json',
  } as const;
  const POTOMAC_STAT = {
    endpoint: 'stat',
    sites: '01646500',
    parameterCd: '00060',
    fixture: 'stat-01646500-00060-0924.rdb',
  } as const;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('recovers when the retry returns a whole body', async () => {
    http.route(
      nwisBodyRoute(POTOMAC_IV, truncatedFixture(POTOMAC_IV.fixture), { once: true }),
      nwisRoute(POTOMAC_IV),
      nwisRoute(POTOMAC_STAT),
    );
    const result = await afterRetries(
      runToolContract(waterGetConditions, { site: '01646500', parameterCd: '00060' }),
    );

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      currentValue: '3510',
      historicalContext: { percentileClass: 'normal' },
    });
    expect(allText(result.content)).toContain('**Current value:** 3510 ft3/s [P]');
  });

  it('fails as upstream_error with its recovery hint when every attempt is truncated', async () => {
    http.route(
      nwisBodyRoute(POTOMAC_IV, truncatedFixture(POTOMAC_IV.fixture)),
      nwisRoute(POTOMAC_STAT),
    );
    const result = await afterRetries(
      runToolContract(waterGetConditions, { site: '01646500', parameterCd: '00060' }),
    );

    expect(http.calls.filter((c) => new URL(c.request.url).pathname === '/nwis/iv/')).toHaveLength(
      4,
    );
    expect(result.isError).toBe(true);
    const recovery = declaredRecovery(waterGetConditions.errors, 'upstream_error');
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

describe('the NWIS no-data sentinel (#45)', () => {
  it('reports a -999999 reading as missing and unranked, naming its qualifiers', async () => {
    // A seasonal gage: every record NWIS returns is -999999 qualified [P,Ssn], while the stat
    // table still publishes percentiles for the day (p05 = 20 ft3/s).
    const { result, structured, text } = await conditionsFor(
      '12024000',
      '00060',
      'iv-12024000-00060.json',
      'stat-12024000-00060-0924.rdb',
    );

    expect(result.isError).toBeFalsy();
    expect(structured).toMatchObject({
      currentValue: '',
      currentDateTime: '2026-09-24T21:30:00.000-07:00',
      qualifiers: ['P', 'Ssn'],
      historicalContextStatus: 'available',
      historicalContext: { percentileClass: 'unknown', p05: 20, periodOfRecord: '1944–1971' },
    });
    const context = structured.historicalContext as { percentileLabel: string } | null;
    expect(context?.percentileLabel).toContain('Ssn');
    expect(context?.percentileLabel).not.toBe('insufficient percentile data');
    expect(structured.note).toContain('Ssn');

    expect(text).not.toContain('-999999');
    expect(text).not.toContain('record-low');
    expect(text).toContain('**Current value:** no data [P,Ssn]');
    expect(text).toContain('**Condition:** unknown — ');
  });
});
