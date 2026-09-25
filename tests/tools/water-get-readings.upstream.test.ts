/**
 * @fileoverview water_get_readings driven end to end against captured NWIS responses — the real
 * service layer and WaterML parser run behind a strict fetch mock, and results are asserted on the
 * assembled tool result (structuredContent and content[]).
 * @module tests/tools/water-get-readings.upstream.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  type FetchMockHarness,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waterGetReadings } from '@/mcp-server/tools/definitions/water-get-readings.tool.js';
import { declaredRecovery } from '../helpers/error-contract.js';
import {
  afterRetries,
  allText,
  nwisBodyRoute,
  nwisRoute,
  truncatedFixture,
} from '../helpers/nwis-fixtures.js';

type Reading = {
  methodDescription?: string | null;
  methodId?: string | null;
  siteNumber: string;
  totalValues: number;
  values: { dateTime: string; qualifiers: string[]; value: string }[];
};
type Readings = { missingSites: string[]; readings: Reading[]; total: number; truncated: boolean };

let http: FetchMockHarness;

beforeEach(() => {
  http = createFetchMock();
  http.install();
});

afterEach(() => {
  http.restore();
});

describe('water_get_readings against captured NWIS responses', () => {
  describe('single method (characterization)', () => {
    it('returns the latest records of a single-method series', async () => {
      http.route(
        nwisRoute({
          endpoint: 'iv',
          sites: '01646500',
          parameterCd: '00060',
          fixture: 'iv-01646500-00060.json',
        }),
      );
      const result = await runToolContract(waterGetReadings, {
        sites: ['01646500'],
        parameterCd: ['00060'],
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as Readings;
      expect(structured).toMatchObject({ total: 1, truncated: true, missingSites: [] });
      expect(structured.readings[0]).toMatchObject({ siteNumber: '01646500', totalValues: 11 });
      expect(structured.readings[0]?.values).toHaveLength(10);
      expect(structured.readings[0]?.values.at(-1)).toEqual({
        dateTime: '2026-09-24T22:50:00.000-04:00',
        value: '3510',
        qualifiers: ['P'],
      });

      const text = allText(result.content);
      expect(text).toContain(
        '### POTOMAC RIVER NEAR WASH, DC LITTLE FALLS PUMP STA (01646500) — Streamflow, ft³/s | code: 00060 | unit: ft3/s',
      );
      expect(text).toContain('- 2026-09-24T22:50:00.000-04:00: **3510** ft3/s [P]');
      expect(text).toContain('*(showing the latest 10 of 11 records in this period)*');
    });

    it('names a requested site NWIS returned nothing for', async () => {
      http.route(
        nwisRoute({
          endpoint: 'iv',
          sites: '01646500,01638500,99999999',
          parameterCd: '00060',
          fixture: 'iv-01638500-01646500-00060.json',
        }),
      );
      const result = await runToolContract(waterGetReadings, {
        sites: ['01646500', '01638500', '99999999'],
        parameterCd: ['00060'],
      });

      const structured = result.structuredContent as Readings;
      expect(structured.total).toBe(2);
      expect(structured.missingSites).toEqual(['99999999']);
    });
  });

  describe('multiple method blocks (#43)', () => {
    it('returns the values held in a second method block', async () => {
      http.route(
        nwisRoute({
          endpoint: 'iv',
          sites: '12036400',
          parameterCd: '00060',
          fixture: 'iv-12036400-00060.json',
        }),
      );
      const result = await runToolContract(waterGetReadings, {
        sites: ['12036400'],
        parameterCd: ['00060'],
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as Readings;
      expect(structured.total).toBe(1);
      expect(structured.readings[0]).toMatchObject({
        methodId: '306966',
        methodDescription: null,
        totalValues: 4,
      });
      expect(structured.readings[0]?.values.map((v) => v.value)).toEqual([
        '4.19',
        '4.19',
        '4.42',
        '4.42',
      ]);

      const text = allText(result.content);
      expect(text).toContain('*(4 records in this period)*');
      expect(text).toContain('Method: (no description) | method ID: 306966');
    });

    it('returns each sensor as its own series, named on both surfaces', async () => {
      http.route(
        nwisRoute({
          endpoint: 'iv',
          sites: '12056500',
          parameterCd: '00010',
          fixture: 'iv-12056500-00010.json',
        }),
      );
      const result = await runToolContract(waterGetReadings, {
        sites: ['12056500'],
        parameterCd: ['00010'],
      });

      const structured = result.structuredContent as Readings;
      expect(structured.total).toBe(2);
      expect(
        structured.readings.map((r) => [r.methodId, r.methodDescription, r.totalValues]),
      ).toEqual([
        ['150723', null, 7],
        ['352066', 'QWsonde-EXO, [From QW Sonde]', 6],
      ]);
      // A site is missing only when it returned no series at all, not when it returned two.
      expect(structured.missingSites).toEqual([]);

      const text = allText(result.content);
      expect(text).toContain('Method: QWsonde-EXO, [From QW Sonde] | method ID: 352066');
      expect(text).toContain('Method: (no description) | method ID: 150723');
      expect(text).toContain('- 2026-09-24T20:15:00.000-07:00: **11.6** deg C [P]');
    });

    it('counts series after the parser drops an empty sibling block, so totalSeries equals total', async () => {
      // The capture holds two method blocks — "[(2)]" empty, "" with 4 values. The empty one is
      // dropped by the parser, not by the series cap, so it is not counted in totalSeries.
      http.route(
        nwisRoute({
          endpoint: 'iv',
          sites: '12036400',
          parameterCd: '00060',
          fixture: 'iv-12036400-00060.json',
        }),
      );
      const result = await runToolContract(waterGetReadings, {
        sites: ['12036400'],
        parameterCd: ['00060'],
      });

      expect(result.structuredContent).toMatchObject({ total: 1, totalSeries: 1 });
      expect(allText(result.content).split('\n')[0]).toBe('**1 time series**');
    });

    it('reports no_data_for_parameter when every method block is empty', async () => {
      http.route(
        nwisRoute({
          endpoint: 'iv',
          sites: '01589485',
          parameterCd: '00010',
          fixture: 'iv-01589485-00010.json',
        }),
      );
      const result = await runToolContract(waterGetReadings, {
        sites: ['01589485'],
        parameterCd: ['00010'],
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'no_data_for_parameter' } },
      });
      expect(allText(result.content)).toContain('no data available');
    });
  });
});

describe('a truncated NWIS response body (#46)', () => {
  const POTOMAC_IV = {
    endpoint: 'iv',
    sites: '01646500',
    parameterCd: '00060',
    fixture: 'iv-01646500-00060.json',
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
    );
    const result = await afterRetries(
      runToolContract(waterGetReadings, { sites: ['01646500'], parameterCd: ['00060'] }),
    );

    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as Readings).readings[0]).toMatchObject({
      siteNumber: '01646500',
      totalValues: 11,
    });
    expect(allText(result.content)).toContain(
      '- 2026-09-24T22:50:00.000-04:00: **3510** ft3/s [P]',
    );
  });

  it('fails as upstream_error with its recovery hint when every attempt is truncated', async () => {
    http.route(nwisBodyRoute(POTOMAC_IV, truncatedFixture(POTOMAC_IV.fixture)));
    const result = await afterRetries(
      runToolContract(waterGetReadings, { sites: ['01646500'], parameterCd: ['00060'] }),
    );

    expect(http.calls).toHaveLength(4);
    expect(result.isError).toBe(true);
    const recovery = declaredRecovery(waterGetReadings.errors, 'upstream_error');
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
  it('renders a seasonal gage in a batch as missing, never as a magnitude', async () => {
    http.route(
      nwisRoute({
        endpoint: 'iv',
        sites: '01646500,12024000',
        parameterCd: '00060',
        fixture: 'iv-01646500-12024000-00060.json',
      }),
    );
    const result = await runToolContract(waterGetReadings, {
      sites: ['01646500', '12024000'],
      parameterCd: ['00060'],
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Readings;
    expect(structured.missingSites).toEqual([]);
    const seasonal = structured.readings.find((r) => r.siteNumber === '12024000');
    expect(seasonal?.totalValues).toBe(7);
    expect(seasonal?.values.at(-1)).toEqual({
      dateTime: '2026-09-24T21:30:00.000-07:00',
      value: '',
      qualifiers: ['P', 'Ssn'],
    });
    expect(seasonal?.values.every((v) => v.value === '')).toBe(true);

    const text = allText(result.content);
    expect(text).not.toContain('-999999');
    expect(text).toContain('- 2026-09-24T21:30:00.000-07:00: no data [P,Ssn]');
    // The measured site in the same batch renders as before.
    expect(text).toContain('- 2026-09-24T23:50:00.000-04:00: **3510** ft3/s [P]');
  });
});
