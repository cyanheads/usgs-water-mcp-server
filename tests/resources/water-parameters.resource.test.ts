/**
 * @fileoverview Tests for usgs-water://parameters resource — static parameter catalog.
 * @module tests/resources/water-parameters.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { waterParametersResource } from '@/mcp-server/resources/definitions/water-parameters.resource.js';

describe('waterParametersResource', () => {
  it('returns the full parameter catalog', () => {
    const ctx = createMockContext({ uri: new URL('usgs-water://parameters') });
    const result = waterParametersResource.handler({}, ctx) as {
      parameters: unknown[];
      total: number;
    };
    expect(result.total).toBeGreaterThan(5);
    expect(result.parameters.length).toBe(result.total);
  });

  it('includes key parameter codes (00060, 00065, 72019)', () => {
    const ctx = createMockContext({ uri: new URL('usgs-water://parameters') });
    const result = waterParametersResource.handler({}, ctx) as {
      parameters: Array<{ code: string }>;
      total: number;
    };
    const codes = result.parameters.map((p) => p.code);
    expect(codes).toContain('00060');
    expect(codes).toContain('00065');
    expect(codes).toContain('72019');
  });

  it('returns records with required fields', () => {
    const ctx = createMockContext({ uri: new URL('usgs-water://parameters') });
    const result = waterParametersResource.handler({}, ctx) as {
      parameters: Array<{ code: string; name: string; unit: string; group: string }>;
      total: number;
    };
    for (const p of result.parameters) {
      expect(p.code).toMatch(/^\d{5}$/);
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.unit.length).toBeGreaterThan(0);
      expect([
        'streamflow',
        'groundwater',
        'temperature',
        'meteorological',
        'water-quality',
      ]).toContain(p.group);
    }
  });

  it('list() returns the parameters URI entry', () => {
    const listing = waterParametersResource.list!();
    expect(listing.resources).toHaveLength(1);
    expect(listing.resources[0]?.uri).toBe('usgs-water://parameters');
    expect(listing.resources[0]?.mimeType).toBe('application/json');
  });

  it('handler returns same data regardless of how many times called (idempotent)', () => {
    const ctx = createMockContext({ uri: new URL('usgs-water://parameters') });
    const r1 = waterParametersResource.handler({}, ctx) as { total: number };
    const r2 = waterParametersResource.handler({}, ctx) as { total: number };
    expect(r1.total).toBe(r2.total);
  });
});
