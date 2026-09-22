/**
 * @fileoverview Builders for deterministic, identifier-safe DataCanvas table names.
 *
 * `registerTable` is `DROP TABLE IF EXISTS` + `CREATE TABLE`, so a name that omits a dimension of
 * the query lets two different result sets land on one table — the second silently replaces the
 * first while the response still reports a successful staging. A staged name therefore has to vary
 * with every input that changes the rows, and stay fixed for the ones that do not, so re-running an
 * identical query replaces only its own table.
 *
 * Carrying every dimension literally does not fit: a canvas identifier is capped at 63 characters
 * and a single `countyCd` list alone can run to 119. The shape here is a readable prefix — what the
 * query was scoped to — plus a short digest of the full normalized filter set, which is what makes
 * the name total over the inputs.
 *
 * @module services/canvas/canvas-table-name
 */

import { createHash } from 'node:crypto';
import { CANVAS_IDENTIFIER_REGEX } from '@cyanheads/mcp-ts-core/canvas';
import { internalError } from '@cyanheads/mcp-ts-core/errors';

/**
 * Rewrite every character outside `[A-Za-z0-9_]` to `_`, so a comma-separated list, a hyphen, or a
 * decimal point in an upstream filter value can never reach a canvas identifier. Case is preserved:
 * the token is read by agents alongside the filters that produced it.
 */
export function sanitizeIdentifierToken(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * Recursively rebuild `value` with object keys in codepoint order, so two structurally equal filter
 * sets serialize to the same JSON regardless of the order their keys were assigned. Arrays keep
 * their order — position is meaningful there. `undefined` members are dropped by `JSON.stringify`,
 * which is what makes an absent optional filter and an explicitly-undefined one hash alike.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, member]) => [key, canonicalize(member)]),
    );
  }
  return value;
}

/**
 * First 8 hex characters of a SHA-256 over the canonical JSON of `input`. Deterministic across
 * processes and key orderings, so the same filter set always resolves to the same suffix.
 */
export function shortHash(input: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(input)))
    .digest('hex')
    .slice(0, 8);
}

/**
 * Return `name` once it satisfies the canvas identifier rule, throwing otherwise. A violation means
 * the derivation above let an unsanitized value through, not that the caller sent something bad —
 * failing here names the derived value, where `registerTable`'s own rejection would surface deep in
 * the provider with no indication of which tool built it.
 */
export function assertCanvasTableName(name: string): string {
  if (!CANVAS_IDENTIFIER_REGEX.test(name)) {
    throw internalError(`Derived canvas table name "${name}" is not a legal canvas identifier.`, {
      tableName: name,
    });
  }

  return name;
}
