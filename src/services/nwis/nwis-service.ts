/**
 * @fileoverview USGS NWIS Water Services integration — fetch wrapper with HTML-error detection,
 * RDB parser for site/stat endpoints, and JSON parser for IV/DV endpoints.
 * @module services/nwis/nwis-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  JsonRpcErrorCode,
  McpError,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type {
  NwisSite,
  NwisStatResult,
  NwisStatRow,
  NwisTimeSeries,
  NwisValueRecord,
} from './types.js';

const BASE_URL = 'https://waterservices.usgs.gov/nwis';

// ── HTTP helpers ──────────────────────────────────────────────────────────────

/**
 * Detect whether a response body looks like an NWIS HTML error page.
 * NWIS returns HTTP 400 with an HTML body for invalid inputs.
 */
function looksLikeHtml(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('<!') || t.startsWith('<html');
}

/** Extract a human-readable message from an HTML error page. */
function extractHtmlError(html: string): string {
  // Try <h1> first, then <title>
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1?.[1]) return h1[1].replace(/<[^>]+>/g, '').trim();
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title?.[1]) return title[1].replace(/<[^>]+>/g, '').trim();
  return 'NWIS returned an HTML error page with no extractable message.';
}

/** Maximum bytes consumed from an upstream error response body. */
const MAX_ERROR_BODY_BYTES = 4_096;

/** Fetch text from a URL, throwing on HTTP/network errors. */
async function fetchText(url: string, ctx: Context): Promise<string> {
  const cfg = getServerConfig();

  try {
    const resp = await fetchWithTimeout(url, cfg.requestTimeoutMs, ctx, {
      headers: { 'User-Agent': cfg.userAgent, Accept: '*/*' },
      signal: ctx.signal,
      expectedStatuses: [400, 404],
      errorBodyLimit: MAX_ERROR_BODY_BYTES,
    });
    return await resp.text();
  } catch (err: unknown) {
    if (!(err instanceof McpError)) throw err;

    const status = typeof err.data?.status === 'number' ? err.data.status : undefined;
    const body = typeof err.data?.body === 'string' ? err.data.body : '';
    if (status === undefined || status < 400 || status >= 500) throw err;

    // NWIS returns HTTP 404 with empty body when no data matches the query (valid filters, zero
    // results). Treat this as empty content so callers can surface the appropriate "not found"
    // contract error rather than a misleading ValidationError.
    if (status === 404 && body.trim() === '') {
      return '';
    }
    // HTML body → ValidationError with extracted message (not retryable)
    if (looksLikeHtml(body)) {
      const msg = extractHtmlError(body);
      throw validationError(
        `NWIS rejected the request: ${msg}`,
        { httpStatus: status },
        {
          cause: err,
        },
      );
    }
    throw validationError(
      `NWIS returned HTTP ${status}: ${body.slice(0, 200)}`,
      {
        httpStatus: status,
      },
      { cause: err },
    );
  }
}

// ── Failure classification ────────────────────────────────────────────────────

/** An NWIS failure mapped onto the reason vocabulary every network-calling tool declares. */
export interface NwisFailure {
  /** NWIS's own message, which names the offending field verbatim on a rejected request. */
  message: string;
  reason: 'invalid_request' | 'upstream_error';
}

/**
 * Classify an error raised by this module into the failure reason its calling tool declares.
 *
 * Every NWIS failure this module raises is already typed — an HTML 400 becomes a
 * `validationError`; a 5xx, or an IV/DV body that is not valid WaterML-JSON, becomes a
 * `serviceUnavailable` — so callers branch on the error's
 * code instead of re-matching its prose. `invalid_request` names no field on purpose: NWIS
 * reports the offending one verbatim in the message (`period: Invalid format…`,
 * `ParameterCd: length must be…`), and inferring a field from the wrapper text is what made a
 * malformed period surface as a malformed site number.
 *
 * Returns null for anything this module did not classify — raw network faults and aborts — which
 * callers rethrow for the framework's auto-classifier to handle.
 */
