/**
 * @fileoverview Zod schemas for the input formats the tools accept, shared by every tool that
 * forwards a value into a USGS Water Data query, so a malformed value is rejected at the edge
 * before any request is sent.
 *
 * Each export is a bare, undescribed schema — attach tool-specific guidance with `.describe()` at
 * the definition site (`.describe()` clones, so the shared base is never mutated). The `.regex()`
 * constraints also serialize into each tool's advertised JSON Schema as `pattern`, so a calling
 * model sees the format rule rather than only reading it in prose.
 * @module services/waterdata/input-schemas
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

/** One or more 5-digit parameter codes, comma-separated. */
export const ParameterCdListSchema = z
  .string()
  .regex(
    /^\d{5}(,\d{5})*$/,
    'Parameter codes must be 5 digits each, comma-separated with no spaces (e.g. "00060" or "00060,00065").',
  );

/**
 * ISO 8601 duration, sent as a `time` filter that ends now. The OGC collections reject a negative
 * duration ("P-T2H" → 400 "Invalid ISO 8601 duration"), which this pattern excludes by
 * construction.
 */
export const PeriodSchema = z
  .string()
  .regex(
    /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/,
    'Must be an ISO 8601 duration (e.g. "PT2H", "P1D", "P7D"). Negative durations are not supported.',
  );

/**
 * Hydrologic Unit Code: a 2-digit region or an 8-digit subbasin, the two levels the WaterServices
 * filter took. It matches every site whose HUC starts with it, 12-digit HUCs included.
 */
export const HucSchema = z
  .string()
  .regex(
    /^(\d{2}|\d{8})$/,
    'huc must be a 2-digit region (e.g. "02") or an 8-digit subbasin (e.g. "02070008").',
  );

/** FIPS county code(s) — bare 5-digit codes, comma-separated, up to 20 per call. */
export const CountyCdSchema = z
  .string()
  .regex(
    /^\d{5}(,\d{5}){0,19}$/,
    'countyCd must be bare 5-digit FIPS code(s), comma-separated, max 20 (e.g. "51013" or "51059,51061").',
  );

/** 2-letter US state or territory postal code, any case. */
export const StateCdSchema = z
  .string()
  .regex(/^[A-Za-z]{2}$/, 'stateCd must be a 2-letter state or territory postal code (e.g. "VA").');

/** Bounding box — four comma-separated decimal degrees ordered "west,south,east,north". */
export const BboxSchema = z
  .string()
  .regex(
    /^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$/,
    'bbox must be 4 comma-separated decimal numbers as "west,south,east,north" (e.g. "-77.5,38.5,-76.5,39.5").',
  );
