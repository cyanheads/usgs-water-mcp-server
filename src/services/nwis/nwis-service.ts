/**
 * @fileoverview USGS NWIS Water Services integration — fetch wrapper with HTML-error detection,
 * RDB parser for site/stat endpoints, and JSON parser for IV/DV endpoints.
 * @module services/nwis/nwis-service
 */

import { serviceUnavailable, validationError } from '@cyanheads/mcp-ts-core/errors';
import { withRetry } from '@cyanheads/mcp-ts-core/utils';
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

/** Fetch a URL, enforcing a timeout via AbortController. */
async function fetchWithTimeout(url: string, signal?: AbortSignal): Promise<Response> {
  const cfg = getServerConfig();
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), cfg.requestTimeoutMs);

  // Chain with caller's signal if provided
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;

  try {
    return await fetch(url, {
      headers: { 'User-Agent': cfg.userAgent, Accept: '*/*' },
      signal: combined,
    });
  } finally {
    clearTimeout(tid);
  }
}

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

/** Fetch text from a URL, throwing on HTTP/network errors. */
async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const resp = await fetchWithTimeout(url, signal);

  // 5xx → ServiceUnavailable (retryable)
  if (resp.status >= 500) {
    const body = await resp.text().catch(() => '');
    throw serviceUnavailable(`NWIS returned HTTP ${resp.status}: ${resp.statusText}`, {
      url,
      status: resp.status,
      body: body.slice(0, 200),
    });
  }

  const text = await resp.text();

  // 400-class errors
  if (!resp.ok) {
    // NWIS returns HTTP 404 with empty body when no data matches the query (valid filters, zero
    // results). Treat this as empty content so callers can surface the appropriate "not found"
    // contract error rather than a misleading ValidationError.
    if (resp.status === 404 && text.trim() === '') {
      return '';
    }
    // HTML body → ValidationError with extracted message (not retryable)
    if (looksLikeHtml(text)) {
      const msg = extractHtmlError(text);
      throw validationError(`NWIS rejected the request: ${msg}`, { url, httpStatus: resp.status });
    }
    throw validationError(`NWIS returned HTTP ${resp.status}: ${text.slice(0, 200)}`, {
      url,
      httpStatus: resp.status,
    });
  }

  return text;
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
  return {
    siteNumber: r['site_no'] ?? fallbackSiteNo ?? '',
    siteName: r['station_nm'] ?? '',
    siteType: r['site_tp_cd'] ?? '',
    latitude: parseFloat_(r['dec_lat_va']) ?? 0,
    longitude: parseFloat_(r['dec_long_va']) ?? 0,
    stateCd: r['state_cd'] ?? '',
    countyCd: r['county_cd'] ?? '',
    hucCd: r['huc_cd'] ?? '',
    dataTypes: r['data_type_cd'] ? r['data_type_cd'].split(',').map((s) => s.trim()) : [],
    parameterCds: r['parm_cd'] ? [r['parm_cd']] : [],
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
export async function findSites(
  params: FindSitesParams,
  signal?: AbortSignal,
): Promise<NwisSite[]> {
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

  const text = await withRetry(() => fetchText(url, signal), {
    maxRetries: 3,
    baseDelayMs: 500,
    operation: 'findSites',
  });

  const rows = parseRdb(text);
  return rows.map((r) => mapSiteRow(r));
}

/** Get metadata for a single site. */
export async function getSiteInfo(
  siteNumber: string,
  signal?: AbortSignal,
): Promise<NwisSite | null> {
  const qs = new URLSearchParams({ format: 'rdb', sites: siteNumber, siteOutput: 'expanded' });
  const url = `${BASE_URL}/site/?${qs}`;

  const text = await withRetry(() => fetchText(url, signal), {
    maxRetries: 3,
    baseDelayMs: 500,
    operation: 'getSiteInfo',
  });

  const rows = parseRdb(text);
  if (rows.length === 0) return null;
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return mapSiteRow(rows[0]!, siteNumber);
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
      sourceInfo?: {
        siteName?: string;
        siteCode?: Array<{ value?: string }>;
      };
      variable?: {
        variableCode?: Array<{ value?: string }>;
        variableName?: string;
        unit?: { unitCode?: string };
      };
      values?: Array<{
        value?: Array<{
          value?: string;
          qualifiers?: string[];
          dateTime?: string;
        }>;
      }>;
    }>;
  };
}

