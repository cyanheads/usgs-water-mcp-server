/**
 * @fileoverview Test helper for extracting text from formatted MCP content blocks.
 * @module tests/helpers/content-block
 */

import type { ContentBlock } from '@cyanheads/mcp-ts-core';

/** Returns a text block's payload and fails loudly when a formatter emits another block type. */
export function textContent(block: ContentBlock | undefined): string {
  if (block?.type !== 'text') {
    throw new Error('Expected a text content block.');
  }

  return block.text;
}

/** The text of every text block in a tool result's `content[]`, joined. */
export function allText(content: readonly { type: string; text?: string }[]): string {
  return content.map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('\n');
}
