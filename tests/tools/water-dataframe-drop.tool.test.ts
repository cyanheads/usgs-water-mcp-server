/**
 * @fileoverview Tests for water_dataframe_drop — remove one staged table from a DataCanvas. Runs
 * against a real DuckDB-backed canvas wired through the server's own canvas accessor, so the
 * acquire → describe → drop path under test is the one a deployment takes.
 * @module tests/tools/water-dataframe-drop.tool.test
 */

import {
  CanvasInstance,
  CanvasRegistry,
  DataCanvas,
  DuckdbProvider,
} from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waterDataframeDescribe } from '@/mcp-server/tools/definitions/water-dataframe-describe.tool.js';
import { waterDataframeDrop } from '@/mcp-server/tools/definitions/water-dataframe-drop.tool.js';
import { setCanvas } from '@/services/canvas/canvas-accessor.js';
import { textContent } from '../helpers/content-block.js';
import { captureError, contractError, declaredRecovery } from '../helpers/error-contract.js';

/**
 * Load the tool with its opt-in flag on, so the definition under test is the callable one a
 * deployment registers rather than the disabled-wrapped copy. Hoisted above the imports.
 */
vi.hoisted(() => {
  process.env.WATER_DATAFRAME_DROP_ENABLED = 'true';
});

const recovery = (reason: string) => declaredRecovery(waterDataframeDrop.errors, reason);

const TTL_MS = 60_000;
const SERIES_TABLE = 'water_series_01646500_00060_dv_20240101_20240103';
const SITES_TABLE = 'water_sites_WA_ST_0a1b2c3d';

let now: number;
let canvas: DataCanvas;
let instance: CanvasInstance;

/** Structured result of a successful drop, read off the contract runner's wire result. */
async function dropTable(canvasId: string, tableName: string) {
  const call = await runToolContract(waterDataframeDrop, {
    canvas_id: canvasId,
    table_name: tableName,
  });
  if (call.isError) throw new Error(`Expected the drop to succeed: ${JSON.stringify(call)}`);
  return call;
}

/** Table names the real describe tool reports for `canvasId`. */
async function describedTables(canvasId: string): Promise<string[]> {
  const call = await runToolContract(waterDataframeDescribe, { canvas_id: canvasId });
  const { tables } = call.structuredContent as { tables: { name: string }[] };
  return tables.map((t) => t.name);
}

