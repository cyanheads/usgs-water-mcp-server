/**
 * @fileoverview Run read-only SQL SELECT queries against water data tables staged on a DataCanvas
 * by water_get_series. Requires CANVAS_PROVIDER_TYPE=duckdb.
 * @module mcp-server/tools/definitions/water-dataframe-query.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import type { CanvasInstance, QueryResult } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';

export const waterDataframeQuery = tool('water_dataframe_query', {
  description:
    'Run a read-only SQL SELECT against water data tables staged on a DataCanvas by water_get_series or water_find_sites. Workflow: run water_get_series or water_find_sites (get canvas_id + table_name) → water_dataframe_describe (confirm the table and its columns) → water_dataframe_query (SQL analysis). Only SELECT statements are permitted. At most 10,000 rows are returned, and a query matching more is truncated silently (no error) — scope with WHERE/LIMIT, and use SELECT COUNT(*) or water_dataframe_describe to learn the true match count. Requires DataCanvas to be enabled on this server instance. Returns an error if DataCanvas is not available.',
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
        'Number of rows returned in the rows array (up to the 10,000-row cap), not the total matched by the query. A query matching more than 10,000 rows is truncated silently, so row_count then equals the returned count and undercounts the true total. To get the true match count run SELECT COUNT(*) with the same filter, or call water_dataframe_describe for the full row count of the staged table; page large results with LIMIT/OFFSET.',
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
      throw ctx.fail('canvas_disabled', 'DataCanvas is not enabled on this server instance.');
    }

    ctx.log.info('Running dataframe query', { canvas_id: input.canvas_id });

    let instance: CanvasInstance;
    try {
      instance = await canvas.acquire(input.canvas_id, ctx);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('NotFound') || msg.includes('not found') || msg.includes('expired')) {
        throw ctx.fail('canvas_not_found', `Canvas ${input.canvas_id} not found or expired.`);
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
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes('ValidationError') ||
        msg.includes('SELECT') ||
        msg.includes('read_') ||
        msg.includes('syntax') ||
        msg.includes('Parser Error')
      ) {
        throw ctx.fail('invalid_sql', msg);
      }
      throw err;
    }

    ctx.log.info('Query complete', { rowCount: result.rowCount });
    return { rows: result.rows, row_count: result.rowCount };
  },

  format(result) {
    const lines = [`**${result.row_count} row(s)** (${result.rows.length} returned)\n`];
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
