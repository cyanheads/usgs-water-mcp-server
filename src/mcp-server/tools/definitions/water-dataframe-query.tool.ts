/**
 * @fileoverview Run read-only SQL SELECT queries against water data tables staged on a DataCanvas
 * by water_get_series or water_find_sites. Requires CANVAS_PROVIDER_TYPE=duckdb.
 * @module mcp-server/tools/definitions/water-dataframe-query.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import {
  type CanvasInstance,
  type QueryResult,
  SQL_GATE_REASONS,
} from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';

/**
 * Canvas rejections this tool maps onto its `invalid_sql` contract entry, with guidance scoped to
 * what an MCP caller controls. A `null` value keeps the engine's own message — it names the
 * offending column or function and is directly actionable. Reasons absent from this map are
 * handled by their own branch in the catch, or re-thrown untouched.
 *
 * The rewritten entries exist because the engine wording addresses a direct `CanvasInstance`
 * consumer, not an MCP caller: the non-SELECT rejection points at `registerTable`/`drop`/`clear`,
 * which is not reachable through this tool — it exposes read-only SELECT and nothing else.
 */
const SQL_GATE_MESSAGES: Record<string, string | null> = {
  [SQL_GATE_REASONS.nonSelectStatement]:
    'This tool runs read-only SELECT statements only; the submitted statement is not a SELECT.',
  [SQL_GATE_REASONS.multiStatement]: 'Submit exactly one SELECT statement per call.',
  [SQL_GATE_REASONS.invalidSql]: null,
  [SQL_GATE_REASONS.deniedFunction]: null,
  [SQL_GATE_REASONS.deniedFunctionInPlan]: null,
  [SQL_GATE_REASONS.planOperatorNotAllowed]: null,
};

/**
 * Reason the canvas provider sets when a query names a table that is not staged. Not part of
 * `SQL_GATE_REASONS` — it is raised by the provider's prepare step, ahead of the gate.
 */
const MISSING_TABLE_REASON = 'missing_table';

