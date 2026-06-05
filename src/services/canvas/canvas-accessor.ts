/**
 * @fileoverview Module-level canvas accessor for DataCanvas integration.
 * Wired during createApp() setup() before any handler runs.
 * @module services/canvas/canvas-accessor
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';

let _canvas: DataCanvas | undefined;

/** Store the canvas instance from createApp setup(). */
export const setCanvas = (c: DataCanvas | undefined): void => {
  _canvas = c;
};

/** Retrieve the canvas instance. Returns undefined when CANVAS_PROVIDER_TYPE is not set. */
export const getCanvas = (): DataCanvas | undefined => _canvas;
