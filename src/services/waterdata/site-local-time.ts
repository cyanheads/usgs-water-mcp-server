/**
 * @fileoverview Site-local time for the USGS Water Data APIs, which return UTC instants: render an
 * instant the way WaterServices served it (`2026-11-11T02:50:00.000-05:00`), and turn a site-local
 * calendar day into the UTC instants a query needs — from a monitoring location's time-zone code and
 * daylight-saving flag.
 * @module services/waterdata/site-local-time
 */

/** A site's clock: its time-zone code and whether it observes daylight saving time. */
export interface SiteTimeZone {
  /** Time-zone code as `monitoring-locations` writes it — the standard-time code (`EST`, even in summer). */
  abbreviation: string;
  /** `uses_daylight_savings` = `Y`. */
  observesDaylightSaving: boolean;
}

/** UTC offset in minutes of a site's standard time, and of its daylight time when it has one. */
interface ZoneOffsets {
  daylightMinutes: number | undefined;
  standardMinutes: number;
}

function offsetMinutesOf(text: string): number {
  const [hours = '0', minutes = '0'] = text.slice(1).split(':');
  const magnitude = Number(hours) * 60 + Number(minutes);
  return text.startsWith('-') ? -magnitude : magnitude;
}

/**
 * Every code of the `time-zone-codes` collection: `time_zone_utc_offset` and
 * `time_zone_daylight_savings_utc_offset` (null for a code without a daylight time). The collection
 * is the NWIS code table WaterServices converted with; site records carry only the code.
 */
const ZONES: ReadonlyMap<string, ZoneOffsets> = new Map(
  (
    [
      ['ACST', '+09:30', '+10:30'],
      ['AEST', '+10:00', '+11:00'],
      ['AFT', '+04:30', null],
      ['AKST', '-09:00', '-08:00'],
      ['AST', '-04:00', '-03:00'],
      ['AWST', '+08:00', '+09:00'],
      ['BT', '+03:00', null],
      ['CAST', '+09:30', '+10:30'],
      ['CCT', '+08:00', null],
      ['CET', '+01:00', '+02:00'],
      ['CST', '-06:00', '-05:00'],
      ['DNT', '+01:00', null],
      ['DST', '+01:00', null],
      ['EAST', '+10:00', '+11:00'],
      ['EET', '+02:00', '+03:00'],
      ['EST', '-05:00', '-04:00'],
      ['FST', '+01:00', '+02:00'],
      ['GST', '+10:00', null],
      ['HST', '-10:00', '-09:00'],
      ['IDLE', '+12:00', null],
      ['IDLW', '-12:00', null],
      ['IST', '+02:00', null],
      ['IT', '+03:30', null],
      ['JST', '+09:00', null],
      ['JT', '+07:30', null],
      ['KST', '+09:00', null],
      ['LIGT', '+10:00', null],
      ['MET', '+01:00', '+02:00'],
      ['MEWT', '+01:00', '+02:00'],
      ['MEZ', '+01:00', null],
      ['MST', '-07:00', '-06:00'],
      ['MT', '+08:30', null],
      ['NFT', '-03:30', '-02:30'],
      ['NOR', '+01:00', null],
      ['NST', '-03:30', '-02:30'],
      ['NZST', '+12:00', '+13:00'],
      ['NZT', '+12:00', '+13:00'],
      ['PST', '-08:00', '-07:00'],
      ['SAT', '+09:30', '+10:30'],
      ['SET', '+01:00', null],
      ['SWT', '+01:00', '+02:00'],
      ['UTC', '+00:00', null],
      ['WAST', '+07:00', '+08:00'],
      ['WAT', '-01:00', null],
      ['WET', '+00:00', '+01:00'],
      ['WST', '+08:00', '+09:00'],
      ['ZP-11', '-11:00', null],
      ['ZP-2', '-02:00', null],
      ['ZP-3', '-03:00', null],
      ['ZP11', '+11:00', null],
      ['ZP4', '+04:00', null],
      ['ZP5', '+05:00', null],
      ['ZP6', '+06:00', null],
    ] as const
  ).map(([code, standard, daylight]) => [
    code,
    {
      standardMinutes: offsetMinutesOf(standard),
      daylightMinutes: daylight === null ? undefined : offsetMinutesOf(daylight),
    },
  ]),
);

/**
 * The time zone of a monitoring location, or null when it carries no code or one outside the
 * `time-zone-codes` table — its instants are then written in UTC.
 */
export function siteTimeZone(
  abbreviation: string | null | undefined,
  daylightSavingFlag: string | null | undefined,
): SiteTimeZone | null {
  if (!abbreviation || !ZONES.has(abbreviation)) return null;
  return { abbreviation, observesDaylightSaving: daylightSavingFlag === 'Y' };
}

const HOUR_MS = 3_600_000;

/**
 * The US daylight-time rules every site that observes daylight saving follows, read from
 * America/New_York's history. Each site that flags daylight saving sits in a US state or territory —
 * the foreign-coded ones among them are coding slips such as `SAT` in Utah — so the federal dates
 * apply, at 2 a.m. on the site's own clock.
 */
