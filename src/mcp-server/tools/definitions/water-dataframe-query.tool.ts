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
    'Run a read-only SQL SELECT against water time-series tables staged on a DataCanvas by water_get_series. ' +
    'Workflow: water_get_series (get canvas_id + table_name) → water_dataframe_describe (confirm schema) → ' +
    'water_dataframe_query (SQL analysis). Only SELECT statements are permitted. ' +
    'Results are capped at 10,000 rows; use WHERE and LIMIT clauses to stay within budget. ' +
    'Requires DataCanvas to be enabled on this server instance. Returns an error if DataCanvas is not available.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    canvas_id: z
      .string()
      .describe('Canvas ID returned by water_get_series. Identifies the canvas holding the data.'),
    sql: z
      .string()
      .describe(
        'Read-only SELECT statement. Reference tables by the names returned in water_get_series table_name. ' +
          'Columns available: date_time (VARCHAR), value (VARCHAR), qualifiers (VARCHAR), ' +
          'site_number (VARCHAR), parameter_cd (VARCHAR), unit_code (VARCHAR). ' +
          'Example: SELECT date_time, value FROM water_series_01646500_00060 ORDER BY date_time DESC LIMIT 10',
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
        'Total rows matched by the query before the 10,000-row cap. When row_count > rows.length, add WHERE or LIMIT clauses to retrieve specific subsets.',
      ),
  }),

  errors: [
    {
      reason: 'canvas_disabled',
      code: JsonRpcErrorCode.InvalidRequest,
      when: 'CANVAS_PROVIDER_TYPE is not set to duckdb.',
      recovery: 'Set CANVAS_PROVIDER_TYPE=duckdb in the server environment to enable DataCanvas.',
    },
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The canvas_id does not exist or has expired.',
      recovery: 'Re-run water_get_series to stage the data again and get a fresh canvas_id.',
    },
    {
      reason: 'invalid_sql',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The SQL is not a read-only SELECT, contains disallowed functions, or is syntactically invalid.',
      recovery:
        'Use only SELECT statements. Do not use file-reading functions (read_csv, read_parquet, etc.).',
    },
  ],

  async handler(input, ctx) {
    const canvas = getCanvas();
    if (!canvas) {
      throw ctx.fail(
        'canvas_disabled',
        'DataCanvas is not enabled. Set CANVAS_PROVIDER_TYPE=duckdb.',
      );
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
      result = await instance.query(input.sql, { signal: ctx.signal });
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
