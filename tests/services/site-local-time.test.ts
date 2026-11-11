/**
 * @fileoverview Site-local time for the Water Data APIs' UTC instants: every code of the captured
 * `time-zone-codes` collection at its standard and daylight offsets, the US federal daylight-time
 * dates at 2 a.m. on each site's own clock (half-hour zones included), the UTC rendering of a site
 * with no known zone, and the site-local day bounds a `continuous` query is built from.
 * @module tests/services/site-local-time.test
 */

import { describe, expect, it } from 'vitest';
import {
  siteLocalDate,
  siteLocalDayStart,
  siteTimeZone,
  toSiteLocalTimestamp,
} from '@/services/waterdata/site-local-time.js';
import { waterDataFixture } from '../helpers/water-data-fake.js';

interface ZoneCode {
  id: string;
  properties: {
    time_zone_daylight_savings_utc_offset: string | null;
    time_zone_utc_offset: string;
  };
}

/** The `time-zone-codes` collection as captured: all 53 codes and their two offsets. */
const ZONE_CODES = (
  JSON.parse(waterDataFixture('observations-time-zone-codes.json')) as { features: ZoneCode[] }
).features;

const WINTER = '2026-01-15T12:00:00Z';
const SUMMER = '2026-07-15T12:00:00Z';

function zone(code: string, daylightSaving: 'Y' | 'N') {
  const found = siteTimeZone(code, daylightSaving);
  if (!found) throw new Error(`No zone for ${code}`);
  return found;
}

/** The offset a rendered timestamp ends with (`-05:00`). */
function offsetOf(timestamp: string): string {
  return timestamp.slice(-6);
}

describe('siteTimeZone', () => {
  it('covers all 53 codes of the time-zone-codes collection', () => {
    expect(ZONE_CODES).toHaveLength(53);
    for (const { id } of ZONE_CODES) {
      expect(siteTimeZone(id, 'Y')).toEqual({ abbreviation: id, observesDaylightSaving: true });
      expect(siteTimeZone(id, 'N')).toEqual({ abbreviation: id, observesDaylightSaving: false });
    }
  });

  it.each([
    ['an unknown code', 'XYZ'],
    ['a lowercase code', 'est'],
    ['an empty code', ''],
    ['no code', null],
    ['an absent code', undefined],
    ['a prototype key', '__proto__'],
    ['a prototype key', 'constructor'],
  ])('is null for %s (%s)', (_label, code) => {
    expect(siteTimeZone(code, 'Y')).toBeNull();
  });

  it('reads daylight saving only from a flag of Y', () => {
    expect(siteTimeZone('EST', 'N')?.observesDaylightSaving).toBe(false);
    expect(siteTimeZone('EST', null)?.observesDaylightSaving).toBe(false);
    expect(siteTimeZone('EST', 'y')?.observesDaylightSaving).toBe(false);
  });
});