export function classifyNwisFailure(err: unknown): NwisFailure | null {
  if (!(err instanceof McpError)) return null;
  if (err.code === JsonRpcErrorCode.ValidationError) {
    return { reason: 'invalid_request', message: err.message };
  }
  if (err.code === JsonRpcErrorCode.ServiceUnavailable) {
    return { reason: 'upstream_error', message: err.message };
  }
  return null;
}

// ── RDB parser ────────────────────────────────────────────────────────────────

/**
 * Parse NWIS RDB (tab-delimited) format. Lines starting with '#' are comments.
 * First non-comment line: column headers. Second non-comment line: type/width metadata (skip).
 * Subsequent lines: data rows.
 */
function parseRdb(text: string): Array<Record<string, string>> {
  const lines = text.split('\n');
  const dataLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    dataLines.push(trimmed);
  }

  if (dataLines.length < 2) return []; // header + type line only

  const headers = (dataLines[0] ?? '').split('\t');
  // dataLines[1] is the type/width metadata row — skip it
  const results: Array<Record<string, string>> = [];

  for (let i = 2; i < dataLines.length; i++) {
    const cols = (dataLines[i] ?? '').split('\t');
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[(headers[j] ?? '').trim()] = (cols[j] ?? '').trim();
    }
    results.push(row);
  }

  return results;
}

/** Parse a string to a float, returning null if not a valid number. */
function parseFloat_(s: string | undefined): number | null {
  if (!s || s === '') return null;
  const n = Number.parseFloat(s);
  return Number.isNaN(n) ? null : n;
}

// ── Site service ──────────────────────────────────────────────────────────────

/** Map a single RDB row from the NWIS site service to an NwisSite. */
function mapSiteRow(r: Record<string, string>, fallbackSiteNo?: string): NwisSite {
  const drainageArea = parseFloat_(r['drain_area_va']);
  const altitude = parseFloat_(r['alt_va']);
  const contributingArea = parseFloat_(r['contrib_drain_area_va']);
  return {
    siteNumber: r['site_no'] ?? fallbackSiteNo ?? '',
    siteName: r['station_nm'] ?? '',
    siteType: r['site_tp_cd'] ?? '',
    latitude: parseFloat_(r['dec_lat_va']) ?? 0,
    longitude: parseFloat_(r['dec_long_va']) ?? 0,
    // state_cd, county_cd, drain_area_va, contrib_drain_area_va are only present in siteOutput=expanded;
    // alt_va and huc_cd are present in basic mode too, so they populate regardless of siteOutput —
    // but NWIS leaves huc_cd blank for some sites, so omit it (like every sibling) rather than
    // backfilling an empty string that renders as a bare "HUC:" label.
    ...(r['state_cd'] !== undefined && r['state_cd'] !== '' ? { stateCd: r['state_cd'] } : {}),
    ...(r['county_cd'] !== undefined && r['county_cd'] !== '' ? { countyCd: r['county_cd'] } : {}),
    ...(drainageArea !== null ? { drainageArea } : {}),
    ...(altitude !== null ? { altitude } : {}),
    ...(contributingArea !== null ? { contributingArea } : {}),
    ...(r['huc_cd'] !== undefined && r['huc_cd'] !== '' ? { hucCd: r['huc_cd'] } : {}),
  };
}

export interface FindSitesParams {
  bbox?: string;
  countyCd?: string;
  hasDataTypeCd?: string;
  huc?: string;
  parameterCd?: string;
  siteOutput?: 'basic' | 'expanded';
  siteType?: string;
  stateCd?: string;
}

/**
 * Find USGS monitoring sites via the NWIS site service.
 * Returns RDB-parsed site records.
 */