const US_RULES_ZONE = 'America/New_York';
const US_RULES_STANDARD_MINUTES = -300;

const newYorkClock = new Intl.DateTimeFormat('en-US', {
  timeZone: US_RULES_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
});

/** True when New York keeps daylight time at `instantMs` (a whole UTC hour). */
function newYorkInDaylight(instantMs: number): boolean {
  const part: Record<string, number> = {};
  for (const { type, value } of newYorkClock.formatToParts(instantMs)) part[type] = Number(value);
  const wallMs = Date.UTC(part.year ?? 0, (part.month ?? 1) - 1, part.day ?? 1, part.hour ?? 0);
  return wallMs - instantMs !== US_RULES_STANDARD_MINUTES * 60_000;
}

/** First whole hour in `[lowMs, highMs]` whose daylight state equals `wanted`, given it flips once. */
function firstHourWhere(lowMs: number, highMs: number, wanted: boolean): number {
  let low = lowMs / HOUR_MS;
  let high = highMs / HOUR_MS;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (newYorkInDaylight(mid * HOUR_MS) === wanted) high = mid;
    else low = mid + 1;
  }
  return low * HOUR_MS;
}

/** Each year's daylight-time window `[start, end)` on New York's clock, or null for a year without one. */
const daylightWindows = new Map<number, readonly [number, number] | null>();

/**
 * New York's daylight window in UTC `year`. A US year holds at most one window, and it always
 * contains July 1 (the year-round war time of 1942–45 included), so each edge is one flip between
 * January 1 and July 1, or between July 1 and the next January 1.
 */
function daylightWindow(year: number): readonly [number, number] | null {
  const known = daylightWindows.get(year);
  if (known !== undefined) return known;
  const yearStart = Date.UTC(year, 0, 1);
  const midYear = Date.UTC(year, 6, 1);
  const nextYear = Date.UTC(year + 1, 0, 1);
  const window = newYorkInDaylight(midYear)
    ? ([
        firstHourWhere(yearStart, midYear, true),
        firstHourWhere(midYear, nextYear, false),
      ] as const)
    : null;
  daylightWindows.set(year, window);
  return window;
}

/** A zone {@link siteTimeZone} returned always has an entry; any other is a programmer error. */
function offsetsOf(zone: SiteTimeZone): ZoneOffsets {
  const offsets = ZONES.get(zone.abbreviation);
  if (!offsets) throw new Error(`No offset is known for time zone ${zone.abbreviation}.`);
  return offsets;
}

/** UTC offset in minutes of a site's clock at `instantMs`; UTC for a site without a known zone. */
function offsetAt(instantMs: number, zone: SiteTimeZone | null): number {
  if (!zone) return 0;
  const { standardMinutes, daylightMinutes } = offsetsOf(zone);
  if (!zone.observesDaylightSaving || daylightMinutes === undefined) return standardMinutes;
  // The instant at which New York's standard clock reads what this site's standard clock reads.
  const onNewYorkClock = instantMs + (standardMinutes - US_RULES_STANDARD_MINUTES) * 60_000;
  const window = daylightWindow(new Date(onNewYorkClock).getUTCFullYear());
  return window && onNewYorkClock >= window[0] && onNewYorkClock < window[1]
    ? daylightMinutes
    : standardMinutes;
}

function offsetText(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/**
 * Render a UTC instant (`2026-11-11T07:50:00+00:00`, any form `Date.parse` reads) as the site's
 * local time with milliseconds and offset: `2026-11-11T02:50:00.000-05:00`. A site without a known
 * zone is written in UTC (`+00:00`), so the offset still states which clock the time is on.
 *
 * @throws {Error} when `utc` is not a parseable instant — validate upstream data before calling.
 */
export function toSiteLocalTimestamp(utc: string, zone: SiteTimeZone | null): string {
  const instantMs = Date.parse(utc);
  if (Number.isNaN(instantMs)) throw new Error(`Unreadable timestamp: ${utc}`);
  const offset = offsetAt(instantMs, zone);
  const local = new Date(instantMs + offset * 60_000).toISOString().slice(0, 23);
  return `${local}${offsetText(offset)}`;
}

/** The site-local calendar date (`YYYY-MM-DD`) of a UTC instant. */
export function siteLocalDate(instantMs: number, zone: SiteTimeZone | null): string {
  return new Date(instantMs + offsetAt(instantMs, zone) * 60_000).toISOString().slice(0, 10);
}

/**
 * The UTC instant (ms) at which site-local calendar day `date` (`YYYY-MM-DD`) begins. Midnight never
 * falls in a daylight-time gap — the switch happens at 2 a.m. — so the offset read at midnight
 * standard time is the one in force at midnight.
 */
export function siteLocalDayStart(date: string, zone: SiteTimeZone | null): number {
  const wallMs = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(wallMs)) throw new Error(`Unreadable date: ${date}`);
  if (!zone) return wallMs;
  const midnightStandardMs = wallMs - offsetsOf(zone).standardMinutes * 60_000;
  return wallMs - offsetAt(midnightStandardMs, zone) * 60_000;
}
