/**
 * @fileoverview Tests for water_dataframe_query tool — SQL SELECT against canvas tables.
 * Mocks the canvas-accessor: most cases hand it a stub canvas, and the refusal block hands it a
 * real DuckDB-backed canvas, so the mapping is checked against what the installed canvas raises.
 * @module tests/tools/water-dataframe-query.tool.test
 */

import {
  type CanvasInstance,
  CanvasRegistry,
  DataCanvas,
  DUCKDB_ERROR_REASONS,
  type DuckdbErrorReason,
  DuckdbProvider,
} from '@cyanheads/mcp-ts-core/canvas';
import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waterDataframeQuery } from '@/mcp-server/tools/definitions/water-dataframe-query.tool.js';
import { textContent } from '../helpers/content-block.js';
import { captureError, contractError, declaredRecovery } from '../helpers/error-contract.js';

let mockCanvasInstance: unknown;

vi.mock('@/services/canvas/canvas-accessor.js', () => ({
  getCanvas: () => mockCanvasInstance,
}));

const recovery = (reason: string) => declaredRecovery(waterDataframeQuery.errors, reason);

/**
 * Recovery hints the canvas attaches to its rejections, copied from @cyanheads/mcp-ts-core
 * (`sqlGate`, `DuckdbProvider`, `CanvasRegistry`). The tool carries each `invalid_sql` one through,
 * so these are the hints a caller receives.
 */
const CANVAS_HINTS = {
  nonSelect:
    'Rewrite as a single SELECT — this surface is read-only and cannot create, alter, or drop tables.',
  pivot:
    'A PIVOT runs as one SELECT only when it lists its values, as ON column IN (value, ...): list them, or rewrite as a single SELECT — this surface is read-only and cannot create, alter, or drop tables.',
  multiStatement:
    'Send exactly one SELECT statement; split multi-statement SQL into separate calls.',
  syntax:
    'Fix the SQL syntax the message names and send a single read-only SELECT. Put AS before an alias that is a SQL keyword, or double-quote it.',
  binder:
    "Correct the column or function the message names; list the staged columns with this server's dataframe-describe tool.",
  catalog:
    "Correct the function, type, collation, or schema name the message reports missing — list the staged tables with this server's dataframe-describe tool.",
  deniedFunction: 'Remove the function the message names — only the staged tables are queryable.',
  bareCurrentSchema:
    'Qualify a column named current_schema with its table (<table>.current_schema), or remove the reference — the current_schema() function is not available.',
  conversion:
    'Wrap the cast in TRY_CAST, or filter out the rows the message names before converting them.',
  readOnly:
    "Send a read-only SELECT over the staged tables — list them with this server's dataframe-describe tool. This surface reads no files and cannot create, alter, or drop anything.",
  systemCatalog:
    "Query only the staged dataframe tables; use this server's dataframe-describe tool to list them.",
  missingTable:
    "Re-run the tool that produced this table to stage it again, or list the currently staged tables with this server's dataframe-describe tool.",
  canvasNotFound:
    'Re-run the tool that produced this canvas_id to stage fresh data, or verify the id was copied correctly.',
} as const;

/**
 * Errors copied verbatim from @cyanheads/mcp-ts-core so these tests assert against what the canvas
 * actually raises — the real-canvas block checks each against the installed canvas. Every one is a
 * structured `McpError` carrying `data.reason` and `data.recovery`: `CanvasRegistry.canvasNotFound()`
 * and the `DuckdbProvider.assertReadOnlySql` / `sqlGate` paths.
 */
