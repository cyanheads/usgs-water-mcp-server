/**
 * @fileoverview Tests for server config parsing — the WATER_DATAFRAME_DROP_ENABLED flag that gates
 * water_dataframe_drop. Each case loads the config module fresh, since getServerConfig() caches its
 * first parse for the life of the module.
 * @module tests/config/server-config.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureError } from '../helpers/error-contract.js';

/** Parse the server config with WATER_DATAFRAME_DROP_ENABLED set to `value` (undefined = unset). */
async function parseWithDropFlag(value: string | undefined) {
  vi.resetModules();
  vi.stubEnv('WATER_DATAFRAME_DROP_ENABLED', value);
  const { getServerConfig } = await import('@/config/server-config.js');
  return getServerConfig();
}

describe('getServerConfig — WATER_DATAFRAME_DROP_ENABLED', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('defaults to false when the variable is unset', async () => {
    await expect(parseWithDropFlag(undefined)).resolves.toMatchObject({
      dataframeDropEnabled: false,
    });
  });

  it.each([
    ['true', true],
    ['TRUE', true],
    ['1', true],
    ['false', false],
    ['0', false],
    ['yes', true],
    ['on', true],
    ['y', true],
    ['enabled', true],
    ['no', false],
    ['off', false],
    ['n', false],
    ['disabled', false],
    ['On', true],
    ['OFF', false],
  ])('parses %s as %s', async (value, expected) => {
    await expect(parseWithDropFlag(value)).resolves.toMatchObject({
      dataframeDropEnabled: expected,
    });
  });

  it.each([
    ['a blank value', ''],
    ['whitespace', '   '],
    ['an unsubstituted host placeholder', `\${WATER_DATAFRAME_DROP_ENABLED}`],
  ])('reads %s as unset and keeps the default', async (_label, value) => {
    await expect(parseWithDropFlag(value)).resolves.toMatchObject({
      dataframeDropEnabled: false,
    });
  });

  it('rejects an unrecognized value naming the variable, instead of coercing it to true', async () => {
    const error = await captureError(() => parseWithDropFlag('maybe'));
    expect(error).toMatchObject({ code: JsonRpcErrorCode.ConfigurationError });
    expect((error as Error).message).toContain('WATER_DATAFRAME_DROP_ENABLED');
  });

  it('reads the registration flag without validating unrelated configuration', async () => {
    vi.resetModules();
    vi.stubEnv('USGS_REQUEST_TIMEOUT_MS', 'abc');
    vi.stubEnv('WATER_DATAFRAME_DROP_ENABLED', 'true');
    const { isDataframeDropEnabled, getServerConfig } = await import('@/config/server-config.js');
    expect(isDataframeDropEnabled()).toBe(true);
    expect(() => getServerConfig()).toThrow('USGS_REQUEST_TIMEOUT_MS');
  });

  it('defers an invalid registration flag to full startup validation', async () => {
    vi.resetModules();
    vi.stubEnv('WATER_DATAFRAME_DROP_ENABLED', 'garbage');
    const { isDataframeDropEnabled, getServerConfig } = await import('@/config/server-config.js');
    expect(isDataframeDropEnabled()).toBe(false);
    expect(() => getServerConfig()).toThrow('WATER_DATAFRAME_DROP_ENABLED');
  });
});