export async function findSites(params: FindSitesParams, ctx: Context): Promise<NwisSite[]> {
  const qs = new URLSearchParams({ format: 'rdb' });
  if (params.bbox) qs.set('bBox', params.bbox);
  if (params.stateCd) qs.set('stateCd', params.stateCd);
  if (params.countyCd) qs.set('countyCd', params.countyCd);
  if (params.huc) qs.set('huc', params.huc);
  if (params.siteType) qs.set('siteType', params.siteType);
  if (params.parameterCd) qs.set('parameterCd', params.parameterCd);
  if (params.hasDataTypeCd) qs.set('hasDataTypeCd', params.hasDataTypeCd);
  if (params.siteOutput) qs.set('siteOutput', params.siteOutput);

  const url = `${BASE_URL}/site/?${qs}`;

  const text = await withRetry(() => fetchText(url, ctx), {
    maxRetries: 3,
    baseDelayMs: 500,
    operation: 'findSites',
    context: ctx,
    signal: ctx.signal,
  });

  const rows = parseRdb(text);
  return rows.map((r) => mapSiteRow(r));
}

/** Get metadata for a single site. */
export async function getSiteInfo(siteNumber: string, ctx: Context): Promise<NwisSite | null> {
  const qs = new URLSearchParams({ format: 'rdb', sites: siteNumber, siteOutput: 'expanded' });
  const url = `${BASE_URL}/site/?${qs}`;

  const text = await withRetry(() => fetchText(url, ctx), {
    maxRetries: 3,
    baseDelayMs: 500,
    operation: 'getSiteInfo',
    context: ctx,
    signal: ctx.signal,
  });

  const first = parseRdb(text)[0];
  if (!first) return null;
  return mapSiteRow(first, siteNumber);
}

// ── HTML entity decoder ───────────────────────────────────────────────────────

/** Decode common HTML numeric entities in NWIS JSON string fields (e.g. &#179; → ³). */
function decodeHtmlEntities(s: string): string {
  return s.replace(/&#(\d+);/g, (_, code: string) =>
    String.fromCodePoint(Number.parseInt(code, 10)),
  );
}

// ── WaterML-JSON IV/DV parser ─────────────────────────────────────────────────

interface WatermlResponse {
  value?: {
    timeSeries?: Array<{
      /** `agency:site:parameter:statistic`, e.g. "USGS:01646500:00010:00003". */
      name?: string;
      sourceInfo?: {
        siteName?: string;
        siteCode?: Array<{ value?: string }>;
      };
      variable?: {
        variableCode?: Array<{ value?: string }>;
        variableName?: string;
        unit?: { unitCode?: string };
        /** Value NWIS writes in place of a reading it cannot provide — `-999999`. */
        noDataValue?: number | null;
        options?: {
          option?: Array<{ name?: string; optionCode?: string; value?: string }>;
        };
      };
      /** One block per method (sensor) — a timeSeries can carry several. */
      values?: Array<{
        method?: Array<{ methodID?: number | string; methodDescription?: string }>;
        value?: Array<{
          value?: string;
          qualifiers?: string[];
          dateTime?: string;
        }>;
      }>;
    }>;
  };
}

/** Decoded, non-empty string, or null — NWIS writes an unlabeled method as "". */
function nonEmpty(s: string | undefined): string | null {
  const decoded = decodeHtmlEntities(s ?? '').trim();
  return decoded === '' ? null : decoded;
}

/**
 * A record's value, or "" when NWIS reported none. NWIS writes the series' `noDataValue`
 * (`-999999`) for a reading it cannot provide — a seasonal, discontinued, dry, or malfunctioning
 * gage — and names the reason in the record's qualifiers (`Ssn`, `Dis`, `Dry`, `Eqp`, …), which
 * the caller keeps.
 */
function readValue(raw: string | undefined, noDataValue: number | null | undefined): string {
  if (!raw) return '';
  return noDataValue != null && Number(raw) === noDataValue ? '' : raw;
}