const CANVAS_ERRORS = {
  canvasNotFound: (canvasId: string) =>
    notFound('Canvas not found or expired.', {
      reason: 'canvas_not_found',
      canvasId,
      recovery: { hint: CANVAS_HINTS.canvasNotFound },
    }),
  /** A single statement that parses but is not a SELECT, refused before it is prepared. */
  nonSelect: () =>
    validationError('Canvas query must be SELECT.', {
      reason: 'non_select_statement',
      statementType: 'UNKNOWN',
      recovery: { hint: CANVAS_HINTS.nonSelect },
    }),
  /** `assertNoSystemCatalogs` — provoked by this tool's own `denySystemCatalogs: true`. */
  systemCatalog: (catalog: string) =>
    validationError(
      `Canvas query references a system catalog: ${catalog}. System catalogs are not permitted.`,
      { reason: 'system_catalog_access', catalog, recovery: { hint: CANVAS_HINTS.systemCatalog } },
    ),
  /** Provider prepare step — a SELECT naming a table that is not staged. */
  missingTable: (tableName: string) =>
    notFound(
      `Canvas table "${tableName}" does not exist. The table may have expired, been dropped, or the name may be mistyped.`,
      { reason: 'missing_table', tableName, recovery: { hint: CANVAS_HINTS.missingTable } },
    ),
  /** Provider prepare step — a SELECT naming a column DuckDB's binder could not resolve. */
  binderFailure: (binderMessage: string) =>
    validationError(`Canvas query failed to prepare: ${binderMessage}`, {
      reason: 'invalid_sql',
      statementType: 'UNKNOWN',
      binderMessage,
      recovery: { hint: CANVAS_HINTS.binder },
    }),
  /** `assertNoDeniedFunctions` — file-reading table functions. */
  deniedFunction: (fn: string) =>
    validationError(
      `Canvas query references disallowed table function: ${fn}. File-reading and external-data functions are not permitted.`,
      { reason: 'denied_function', function: fn, recovery: { hint: CANVAS_HINTS.deniedFunction } },
    ),
  /**
   * `classifyDuckdbError` — an engine-side rejection raised past the gate, with the hint its class
   * calls for. All three classes are caller-side, so they belong in the same `invalid_sql` funnel
   * as the gate's own rejections.
   */
  engineFailure: (reason: DuckdbErrorReason, message: string, hint: string) =>
    validationError(message, { reason, recovery: { hint } }),
};

/** The code, message, and data of a canvas rejection — what reaches the wire. */
function wireShape(error: unknown) {
  if (!(error instanceof McpError)) throw new Error(`Expected an McpError, got ${String(error)}`);
  return { code: error.code, message: error.message, data: error.data };
}