export const waterDataframeQuery = tool('water_dataframe_query', {
  description:
    'Run a read-only SQL SELECT against water data tables staged on a DataCanvas by water_get_series or water_find_sites. Workflow: run water_get_series or water_find_sites (get canvas_id + table_name) → water_dataframe_describe (confirm the table and its columns) → water_dataframe_query (SQL analysis). Only SELECT statements are permitted. At most 10,000 rows are returned; a query matching more is capped and the response sets truncated=true — scope with WHERE/LIMIT, and use SELECT COUNT(*) or water_dataframe_describe to learn the true match count. Requires DataCanvas to be enabled on this server instance. Returns an error if DataCanvas is not available.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    canvas_id: z
      .string()
      .describe(
        'Canvas ID returned by water_get_series or water_find_sites. Identifies the canvas holding the data.',
      ),
    sql: z
      .string()
      .describe(
        'Read-only SELECT statement. Reference the table by the table_name from water_get_series or water_find_sites; columns vary by source table, so run water_dataframe_describe first for the exact schema. Example: SELECT date_time, value FROM water_series_01646500_00060 ORDER BY date_time DESC LIMIT 10',
      ),
  }),
  output: z.object({
    rows: z
      .array(
        z
          .object({})
          .passthrough()
          .describe(
            'A result row whose keys are the selected column names and values are the corresponding cell values.',
          ),
      )
      .describe('Result rows returned (up to 10,000). Column names match the SELECT clause.'),
    row_count: z
      .number()
      .int()
      .describe(
        'Number of rows returned in the rows array (up to the 10,000-row cap), not the total matched by the query. When truncated is true the cap was reached, so row_count equals the returned count and undercounts the true total. To get the true match count run SELECT COUNT(*) with the same filter, or call water_dataframe_describe for the full row count of the staged table; page large results with LIMIT/OFFSET.',
      ),
    truncated: z
      .boolean()
      .describe(
        'True when the query matched more rows than the 10,000-row cap and the result was capped — rows and row_count then cover only the first 10,000 matches, and the rest are not in this response. False means rows and row_count are the complete result for this query. When true, narrow the query with WHERE, page with LIMIT/OFFSET, or run SELECT COUNT(*) with the same filter for the true total.',
      ),
  }),

  errors: [
    {
      reason: 'canvas_disabled',
      code: JsonRpcErrorCode.InvalidRequest,
      when: 'DataCanvas is not enabled on this server instance.',
      recovery:
        'DataCanvas is not available on this server instance; use water_get_series to read the data directly.',
    },
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The canvas_id does not exist or has expired.',
      recovery: 'Re-run water_get_series to stage the data again and get a fresh canvas_id.',
    },
    {
      reason: 'table_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The SQL names a table that is not staged on this canvas — it may have expired, or was never created.',
      recovery:
        'Call water_dataframe_describe with this canvas_id to list the staged tables, or re-run water_get_series or water_find_sites to stage the data again.',
    },
    {
      reason: 'system_catalog_access',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The SQL reads a database system catalog (information_schema, pg_catalog, sqlite_master, duckdb_*) instead of a staged table.',
      recovery:
        'Query the staged tables directly — call water_dataframe_describe with this canvas_id for their names and columns.',
    },
    {
      reason: 'invalid_sql',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The SQL is not a read-only SELECT, contains disallowed functions, or is syntactically invalid.',
      recovery:
        'Use only SELECT statements. Do not use file-reading functions (read_csv, read_parquet, etc.).',
    },
  ],

  async handler(input, ctx) {
    const canvas = getCanvas();
    if (!canvas) {
      ctx.log.info(
        'DataCanvas not enabled; set CANVAS_PROVIDER_TYPE=duckdb to enable SQL queries over staged series.',
      );
      throw ctx.fail(
        'canvas_disabled',
        'DataCanvas is not enabled on this server instance.',
        ctx.recoveryFor('canvas_disabled'),
      );
    }

    ctx.log.info('Running dataframe query', { canvas_id: input.canvas_id });

    let instance: CanvasInstance;
    try {
      instance = await canvas.acquire(input.canvas_id, ctx);
    } catch (err: unknown) {
      if (err instanceof McpError && err.data?.['reason'] === 'canvas_not_found') {
        throw ctx.fail(
          'canvas_not_found',
          `Canvas ${input.canvas_id} not found or expired.`,
          ctx.recoveryFor('canvas_not_found'),
          { cause: err },
        );
      }
      throw err;
    }

    let result: QueryResult;
    try {
      result = await instance.query(input.sql, {
        signal: ctx.signal,
        denySystemCatalogs: true,
      });
    } catch (err: unknown) {
      if (err instanceof McpError) {
        const reason = err.data?.['reason'];
        if (reason === MISSING_TABLE_REASON) {
          const tableName = err.data?.['tableName'];
          const subject =
            typeof tableName === 'string' ? `Table "${tableName}"` : 'A table named in this query';
          throw ctx.fail(
            'table_not_found',
            `${subject} is not staged on canvas ${input.canvas_id}.`,
            ctx.recoveryFor('table_not_found'),
            { cause: err },
          );
        }
        if (reason === SQL_GATE_REASONS.systemCatalogAccess) {
          throw ctx.fail(
            'system_catalog_access',
            'System catalog tables are not queryable here; only the tables staged on this canvas are.',
            ctx.recoveryFor('system_catalog_access'),
            { cause: err },
          );
        }
        const scoped = typeof reason === 'string' ? SQL_GATE_MESSAGES[reason] : undefined;
        if (scoped !== undefined) {
          throw ctx.fail('invalid_sql', scoped ?? err.message, ctx.recoveryFor('invalid_sql'), {
            cause: err,
          });
        }
      }
      throw err;
    }

    ctx.log.info('Query complete', { rowCount: result.rowCount, truncated: result.truncated });
    return {
      rows: result.rows,
      row_count: result.rowCount,
      truncated: result.truncated ?? false,
    };
  },

  format(result) {
    const truncationNote = result.truncated
      ? ' — **truncated** at the 10,000-row cap; more rows matched. Narrow with WHERE, page with LIMIT/OFFSET, or run SELECT COUNT(*) for the true total.'
      : ' — not truncated';
    const lines = [
      `**${result.row_count} row(s)** (${result.rows.length} returned)${truncationNote}\n`,
    ];
    const firstRow = result.rows[0];
    if (firstRow !== undefined) {
      const headers = Object.keys(firstRow);
      lines.push(`| ${headers.join(' | ')} |`);
      lines.push(`| ${headers.map(() => '---').join(' | ')} |`);
      for (const row of result.rows.slice(0, 50)) {
        lines.push(`| ${headers.map((h) => String(row?.[h] ?? '')).join(' | ')} |`);
      }
      if (result.rows.length > 50) lines.push(`*(showing 50 of ${result.rows.length})*`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