describe('toSiteLocalTimestamp', () => {
  it.each(ZONE_CODES.map((code) => [code.id, code] as const))(
    '%s renders its collection offsets',
    (_id, { id, properties: p }) => {
      const standard = p.time_zone_utc_offset;
      const daylight = p.time_zone_daylight_savings_utc_offset ?? standard;
      const cases = [
        [WINTER, 'N', standard],
        [SUMMER, 'N', standard],
        [WINTER, 'Y', standard],
        [SUMMER, 'Y', daylight],
      ] as const;
      for (const [instant, flag, offset] of cases) {
        const rendered = toSiteLocalTimestamp(instant, zone(id, flag));
        expect(offsetOf(rendered)).toBe(offset);
        expect(rendered).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
        expect(Date.parse(rendered)).toBe(Date.parse(instant));
      }
    },
  );

  it.each([
    ['ZP-11', 'N', '2026-11-11T07:50:00+00:00', '2026-11-10T20:50:00.000-11:00'],
    ['ZP11', 'N', '2026-11-11T07:50:00+00:00', '2026-11-11T18:50:00.000+11:00'],
    ['AFT', 'N', '2026-11-11T07:50:00+00:00', '2026-11-11T12:20:00.000+04:30'],
    ['AFT', 'Y', '2026-07-11T07:50:00+00:00', '2026-07-11T12:20:00.000+04:30'],
    ['ZP4', 'Y', '2026-07-11T07:50:00+00:00', '2026-07-11T11:50:00.000+04:00'],
    ['MST', 'N', '2026-07-11T07:50:00+00:00', '2026-07-11T00:50:00.000-07:00'],
    ['MST', 'Y', '2026-07-11T07:50:00+00:00', '2026-07-11T01:50:00.000-06:00'],
    ['AKST', 'Y', '2026-07-11T07:50:00+00:00', '2026-07-10T23:50:00.000-08:00'],
    ['AKST', 'Y', '2026-11-11T07:50:00+00:00', '2026-11-10T22:50:00.000-09:00'],
    ['NFT', 'Y', '2026-07-11T07:50:00+00:00', '2026-07-11T05:20:00.000-02:30'],
    ['NFT', 'Y', '2026-11-11T07:50:00+00:00', '2026-11-11T04:20:00.000-03:30'],
    ['HST', 'N', '2026-07-11T07:50:00+00:00', '2026-07-10T21:50:00.000-10:00'],
    ['EST', 'Y', '2026-11-11T07:50:00+00:00', '2026-11-11T02:50:00.000-05:00'],
  ])('%s|%s renders %s as %s', (code, flag, utc, expected) => {
    expect(toSiteLocalTimestamp(utc, zone(code, flag as 'Y' | 'N'))).toBe(expected);
  });

  it.each([
    // Spring forward: 2 a.m. standard time on each site's own clock, the second Sunday of March.
    ['EST', '2026-03-08T06:59:59Z', '2026-03-08T01:59:59.000-05:00'],
    ['EST', '2026-03-08T07:00:00Z', '2026-03-08T03:00:00.000-04:00'],
    ['CST', '2026-03-08T07:59:59Z', '2026-03-08T01:59:59.000-06:00'],
    ['CST', '2026-03-08T08:00:00Z', '2026-03-08T03:00:00.000-05:00'],
    ['PST', '2026-03-08T09:59:59Z', '2026-03-08T01:59:59.000-08:00'],
    ['PST', '2026-03-08T10:00:00Z', '2026-03-08T03:00:00.000-07:00'],
    ['AKST', '2026-03-08T10:59:59Z', '2026-03-08T01:59:59.000-09:00'],
    ['AKST', '2026-03-08T11:00:00Z', '2026-03-08T03:00:00.000-08:00'],
    ['NFT', '2026-03-08T05:29:59Z', '2026-03-08T01:59:59.000-03:30'],
    ['NFT', '2026-03-08T05:30:00Z', '2026-03-08T03:00:00.000-02:30'],
    // Fall back: 2 a.m. daylight time, the first Sunday of November; the 1 a.m. hour repeats.
    ['EST', '2026-11-01T05:59:59Z', '2026-11-01T01:59:59.000-04:00'],
    ['EST', '2026-11-01T06:00:00Z', '2026-11-01T01:00:00.000-05:00'],
    ['PST', '2026-11-01T08:59:59Z', '2026-11-01T01:59:59.000-07:00'],
    ['PST', '2026-11-01T09:00:00Z', '2026-11-01T01:00:00.000-08:00'],
    ['AKST', '2026-11-01T09:59:59Z', '2026-11-01T01:59:59.000-08:00'],
    ['AKST', '2026-11-01T10:00:00Z', '2026-11-01T01:00:00.000-09:00'],
    ['NFT', '2026-11-01T04:29:59Z', '2026-11-01T01:59:59.000-02:30'],
    ['NFT', '2026-11-01T04:30:00Z', '2026-11-01T01:00:00.000-03:30'],
  ])('%s switches at 2 a.m. local: %s → %s', (code, utc, expected) => {
    expect(toSiteLocalTimestamp(utc, zone(code, 'Y'))).toBe(expected);
  });

  it.each([
    // 1987–2006: first Sunday of April, last Sunday of October.
    ['2006-04-02T06:59:59Z', '2006-04-02T01:59:59.000-05:00'],
    ['2006-04-02T07:00:00Z', '2006-04-02T03:00:00.000-04:00'],
    ['2006-10-29T05:59:59Z', '2006-10-29T01:59:59.000-04:00'],
    ['2006-10-29T06:00:00Z', '2006-10-29T01:00:00.000-05:00'],
    // 2007 onward, the year the federal dates moved.
    ['2007-03-11T07:00:00Z', '2007-03-11T03:00:00.000-04:00'],
    ['2007-11-04T06:00:00Z', '2007-11-04T01:00:00.000-05:00'],
    // 1974 wartime-style year-round daylight time began January 6.
    ['1974-01-06T06:59:59Z', '1974-01-06T01:59:59.000-05:00'],
    ['1974-01-06T07:00:00Z', '1974-01-06T03:00:00.000-04:00'],
  ])('follows the federal dates of the year: %s → %s', (utc, expected) => {
    expect(toSiteLocalTimestamp(utc, zone('EST', 'Y'))).toBe(expected);
  });

  it('writes a site without a known zone in UTC, with the offset', () => {
    expect(toSiteLocalTimestamp('2026-11-11T07:50:00+00:00', null)).toBe(
      '2026-11-11T07:50:00.000+00:00',
    );
    expect(toSiteLocalTimestamp('2026-07-11T07:50:00Z', null)).toBe(
      '2026-07-11T07:50:00.000+00:00',
    );
  });

  it('keeps milliseconds and reads any offset form Date.parse reads', () => {
    expect(toSiteLocalTimestamp('2026-11-11T07:50:00.125Z', zone('EST', 'Y'))).toBe(
      '2026-11-11T02:50:00.125-05:00',
    );
    expect(toSiteLocalTimestamp('2026-11-11T02:50:00-05:00', zone('PST', 'Y'))).toBe(
      '2026-11-10T23:50:00.000-08:00',
    );
  });

  it('throws on an instant it cannot read', () => {
    expect(() => toSiteLocalTimestamp('not a time', zone('EST', 'Y'))).toThrow(
      'Unreadable timestamp: not a time',
    );
  });
});