/** Canvas whose `query` rejects with `err`. */
function canvasRejecting(err: unknown) {
  return {
    acquire: vi.fn().mockResolvedValue({
      canvasId: 'canvas0001',
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

  it('names the tools that stage data and the tool that describes it', () => {
    const { description } = waterDataframeQuery;
    for (const companion of ['water_get_series', 'water_find_sites', 'water_dataframe_describe']) {
      expect(description).toContain(companion);
    }
    expect(description).toContain('Requires DataCanvas to be enabled on this server instance.');
  });

  it('points at water_dataframe_drop only as an opt-in, never as always available', () => {
    // water_dataframe_drop is registered disabled unless the deployment opts in.
    expect(waterDataframeQuery.description).toContain(
      'water_dataframe_drop (when this server enables it)',
    );
  });

  it('throws canvas_disabled when canvas is not configured', async () => {
    mockCanvasInstance = undefined;
    const input = {
      canvas_id: 'canvas0001',
      sql: 'SELECT * FROM water_series_01646500_00060 LIMIT 10',
    };
    await expect(contractError(waterDataframeQuery, input)).resolves.toMatchObject({
      code: JsonRpcErrorCode.InvalidRequest,
      data: { reason: 'canvas_disabled', recovery: recovery('canvas_disabled') },
    });
  });

  it('canvas_disabled error is agent-facing and omits the CANVAS_PROVIDER_TYPE env var (regression: #8)', async () => {
    mockCanvasInstance = undefined;
    const ctx = createMockContext({ errors: waterDataframeQuery.errors });
    const input = waterDataframeQuery.input.parse({
      canvas_id: 'canvas0001',
      sql: 'SELECT * FROM water_series_01646500_00060 LIMIT 10',
    });
    const error = (await captureError(() => waterDataframeQuery.handler(input, ctx))) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('DataCanvas is not enabled on this server instance.');
    expect(error.message).not.toContain('CANVAS_PROVIDER_TYPE');
  });

  it('throws canvas_not_found when acquire rejects a stale canvas_id', async () => {
    mockCanvasInstance = {
      acquire: vi.fn().mockRejectedValue(CANVAS_ERRORS.canvasNotFound('stalecanv1')),
    };
    const input = {
      canvas_id: 'stalecanv1',
      sql: 'SELECT date_time, value FROM water_series_01646500_00060',
    };
    await expect(contractError(waterDataframeQuery, input)).resolves.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'canvas_not_found', recovery: recovery('canvas_not_found') },
    });
  });

  it('declares canvas_not_found as service-thrown — the shared acquire helper raises it', () => {
    const entry = waterDataframeQuery.errors!.find((e) => e.reason === 'canvas_not_found');
    expect(entry).toMatchObject({ code: JsonRpcErrorCode.NotFound, thrownBy: 'service' });
  });

  it('rejects a canvas_id outside the minted shape at parse level, before any canvas lookup', () => {
    // CanvasIdSchema advertises the 10-character shape the registry mints, so an id that could
    // never exist is refused at argument validation rather than reaching acquire() and coming back
    // as canvas_not_found — a miss the caller would read as "expired" instead of "malformed".
    const acquire = vi.fn();
    mockCanvasInstance = { acquire };
    for (const canvas_id of ['canvas0001xx', 'short', 'has space', 'canvas.001']) {
      expect(() =>
        waterDataframeQuery.input.parse({
          canvas_id,
          sql: 'SELECT * FROM water_series_01646500_00060',
        }),
      ).toThrow();
    }
    expect(acquire).not.toHaveBeenCalled();
  });

  it('throws invalid_sql when the binder rejects a SELECT, keeping the message and hint that name the fault', async () => {
    mockCanvasInstance = canvasRejecting(
      CANVAS_ERRORS.binderFailure('Referenced column "valu" not found in FROM clause!'),
    );
    const error = await contractError(waterDataframeQuery, {
      canvas_id: 'canvas0001',
      sql: 'SELECT valu FROM water_series_01646500_00060',
    });
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_sql', recovery: { hint: CANVAS_HINTS.binder } },
    });
    // The binder names the offending column — that is actionable, so it must survive the mapping.
    expect(error.message).toContain('valu');
  });

  it('keeps the disallowed-function message, which names the function the caller used', async () => {
    mockCanvasInstance = canvasRejecting(CANVAS_ERRORS.deniedFunction('read_csv'));
    const ctx = createMockContext({ errors: waterDataframeQuery.errors });
    const input = waterDataframeQuery.input.parse({
      canvas_id: 'canvas0001',
      sql: "SELECT * FROM read_csv('/etc/passwd')",
    });
    const error = (await captureError(() => waterDataframeQuery.handler(input, ctx))) as Error;
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_sql', recovery: { hint: CANVAS_HINTS.deniedFunction } },
    });
    expect(error.message).toContain('read_csv');
  });

  it('fills the contract recovery for a funneled rejection the canvas sent without a hint', async () => {
    mockCanvasInstance = canvasRejecting(
      validationError('Canvas query failed to prepare: Binder Error: x', { reason: 'invalid_sql' }),
    );
    await expect(
      contractError(waterDataframeQuery, {
        canvas_id: 'canvas0001',
        sql: 'SELECT x FROM water_series_01646500_00060',
      }),
    ).resolves.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_sql', recovery: recovery('invalid_sql') },
    });
  });

  it('keeps the canvas non-SELECT rejection, which names no canvas method (regression: #25)', async () => {
    mockCanvasInstance = canvasRejecting(CANVAS_ERRORS.nonSelect());
    const error = await contractError(waterDataframeQuery, {
      canvas_id: 'canvas0001',
      sql: 'DELETE FROM water_series_01646500_00060',
    });
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: 'Canvas query must be SELECT.',
      data: { reason: 'invalid_sql', recovery: { hint: CANVAS_HINTS.nonSelect } },
    });
    // These are CanvasInstance methods; no MCP caller can invoke them.
    expect(error.message).not.toContain('registerTable');
    expect(error.message).not.toContain('drop');
    expect(error.message).not.toContain('clear');
  });

  it('keeps the catalog the system-catalog rejection names, never denySystemCatalogs (regression: #25)', async () => {
    mockCanvasInstance = canvasRejecting(CANVAS_ERRORS.systemCatalog('information_schema'));
    const error = await contractError(waterDataframeQuery, {
      canvas_id: 'canvas0001',
      sql: 'SELECT * FROM information_schema.tables',
    });
    // Its own contract reason, not invalid_sql: the SELECT-only/no-read_csv recovery invalid_sql
    // declares does not address a catalog reference, and a mismatched hint is the #24 defect.
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'system_catalog_access',
        recovery: recovery('system_catalog_access'),
      },
    });
    // The matched name tells the caller which reference to change.
    expect(error.message).toContain('information_schema');
    // denySystemCatalogs is a QueryOptions field this handler sets; the caller cannot reach it.
    expect(error.message).not.toContain('denySystemCatalogs');
    // The route out of this failure — query the staged tables instead — reaches the caller.
    expect(recovery('system_catalog_access').hint).toContain('water_dataframe_describe');
  });

  it('maps a query against an unstaged table to table_not_found and drops the describe() reference', async () => {
    mockCanvasInstance = canvasRejecting(CANVAS_ERRORS.missingTable('water_series_09380000_00060'));
    const error = await contractError(waterDataframeQuery, {
      canvas_id: 'canvas0001',
      sql: 'SELECT * FROM water_series_09380000_00060',
    });
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'table_not_found', recovery: recovery('table_not_found') },
    });
    expect(error.message).toContain('water_series_09380000_00060');
    expect(error.message).not.toContain('registerTable');
    expect(error.message).not.toContain('describe()');
  });

  it.each([
    [
      DUCKDB_ERROR_REASONS.sqlParseError,
      'Canvas SQL rejected: Parser Error: syntax error at or near "SELEC"',
      CANVAS_HINTS.syntax,
    ],
    [
      DUCKDB_ERROR_REASONS.sqlReadOnly,
      'Canvas SQL rejected: Permission Error: File system operations are disabled by configuration',
      CANVAS_HINTS.readOnly,
    ],
    [
      DUCKDB_ERROR_REASONS.sqlExecutionError,
      "Canvas query failed: Conversion Error: Could not convert string 'n/a' to DOUBLE",
      CANVAS_HINTS.conversion,
    ],
  ])(
    'maps the engine-side %s rejection to invalid_sql, keeping the engine message and hint',
    async (reason, message, hint) => {
      mockCanvasInstance = canvasRejecting(CANVAS_ERRORS.engineFailure(reason, message, hint));
      const error = await contractError(waterDataframeQuery, {
        canvas_id: 'canvas0001',
        sql: 'SELECT CAST(value AS DOUBLE) FROM water_series_01646500_00060',
      });
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'invalid_sql', recovery: { hint } },
      });
      // The engine names the offending token, column, or value — that detail must survive the mapping.
      expect(error.message).toBe(message);
    },
  );

  it('re-throws a canvas failure it has no mapping for rather than labelling it invalid_sql', async () => {
    mockCanvasInstance = canvasRejecting(new Error('DuckDB out of memory'));
    const ctx = createMockContext({ errors: waterDataframeQuery.errors });
    const input = waterDataframeQuery.input.parse({
      canvas_id: 'canvas0001',
      sql: 'SELECT * FROM water_series_01646500_00060',
    });
    await expect(waterDataframeQuery.handler(input, ctx)).rejects.toThrow('DuckDB out of memory');
  });

  it('returns rows and row_count for a valid SELECT', async () => {
    const mockInstance = {
      canvasId: 'canvas0001',
      query: vi.fn().mockResolvedValue(MOCK_QUERY_RESULT),
    };
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue(mockInstance) };

    const ctx = createMockContext({ errors: waterDataframeQuery.errors });
    const input = waterDataframeQuery.input.parse({
      canvas_id: 'canvas0001',
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
      canvasId: 'canvas0001',
      query: vi.fn().mockResolvedValue({ ...MOCK_QUERY_RESULT, rowCount: 10_000, truncated: true }),
    };
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue(mockInstance) };

    const ctx = createMockContext({ errors: waterDataframeQuery.errors });
    const input = waterDataframeQuery.input.parse({
      canvas_id: 'canvas0001',
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
      canvasId: 'canvas0001',
      query: vi.fn().mockResolvedValue(MOCK_QUERY_RESULT),
    };
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue(mockInstance) };

    const ctx = createMockContext({ errors: waterDataframeQuery.errors });
    const input = waterDataframeQuery.input.parse({
      canvas_id: 'canvas0001',
      sql: 'SELECT date_time FROM water_series_01646500_00060 LIMIT 2',
    });
    const result = await waterDataframeQuery.handler(input, ctx);

    expect(result.truncated).toBe(false);
    expect(waterDataframeQuery.output.parse(result).truncated).toBe(false);
  });

  it('passes the sql and signal to instance.query', async () => {
    const mockQuery = vi.fn().mockResolvedValue(MOCK_QUERY_RESULT);
    const mockInstance = { canvasId: 'canvas0001', query: mockQuery };
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue(mockInstance) };

    const ctx = createMockContext({ errors: waterDataframeQuery.errors });
    const sql = 'SELECT AVG(CAST(value AS DOUBLE)) FROM water_series_01646500_00060';
    const input = waterDataframeQuery.input.parse({ canvas_id: 'canvas0001', sql });
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
    const text = textContent(blocks[0]);
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
    expect(textContent(capped[0])).toMatch(/truncated/i);

    const complete = waterDataframeQuery.format!({
      rows: MOCK_QUERY_RESULT.rows,
      row_count: 2,
      truncated: false,
    });
    expect(textContent(complete[0])).toContain('not truncated');
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
    const text = textContent(blocks[0]);

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
    const text = textContent(blocks[0]);
    expect(text).toContain('0 row(s)');
  });

  describe('refusals from a real DuckDB canvas', () => {
    const SERIES_TABLE = 'water_series_01646500_00060_dv_20240101_20240102';
    let canvas: DataCanvas;
    let instance: CanvasInstance;

    beforeEach(async () => {
      const provider = new DuckdbProvider({
        defaultRowLimit: 10_000,
        exportRootPath: '.canvas-exports',
        memoryLimitMb: 128,
        schemaSniffRows: 100,
      });
      const registry = new CanvasRegistry(
        provider,
        { absoluteCapMs: 600_000, maxCanvasesPerTenant: 10, sweeperIntervalMs: 0, ttlMs: 60_000 },
        () => 0,
      );
      canvas = new DataCanvas(provider, registry);
      mockCanvasInstance = canvas;
      instance = await canvas.acquire(undefined, createMockContext());
      await instance.registerTable(SERIES_TABLE, [
        { date_time: '2024-01-01', value: '5000', qualifiers: 'A' },
        { date_time: '2024-01-02', value: 'n/a', qualifiers: 'P' },
      ]);
    });

    afterEach(async () => {
      await canvas.shutdown(createMockContext());
    });

    it.each([
      [
        'a PIVOT without an IN list',
        `PIVOT ${SERIES_TABLE} ON qualifiers USING count(*)`,
        'Canvas query must be SELECT.',
        CANVAS_HINTS.pivot,
      ],
      [
        'a statement that does not parse and opens like no read',
        'SELEC 1',
        'Canvas query must be SELECT; the statement could not be parsed or prepared.',
        CANVAS_HINTS.nonSelect,
      ],
      [
        'a read with a syntax error',
        `SELECT date_time value FROM ${SERIES_TABLE} WHERE`,
        'Parser Error: syntax error at or near "WHERE"',
        CANVAS_HINTS.syntax,
      ],
      [
        'a write',
        `DELETE FROM ${SERIES_TABLE}`,
        'Canvas query must be SELECT.',
        CANVAS_HINTS.nonSelect,
      ],
      [
        'two statements',
        'SELECT 1; SELECT 2',
        'Canvas query must contain exactly one SQL statement.',
        CANVAS_HINTS.multiStatement,
      ],
      [
        'an unknown column',
        `SELECT valu FROM ${SERIES_TABLE}`,
        'Referenced column "valu" not found',
        CANVAS_HINTS.binder,
      ],
      [
        'an unknown function',
        `SELECT nosuchfn(value) FROM ${SERIES_TABLE}`,
        'Scalar Function with name nosuchfn does not exist',
        CANVAS_HINTS.catalog,
      ],
      [
        'a file-reading function',
        "SELECT * FROM read_csv('/etc/passwd')",
        'Canvas query references disallowed table function: read_csv.',
        CANVAS_HINTS.deniedFunction,
      ],
      [
        'an unqualified current_schema',
        `SELECT current_schema FROM ${SERIES_TABLE}`,
        'Canvas query references current_schema unqualified.',
        CANVAS_HINTS.bareCurrentSchema,
      ],
      [
        'a file named as a table',
        "SELECT * FROM '/etc/passwd'",
        'Canvas SQL rejected: "/etc/passwd" names a file, not a staged table.',
        CANVAS_HINTS.readOnly,
      ],
      [
        'a cast the staged rows cannot take',
        `SELECT CAST(value AS DOUBLE) FROM ${SERIES_TABLE}`,
        "Conversion Error: Could not convert string 'n/a' to DOUBLE",
        CANVAS_HINTS.conversion,
      ],
    ])(
      'reports %s as invalid_sql with the canvas message and its recovery hint',
      async (_label, sql, message, hint) => {
        const result = await runToolContract(waterDataframeQuery, {
          canvas_id: instance.canvasId,
          sql,
        });
        expect(result.isError).toBe(true);
        const { error } = result.structuredContent as {
          error: { code: number; message: string; data: Record<string, unknown> };
        };
        expect(error).toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'invalid_sql', recovery: { hint } },
        });
        expect(error.message).toContain(message);
        // content[]-only clients read the same hint.
        const text = textContent(result.content?.[0]);
        expect(text).toContain(`Recovery: ${escapeMarkdownInline(hint)}`);
        expect(text).toContain('(reason invalid_sql)');
      },
    );

    it('names the catalog a system-catalog refusal matched, under the contract recovery', async () => {
      // A column alias spelled like an internal metadata view is refused too; the matched name is
      // what tells the caller which reference to change.
      await expect(
        contractError(waterDataframeQuery, {
          canvas_id: instance.canvasId,
          sql: `SELECT value AS pg_class FROM ${SERIES_TABLE}`,
        }),
      ).resolves.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message:
          'Canvas query references a system catalog: pg_class. System catalogs are not permitted.',
        data: { reason: 'system_catalog_access', recovery: recovery('system_catalog_access') },
      });
    });

    it('builds each CANVAS_ERRORS fixture exactly as the installed canvas raises it', async () => {
      const raised = async (sql: string) =>
        wireShape(await captureError(() => instance.query(sql, { denySystemCatalogs: true })));

      expect(await raised(`DELETE FROM ${SERIES_TABLE}`)).toEqual(
        wireShape(CANVAS_ERRORS.nonSelect()),
      );
      expect(await raised('SELECT * FROM information_schema.tables')).toEqual(
        wireShape(CANVAS_ERRORS.systemCatalog('information_schema')),
      );
      expect(await raised('SELECT * FROM water_series_09380000_00060')).toEqual(
        wireShape(CANVAS_ERRORS.missingTable('water_series_09380000_00060')),
      );
      expect(await raised("SELECT * FROM read_csv('/etc/passwd')")).toEqual(
        wireShape(CANVAS_ERRORS.deniedFunction('read_csv')),
      );
      const binder = await raised(`SELECT valu FROM ${SERIES_TABLE}`);
      expect(binder).toEqual(
        wireShape(CANVAS_ERRORS.binderFailure(String(binder.data?.['binderMessage']))),
      );
      const conversion = await raised(`SELECT CAST(value AS DOUBLE) FROM ${SERIES_TABLE}`);
      expect(conversion).toEqual(
        wireShape(
          CANVAS_ERRORS.engineFailure(
            DUCKDB_ERROR_REASONS.sqlExecutionError,
            conversion.message,
            CANVAS_HINTS.conversion,
          ),
        ),
      );
      expect(
        wireShape(await captureError(() => canvas.acquire('abcdefghij', createMockContext()))),
      ).toEqual(wireShape(CANVAS_ERRORS.canvasNotFound('abcdefghij')));
    });
  });
});
