/**
 * @fileoverview Tests for water_dataframe_query tool — SQL SELECT against canvas tables.
 * Mocks the canvas-accessor to avoid live DuckDB.
 * @module tests/tools/water-dataframe-query.tool.test
 */

import { JsonRpcErrorCode, notFound, validationError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waterDataframeQuery } from '@/mcp-server/tools/definitions/water-dataframe-query.tool.js';
import { declaredRecovery } from '../helpers/error-contract.js';

let mockCanvasInstance: unknown;

vi.mock('@/services/canvas/canvas-accessor.js', () => ({
  getCanvas: () => mockCanvasInstance,
}));

const recovery = (reason: string) => declaredRecovery(waterDataframeQuery.errors, reason);

/**
 * Errors copied verbatim from @cyanheads/mcp-ts-core so these tests assert against what the canvas
 * actually raises. Every one is a structured `McpError` carrying `data.reason`:
 * `CanvasRegistry.canvasNotFound()` and the `DuckdbProvider.assertReadOnlySql` / `sqlGate` paths.
 */
const CANVAS_ERRORS = {
  canvasNotFound: (canvasId: string) =>
    notFound('Canvas not found or expired.', {
      reason: 'canvas_not_found',
      canvasId,
      recovery: {
        hint: 'Re-run the tool that produced this canvas_id to stage fresh data, or verify the id was copied correctly.',
      },
    }),
  /** `assertSelectOnly` — the mutation-statement rejection that names internal canvas methods (#25). */
  nonSelect: (statementType: string) =>
    validationError(
      `Canvas query must be SELECT; got ${statementType}. Mutations must use registerTable, drop, or clear.`,
      { reason: 'non_select_statement', statementType },
    ),
  /** `assertNoSystemCatalogs` — provoked by this tool's own `denySystemCatalogs: true`. */
  systemCatalog: (catalog: string) =>
    validationError(
      `Canvas query references a system catalog: ${catalog}. System catalogs are not permitted when denySystemCatalogs is enabled.`,
      { reason: 'system_catalog_access', catalog },
    ),
  /** Provider prepare step — a SELECT naming a table that is not staged. */
  missingTable: (tableName: string) =>
    notFound(
      `Canvas table "${tableName}" does not exist. The table may have expired or been dropped — re-stage it or call describe() to inspect the canvas.`,
      {
        reason: 'missing_table',
        tableName,
        recovery: {
          hint: 'Re-stage the table via registerTable() or call describe() to see what tables are currently available.',
        },
      },
    ),
  /** Provider prepare step — a SELECT-shaped statement DuckDB's binder rejected. */
  binderFailure: (binderMessage: string) =>
    validationError(`Canvas query failed to prepare: ${binderMessage}`, {
      reason: 'invalid_sql',
      statementType: 'UNKNOWN',
      binderMessage,
    }),
  /** `assertNoDeniedFunctions` — file-reading table functions. */
  deniedFunction: (fn: string) =>
    validationError(
      `Canvas query references disallowed table function: ${fn}. File-reading and external-data functions are not permitted.`,
      { reason: 'denied_function', function: fn },
    ),
};

/** Canvas whose `query` rejects with `err`. */
function canvasRejecting(err: unknown) {
  return {
    acquire: vi.fn().mockResolvedValue({
      canvasId: 'canvas0001xx',
      query: vi.fn().mockRejectedValue(err),
    }),
  };
}

const MOCK_QUERY_RESULT = {
  rows: [
    {
      date_time: '2024-01-01',
      value: '5000',
      qualifiers: 'A',
      site_number: '01646500',
      parameter_cd: '00060',
      unit_code: 'ft3/s',
    },
    {
      date_time: '2024-01-02',
      value: '5200',
      qualifiers: 'A',
      site_number: '01646500',
      parameter_cd: '00060',
      unit_code: 'ft3/s',
    },
  ],
  rowCount: 2,
  columns: ['date_time', 'value', 'qualifiers', 'site_number', 'parameter_cd', 'unit_code'],
};

