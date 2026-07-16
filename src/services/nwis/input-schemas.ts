/**
 * @fileoverview Zod schemas for the input formats USGS NWIS actually accepts, verified against
 * the live service. Shared by every tool that forwards a value into an NWIS query parameter, so
 * a malformed value is rejected at the edge instead of being inferred from NWIS's HTML 400 prose.
 *
 * Each export is a bare, undescribed schema — attach tool-specific guidance with `.describe()` at
 * the definition site (`.describe()` clones, so the shared base is never mutated). The `.regex()`
 * constraints also serialize into each tool's advertised JSON Schema as `pattern`, so a calling
 * model sees the format rule rather than only reading it in prose.
 * @module services/nwis/input-schemas
 */

import { z } from '@cyanheads/mcp-ts-core';

/** USGS site number — 8–15 digits, zero-padded (e.g. "01646500"). */
export const SiteNumberSchema = z
  .string()
  .regex(
    /^\d{8,15}$/,
    'Site number must be 8–15 digits (e.g. "01646500"). Use water_find_sites to discover valid site numbers.',
  );

/** A single 5-digit USGS parameter code (e.g. "00060"). */
export const ParameterCdSchema = z
  .string()
  .regex(
    /^\d{5}$/,
    'Parameter code must be exactly 5 digits (e.g. "00060"). Use water_list_parameters to discover codes.',
  );

/**
 * One or more 5-digit parameter codes, comma-separated. NWIS accepts multi-value parameterCd on
 * the site service and the IV/DV data endpoints.
 */
export const ParameterCdListSchema = z
  .string()
  .regex(
    /^\d{5}(,\d{5})*$/,
    'Parameter codes must be 5 digits each, comma-separated with no spaces (e.g. "00060" or "00060,00065").',
  );

/**
 * ISO 8601 duration. NWIS requires the full duration grammar and rejects negative periods
 * (e.g. "P-T2H"), which this pattern excludes by construction.
 */
export const PeriodSchema = z
  .string()
  .regex(
    /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/,
    'period must be an ISO 8601 duration (e.g. "PT2H", "P1D", "P7D"). Negative periods are not supported.',
  );

/**
 * Hydrologic Unit Code. NWIS accepts a 2-digit major HUC or an 8-digit minor HUC and nothing
 * else — 4-, 6-, 10-, and 12-digit values are all rejected upstream.
 */
export const HucSchema = z
  .string()
  .regex(
    /^(\d{2}|\d{8})$/,
    'huc must be a 2-digit major HUC (e.g. "02") or an 8-digit minor HUC (e.g. "02070008"). NWIS accepts no other lengths.',
  );

/** FIPS county code(s) — bare 5-digit codes, comma-separated, up to the 20 NWIS allows per request. */
export const CountyCdSchema = z
  .string()
  .regex(
    /^\d{5}(,\d{5}){0,19}$/,
    'countyCd must be bare 5-digit FIPS code(s), comma-separated, max 20 (e.g. "51013" or "51059,51061").',
  );

/** 2-letter US state or territory abbreviation. */
export const StateCdSchema = z
  .string()
  .regex(/^[A-Za-z]{2}$/, 'stateCd must be a 2-letter state abbreviation (e.g. "VA").');

/** Bounding box — four comma-separated decimal degrees ordered "west,south,east,north". */
export const BboxSchema = z
  .string()
  .regex(
    /^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$/,
    'bbox must be 4 comma-separated decimal numbers as "west,south,east,north" (e.g. "-77.5,38.5,-76.5,39.5").',
  );