/**
 * Flatten a WaterML response into one series per `timeSeries` × method block.
 *
 * Each `values[]` block is a separate method — a second sensor, a relocated probe, a discontinued
 * gage — so every block is read. An empty block is dropped when a sibling block of the same
 * `timeSeries` carries values, since it adds nothing but a name; when every block is empty, one
 * empty series (the first block's) remains, so "this site reports the parameter but returned no
 * values" still reaches the caller instead of the series vanishing. A record holding the series'
 * no-data value keeps its place, timestamp, and qualifiers with an empty value — see
 * {@link readValue}.
 */
function parseWaterml(json: WatermlResponse): NwisTimeSeries[] {
  return (json.value?.timeSeries ?? []).flatMap((ts): NwisTimeSeries[] => {
    const noDataValue = ts.variable?.noDataValue;
    const statOption = ts.variable?.options?.option?.find((o) => o.name === 'Statistic');
    const base = {
      siteNumber: ts.sourceInfo?.siteCode?.[0]?.value ?? '',
      siteName: ts.sourceInfo?.siteName ?? '',
      parameterCd: ts.variable?.variableCode?.[0]?.value ?? '',
      parameterName: decodeHtmlEntities(ts.variable?.variableName ?? ''),
      unitCode: decodeHtmlEntities(ts.variable?.unit?.unitCode ?? ''),
      statCd: statOption?.optionCode ?? ts.name?.split(':')[3] ?? '',
      statName: nonEmpty(statOption?.value),
    };

    const blocks = (ts.values ?? []).map(
      (block): NwisTimeSeries => ({
        ...base,
        methodId: block.method?.[0]?.methodID?.toString() ?? null,
        methodDescription: nonEmpty(block.method?.[0]?.methodDescription),
        values: (block.value ?? []).map(
          (v): NwisValueRecord => ({
            dateTime: v.dateTime ?? '',
            value: readValue(v.value, noDataValue),
            qualifiers: v.qualifiers ?? [],
          }),
        ),
      }),
    );

    const withValues = blocks.filter((s) => s.values.length > 0);
    if (withValues.length > 0) return withValues;
    return [blocks[0] ?? { ...base, methodId: null, methodDescription: null, values: [] }];
  });
}

/**
 * Read an IV/DV response body as WaterML-JSON. NWIS sometimes answers HTTP 200 with a body cut off
 * mid-document; that — or any other body without a `value.timeSeries` array, which every
 * well-formed response carries (empty when nothing matched) — is an upstream fault, not a parse
 * bug, so it is raised as `ServiceUnavailable` for the retry wrapper to retry like a 503.
 */
function parseWatermlBody(text: string, url: string): NwisTimeSeries[] {
  let json: WatermlResponse | null;
  try {
    json = JSON.parse(text) as WatermlResponse | null;
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    throw serviceUnavailable(
      `NWIS returned a response that is not valid WaterML-JSON: ${detail}`,
      { url, bodyLength: text.length },
      { cause: err },
    );
  }
  if (json === null || !Array.isArray(json.value?.timeSeries)) {
    throw serviceUnavailable(
      'NWIS returned a response that is not valid WaterML-JSON: it carries no timeSeries document.',
      { url, bodyLength: text.length },
    );
  }
  return parseWaterml(json);
}

/**
 * Fetch and parse one IV/DV request. Parsing sits inside the retry so a truncated body is retried
 * and, if every attempt fails, surfaces as the same `ServiceUnavailable` a persistent 5xx does.
 */
function fetchWaterml(url: string, operation: string, ctx: Context): Promise<NwisTimeSeries[]> {
  return withRetry(async () => parseWatermlBody(await fetchText(url, ctx), url), {
    maxRetries: 3,
    baseDelayMs: 500,
    operation,
    context: ctx,
    signal: ctx.signal,
  });
}

/** True when at least one record carries a value — a record NWIS reported as no data does not. */
export function carriesValues(series: NwisTimeSeries | undefined): boolean {
  return series?.values.some((v) => v.value !== '') ?? false;
}