function parseWaterml(json: WatermlResponse): NwisTimeSeries[] {
  const series = json.value?.timeSeries ?? [];
  return series.map((ts): NwisTimeSeries => {
    const siteNumber = ts.sourceInfo?.siteCode?.[0]?.value ?? '';
    const siteName = ts.sourceInfo?.siteName ?? '';
    const parameterCd = ts.variable?.variableCode?.[0]?.value ?? '';
    const parameterName = decodeHtmlEntities(ts.variable?.variableName ?? '');
    const unitCode = decodeHtmlEntities(ts.variable?.unit?.unitCode ?? '');
    const rawValues = ts.values?.[0]?.value ?? [];
    const values: NwisValueRecord[] = rawValues.map((v) => ({
      dateTime: v.dateTime ?? '',
      value: v.value ?? '',
      qualifiers: v.qualifiers ?? [],
    }));
    return { siteNumber, siteName, parameterCd, parameterName, unitCode, values };
  });
}

// ── IV service ────────────────────────────────────────────────────────────────

export interface GetReadingsParams {
  parameterCds?: string[];
  period?: string;
  sites: string[];
}

/** Get the latest instantaneous values for one or more sites. */
export async function getReadings(
  params: GetReadingsParams,
  signal?: AbortSignal,
): Promise<NwisTimeSeries[]> {
  const qs = new URLSearchParams({
    format: 'json',
    sites: params.sites.join(','),
  });
  if (params.parameterCds?.length) qs.set('parameterCd', params.parameterCds.join(','));
  if (params.period) qs.set('period', params.period);
  else qs.set('period', 'PT2H'); // default: last 2 hours

  const url = `${BASE_URL}/iv/?${qs}`;

  const text = await withRetry(() => fetchText(url, signal), {
    maxRetries: 3,
    baseDelayMs: 500,
    operation: 'getReadings',
  });

  return parseWaterml(JSON.parse(text) as WatermlResponse);
}

// ── DV/IV series service ──────────────────────────────────────────────────────

export interface GetSeriesParams {
  endDate: string;
  parameterCd: string;
  seriesType: 'daily' | 'instantaneous';
  site: string;
  startDate: string;
}

/** Get a time series of daily or instantaneous values. */
export async function getSeries(
  params: GetSeriesParams,
  signal?: AbortSignal,
): Promise<NwisTimeSeries[]> {
  const endpoint = params.seriesType === 'daily' ? 'dv' : 'iv';
  const qs = new URLSearchParams({
    format: 'json',
    sites: params.site,
    parameterCd: params.parameterCd,
    startDT: params.startDate,
    endDT: params.endDate,
  });

  const url = `${BASE_URL}/${endpoint}/?${qs}`;

  const text = await withRetry(() => fetchText(url, signal), {
    maxRetries: 3,
    baseDelayMs: 500,
    operation: 'getSeries',
  });

  return parseWaterml(JSON.parse(text) as WatermlResponse);
}

// ── Stat service ──────────────────────────────────────────────────────────────

/** Get daily percentile statistics for a site and parameter. */
export async function getStats(
  siteNumber: string,
  parameterCd: string,
  signal?: AbortSignal,
): Promise<NwisStatResult> {
  const qs = new URLSearchParams({
    format: 'rdb',
    sites: siteNumber,
    parameterCd,
    statReportType: 'daily',
    statType: 'all',
  });

  const url = `${BASE_URL}/stat/?${qs}`;

  const text = await withRetry(() => fetchText(url, signal), {
    maxRetries: 3,
    baseDelayMs: 500,
    operation: 'getStats',
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
    }),
  );

  return { siteNumber, parameterCd, rows: statRows };
}
