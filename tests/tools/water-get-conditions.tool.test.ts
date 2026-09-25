/**
 * @fileoverview Tests for water_get_conditions tool — current value with historical percentile context.
 * Mocks the nwis-service module to avoid live API calls.
 * @module tests/tools/water-get-conditions.tool.test
 */

import {
  JsonRpcErrorCode,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waterGetConditions } from '@/mcp-server/tools/definitions/water-get-conditions.tool.js';
import type { NwisStatResult, NwisStatRow, NwisTimeSeries } from '@/services/nwis/types.js';
import { textContent } from '../helpers/content-block.js';
import { declaredRecovery } from '../helpers/error-contract.js';
import { allText } from '../helpers/nwis-fixtures.js';

const recovery = (reason: string) => declaredRecovery(waterGetConditions.errors, reason);

// Stub the network calls; keep the real classifyNwisFailure — it is pure, and the handler's IV-side
// error mapping under test here depends on it.
vi.mock('@/services/nwis/nwis-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/nwis/nwis-service.js')>()),
  getReadings: vi.fn(),
  getStats: vi.fn(),
  getSeries: vi.fn(),
  findSites: vi.fn(),
  getSiteInfo: vi.fn(),
}));

import { getReadings, getStats } from '@/services/nwis/nwis-service.js';

const mockGetReadings = vi.mocked(getReadings);
const mockGetStats = vi.mocked(getStats);

/** A deterministic date that maps to month=6, day=4 for stat lookup. */
const CURRENT_DATETIME = '2026-06-04T14:15:00-04:00';

const MOCK_IV: NwisTimeSeries[] = [
  {
    siteNumber: '01646500',
    siteName: 'POTOMAC RIVER AT LITTLE FALLS',
    parameterCd: '00060',
    parameterName: 'Streamflow, ft³/s',
    unitCode: 'ft3/s',
    methodId: '69928',
    methodDescription: null,
    statCd: '00000',
    statName: null,
    values: [
      { dateTime: '2026-06-04T14:00:00-04:00', value: '5000', qualifiers: ['A'] },
      { dateTime: CURRENT_DATETIME, value: '6000', qualifiers: ['A'] },
    ],
  },
];

/**
 * A June stat row for one calendar day. Only dayNu and p50 vary — every threshold that drives the
 * percentile class is held constant, so asserting p50 identifies which day's row was matched
 * without perturbing the classification.
 */
function statRowForDay(dayNu: number, p50: number): NwisStatRow {
  return {
    monthNu: 6,
    dayNu,
    beginYr: 1930,
    endYr: 2025,
    countNu: 95,
    p05: 2000,
    p10: 3000,
    p25: 4500,
    p50,
    p75: 9000,
    p95: 14000,
    maxVa: 22000,
    minVa: 800,
    meanVa: 7000,
    tsId: '68478',
    seriesDescription: null,
  };
}

/** Stat result with a row for June 4 (month=6, day=4). */
const MOCK_STAT: NwisStatResult = {
  siteNumber: '01646500',
  parameterCd: '00060',
  rows: [statRowForDay(4, 6000)],
};

/** Stat rows for three adjacent calendar days, each carrying a distinct p50. */
const MOCK_STAT_ADJACENT_DAYS: NwisStatResult = {
  siteNumber: '01646500',
  parameterCd: '00060',
  rows: [statRowForDay(27, 4990), statRowForDay(28, 4780), statRowForDay(29, 4610)],
};

/** p50 of the June 28 row — the calendar day every timestamp in the date-selection cases names. */
const JUNE_28_P50 = 4780;

