/**
 * @fileoverview Tests for the canvas table-name builders — sanitization, the deterministic filter
 * digest, and the identifier guard.
 * @module tests/services/canvas-table-name.test
 */

import { CANVAS_IDENTIFIER_REGEX } from '@cyanheads/mcp-ts-core/canvas';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import {
  assertCanvasTableName,
  sanitizeIdentifierToken,
  shortHash,
} from '@/services/canvas/canvas-table-name.js';

describe('sanitizeIdentifierToken', () => {
  it('passes through a value that is already identifier-safe', () => {
    expect(sanitizeIdentifierToken('ST')).toBe('ST');
    expect(sanitizeIdentifierToken('site_type_9')).toBe('site_type_9');
  });

  it('preserves case — the token is read alongside the filters that produced it', () => {
    expect(sanitizeIdentifierToken('Ks')).toBe('Ks');
  });

  it('rewrites every character outside [A-Za-z0-9_]', () => {
    // The three shapes that actually reach a filter value: comma lists, bbox decimals/signs, and
    // the colon county form NWIS rejects but a caller may still try.
    expect(sanitizeIdentifierToken('ST,GW')).toBe('ST_GW');
    expect(sanitizeIdentifierToken('-77.5,38.5,-76.5,39.5')).toBe('_77_5_38_5__76_5_39_5');
    expect(sanitizeIdentifierToken('51:013')).toBe('51_013');
  });

  it('leaves no character the canvas identifier rule rejects, for any input', () => {
    for (const value of ['ST,GW', 'a b\tc', 'x"; DROP TABLE y', 'é—ü', '../etc/passwd']) {
      expect(`t_${sanitizeIdentifierToken(value)}`).toMatch(CANVAS_IDENTIFIER_REGEX);
    }
  });
});

describe('shortHash', () => {
  it('returns 8 lowercase hex characters', () => {
    expect(shortHash({ stateCd: 'RI' })).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is stable for the same filter set — the property that makes re-staging idempotent', () => {
    expect(shortHash({ stateCd: 'RI', siteType: 'ST' })).toBe(
      shortHash({ stateCd: 'RI', siteType: 'ST' }),
    );
  });

  it('ignores key order', () => {
    expect(shortHash({ stateCd: 'RI', siteType: 'ST' })).toBe(
      shortHash({ siteType: 'ST', stateCd: 'RI' }),
    );
  });

  it('treats an absent key and an explicitly-undefined key alike', () => {
    expect(shortHash({ stateCd: 'RI', siteType: undefined })).toBe(shortHash({ stateCd: 'RI' }));
  });

  it('changes when any value changes', () => {
    const base = shortHash({ stateCd: 'RI', siteType: 'ST' });
    expect(shortHash({ stateCd: 'RI', siteType: 'GW' })).not.toBe(base);
    expect(shortHash({ stateCd: 'VA', siteType: 'ST' })).not.toBe(base);
    expect(shortHash({ stateCd: 'RI', siteType: 'ST', parameterCd: '00060' })).not.toBe(base);
  });

  it('distinguishes a value moved between keys', () => {
    expect(shortHash({ stateCd: 'RI', huc: undefined })).not.toBe(
      shortHash({ stateCd: undefined, huc: 'RI' }),
    );
  });

  it('canonicalizes nested objects at every depth, not just the top level', () => {
    expect(shortHash({ a: { z: 1, y: { q: 2, p: 3 } } })).toBe(
      shortHash({ a: { y: { p: 3, q: 2 }, z: 1 } }),
    );
    expect(shortHash({ a: { y: { p: 3, q: 2 }, z: 1 } })).not.toBe(
      shortHash({ a: { y: { p: 3, q: 9 }, z: 1 } }),
    );
  });

  it('keeps array order significant — position carries meaning there', () => {
    expect(shortHash({ codes: ['00060', '00065'] })).not.toBe(
      shortHash({ codes: ['00065', '00060'] }),
    );
  });

  it('distinguishes a nested object from its flattened spelling', () => {
    expect(shortHash({ a: { b: 1 } })).not.toBe(shortHash({ a: 1, b: 1 }));
  });
});

describe('assertCanvasTableName', () => {
  it('returns a legal identifier unchanged', () => {
    expect(assertCanvasTableName('water_sites_RI_ST_0a1b2c3d')).toBe('water_sites_RI_ST_0a1b2c3d');
  });

  it('accepts a name at the 63-character cap and rejects one past it', () => {
    expect(assertCanvasTableName('w'.repeat(63))).toHaveLength(63);
    expect(() => assertCanvasTableName('w'.repeat(64))).toThrow(McpError);
  });

  it('rejects a name that does not start with a letter or underscore', () => {
    expect(() => assertCanvasTableName('9water_sites')).toThrow(McpError);
  });

  it('rejects a name carrying a character outside the identifier rule', () => {
    expect(() => assertCanvasTableName('water_sites_ST,GW_0a1b2c3d')).toThrow(McpError);
  });

  it('rejects an empty name', () => {
    expect(() => assertCanvasTableName('')).toThrow(McpError);
  });

  it('names the offending value in the error, so the derivation is debuggable', () => {
    expect(() => assertCanvasTableName('water sites')).toThrow(/water sites/);
  });
});
