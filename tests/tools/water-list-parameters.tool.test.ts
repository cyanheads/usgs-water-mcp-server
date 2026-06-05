/**
 * @fileoverview Tests for water_list_parameters tool — static parameter code catalog.
 * @module tests/tools/water-list-parameters.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { waterListParameters } from '@/mcp-server/tools/definitions/water-list-parameters.tool.js';

describe('waterListParameters', () => {
  it('returns the full catalog when group is "all"', () => {
    const ctx = createMockContext();
    const input = waterListParameters.input.parse({ group: 'all' });
    const result = waterListParameters.handler(input, ctx);
    expect(result.total).toBeGreaterThan(5);
    expect(result.parameters.length).toBe(result.total);
    expect(result.parameters.some((p) => p.code === '00060')).toBe(true);
    expect(result.parameters.some((p) => p.code === '72019')).toBe(true);
  });

  it('defaults to "all" group', () => {
    const ctx = createMockContext();
    const input = waterListParameters.input.parse({});
    const result = waterListParameters.handler(input, ctx);
    expect(result.total).toBeGreaterThan(5);
  });

  it('filters to streamflow group', () => {
    const ctx = createMockContext();
    const input = waterListParameters.input.parse({ group: 'streamflow' });
    const result = waterListParameters.handler(input, ctx);
    expect(result.total).toBeGreaterThan(0);
    expect(result.parameters.every((p) => p.group === 'streamflow')).toBe(true);
    expect(result.parameters.some((p) => p.code === '00060')).toBe(true);
    expect(result.parameters.some((p) => p.code === '72019')).toBe(false);
  });

  it('filters to groundwater group', () => {
    const ctx = createMockContext();
    const input = waterListParameters.input.parse({ group: 'groundwater' });
    const result = waterListParameters.handler(input, ctx);
    expect(result.total).toBeGreaterThan(0);
    expect(result.parameters.every((p) => p.group === 'groundwater')).toBe(true);
    expect(result.parameters.some((p) => p.code === '72019')).toBe(true);
  });

  it('returns structurally valid records', () => {
    const ctx = createMockContext();
    const input = waterListParameters.input.parse({ group: 'all' });
    const result = waterListParameters.handler(input, ctx);
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

  it('formats all parameters as code — name (unit) lines', () => {
    const ctx = createMockContext();
    const input = waterListParameters.input.parse({ group: 'streamflow' });
    const result = waterListParameters.handler(input, ctx);
    const blocks = waterListParameters.format!(result);
    const text = blocks[0]?.text ?? '';
    expect(text).toContain('00060');
    expect(text).toContain('Discharge');
    expect(text).toContain('ft');
    expect(text).toContain('streamflow');
  });
});