describe('waterGetConditions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns current value with percentile classification (normal)', async () => {
    mockGetReadings.mockResolvedValue(MOCK_IV);
    mockGetStats.mockResolvedValue(MOCK_STAT);

    const ctx = createMockContext({ errors: waterGetConditions.errors });
    const input = waterGetConditions.input.parse({ site: '01646500', parameterCd: '00060' });
    const result = await waterGetConditions.handler(input, ctx);

    expect(result.siteNumber).toBe('01646500');
    expect(result.currentValue).toBe('6000');
    expect(result.qualifiers).toContain('A');
    expect(result.historicalContext).not.toBeNull();
    // 6000 is at p50 — sits in p25–p75 → normal
    expect(result.historicalContext?.percentileClass).toBe('normal');
    expect(result.historicalContext?.percentileLabel).toBe('25th–75th percentile');
    expect(result.historicalContext?.periodOfRecord).toBe('1930–2025');
    expect(result.historicalContextStatus).toBe('available');
    // The instantaneous-vs-daily-mean caveat rides on every populated context (#17).
    expect(result.historicalContext?.comparisonBasis).toContain('instantaneous');
    expect(result.historicalContext?.comparisonBasis).toContain('daily-mean');
  });

  it('classifies record-high when value >= p95', async () => {
    const highIv: NwisTimeSeries[] = [
      {
        ...MOCK_IV[0]!,
        values: [{ dateTime: CURRENT_DATETIME, value: '20000', qualifiers: ['P'] }],
      },
    ];
    mockGetReadings.mockResolvedValue(highIv);
    mockGetStats.mockResolvedValue(MOCK_STAT);

    const ctx = createMockContext({ errors: waterGetConditions.errors });
    const input = waterGetConditions.input.parse({ site: '01646500', parameterCd: '00060' });
    const result = await waterGetConditions.handler(input, ctx);

    expect(result.historicalContext?.percentileClass).toBe('record-high');
    // The class name says "record"; the label is what tells a consumer it is a percentile extreme.
    expect(result.historicalContext?.percentileLabel).toBe(
      '≥ 95th percentile (percentile-of-record extreme, not a verified all-time record)',
    );
  });

  it('classifies record-low when value < p05', async () => {
    const lowIv: NwisTimeSeries[] = [
      { ...MOCK_IV[0]!, values: [{ dateTime: CURRENT_DATETIME, value: '500', qualifiers: ['P'] }] },
    ];
    mockGetReadings.mockResolvedValue(lowIv);
    mockGetStats.mockResolvedValue(MOCK_STAT);

    const ctx = createMockContext({ errors: waterGetConditions.errors });
    const input = waterGetConditions.input.parse({ site: '01646500', parameterCd: '00060' });
    const result = await waterGetConditions.handler(input, ctx);

    expect(result.historicalContext?.percentileClass).toBe('record-low');
    expect(result.historicalContext?.percentileLabel).toBe(
      '< 5th percentile (percentile-of-record extreme, not a verified all-time record)',
    );
  });

  /**
   * The stat table's month_nu/day_nu are plain calendar integers, so the row must be chosen from
   * the observation's own calendar date — the date the NWIS timestamp already states. Converting
   * through `Date` re-projects the instant into whatever timezone the runner happens to be in and
   * lands on a neighboring row near midnight.
   *
   * Each case below names June 28 and asserts June 28's p50. The three offsets are chosen so no
   * runner timezone passes all three against a local-time lookup: the first fails west of -04:00,
   * the second east of it, and the third — a positive offset, which US territory coverage reaches
   * — fails everywhere but the far-eastern zones, closing the gap at -04:00 itself where the first
   * two coincidentally agree. UTC getters are no substitute either: they resolve the first case and
   * fail the third.
   */
  describe('stat row selection follows the observation date, not the runtime timezone', () => {
    async function conditionsAt(dateTime: string) {
      mockGetReadings.mockResolvedValue([
        { ...MOCK_IV[0]!, values: [{ dateTime, value: '6000', qualifiers: ['P'] }] },
      ]);
      mockGetStats.mockResolvedValue(MOCK_STAT_ADJACENT_DAYS);
      const ctx = createMockContext({ errors: waterGetConditions.errors });
      const input = waterGetConditions.input.parse({ site: '01646500', parameterCd: '00060' });
      return waterGetConditions.handler(input, ctx);
    }

    it('matches June 28 for a reading just after midnight at -04:00', async () => {
      // 2026-06-28T04:50Z — a runner behind -04:00 (e.g. US Pacific) reads this back as June 27.
      const result = await conditionsAt('2026-06-28T00:50:00.000-04:00');
      expect(result.historicalContext?.p50).toBe(JUNE_28_P50);
    });

    it('matches June 28 for a reading just before midnight at -04:00', async () => {
      // 2026-06-29T03:50Z — a runner ahead of -04:00 (e.g. UTC on CI) reads this forward as June 29.
      const result = await conditionsAt('2026-06-28T23:50:00.000-04:00');
      expect(result.historicalContext?.p50).toBe(JUNE_28_P50);
    });

    it('matches June 28 for a reading just after midnight at +10:00', async () => {
      // 2026-06-27T14:30Z — Guam is a US territory NWIS covers. Every runner behind +09:30 reads
      // this back as June 27.
      const result = await conditionsAt('2026-06-28T00:30:00.000+10:00');
      expect(result.historicalContext?.p50).toBe(JUNE_28_P50);
    });
  });

  /**
   * Classification driven through the assembled tool result, so the class and label are asserted on
   * both structuredContent and content[]. Thresholds are statRowForDay's: p05 2000, p10 3000,
   * p25 4500, p75 9000, p95 14000.
   */
  describe('percentile classification', () => {
    type Threshold = 'p05' | 'p10' | 'p25' | 'p75' | 'p95';

    async function classify(value: string, blank: Threshold[] = []) {
      mockGetReadings.mockResolvedValue([
        { ...MOCK_IV[0]!, values: [{ dateTime: CURRENT_DATETIME, value, qualifiers: ['P'] }] },
      ]);
      const row = statRowForDay(4, 6000);
      for (const key of blank) row[key] = null;
      mockGetStats.mockResolvedValue({ siteNumber: '01646500', parameterCd: '00060', rows: [row] });
      const result = await runToolContract(waterGetConditions, {
        site: '01646500',
        parameterCd: '00060',
      });
      expect(result.isError).toBeFalsy();
      const context = (
        result.structuredContent as {
          historicalContext: { percentileClass: string; percentileLabel: string };
        }
      ).historicalContext;
      return { ...context, text: allText(result.content) };
    }

    const HIGH = '≥ 95th percentile (percentile-of-record extreme, not a verified all-time record)';
    const LOW = '< 5th percentile (percentile-of-record extreme, not a verified all-time record)';

    it.each([
      ['20000', 'record-high', HIGH],
      ['14000', 'record-high', HIGH],
      ['13999', 'above-normal', '75th–95th percentile'],
      ['9000', 'above-normal', '75th–95th percentile'],
      ['8999', 'normal', '25th–75th percentile'],
      ['4500', 'normal', '25th–75th percentile'],
      ['4499', 'below-normal', '10th–25th percentile'],
      ['3000', 'below-normal', '10th–25th percentile'],
      ['2999', 'low', '5th–10th percentile'],
      ['2000', 'low', '5th–10th percentile'],
      ['1999', 'record-low', LOW],
    ])('classifies %s against a fully published table as %s', async (value, cls, label) => {
      const { percentileClass, percentileLabel, text } = await classify(value);
      expect(percentileClass).toBe(cls);
      expect(percentileLabel).toBe(label);
      expect(text).toContain(`**Condition:** ${cls} — ${label} |`);
    });

    it.each<[string, Threshold[], string, string]>([
      // #44: a value outside p25–p75 is placed by the thresholds that are published.
      ['9500', ['p95'], 'above-normal', '≥ 75th percentile; 95th not published'],
      ['20000', ['p95'], 'above-normal', '≥ 75th percentile; 95th not published'],
      ['4000', ['p10'], 'below-normal', '< 25th percentile; 10th not published'],
      ['1000', ['p05', 'p10'], 'below-normal', '< 25th percentile; 10th not published'],
      ['2500', ['p05'], 'low', '< 10th percentile; 5th not published'],
      ['1000', ['p05'], 'low', '< 10th percentile; 5th not published'],
      // normal needs both quartiles; a value no published threshold can place is unknown.
      ['6000', ['p75'], 'unknown', '25th–95th percentile; 75th not published'],
      ['6000', ['p75', 'p95'], 'unknown', '≥ 25th percentile; 75th, 95th not published'],
      ['6000', ['p25'], 'unknown', '10th–75th percentile; 25th not published'],
      [
        '6000',
        ['p05', 'p10', 'p25'],
        'unknown',
        '< 75th percentile; 5th, 10th, 25th not published',
      ],
      [
        '6000',
        ['p05', 'p10', 'p25', 'p75', 'p95'],
        'unknown',
        'no percentile thresholds published',
      ],
    ])('classifies %s with %j blank as %s', async (value, blank, cls, label) => {
      const { percentileClass, percentileLabel, text } = await classify(value, blank);
      expect(percentileClass).toBe(cls);
      expect(percentileLabel).toBe(label);
      expect(text).toContain(`**Condition:** ${cls} — ${label} |`);
    });

    it.each<[string, Threshold[], string, string]>([
      ['6000', ['p05', 'p10', 'p95'], 'normal', '25th–75th percentile'],
      ['20000', ['p75'], 'record-high', HIGH],
      ['1000', ['p10'], 'record-low', LOW],
    ])(
      'keeps %s with %j blank as %s, the published thresholds deciding',
      async (value, blank, cls, label) => {
        const { percentileClass, percentileLabel } = await classify(value, blank);
        expect(percentileClass).toBe(cls);
        expect(percentileLabel).toBe(label);
      },
    );

    it('keeps the label for a non-numeric reading unchanged', async () => {
      const { percentileClass, percentileLabel } = await classify('Ice');
      expect(percentileClass).toBe('unknown');
      expect(percentileLabel).toBe('insufficient percentile data');
    });

    /**
     * Every combination of blank thresholds (32) against a value at, between, and beyond each
     * threshold. The class must be one the published thresholds prove; `unknown` must mean no
     * published threshold decides; an open-ended class must name the threshold it could not check.
     */
    describe('every combination of blank thresholds', () => {
      const KEYS: Threshold[] = ['p05', 'p10', 'p25', 'p75', 'p95'];
      const PUBLISHED = { p05: 2000, p10: 3000, p25: 4500, p75: 9000, p95: 14000 };
      const VALUES = [1000, 2000, 2500, 3000, 4000, 4500, 6000, 9000, 12000, 14000, 20000];
      const COMBINATIONS = Array.from({ length: 2 ** KEYS.length }, (_, mask) =>
        KEYS.filter((_, i) => mask & (1 << i)),
      );

      /** The class each published threshold set proves for a value, independent of the tool. */
      function provable(v: number, blank: Threshold[]): Record<string, boolean> {
        const t = Object.fromEntries(
          KEYS.map((k) => [k, blank.includes(k) ? null : PUBLISHED[k]]),
        ) as Record<Threshold, number | null>;
        const below = (k: Threshold) => t[k] !== null && v < (t[k] as number);
        const atOrAbove = (k: Threshold) => t[k] !== null && v >= (t[k] as number);
        const notBelow = (k: Threshold) => t[k] === null || v >= (t[k] as number);
        return {
          'record-high': atOrAbove('p95'),
          'above-normal': atOrAbove('p75') && !atOrAbove('p95'),
          normal: atOrAbove('p25') && below('p75'),
          'below-normal': below('p25') && notBelow('p10') && notBelow('p05'),
          low: below('p10') && notBelow('p05'),
          'record-low': below('p05'),
        };
      }

      it.each(COMBINATIONS.map((blank) => [blank]))(
        'never places a value outside its band with %j blank',
        async (blank) => {
          for (const v of VALUES) {
            const { percentileClass, percentileLabel } = await classify(String(v), blank);
            const proven = provable(v, blank);
            const decided = Object.entries(proven).filter(([, holds]) => holds);
            expect(decided.length, `value ${v}`).toBeLessThanOrEqual(1);
            if (percentileClass === 'unknown') {
              expect(decided, `value ${v} is decidable`).toEqual([]);
            } else {
              expect(proven[percentileClass], `value ${v} → ${percentileClass}`).toBe(true);
            }
            if (percentileClass === 'above-normal' && blank.includes('p95')) {
              expect(percentileLabel).toContain('95th not published');
            }
            if (percentileClass === 'below-normal' && blank.includes('p10')) {
              expect(percentileLabel).toContain('10th not published');
            }
            if (percentileClass === 'low' && blank.includes('p05')) {
              expect(percentileLabel).toContain('5th not published');
            }
          }
        },
      );
    });
  });

  describe('a reading NWIS reported as no data (#45)', () => {
    /** One method block whose latest record carries the given value and qualifiers. */
    function method(methodId: string, value: string, qualifiers: string[]): NwisTimeSeries {
      return {
        ...MOCK_IV[0]!,
        methodId,
        methodDescription: `sensor ${methodId}`,
        values: [{ dateTime: CURRENT_DATETIME, value, qualifiers }],
      };
    }

    it('reports the missing reading as unknown and names its qualifiers on both surfaces', async () => {
      mockGetReadings.mockResolvedValue([method('69928', '', ['P', 'Eqp'])]);
      mockGetStats.mockResolvedValue(MOCK_STAT);
      const result = await runToolContract(waterGetConditions, {
        site: '01646500',
        parameterCd: '00060',
      });

      const structured = result.structuredContent as {
        currentValue: string;
        historicalContext: { percentileClass: string; percentileLabel: string };
        note?: string;
        qualifiers: string[];
      };
      expect(structured.currentValue).toBe('');
      expect(structured.qualifiers).toEqual(['P', 'Eqp']);
      expect(structured.historicalContext.percentileClass).toBe('unknown');
      expect(structured.historicalContext.percentileLabel).toContain('Eqp');
      expect(structured.note).toContain('Eqp');
      const text = allText(result.content);
      expect(text).toContain('**Current value:** no data [P,Eqp]');
      expect(text).toContain(
        `**Condition:** unknown — ${structured.historicalContext.percentileLabel}`,
      );
    });

    it("prefers another method's measured reading over a missing one at the same time", async () => {
      // Both methods last report at the same instant; the first (a discontinued sensor) sends the
      // no-data value, so the second's measurement is the current reading.
      mockGetReadings.mockResolvedValue([
        method('11111', '', ['P', 'Dis']),
        method('22222', '6000', ['P']),
      ]);
      mockGetStats.mockResolvedValue(MOCK_STAT);
      const result = await runToolContract(waterGetConditions, {
        site: '01646500',
        parameterCd: '00060',
      });

      expect(result.structuredContent).toMatchObject({
        currentValue: '6000',
        methodId: '22222',
        historicalContext: { percentileClass: 'normal' },
      });
    });

    it('still reports the missing reading when no method carries a measurement', async () => {
      mockGetReadings.mockResolvedValue([
        method('11111', '', ['P', 'Dis']),
        method('22222', '', ['P', 'Ssn']),
      ]);
      mockGetStats.mockResolvedValue({ ...MOCK_STAT, rows: [] });
      const result = await runToolContract(waterGetConditions, {
        site: '01646500',
        parameterCd: '00060',
      });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        currentValue: '',
        methodId: '11111',
        qualifiers: ['P', 'Dis'],
        historicalContext: null,
        historicalContextStatus: 'no_record',
      });
      expect(allText(result.content)).toContain('**Current value:** no data [P,Dis]');
    });
  });

  describe('pairing the reporting sensor with a stat series (#43)', () => {
    /** A measured method block whose single record is read at `time` (HH:MM, June 4). */
    function sensor(methodId: string, description: string | null, value: string, time: string) {
      return {
        ...MOCK_IV[0]!,
        methodId,
        methodDescription: description,
        values: [{ dateTime: `2026-06-04T${time}:00-04:00`, value, qualifiers: ['P'] }],
      } satisfies NwisTimeSeries;
    }

    /** A stat series for June 4 with the given ts_id and description. */
    function statSeries(tsId: string, description: string | null): NwisStatRow {
      return { ...statRowForDay(4, 6000), tsId, seriesDescription: description };
    }

    async function conditions(series: NwisTimeSeries[], rows: NwisStatRow[]) {
      mockGetReadings.mockResolvedValue(series);
      mockGetStats.mockResolvedValue({ siteNumber: '01646500', parameterCd: '00060', rows });
      const result = await runToolContract(waterGetConditions, {
        site: '01646500',
        parameterCd: '00060',
      });
      expect(result.isError).toBeFalsy();
      return {
        structured: result.structuredContent as {
          historicalContext: { methodMatched: boolean; statSeriesId: string } | null;
          historicalContextStatus: string;
          methodId: string;
          note?: string;
        },
        text: allText(result.content),
      };
    }

    it('takes the most recent reading when no sensor is paired', async () => {
      const { structured } = await conditions(
        [sensor('1', 'LEFT BANK', '6000', '14:00'), sensor('2', 'RIGHT BANK', '6100', '14:15')],
        [statSeries('90', null)],
      );
      expect(structured).toMatchObject({
        methodId: '2',
        historicalContext: { statSeriesId: '90', methodMatched: false },
      });
      expect(structured.note).toContain('only statistics series at this site');
    });

    it('never sets aside a "[Discontinued]" label to pair a live sensor with a retired series', async () => {
      const { structured } = await conditions(
        [sensor('1', 'From multiparameter sonde', '6000', '14:00')],
        [statSeries('90', 'From multiparameter sonde, [Discontinued]'), statSeries('91', 'Pump')],
      );
      expect(structured).toMatchObject({
        historicalContext: null,
        historicalContextStatus: 'no_matching_method',
      });
    });

    it('identifies no series when two share the sensor’s description', async () => {
      const { structured, text } = await conditions(
        [sensor('1', null, '6000', '14:00')],
        [statSeries('90', null), statSeries('91', null)],
      );
      expect(structured).toMatchObject({
        historicalContext: null,
        historicalContextStatus: 'no_matching_method',
      });
      expect(structured.note).toContain('none is identified');
      expect(text).toContain(structured.note ?? '(missing note)');
    });
  });

  it('reports no_record when the stat table is empty', async () => {
    mockGetReadings.mockResolvedValue(MOCK_IV);
    mockGetStats.mockResolvedValue({ siteNumber: '01646500', parameterCd: '00060', rows: [] });

    const ctx = createMockContext({ errors: waterGetConditions.errors });
    const input = waterGetConditions.input.parse({ site: '01646500', parameterCd: '00060' });
    const result = await waterGetConditions.handler(input, ctx);

    // Partial success — not a throw
    expect(result.currentValue).toBe('6000');
    expect(result.historicalContext).toBeNull();
    expect(result.historicalContextStatus).toBe('no_record');
    expect(result.note).toContain('No historical');
    // An empty stat table is not evidence of a deficient gage — NWIS publishes no percentile
    // product at all for some parameters, so the note offers that cause alongside a short record.
    expect(result.note).toContain('no daily-statistics percentile product');
    expect(result.note).toContain('too new or too short');
  });

  it('reports unavailable (not no_record) when the stat service throws — partial success', async () => {
    mockGetReadings.mockResolvedValue(MOCK_IV);
    mockGetStats.mockRejectedValue(
      serviceUnavailable('NWIS returned HTTP 503: Service Unavailable'),
    );

    const ctx = createMockContext({ errors: waterGetConditions.errors });
    const input = waterGetConditions.input.parse({ site: '01646500', parameterCd: '00060' });
    const result = await waterGetConditions.handler(input, ctx);

    // The IV reading still returns — a stat failure is non-fatal.
    expect(result.currentValue).toBe('6000');
    expect(result.historicalContext).toBeNull();
    // #20: an operational stat failure must be distinguishable from an empty stat table, and must
    // never be attributed to the site's own record.
    expect(result.historicalContextStatus).toBe('unavailable');
    expect(result.note).toContain('could not be retrieved');
    expect(result.note).not.toContain('site may be new');
  });

  it('reports no_matching_day when stat rows exist but none for the observation date', async () => {
    mockGetReadings.mockResolvedValue(MOCK_IV); // observation is June 4
    mockGetStats.mockResolvedValue({
      siteNumber: '01646500',
      parameterCd: '00060',
      rows: [statRowForDay(15, 5000)], // June 15 only — no row for June 4
    });

    const ctx = createMockContext({ errors: waterGetConditions.errors });
    const input = waterGetConditions.input.parse({ site: '01646500', parameterCd: '00060' });
    const result = await waterGetConditions.handler(input, ctx);

    expect(result.currentValue).toBe('6000');
    expect(result.historicalContext).toBeNull();
    expect(result.historicalContextStatus).toBe('no_matching_day');
    expect(result.note).toContain("no entry for today's calendar day");
  });

  it('throws no_data_for_parameter when IV returns empty (ambiguous: site not found or no data)', async () => {
    mockGetReadings.mockResolvedValue([]);
    mockGetStats.mockResolvedValue(MOCK_STAT);

    const ctx = createMockContext({ errors: waterGetConditions.errors });
    const input = waterGetConditions.input.parse({ site: '99999999', parameterCd: '00060' });
    await expect(waterGetConditions.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_data_for_parameter', recovery: recovery('no_data_for_parameter') },
    });
  });

  it('throws no_data_for_parameter when IV series has no values', async () => {
    mockGetReadings.mockResolvedValue([{ ...MOCK_IV[0]!, values: [] }]);
    mockGetStats.mockResolvedValue(MOCK_STAT);

    const ctx = createMockContext({ errors: waterGetConditions.errors });
    const input = waterGetConditions.input.parse({ site: '01646500', parameterCd: '99999' });
    await expect(waterGetConditions.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_data_for_parameter', recovery: recovery('no_data_for_parameter') },
    });
  });

  it('maps a 5xx on the IV call to upstream_error via classifyNwisFailure', async () => {
    // The service throws a serviceUnavailable() McpError shaped like "NWIS returned HTTP 503:
    // Service Unavailable". classifyNwisFailure branches on err.code, so the exact prose is
    // irrelevant — the old ad hoc substring match failed on the capital "U" in "Unavailable".
    mockGetReadings.mockRejectedValue(
      serviceUnavailable('NWIS returned HTTP 503: Service Unavailable', { status: 503 }),
    );
    mockGetStats.mockResolvedValue(MOCK_STAT);

    const ctx = createMockContext({ errors: waterGetConditions.errors });
    const input = waterGetConditions.input.parse({ site: '01646500', parameterCd: '00060' });
    await expect(waterGetConditions.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_error', recovery: recovery('upstream_error') },
    });
  });

  it('maps an NWIS rejection on the IV call to invalid_request', async () => {
    // NWIS names the offending field itself; the reason must not re-guess it from the wrapper text.
    mockGetReadings.mockRejectedValue(
      validationError('NWIS rejected the request: HTTP Status 400 - parameterCd: Invalid format', {
        httpStatus: 400,
      }),
    );
    mockGetStats.mockResolvedValue(MOCK_STAT);

    const ctx = createMockContext({ errors: waterGetConditions.errors });
    const input = waterGetConditions.input.parse({ site: '01646500', parameterCd: '00060' });
    await expect(waterGetConditions.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_request', recovery: recovery('invalid_request') },
      message: expect.stringContaining('parameterCd: Invalid format'),
    });
  });

  it('rethrows an unclassified IV error rather than guessing a reason', async () => {
    mockGetReadings.mockRejectedValue(new TypeError('fetch failed'));
    mockGetStats.mockResolvedValue(MOCK_STAT);

    const ctx = createMockContext({ errors: waterGetConditions.errors });
    const input = waterGetConditions.input.parse({ site: '01646500', parameterCd: '00060' });
    await expect(waterGetConditions.handler(input, ctx)).rejects.toThrow('fetch failed');
  });

  it('formats result with current value and percentile class', () => {
    const result = {
      siteNumber: '01646500',
      siteName: 'POTOMAC RIVER AT LITTLE FALLS',
      parameterCd: '00060',
      parameterName: 'Streamflow, ft³/s',
      unitCode: 'ft3/s',
      methodId: '69928',
      methodDescription: null,
      currentValue: '6000',
      currentDateTime: CURRENT_DATETIME,
      qualifiers: ['A'],
      historicalContext: {
        percentileClass: 'normal' as const,
        percentileLabel: '25th–75th percentile',
        p05: 2000,
        p10: 3000,
        p25: 4500,
        p50: 6000,
        p75: 9000,
        p95: 14000,
        periodOfRecord: '1930–2025',
        comparisonBasis: 'instantaneous reading ranked against daily-mean percentiles',
        statSeriesId: '68478',
        statSeriesDescription: null,
        methodMatched: true,
      },
      historicalContextStatus: 'available' as const,
      note: undefined,
    };
    const blocks = waterGetConditions.format!(result);
    const text = textContent(blocks[0]);
    expect(text).toContain('01646500');
    expect(text).toContain('6000');
    expect(text).toContain('[A]');
    expect(text).toContain('normal');
    expect(text).toContain('1930–2025');
    expect(text).toContain('p50=6000');
    // structuredContent and content[] must carry the same data — the label is not schema-only.
    expect(text).toContain('25th–75th percentile');
    // comparisonBasis is surfaced in the rendered text too (#17).
    expect(text).toContain('instantaneous reading ranked against daily-mean percentiles');
    // historicalContextStatus is rendered unconditionally (#20, format parity).
    expect(text).toContain('**Historical context status:** available');
  });

  it('formats result with null historicalContext gracefully and surfaces the status', () => {
    const result = {
      siteNumber: '01646500',
      siteName: 'POTOMAC RIVER',
      parameterCd: '00060',
      parameterName: 'Streamflow, ft³/s',
      unitCode: 'ft3/s',
      methodId: '69928',
      methodDescription: null,
      currentValue: '6000',
      currentDateTime: CURRENT_DATETIME,
      qualifiers: [],
      historicalContext: null,
      historicalContextStatus: 'unavailable' as const,
      note: 'Historical percentile context could not be retrieved.',
    };
    const blocks = waterGetConditions.format!(result);
    const text = textContent(blocks[0]);
    expect(text).toContain('No historical context');
    // The discriminator is rendered so a content-only client can tell why context is absent (#20).
    expect(text).toContain('unavailable');
    expect(text).toContain('could not be retrieved');
  });

  describe('input validation', () => {
    it('rejects a non-numeric site at the Zod parse level, before any NWIS call', () => {
      expect(() => waterGetConditions.input.parse({ site: 'abc', parameterCd: '00060' })).toThrow();
      expect(mockGetReadings).not.toHaveBeenCalled();
    });

    it('rejects a site number outside 8–15 digits', () => {
      expect(() =>
        waterGetConditions.input.parse({ site: '1646500', parameterCd: '00060' }),
      ).toThrow();
      expect(() =>
        waterGetConditions.input.parse({ site: '0164650012345678', parameterCd: '00060' }),
      ).toThrow();
    });

    it('rejects a parameter code that is not exactly 5 digits', () => {
      expect(() =>
        waterGetConditions.input.parse({ site: '01646500', parameterCd: 'x' }),
      ).toThrow();
      expect(() =>
        waterGetConditions.input.parse({ site: '01646500', parameterCd: '0006' }),
      ).toThrow();
      expect(() =>
        waterGetConditions.input.parse({ site: '01646500', parameterCd: '000600' }),
      ).toThrow();
    });

    it('accepts a well-formed site and parameter', () => {
      expect(() =>
        waterGetConditions.input.parse({ site: '01646500', parameterCd: '00060' }),
      ).not.toThrow();
    });
  });
});