describe('siteLocalDate', () => {
  it.each([
    ['EST', 'Y', '2026-11-01T03:59:59Z', '2026-10-31'],
    ['EST', 'Y', '2026-11-01T04:00:00Z', '2026-11-01'],
    ['EST', 'Y', '2026-11-02T04:59:59Z', '2026-11-01'],
    ['EST', 'Y', '2026-11-02T05:00:00Z', '2026-11-02'],
    ['MST', 'N', '2026-07-13T00:00:00Z', '2026-07-12'],
    ['ZP11', 'N', '2026-07-12T13:00:00Z', '2026-07-13'],
  ])('%s|%s: %s falls on %s', (code, flag, utc, date) => {
    expect(siteLocalDate(Date.parse(utc), zone(code, flag as 'Y' | 'N'))).toBe(date);
  });

  it('reads the UTC date for a site without a known zone', () => {
    expect(siteLocalDate(Date.parse('2026-11-01T03:59:59Z'), null)).toBe('2026-11-01');
  });
});

describe('siteLocalDayStart', () => {
  it.each([
    ['EST', 'Y', '2026-03-08', '2026-03-08T05:00:00.000Z'],
    ['EST', 'Y', '2026-03-09', '2026-03-09T04:00:00.000Z'],
    ['EST', 'Y', '2026-11-01', '2026-11-01T04:00:00.000Z'],
    ['EST', 'Y', '2026-11-02', '2026-11-02T05:00:00.000Z'],
    ['EST', 'N', '2026-07-01', '2026-07-01T05:00:00.000Z'],
    ['PST', 'Y', '2026-07-12', '2026-07-12T07:00:00.000Z'],
    ['NFT', 'Y', '2026-07-12', '2026-07-12T02:30:00.000Z'],
    ['AFT', 'N', '2026-11-01', '2026-10-31T19:30:00.000Z'],
    ['ZP-11', 'N', '2026-11-01', '2026-11-01T11:00:00.000Z'],
  ])('%s|%s: local day %s begins at %s', (code, flag, date, instant) => {
    const startMs = siteLocalDayStart(date, zone(code, flag as 'Y' | 'N'));
    expect(new Date(startMs).toISOString()).toBe(instant);
    expect(siteLocalDate(startMs, zone(code, flag as 'Y' | 'N'))).toBe(date);
    expect(siteLocalDate(startMs - 1, zone(code, flag as 'Y' | 'N'))).not.toBe(date);
  });

  it('starts a day of a site without a known zone at UTC midnight', () => {
    expect(new Date(siteLocalDayStart('2026-11-01', null)).toISOString()).toBe(
      '2026-11-01T00:00:00.000Z',
    );
  });

  it('throws on a date it cannot read', () => {
    expect(() => siteLocalDayStart('11/01/2026', zone('EST', 'Y'))).toThrow(
      'Unreadable date: 11/01/2026',
    );
  });
});
