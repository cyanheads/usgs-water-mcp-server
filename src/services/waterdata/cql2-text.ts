/**
 * @fileoverview CQL2-text literals for OGC `filter` queries (`filter-lang=cql2-text`), sent as GET
 * parameters — the form whose `next` links carry the filter forward.
 * @module services/waterdata/cql2-text
 */

/** A CQL2 string literal: single-quoted, with embedded quotes doubled. */
export function cqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** `property IN ('a','b',…)` over string values. `property` is a fixed queryable name, never input. */
export function cqlIn(property: string, values: readonly string[]): string {
  return `${property} IN (${values.map(cqlString).join(',')})`;
}