// ── IV service ────────────────────────────────────────────────────────────────

export interface GetReadingsParams {
  parameterCds?: string[];
  period?: string;
  sites: string[];
}

/** Get the latest instantaneous values for one or more sites. */
export function getReadings(params: GetReadingsParams, ctx: Context): Promise<NwisTimeSeries[]> {
  const qs = new URLSearchParams({
    format: 'json',
    sites: params.sites.join(','),
  });
  if (params.parameterCds?.length) qs.set('parameterCd', params.parameterCds.join(','));
  if (params.period) qs.set('period', params.period);
  else qs.set('period', 'PT2H'); // default: last 2 hours

  return fetchWaterml(`${BASE_URL}/iv/?${qs}`, 'getReadings', ctx);
}

// ── DV/IV series service ──────────────────────────────────────────────────────

export interface GetSeriesParams {
  endDate: string;
  parameterCd: string;
  seriesType: 'daily' | 'instantaneous';
  site: string;
  startDate: string;
  /**
   * Daily statistic code to request (e.g. "00003"). Forwarded to the DV service only, which then
   * returns that statistic alone — the IV service rejects the `statCd` keyword with an HTTP 400.
   */
  statCd?: string;
}

/**
 * Get a time series of daily or instantaneous values — one entry per statistic × method the
 * service returned (see {@link parseWaterml}).
 */
export function getSeries(params: GetSeriesParams, ctx: Context): Promise<NwisTimeSeries[]> {
  const endpoint = params.seriesType === 'daily' ? 'dv' : 'iv';
  const qs = new URLSearchParams({
    format: 'json',
    sites: params.site,
    parameterCd: params.parameterCd,
    startDT: params.startDate,
    endDT: params.endDate,
  });
  if (params.statCd && endpoint === 'dv') qs.set('statCd', params.statCd);

  return fetchWaterml(`${BASE_URL}/${endpoint}/?${qs}`, 'getSeries', ctx);
}

// ── Stat service ──────────────────────────────────────────────────────────────

/** Get daily percentile statistics for a site and parameter. */
export async function getStats(
  siteNumber: string,
  parameterCd: string,
  ctx: Context,
): Promise<NwisStatResult> {
  const qs = new URLSearchParams({
    format: 'rdb',
    sites: siteNumber,
    parameterCd,
    statReportType: 'daily',
    statType: 'all',
  });

  const url = `${BASE_URL}/stat/?${qs}`;

  const text = await withRetry(() => fetchText(url, ctx), {
    maxRetries: 3,
    baseDelayMs: 500,
    operation: 'getStats',
    context: ctx,
    signal: ctx.signal,
  });

  const rows = parseRdb(text);
  const statRows: NwisStatRow[] = rows.map(
    (r): NwisStatRow => ({
      monthNu: Number.parseInt(r['month_nu'] ?? '0', 10),
      dayNu: Number.parseInt(r['day_nu'] ?? '0', 10),
      beginYr: Number.parseInt(r['begin_yr'] ?? '0', 10),
      endYr: Number.parseInt(r['end_yr'] ?? '0', 10),
      countNu: Number.parseInt(r['count_nu'] ?? '0', 10),
      p05: parseFloat_(r['p05_va']),
      p10: parseFloat_(r['p10_va']),
      p25: parseFloat_(r['p25_va']),
      p50: parseFloat_(r['p50_va']),
      p75: parseFloat_(r['p75_va']),
      p95: parseFloat_(r['p95_va']),
      maxVa: parseFloat_(r['max_va']),
      minVa: parseFloat_(r['min_va']),
      meanVa: parseFloat_(r['mean_va']),
      tsId: r['ts_id'] || null,
      seriesDescription: nonEmpty(r['loc_web_ds']),
    }),
  );

  return { siteNumber, parameterCd, rows: statRows };
}
