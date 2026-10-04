/**
 * @fileoverview Drop one table from a DataCanvas staged by water_get_series or water_find_sites,
 * leaving the canvas and its other tables in place. Opt-in: callable only when
 * WATER_DATAFRAME_DROP_ENABLED=true, and listed as a disabled tool otherwise. Requires
 * CANVAS_PROVIDER_TYPE=duckdb at call time.
 * @module mcp-server/tools/definitions/water-dataframe-drop.tool
 */

import { disabledTool, tool, z } from '@cyanheads/mcp-ts-core';
import { CANVAS_IDENTIFIER_REGEX, CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { acquireCanvas } from '@/services/canvas/acquire-canvas.js';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';

const waterDataframeDropDefinition = tool('water_dataframe_drop', {
  description:
    'Drop one table from a DataCanvas — a table staged by water_get_series or water_find_sites — leaving the canvas and its other tables in place. Copy the table name from water_dataframe_describe. Returns the number of rows the dropped table held and the names of the tables still staged. A name that is not staged on the canvas fails and changes nothing, so repeating a drop is safe. Requires DataCanvas to be enabled on this server instance. Returns an error if DataCanvas is not available.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.object({
    canvas_id: CanvasIdSchema.describe(
      'Canvas ID returned by water_get_series or water_find_sites. Identifies the canvas holding the table to drop.',
    ),
    table_name: z
      .string()
      .regex(
        CANVAS_IDENTIFIER_REGEX,
        'Expected a table name as water_dataframe_describe lists it: letters, digits, and underscores, starting with a letter or underscore, at most 63 characters.',
      )
      .describe(
        'Name of the staged table to drop, as water_dataframe_describe lists it — the table_name water_get_series or water_find_sites returned. Matched case-insensitively. Only this table is removed.',
      ),
  }),
  output: z.object({
    canvas_id: z
      .string()
      .describe(
        'The canvas the table was dropped from — still valid, with its other tables intact.',
      ),
    table_name: z.string().describe('Name of the dropped table, as it was staged.'),
    row_count: z.number().int().describe('Number of rows the dropped table held.'),
    remaining_tables: z
      .array(z.string().describe('Name of a table still staged on this canvas.'))
      .describe(
        'Tables still staged on this canvas after the drop — query any of them with water_dataframe_query. Empty when the dropped table was the last one.',
      ),
  }),

  errors: [
    {
      reason: 'canvas_disabled',
      code: JsonRpcErrorCode.InvalidRequest,
      when: 'DataCanvas is not enabled on this server instance.',
      recovery:
        'DataCanvas is not available on this server instance, so no tables are staged and no cleanup is needed — water_get_series and water_find_sites return their data inline here.',
    },
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The canvas_id does not exist or has expired.',
      recovery:
        'An expired canvas has already released its tables, so there is nothing left to drop. If the id may be mistyped, compare it with the canvas_id water_get_series or water_find_sites returned.',
      thrownBy: 'service',
    },
    {
      reason: 'table_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No table with this name is staged on the canvas — it was already dropped, has expired, or was never created.',
      recovery:
        'Call water_dataframe_describe with this canvas_id to list the staged tables and copy the exact name; a table that was already dropped no longer appears there.',
    },
  ],

  async handler(input, ctx) {
    const canvas = getCanvas();
    if (!canvas) {
      ctx.log.info(
        'DataCanvas not enabled; set CANVAS_PROVIDER_TYPE=duckdb to stage tables water_dataframe_drop can remove.',
      );
      throw ctx.fail('canvas_disabled', 'DataCanvas is not enabled on this server instance.');
    }

    ctx.log.info('Dropping canvas table', {
      canvas_id: input.canvas_id,
      table_name: input.table_name,
    });

    const instance = await acquireCanvas(canvas, input.canvas_id, ctx);

    /**
     * Resolve the name against the staged listing before dropping. DuckDB identifiers are
     * case-insensitive, so this finds the table under any spelling water_dataframe_query accepts,
     * and the listing supplies the row count and the tables that remain.
     */
    const wanted = input.table_name.toLowerCase();
    const staged = await instance.describe();
    const target = staged.find((t) => t.name.toLowerCase() === wanted);
    if (!target || !(await instance.drop(target.name))) {
      throw ctx.fail(
        'table_not_found',
        `Table "${input.table_name}" is not staged on canvas ${input.canvas_id}; nothing was dropped.`,
      );
    }

    const remaining = staged.filter((t) => t !== target).map((t) => t.name);
    ctx.log.info('Canvas table dropped', {
      table_name: target.name,
      row_count: target.rowCount,
      remaining: remaining.length,
    });
    return {
      canvas_id: input.canvas_id,
      table_name: target.name,
      row_count: target.rowCount,
      remaining_tables: remaining,
    };
  },

  format(result) {
    const remaining =
      result.remaining_tables.length > 0
        ? `Remaining tables (${result.remaining_tables.length}): ${result.remaining_tables.map((name) => `\`${name}\``).join(', ')}`
        : 'No tables remain on this canvas.';
    return [
      {
        type: 'text',
        text: `**Dropped \`${result.table_name}\`** (${result.row_count} rows) from canvas \`${result.canvas_id}\`.\n\n${remaining}`,
      },
    ];
  },
});

/**
 * Dropping a table discards staged data, so the tool is opt-in. With the flag off it stays in the
 * manifest and on the landing page as a disabled tool, and clients cannot call it.
 */
export const waterDataframeDrop = getServerConfig().dataframeDropEnabled
  ? waterDataframeDropDefinition
  : disabledTool(waterDataframeDropDefinition, {
      reason: 'Dropping staged tables is turned off in this deployment.',
      hint: 'WATER_DATAFRAME_DROP_ENABLED=true',
    });
