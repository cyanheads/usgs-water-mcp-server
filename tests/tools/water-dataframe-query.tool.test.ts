/**
 * @fileoverview Tests for water_dataframe_query tool — SQL SELECT against canvas tables, and the
 * content[] table that renders every returned row. Mocks the canvas-accessor: most cases hand it a
 * stub canvas, and the refusal, row, and sql-example blocks hand it a real DuckDB-backed canvas, so
 * the mapping and the rendering are checked against what the installed canvas returns.
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
import { config, resetConfig } from '@cyanheads/mcp-ts-core/config';
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
import { expectLinear } from '../helpers/linear-time.js';

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

/**
 * Read a GFM table out of rendered text back into cell values, implementing the part of the GFM
 * table extension and CommonMark inline syntax the encoder writes: a row splits on every `|` no
 * backslash precedes, each cell is trimmed and its `\|` unescaped, then backslash escapes of ASCII
 * punctuation and numeric character references are decoded. A cell of exactly `*null*` reads as
 * NULL. Anything else CommonMark would read as markup — an unescaped `*`, `` ` ``, `[`, `]`, `~`,
 * `<` opening a tag, or `&` opening a named entity — fails the read, since this reader cannot parse
 * it and the encoder must never emit it.
 */
function readGfmTable(text: string): { headers: string[]; rows: (string | null)[][] } {
  const lines = text.split('\n').filter((line) => line.startsWith('|'));
  const split = (line: string) => {
    const cells = line
      .slice(1, -1)
      .split(/(?<!\\)\|/)
      .map((cell) => cell.trim().replaceAll('\\|', '|'));
    return cells.map((cell): string | null => {
      if (cell === '*null*') return null;
      const live = cell
        .replace(/\\[!-/:-@[-`{-~]/g, '')
        .match(/[*`[\]~]|<[A-Za-z/!?]|&[A-Za-z][A-Za-z0-9]{1,31};/);
      if (live) throw new Error(`Cell ${JSON.stringify(cell)} holds live markup: ${live[0]}`);
      return cell.replace(
        /\\([!-/:-@[-`{-~])|&#(\d{1,7});|&#[xX]([0-9a-fA-F]{1,6});/g,
        (_m, punct?: string, dec?: string, hex?: string) =>
          punct ?? String.fromCodePoint(dec ? Number(dec) : Number.parseInt(hex ?? '', 16)),
      );
    });
  };
  const [header, delimiter, ...body] = lines;
  expect(delimiter).toMatch(/^\|( --- \|)+$/);
  return {
    headers: split(header ?? '').map((h) => h ?? '(null header)'),
    rows: body.map(split),
  };
}

/** The value a cell reads back as: a string as itself, NULL as null, anything else as its JSON. */
function expectedCell(value: unknown): string | null {
  if (value === null) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * A DuckDB-backed canvas, installed as the accessor's canvas. Shut it down after each test. Its row
 * limit comes from the framework config, as the server's canvas does (`CANVAS_DEFAULT_ROW_LIMIT`).
 */
function installRealCanvas(): DataCanvas {
  const provider = new DuckdbProvider({
    defaultRowLimit: config.canvas.defaultRowLimit,
    exportRootPath: '.canvas-exports',
    memoryLimitMb: 128,
    schemaSniffRows: 100,
  });
  const registry = new CanvasRegistry(
    provider,
    { absoluteCapMs: 600_000, maxCanvasesPerTenant: 10, sweeperIntervalMs: 0, ttlMs: 60_000 },
    () => 0,
  );
  const canvas = new DataCanvas(provider, registry);
  mockCanvasInstance = canvas;
  return canvas;
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

  afterEach(() => {
    // Drops any CANVAS_DEFAULT_ROW_LIMIT override a case set; the next read reparses the environment.
    resetConfig();
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
      query: vi.fn().mockResolvedValue({ ...MOCK_QUERY_RESULT, rowCount: 5_000, truncated: true }),
    };
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue(mockInstance) };

    const ctx = createMockContext({ errors: waterDataframeQuery.errors });
    const input = waterDataframeQuery.input.parse({
      canvas_id: 'canvas0001',
      sql: 'SELECT date_time FROM water_series_01646500_00060',
    });
    const result = await waterDataframeQuery.handler(input, ctx);

    expect(result.truncated).toBe(true);
    expect(result.row_count).toBe(5_000);
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

  it('passes the sql, signal, and the 5,000-row limit to instance.query', async () => {
    const mockQuery = vi.fn().mockResolvedValue(MOCK_QUERY_RESULT);
    const mockInstance = { canvasId: 'canvas0001', query: mockQuery };
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue(mockInstance) };

    const ctx = createMockContext({ errors: waterDataframeQuery.errors });
    const sql = 'SELECT AVG(CAST(value AS DOUBLE)) FROM water_series_01646500_00060';
    const input = waterDataframeQuery.input.parse({ canvas_id: 'canvas0001', sql });
    await waterDataframeQuery.handler(input, ctx);

    expect(mockQuery).toHaveBeenCalledWith(sql, expect.objectContaining({ signal: ctx.signal }));
    expect(mockQuery).toHaveBeenCalledWith(sql, expect.objectContaining({ rowLimit: 5_000 }));
  });

  it("asks for no more rows than the server's canvas row limit when that is below 5,000", async () => {
    const mockQuery = vi.fn().mockResolvedValue(MOCK_QUERY_RESULT);
    const mockInstance = { canvasId: 'canvas0001', query: mockQuery };
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue(mockInstance) };
    const sql = 'SELECT * FROM water_series_01646500_00060';
    const input = waterDataframeQuery.input.parse({ canvas_id: 'canvas0001', sql });

    for (const [canvasLimit, sent] of [
      ['1000', 1_000],
      ['4999', 4_999],
      ['5000', 5_000],
      ['20000', 5_000],
    ] as const) {
      resetConfig({ CANVAS_DEFAULT_ROW_LIMIT: canvasLimit });
      await waterDataframeQuery.handler(
        input,
        createMockContext({ errors: waterDataframeQuery.errors }),
      );
      expect(mockQuery, `CANVAS_DEFAULT_ROW_LIMIT=${canvasLimit}`).toHaveBeenLastCalledWith(
        sql,
        expect.objectContaining({ rowLimit: sent }),
      );
    }
  });

  it('says in the description and the output descriptions that a lower canvas row limit lowers the cap', () => {
    const { rows, row_count, truncated } = waterDataframeQuery.output.shape;
    for (const description of [
      waterDataframeQuery.description,
      rows.description ?? '',
      row_count.description ?? '',
      truncated.description ?? '',
    ]) {
      expect(description).toContain(
        "5,000 rows, or this server instance's canvas row limit when that is lower",
      );
    }
    expect(truncated.description).toContain('cover only the first row_count matches');
  });

  it('says 5,000 rows in the description, the output descriptions, and the truncation text (#58)', () => {
    const { rows, row_count, truncated } = waterDataframeQuery.output.shape;
    for (const description of [
      waterDataframeQuery.description,
      rows.description ?? '',
      row_count.description ?? '',
      truncated.description ?? '',
    ]) {
      expect(description).toContain('5,000');
      expect(description).not.toContain('10,000');
    }
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
      row_count: 5_000,
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

  it('renders every returned row of a capped 5,000-row result, with no "showing N of M" caption (#58)', () => {
    // content[] carries the same rows as structuredContent. At the 5,000-row cap a staged series
    // table's eight columns render to about 0.55 MB of table text beside about 1 MB of rows.
    const rows = Array.from({ length: 5_000 }, (_, i) => ({
      date_time: `2024-01-01T00:${String(i % 60).padStart(2, '0')}:00`,
      value: String(i),
    }));
    const text = textContent(
      waterDataframeQuery.format!({ rows, row_count: 5_000, truncated: true })[0],
    );

    expect(text).toContain('**5000 row(s)** (5000 returned) — **truncated** at the 5,000-row cap');
    const table = readGfmTable(text);
    expect(table.headers).toEqual(['date_time', 'value']);
    expect(table.rows).toHaveLength(5_000);
    expect(table.rows[4_999]).toEqual([rows[4_999]?.date_time, '4999']);
    expect(text).not.toMatch(/showing \d+ of/i);
  });

  describe('content[] table encoding (#58)', () => {
    const render = (rows: Record<string, unknown>[]) =>
      textContent(
        waterDataframeQuery.format!({ rows, row_count: rows.length, truncated: false })[0],
      );

    it('keeps the cell count of a row whose value or column alias holds a pipe', () => {
      const table = readGfmTable(render([{ 'h|dr': 'a|b', next: 'c' }]));
      expect(table.headers).toEqual(['h|dr', 'next']);
      expect(table.rows).toEqual([['a|b', 'c']]);
    });

    it('keeps a value with line breaks inside its row, each break as a reference', () => {
      const text = render([{ nl: 'l1\nl2', crlf: 'r1\r\nr2', cr: 'c1\rc2', after: 'x' }]);
      expect(text).toContain('| l1&#10;l2 | r1&#13;&#10;r2 | c1&#13;c2 | x |');
      expect(readGfmTable(text).rows).toEqual([['l1\nl2', 'r1\r\nr2', 'c1\rc2', 'x']]);
    });

    it('renders a list and a struct as JSON, never 1,2 or [object Object]', () => {
      const text = render([{ lst: [1, 2], st: { x: 1, y: 'b|c' } }]);
      expect(text).not.toContain('[object Object]');
      expect(readGfmTable(text).rows).toEqual([['[1,2]', '{"x":1,"y":"b|c"}']]);
    });

    it('reads NULL, an empty string, and a stored "*null*" back as three different values', () => {
      const text = render([{ nul: null, emp: '', lit: '*null*' }]);
      expect(text).toContain('| *null* |  | \\*null\\* |');
      expect(readGfmTable(text).rows).toEqual([[null, '', '*null*']]);
    });

    it('reads every cell and header back as structuredContent carries it', () => {
      const rows: Record<string, unknown>[] = [
        {
          text: '<b>x</b> *em* _u_ `code` [l](u) ~s~ &amp; #h',
          blocks: '- item\n1. two\n> quote\n# head\n---',
          edges: '  lead and trail  ',
          slashes: 'a\\|b \\ end\\',
          breaks: '\n\ntrailing\n',
          unicode: '水 ≥ 5 µS/cm',
          number: 5000.5,
          flag: true,
          interval: { months: 0, days: 1, micros: '0' },
          map: [{ key: 'k', value: 1 }],
          'col with "quotes" & *stars*': 'v',
        },
        {
          text: 'plain',
          blocks: '',
          edges: null,
          slashes: '\\',
          breaks: 'one',
          unicode: '',
          number: -1,
          flag: false,
          interval: null,
          map: [],
          'col with "quotes" & *stars*': null,
        },
      ];
      const table = readGfmTable(render(rows));
      const headers = Object.keys(rows[0] ?? {});
      expect(table.headers).toEqual(headers);
      expect(table.rows).toEqual(rows.map((row) => headers.map((h) => expectedCell(row[h]))));
    });
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
      canvas = installRealCanvas();
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

  describe('rows from a real DuckDB canvas (#58)', () => {
    const SERIES_TABLE = 'water_series_01646500_00060_dv_19300101_20261112';
    let canvas: DataCanvas;
    let instance: CanvasInstance;

    beforeEach(async () => {
      canvas = installRealCanvas();
      instance = await canvas.acquire(undefined, createMockContext());
      await instance.registerTable(
        SERIES_TABLE,
        Array.from({ length: 6_000 }, (_, i) => ({
          date_time: `day ${String(i).padStart(4, '0')}`,
          value: i % 7 === 0 ? null : String(1000 + i),
          qualifiers: i % 2 === 0 ? 'A' : 'A,e',
        })),
      );
    });

    afterEach(async () => {
      await canvas.shutdown(createMockContext());
    });

    async function run(sql: string) {
      const result = await runToolContract(waterDataframeQuery, {
        canvas_id: instance.canvasId,
        sql,
      });
      expect(result.isError).toBeFalsy();
      return {
        structured: result.structuredContent as {
          rows: Record<string, unknown>[];
          row_count: number;
          truncated: boolean;
        },
        text: textContent(result.content?.[0]),
      };
    }

    it('returns the first 5,000 of 6,000 matches with truncated=true, rendering each in content[]', async () => {
      const { structured, text } = await run(`SELECT * FROM ${SERIES_TABLE} ORDER BY date_time`);

      expect(structured.rows).toHaveLength(5_000);
      expect(structured.row_count).toBe(5_000);
      expect(structured.truncated).toBe(true);
      expect(structured.rows[4_999]).toEqual({
        date_time: 'day 4999',
        value: '5999',
        qualifiers: 'A,e',
      });
      expect(text).toContain('truncated** at the 5,000-row cap');
      const table = readGfmTable(text);
      expect(table.headers).toEqual(['date_time', 'value', 'qualifiers']);
      expect(table.rows).toEqual(
        structured.rows.map((row) => table.headers.map((h) => expectedCell(row[h]))),
      );
    });

    it('returns a 5,000-row result whole, not truncated', async () => {
      const { structured } = await run(`SELECT * FROM ${SERIES_TABLE} LIMIT 5000`);
      expect(structured.rows).toHaveLength(5_000);
      expect(structured.truncated).toBe(false);
    });

    it('renders lists, structs, pipes, line breaks, NULL, and empty strings so content[] reads back as structuredContent', async () => {
      const { structured, text } = await run(
        `SELECT [1,2] AS lst, {'x':1} AS st, 'a|b' AS p, 'l1' || chr(10) || 'l2' AS nl, NULL AS nul, '' AS emp, '*null*' AS lit, 1 AS "h|dr" FROM ${SERIES_TABLE} LIMIT 1`,
      );
      expect(structured.rows).toEqual([
        {
          lst: [1, 2],
          st: { x: 1 },
          p: 'a|b',
          nl: 'l1\nl2',
          nul: null,
          emp: '',
          lit: '*null*',
          'h|dr': 1,
        },
      ]);
      const table = readGfmTable(text);
      expect(table.headers).toEqual(['lst', 'st', 'p', 'nl', 'nul', 'emp', 'lit', 'h|dr']);
      expect(table.rows).toEqual([['[1,2]', '{"x":1}', 'a|b', 'l1\nl2', null, '', '*null*', '1']]);
    });
  });

  describe('a real DuckDB canvas whose row limit is set below 5,000', () => {
    const SERIES_TABLE = 'water_series_01646500_00060_dv_19300101_20261112';
    let canvas: DataCanvas;
    let instance: CanvasInstance;

    beforeEach(async () => {
      // The canvas refuses a rowLimit above this default, which the server's canvas is built from.
      resetConfig({ CANVAS_DEFAULT_ROW_LIMIT: '1000' });
      canvas = installRealCanvas();
      instance = await canvas.acquire(undefined, createMockContext());
      await instance.registerTable(
        SERIES_TABLE,
        Array.from({ length: 6_000 }, (_, i) => ({
          date_time: `day ${String(i).padStart(4, '0')}`,
          value: String(1000 + i),
        })),
      );
    });

    afterEach(async () => {
      await canvas.shutdown(createMockContext());
    });

    async function run(sql: string) {
      const result = await runToolContract(waterDataframeQuery, {
        canvas_id: instance.canvasId,
        sql,
      });
      expect(result.isError, textContent(result.content?.[0])).toBeFalsy();
      return {
        structured: result.structuredContent as {
          rows: Record<string, unknown>[];
          row_count: number;
          truncated: boolean;
        },
        text: textContent(result.content?.[0]),
      };
    }

    it('caps a query matching more at that limit, naming the cap applied in content[]', async () => {
      const { structured, text } = await run(`SELECT * FROM ${SERIES_TABLE} ORDER BY date_time`);

      expect(structured.rows).toHaveLength(1_000);
      expect(structured).toMatchObject({ row_count: 1_000, truncated: true });
      expect(structured.rows[999]).toEqual({ date_time: 'day 0999', value: '1999' });
      expect(text).toContain(
        '**1000 row(s)** (1000 returned) — **truncated** at the 1,000-row cap; more rows matched.',
      );
      expect(text).not.toContain('5,000');
      expect(readGfmTable(text).rows).toHaveLength(1_000);
    });

    it('returns a result that fits the limit whole, not truncated', async () => {
      const { structured, text } = await run(`SELECT * FROM ${SERIES_TABLE} LIMIT 1000`);
      expect(structured.rows).toHaveLength(1_000);
      expect(structured.truncated).toBe(false);
      expect(text).toContain('— not truncated');
    });
  });

  describe('sql example (#59)', () => {
    const sql = waterDataframeQuery.input.shape.sql.description ?? '';
    const example = /Example on an instantaneous series table: (SELECT .+? LIMIT \d+)\./.exec(
      sql,
    )?.[1];
    const recent = /as (WHERE CAST\(time_utc AS TIMESTAMPTZ\) > now\(\) - INTERVAL \d+ \w+)\./.exec(
      sql,
    )?.[1];
    const table = /FROM (\w+)/.exec(example ?? '')?.[1] ?? '';
    let canvas: DataCanvas;

    beforeEach(() => {
      canvas = installRealCanvas();
    });

    afterEach(async () => {
      await canvas.shutdown(createMockContext());
    });

    it('names a table in the form water_get_series stages an instantaneous series under', () => {
      // water_series_<site>_<parameterCd>_<dv|iv>_<startDate>_<endDate>[_<selection digest>]
      expect(table).toMatch(/^water_series_\d{8,15}_\d{5}_iv_\d{8}_\d{8}(_[0-9a-f]{7})?$/);
      expect(example).toMatch(/ORDER BY time_utc/);
    });

    it('runs as written, ordering by time_utc and windowing relative to now through a TIMESTAMPTZ cast', async () => {
      const instance = await canvas.acquire(undefined, createMockContext());
      // The fall-back hour: site-local date_time strings interleave, time_utc orders correctly.
      await instance.registerTable(
        table,
        [
          ['2026-11-01T01:00:00.000-04:00', 1, '2026-11-01T05:00:00.000Z'],
          ['2026-11-01T01:00:00.000-05:00', 3, '2026-11-01T06:00:00.000Z'],
          ['2026-11-01T01:05:00.000-04:00', 2, '2026-11-01T05:05:00.000Z'],
          ['2999-01-01T00:00:00.000-05:00', 4, '2999-01-01T05:00:00.000Z'],
        ].map(([date_time, value, time_utc]) => ({ date_time, value, time_utc })),
        {
          schema: [
            { name: 'date_time', type: 'VARCHAR' },
            { name: 'value', type: 'DOUBLE' },
            { name: 'time_utc', type: 'VARCHAR' },
          ],
        },
      );
      const query = async (text: string) => {
        const result = await runToolContract(waterDataframeQuery, {
          canvas_id: instance.canvasId,
          sql: text,
        });
        expect(result.isError).toBeFalsy();
        return (result.structuredContent as { rows: { value: number }[] }).rows.map((r) => r.value);
      };

      expect(await query(example ?? '')).toEqual([4, 3, 2, 1]);
      expect(await query(`SELECT value FROM ${table} ${recent} ORDER BY time_utc`)).toEqual([4]);
    });
  });

  describe('regex timing: cell text rendered into content[] (#58)', () => {
    /** Both line-break shapes ride along with each escape path's own worst cases. */
    const lineBreakShapes: [string, (chars: number) => string][] = [
      ['one long line ending in a break', (n) => `${'§1 x'.repeat(n / 4)}\ny`],
      ['line breaks throughout', (n) => '  \r\n'.repeat(n / 4)],
    ];

    it.each([
      ['a digit run', (n: number) => '1'.repeat(n)],
      ...lineBreakShapes,
      ['bare carriage returns', (n: number) => 'a\r'.repeat(n / 2)],
      ['a run of # that would close a heading', (n: number) => `a #${'#'.repeat(n)}`],
      ['an autolink opener that never closes', (n: number) => `<${'@'.repeat(n)}`],
      ['nested tag openers', (n: number) => `${'<a'.repeat(n / 4)}${'>'.repeat(n / 2)}`],
      ['entity openers that never close', (n: number) => '&#1'.repeat(n / 3)],
      ['a backslash run', (n: number) => '\\'.repeat(n)],
      ['an underscore run', (n: number) => '_'.repeat(n)],
      ['a bracket run', (n: number) => '['.repeat(n)],
      ['trailing whitespace', (n: number) => `a${' '.repeat(n)}`],
    ])(
      'encodes a cell of %s in linear time',
      (_shape, shape) => {
        expectLinear(
          shape,
          (cell) => {
            waterDataframeQuery.format!({ rows: [{ c: cell }], row_count: 1, truncated: false });
          },
          MAX_CALL_MICROS,
        );
      },
      0,
    );
  });
});

/** CPU ceiling per call at any size; the slowest shape above takes about 80 ms at 320k characters. */
const MAX_CALL_MICROS = 500_000;
