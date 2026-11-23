/**
 * @fileoverview The site-list rule shared by the tools that take many site numbers
 * (`water_get_readings`, `water_get_conditions`): accept up to {@link SITE_LIST_MAX} numbers,
 * read the first {@link SITE_BATCH_SIZE} distinct ones, and hand the rest back as deferred
 * sites for the caller to resubmit.
 * @module services/waterdata/site-batch
 */

/** Distinct sites one call reads: the resolver and readings batches each take 100 per request. */
export const SITE_BATCH_SIZE = 100;

/** Site numbers a call accepts — the largest page `water_find_sites` returns. */
export const SITE_LIST_MAX = 500;

/** One call's split of a site list. Both arrays hold distinct numbers in input order. */
export interface SiteBatch {
  /** Sites not read in this call, each once, for the caller to resubmit. */
  deferred: string[];
  /** Sites this call reads, at most {@link SITE_BATCH_SIZE}. */
  read: string[];
}

/**
 * Split a site list into the distinct numbers read now and the distinct numbers deferred. A
 * repeated number counts once, at its first position.
 */
export function splitSiteBatch(sites: readonly string[]): SiteBatch {
  const distinct = [...new Set(sites)];
  return { read: distinct.slice(0, SITE_BATCH_SIZE), deferred: distinct.slice(SITE_BATCH_SIZE) };
}

/** The `content[]` line naming deferred sites, or `undefined` when none were deferred. */
export function formatDeferredSites(deferred: readonly string[]): string | undefined {
  if (deferred.length === 0) return;
  return `**Deferred sites (${deferred.length}):** ${deferred.join(', ')} — not read in this call; resubmit them as \`sites\` in another call.`;
}
