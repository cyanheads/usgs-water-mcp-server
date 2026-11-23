/**
 * @fileoverview Tests for the shared site-list split: distinct-in-input-order reads, deferral
 * past the batch size, and the deferred-sites line.
 * @module tests/services/site-batch.test
 */

import { describe, expect, it } from 'vitest';
import {
  formatDeferredSites,
  SITE_BATCH_SIZE,
  SITE_LIST_MAX,
  splitSiteBatch,
} from '@/services/waterdata/site-batch.js';

const site = (i: number) => String(10_000_000 + i);

describe('splitSiteBatch', () => {
  it('reads every site when the list fits the batch', () => {
    expect(splitSiteBatch(['01646500', '01638500'])).toEqual({
      read: ['01646500', '01638500'],
      deferred: [],
    });
  });

  it('reads the first 100 distinct sites and defers the rest in input order', () => {
    const sites = Array.from({ length: 150 }, (_, i) => site(i));
    const { read, deferred } = splitSiteBatch(sites);
    expect(read).toHaveLength(100);
    expect(read[0]).toBe(site(0));
    expect(read[99]).toBe(site(99));
    expect(deferred).toEqual(Array.from({ length: 50 }, (_, i) => site(100 + i)));
  });

  it('counts a repeated number once, at its first position', () => {
    const sites = ['01646500', ...Array.from({ length: 100 }, () => '01646500'), '01638500'];
    expect(splitSiteBatch(sites)).toEqual({ read: ['01646500', '01638500'], deferred: [] });
  });

  it('defers a repeated number once', () => {
    const sites = [...Array.from({ length: 100 }, (_, i) => site(i)), site(200), site(200)];
    expect(splitSiteBatch(sites).deferred).toEqual([site(200)]);
  });

  it('does not defer a later repeat of a site it already reads', () => {
    const sites = [...Array.from({ length: 100 }, (_, i) => site(i)), site(0)];
    expect(splitSiteBatch(sites).deferred).toEqual([]);
  });

  it('reads 100 per call and accepts 500', () => {
    expect(SITE_BATCH_SIZE).toBe(100);
    expect(SITE_LIST_MAX).toBe(500);
  });
});

describe('formatDeferredSites', () => {
  it('returns nothing when no site was deferred', () => {
    expect(formatDeferredSites([])).toBeUndefined();
  });

  it('names every deferred site and the resubmit step', () => {
    expect(formatDeferredSites(['01646500', '01638500'])).toBe(
      '**Deferred sites (2):** 01646500, 01638500 — not read in this call; resubmit them as `sites` in another call.',
    );
  });
});