describe('waterDataframeQuery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanvasInstance = undefined;
  });

  it('throws canvas_disabled when canvas is not configured', async () => {
    mockCanvasInstance = undefined;
    const ctx = createMockContext({ errors: waterDataframeQuery.errors });
    const input = waterDataframeQuery.input.parse({
      canvas_id: 'canvas0001xx',
      sql: 'SELECT * FROM water_series_01646500_00060 LIMIT 10',
    });
    await expect(waterDataframeQuery.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidRequest,
      data: { reason: 'canvas_disabled', recovery: recovery('canvas_disabled') },
    });
  });

  it('canvas_disabled error is agent-facing and omits the CANVAS_PROVIDER_TYPE env var (regression: #8)', async () => {
    mockCanvasInstance = undefined;
    const ctx = createMockContext({ errors: waterDataframeQuery.errors });
    const input = waterDataframeQuery.input.parse({
      canvas_id: 'canvas0001xx',
      sql: 'SELECT * FROM water_series_01646500_00060 LIMIT 10',
    });
    const error = (await waterDataframeQuery.handler(input, ctx).catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('DataCanvas is not enabled on this server instance.');
    expect(error.message).not.toContain('CANVAS_PROVIDER_TYPE');
  });

  it('throws canvas_not_found when acquire rejects a stale canvas_id', async () => {
    mockCanvasInstance = {
      acquire: vi.fn().mockRejectedValue(CANVAS_ERRORS.canvasNotFound('stalecanvas1')),
    };
    const ctx = createMockContext({ errors: waterDataframeQuery.errors });
    const input = waterDataframeQuery.input.parse({
      canvas_id: 'stalecanvas1',
      sql: 'SELECT date_time, value FROM water_series_01646500_00060',
    });
    await expect(waterDataframeQuery.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'canvas_not_found', recovery: recovery('canvas_not_found') },
    });
  });

  it('throws invalid_sql when the binder rejects a SELECT, keeping the message that names the fault', async () => {
    mockCanvasInstance = canvasRejecting(
      CANVAS_ERRORS.binderFailure('Referenced column "valu" not found in FROM clause!'),
    );
    const ctx = createMockContext({ errors: waterDataframeQuery.errors });
    const input = waterDataframeQuery.input.parse({
      canvas_id: 'canvas0001xx',
      sql: 'SELECT valu FROM water_series_01646500_00060',
    });
    const error = (await waterDataframeQuery.handler(input, ctx).catch((e: unknown) => e)) as Error;
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_sql', recovery: recovery('invalid_sql') },
    });
    // The binder names the offending column — that is actionable, so it must survive the mapping.
    expect(error.message).toContain('valu');
  });

  it('keeps the disallowed-function message, which names the function the caller used', async () => {
    mockCanvasInstance = canvasRejecting(CANVAS_ERRORS.deniedFunction('read_csv'));
    const ctx = createMockContext({ errors: waterDataframeQuery.errors });
    const input = waterDataframeQuery.input.parse({
      canvas_id: 'canvas0001xx',
      sql: "SELECT * FROM read_csv('/etc/passwd')",
    });
    const error = (await waterDataframeQuery.handler(input, ctx).catch((e: unknown) => e)) as Error;
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_sql' },
    });
    expect(error.message).toContain('read_csv');
  });

  it('rewords the non-SELECT rejection so it never names registerTable/drop/clear (regression: #25)', async () => {
    mockCanvasInstance = canvasRejecting(CANVAS_ERRORS.nonSelect('DELETE'));
    const ctx = createMockContext({ errors: waterDataframeQuery.errors });
    const input = waterDataframeQuery.input.parse({
      canvas_id: 'canvas0001xx',
      sql: 'DELETE FROM water_series_01646500_00060',
    });
    const error = (await waterDataframeQuery.handler(input, ctx).catch((e: unknown) => e)) as Error;
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_sql', recovery: recovery('invalid_sql') },
    });
    // These are CanvasInstance methods; no MCP caller can invoke them.
    expect(error.message).not.toContain('registerTable');
    expect(error.message).not.toContain('drop');
    expect(error.message).not.toContain('clear');
    expect(error.message).toContain('SELECT');
  });

  it('rewords the system-catalog rejection so it never names denySystemCatalogs (regression: #25)', async () => {
    mockCanvasInstance = canvasRejecting(CANVAS_ERRORS.systemCatalog('information_schema'));
    const ctx = createMockContext({ errors: waterDataframeQuery.errors });
    const input = waterDataframeQuery.input.parse({
      canvas_id: 'canvas0001xx',
      sql: 'SELECT * FROM information_schema.tables',
    });
    const error = (await waterDataframeQuery.handler(input, ctx).catch((e: unknown) => e)) as Error;
    // Its own contract reason, not invalid_sql: the SELECT-only/no-read_csv recovery invalid_sql
    // declares does not address a catalog reference, and a mismatched hint is the #24 defect.
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'system_catalog_access',
        recovery: recovery('system_catalog_access'),
      },
    });
    // denySystemCatalogs is a QueryOptions field this handler sets; the caller cannot reach it.
    expect(error.message).not.toContain('denySystemCatalogs');
    // The route out of this failure — query the staged tables instead — reaches the caller.
    expect(recovery('system_catalog_access').hint).toContain('water_dataframe_describe');
  });

  it('maps a query against an unstaged table to table_not_found and drops the describe() reference', async () => {
    mockCanvasInstance = canvasRejecting(CANVAS_ERRORS.missingTable('water_series_09380000_00060'));
    const ctx = createMockContext({ errors: waterDataframeQuery.errors });
    const input = waterDataframeQuery.input.parse({
      canvas_id: 'canvas0001xx',
      sql: 'SELECT * FROM water_series_09380000_00060',
    });
    const error = (await waterDataframeQuery.handler(input, ctx).catch((e: unknown) => e)) as Error;
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'table_not_found', recovery: recovery('table_not_found') },
    });
    expect(error.message).toContain('water_series_09380000_00060');
    expect(error.message).not.toContain('registerTable');
    expect(error.message).not.toContain('describe()');
  });

  it('re-throws a canvas failure it has no mapping for rather than labelling it invalid_sql', async () => {
    mockCanvasInstance = canvasRejecting(new Error('DuckDB out of memory'));
    const ctx = createMockContext({ errors: waterDataframeQuery.errors });
    const input = waterDataframeQuery.input.parse({
      canvas_id: 'canvas0001xx',
      sql: 'SELECT * FROM water_series_01646500_00060',
    });
    await expect(waterDataframeQuery.handler(input, ctx)).rejects.toThrow('DuckDB out of memory');
  });

  it('returns rows and row_count for a valid SELECT', async () => {
    const mockInstance = {
      canvasId: 'canvas0001xx',
      query: vi.fn().mockResolvedValue(MOCK_QUERY_RESULT),
    };
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue(mockInstance) };

    const ctx = createMockContext({ errors: waterDataframeQuery.errors });
    const input = waterDataframeQuery.input.parse({
      canvas_id: 'canvas0001xx',
      sql: 'SELECT date_time, value FROM water_series_01646500_00060 ORDER BY date_time LIMIT 10',
    });
    const result = await waterDataframeQuery.handler(input, ctx);

    expect(result.row_count).toBe(2);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]?.['date_time']).toBe('2024-01-01');
    expect(result.rows[0]?.['value']).toBe('5000');
  });

  it('surfaces QueryResult.truncated when the canvas caps the result (regression: #23)', async () => {
    // The canvas sets truncated when the match set exceeds rowLimit; rowCount then equals the cap,
    // so truncated is the only signal that rows are a partial read.
    const mockInstance = {
      canvasId: 'canvas0001xx',
      query: vi.fn().mockResolvedValue({ ...MOCK_QUERY_RESULT, rowCount: 10_000, truncated: true }),
    };
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue(mockInstance) };

    const ctx = createMockContext({ errors: waterDataframeQuery.errors });
    const input = waterDataframeQuery.input.parse({
      canvas_id: 'canvas0001xx',
      sql: 'SELECT date_time FROM water_series_01646500_00060',
    });
    const result = await waterDataframeQuery.handler(input, ctx);

    expect(result.truncated).toBe(true);
    expect(result.row_count).toBe(10_000);
  });

  it('reports truncated=false when the canvas omits the flag on a complete result', async () => {
    // QueryResult.truncated is optional and absent on an uncapped read — the output field is
    // required, so the handler must normalize rather than emit undefined.
    const mockInstance = {
      canvasId: 'canvas0001xx',
      query: vi.fn().mockResolvedValue(MOCK_QUERY_RESULT),
    };
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue(mockInstance) };

    const ctx = createMockContext({ errors: waterDataframeQuery.errors });
    const input = waterDataframeQuery.input.parse({
      canvas_id: 'canvas0001xx',
      sql: 'SELECT date_time FROM water_series_01646500_00060 LIMIT 2',
    });
    const result = await waterDataframeQuery.handler(input, ctx);

    expect(result.truncated).toBe(false);
    expect(waterDataframeQuery.output.parse(result).truncated).toBe(false);
  });

  it('passes the sql and signal to instance.query', async () => {
    const mockQuery = vi.fn().mockResolvedValue(MOCK_QUERY_RESULT);
    const mockInstance = { canvasId: 'canvas0001xx', query: mockQuery };
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue(mockInstance) };

    const ctx = createMockContext({ errors: waterDataframeQuery.errors });
    const sql = 'SELECT AVG(CAST(value AS DOUBLE)) FROM water_series_01646500_00060';
    const input = waterDataframeQuery.input.parse({ canvas_id: 'canvas0001xx', sql });
    await waterDataframeQuery.handler(input, ctx);

    expect(mockQuery).toHaveBeenCalledWith(sql, expect.objectContaining({ signal: ctx.signal }));
  });

  it('formats results as a markdown table with row count', () => {
    const result = {
      rows: MOCK_QUERY_RESULT.rows,
      row_count: 2,
      truncated: false,
    };
    const blocks = waterDataframeQuery.format!(result);
    const text = blocks[0]?.text ?? '';
    expect(text).toContain('2 row(s)');
    expect(text).toContain('date_time');
    expect(text).toContain('2024-01-01');
    expect(text).toContain('5000');
  });

  it('states the truncation status in content[] in both directions (regression: #23)', () => {
    // content[]-only clients never see structuredContent.truncated, so the rendered text has to
    // carry the signal itself — and say so when the result is complete, not only when it is capped.
    const capped = waterDataframeQuery.format!({
      rows: MOCK_QUERY_RESULT.rows,
      row_count: 10_000,
      truncated: true,
    });
    expect(capped[0]?.text ?? '').toMatch(/truncated/i);

    const complete = waterDataframeQuery.format!({
      rows: MOCK_QUERY_RESULT.rows,
      row_count: 2,
      truncated: false,
    });
    expect(complete[0]?.text ?? '').toContain('not truncated');
  });

  it('caps the rendered table at 50 rows with an accurate "showing 50 of N" caption at worst case (regression: #16 sub-case 2)', () => {
    // Rows can reach the 10,000-row tool cap, so a render cap is legitimate (10k markdown rows is
    // not viable) — this is honest capping, not a silent drop. The requirement is ACCURACY: the
    // caption's stated count must equal what is actually emitted, and the header must disclose the
    // real total. Worst case: the query matched more than the 10,000-row cap, so rows returned =
    // 10,000 (capped) and row_count = the larger matched total. format-parity can't measure this —
    // its synthetic sample is a single row.
    const rows = Array.from({ length: 10_000 }, (_, i) => ({
      date_time: `2024-01-01T00:${String(i % 60).padStart(2, '0')}:00`,
      value: String(i),
    }));
    const result = { rows, row_count: 25_000, truncated: true };
    const blocks = waterDataframeQuery.format!(result);
    const text = blocks[0]?.text ?? '';

    // Header honestly discloses both the matched total and the returned (capped) count.
    expect(text).toContain('25000 row(s)');
    expect(text).toContain('(10000 returned)');
    // Exactly 50 data rows emitted: table = column-header + separator + 50 data rows = 52 lines.
    const tableLines = text.split('\n').filter((l) => l.startsWith('| '));
    expect(tableLines).toHaveLength(52);
    // The caption's stated rendered count matches what was actually rendered.
    expect(text).toContain('showing 50 of 10000');
  });

  it('formats empty result set gracefully', () => {
    const result = { rows: [], row_count: 0, truncated: false };
    const blocks = waterDataframeQuery.format!(result);
    const text = blocks[0]?.text ?? '';
    expect(text).toContain('0 row(s)');
  });
});