describe('waterDataframeDrop', () => {
  beforeEach(async () => {
    now = Date.now();
    const provider = new DuckdbProvider({
      defaultRowLimit: 10_000,
      exportRootPath: '.canvas-exports',
      memoryLimitMb: 128,
      schemaSniffRows: 100,
    });
    const registry = new CanvasRegistry(
      provider,
      { absoluteCapMs: 10 * TTL_MS, maxCanvasesPerTenant: 10, sweeperIntervalMs: 0, ttlMs: TTL_MS },
      () => now,
    );
    canvas = new DataCanvas(provider, registry);
    setCanvas(canvas);

    instance = await canvas.acquire(undefined, createMockContext());
    await instance.registerTable(SERIES_TABLE, [
      { date_time: '2024-01-01', value: 5000 },
      { date_time: '2024-01-02', value: 5200 },
      { date_time: '2024-01-03', value: 5100 },
    ]);
    await instance.registerTable(SITES_TABLE, [
      { site_number: '12345678', site_name: 'Example Creek' },
      { site_number: '12345679', site_name: 'Example River' },
    ]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    setCanvas(undefined);
    await canvas.shutdown(createMockContext());
  });

  it('is the callable definition when WATER_DATAFRAME_DROP_ENABLED=true', () => {
    expect(waterDataframeDrop).not.toHaveProperty('__mcpDisabled');
    expect(waterDataframeDrop.name).toBe('water_dataframe_drop');
  });

  it('declares a destructive, idempotent, closed-world action', () => {
    expect(waterDataframeDrop.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it('drops the named table and leaves the canvas and its other tables in place', async () => {
    const call = await dropTable(instance.canvasId, SERIES_TABLE);

    expect(call.structuredContent).toEqual({
      canvas_id: instance.canvasId,
      table_name: SERIES_TABLE,
      row_count: 3,
      remaining_tables: [SITES_TABLE],
    });
    // The real describe tool no longer lists it, while the other table survives untouched.
    await expect(describedTables(instance.canvasId)).resolves.toEqual([SITES_TABLE]);
    const survivor = await instance.query(`SELECT COUNT(*) AS n FROM ${SITES_TABLE}`);
    expect(Number(survivor.rows[0]?.n)).toBe(2);
  });

  it('carries the same data in content[] as in structuredContent', async () => {
    const call = await dropTable(instance.canvasId, SERIES_TABLE);
    const text = textContent(call.content?.[0]);

    expect(text).toContain(instance.canvasId);
    expect(text).toContain(SERIES_TABLE);
    expect(text).toContain('3 rows');
    expect(text).toContain(SITES_TABLE);
  });

  it('leaves an empty, still-usable canvas after dropping its last table', async () => {
    await dropTable(instance.canvasId, SERIES_TABLE);
    const call = await dropTable(instance.canvasId, SITES_TABLE);

    expect(call.structuredContent).toMatchObject({ row_count: 2, remaining_tables: [] });
    expect(textContent(call.content?.[0])).toContain('No tables remain on this canvas.');
    // The canvas itself survives the drop of its last table: the id still resolves.
    await expect(describedTables(instance.canvasId)).resolves.toEqual([]);
  });

  it('fails table_not_found for a name not staged on the canvas, and drops nothing', async () => {
    const error = await contractError(waterDataframeDrop, {
      canvas_id: instance.canvasId,
      table_name: 'water_series_09380000_00060_dv_20240101_20240103',
    });

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'table_not_found', recovery: recovery('table_not_found') },
    });
    expect(error.message).toContain('water_series_09380000_00060_dv_20240101_20240103');
    expect(error.message).toContain(instance.canvasId);
    await expect(describedTables(instance.canvasId)).resolves.toEqual([SERIES_TABLE, SITES_TABLE]);
  });

  it('fails table_not_found on a repeat drop, changing nothing further', async () => {
    await dropTable(instance.canvasId, SERIES_TABLE);

    await expect(
      contractError(waterDataframeDrop, { canvas_id: instance.canvasId, table_name: SERIES_TABLE }),
    ).resolves.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'table_not_found', recovery: recovery('table_not_found') },
    });
    await expect(describedTables(instance.canvasId)).resolves.toEqual([SITES_TABLE]);
  });

  it('resolves the name case-insensitively, as SQL on the canvas does, and reports the stored name', async () => {
    // DuckDB identifiers are case-insensitive, so water_dataframe_query reaches this table under
    // either spelling — the drop resolves it the same way.
    const lower = SITES_TABLE.toLowerCase();
    await expect(instance.query(`SELECT COUNT(*) AS n FROM ${lower}`)).resolves.toBeDefined();

    const call = await dropTable(instance.canvasId, lower);

    expect(call.structuredContent).toMatchObject({ table_name: SITES_TABLE, row_count: 2 });
    await expect(describedTables(instance.canvasId)).resolves.toEqual([SERIES_TABLE]);
  });

  it('fails table_not_found when the table goes away between the listing and the drop', async () => {
    // A concurrent drop or a per-table expiry can land after describe() listed the table.
    vi.spyOn(CanvasInstance.prototype, 'drop').mockResolvedValueOnce(false);

    await expect(
      contractError(waterDataframeDrop, { canvas_id: instance.canvasId, table_name: SERIES_TABLE }),
    ).resolves.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'table_not_found', recovery: recovery('table_not_found') },
    });
  });

  it('reports a reserved SQL keyword as a table that is not staged', async () => {
    // Passes the identifier pattern, but no canvas table can carry a reserved keyword.
    await expect(
      contractError(waterDataframeDrop, { canvas_id: instance.canvasId, table_name: 'select' }),
    ).resolves.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'table_not_found', recovery: recovery('table_not_found') },
    });
  });

  it.each([
    ['a hyphenated name', 'water-series'],
    ['an empty string', ''],
    ['a leading digit', '1table'],
    ['a name past 63 characters', `t${'x'.repeat(63)}`],
    ['a SQL fragment', 'x; DROP TABLE y'],
  ])('rejects %s at argument validation, before any canvas work', async (_label, table_name) => {
    await expect(
      contractError(waterDataframeDrop, { canvas_id: instance.canvasId, table_name }),
    ).resolves.toMatchObject({ code: JsonRpcErrorCode.InvalidParams });
    await expect(describedTables(instance.canvasId)).resolves.toEqual([SERIES_TABLE, SITES_TABLE]);
  });

  it('fails canvas_not_found for a well-formed canvas_id the registry never minted', async () => {
    await expect(
      contractError(waterDataframeDrop, { canvas_id: 'abcdefghij', table_name: SERIES_TABLE }),
    ).resolves.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'canvas_not_found', recovery: recovery('canvas_not_found') },
    });
  });

  it('fails canvas_not_found once the canvas has expired', async () => {
    now += TTL_MS + 1;

    await expect(
      contractError(waterDataframeDrop, { canvas_id: instance.canvasId, table_name: SERIES_TABLE }),
    ).resolves.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'canvas_not_found', recovery: recovery('canvas_not_found') },
    });
  });

  it('declares canvas_not_found as service-thrown — the shared acquire helper raises it', () => {
    const entry = waterDataframeDrop.errors!.find((e) => e.reason === 'canvas_not_found');
    expect(entry).toMatchObject({ code: JsonRpcErrorCode.NotFound, thrownBy: 'service' });
  });

  it('fails canvas_disabled when DataCanvas is not configured', async () => {
    setCanvas(undefined);

    await expect(
      contractError(waterDataframeDrop, { canvas_id: instance.canvasId, table_name: SERIES_TABLE }),
    ).resolves.toMatchObject({
      code: JsonRpcErrorCode.InvalidRequest,
      data: { reason: 'canvas_disabled', recovery: recovery('canvas_disabled') },
    });
  });

  it('keeps the operator env var out of the agent-facing canvas_disabled message', async () => {
    setCanvas(undefined);
    const ctx = createMockContext({ errors: waterDataframeDrop.errors });
    const input = waterDataframeDrop.input.parse({
      canvas_id: instance.canvasId,
      table_name: SERIES_TABLE,
    });

    const error = (await captureError(() => waterDataframeDrop.handler(input, ctx))) as Error;
    expect(error.message).toBe('DataCanvas is not enabled on this server instance.');
    expect(error.message).not.toContain('CANVAS_PROVIDER_TYPE');
  });

  it('formats every output field, naming the remaining tables', () => {
    const text = textContent(
      waterDataframeDrop.format!({
        canvas_id: 'canvas0001',
        table_name: SERIES_TABLE,
        row_count: 600,
        remaining_tables: [SITES_TABLE, 'water_series_12345678_00065_iv_20240101_20240102'],
      })[0],
    );

    expect(text).toContain('canvas0001');
    expect(text).toContain(SERIES_TABLE);
    expect(text).toContain('600 rows');
    expect(text).toContain('Remaining tables (2)');
    expect(text).toContain(SITES_TABLE);
    expect(text).toContain('water_series_12345678_00065_iv_20240101_20240102');
  });
});
