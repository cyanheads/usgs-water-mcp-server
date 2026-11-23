/**
 * @fileoverview Tool-level tests for water_get_site_data_catalog: the input and output series
 * types, the field and peak rows on both surfaces, and the definition language that tells callers
 * which rows water_get_series reads. The catalog service is mocked; its upstream mapping is covered
 * in tests/services/site-data-catalog.test.ts.
 * @module tests/tools/water-get-site-data-catalog.tool.test
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waterGetSiteDataCatalog } from '@/mcp-server/tools/definitions/water-get-site-data-catalog.tool.js';
import type { SiteCatalogSeries, SiteDataCatalog } from '@/services/waterdata/site-data-catalog.js';
import { textContent } from '../helpers/content-block.js';

vi.mock('@/services/waterdata/site-data-catalog.js', () => ({ getSiteDataCatalog: vi.fn() }));

import { getSiteDataCatalog } from '@/services/waterdata/site-data-catalog.js';

const mockCatalog = vi.mocked(getSiteDataCatalog);

/** A catalog row with every field null but the ones a case sets. */
function row(overrides: Partial<SiteCatalogSeries> & Pick<SiteCatalogSeries, 'timeSeriesId'>) {
  return {
    parameterCd: '00060',
    parameterName: null,
    unit: null,
    statCd: null,
    beginDate: null,
    endDate: null,
    sublocation: null,
    webDescription: null,
    computationPeriod: null,
    computation: null,
    readingType: null,
    seriesType: null,
    ...overrides,
  } satisfies SiteCatalogSeries;
}

/** 01646500 discharge as the catalog lists it: daily mean, continuous, annual peak, a water-year mean, and a field series. */
const CATALOG: SiteDataCatalog = {
  siteNumber: '01646500',
  siteName: 'POTOMAC RIVER NEAR WASH, DC LITTLE FALLS PUMP STA',
  series: [
    row({
      timeSeriesId: '2cf409b0d9694c01828f5d4ff14586a5',
      statCd: '00003',
      computationPeriod: 'Daily',
      computation: 'Mean',
      seriesType: 'daily',
    }),
    row({
      timeSeriesId: '66a4e3fb8abe42fcb0942b5c0fe98f68',
      statCd: '00011',
      computationPeriod: 'Points',
      computation: 'Instantaneous',
      seriesType: 'instantaneous',
    }),
    row({
      timeSeriesId: '51a7ecee083843328f6609518990e022',
      computationPeriod: 'Water Year',
      computation: 'Max At Event Time',
      seriesType: 'peak',
    }),
    row({
      timeSeriesId: '0f0e0d0c0b0a09080706050403020100',
      statCd: '00003',
      computationPeriod: 'Water Year',
      computation: 'Mean',
    }),
    row({
      timeSeriesId: '3ab813d1-f76e-4268-b5e1-8ab4dc53e3d5',
      parameterName: 'Discharge',
      beginDate: '1930-03-25T22:40:00+00:00',
      endDate: '2026-10-07T14:52:31+00:00',
      readingType: 'Discharge',
      seriesType: 'field',
    }),
  ],
  nextCursor: null,
};

describe('water_get_site_data_catalog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns field and peak rows with their reading type on both surfaces', async () => {
    mockCatalog.mockResolvedValue(CATALOG);
    const result = await runToolContract(waterGetSiteDataCatalog, { site: '01646500' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(CATALOG);
    const text = textContent(result.content[0]);
    expect(text).toContain('- **seriesType:** peak');
    expect(text).toContain('- **seriesType:** field');
    expect(text).toContain('- **readingType:** Discharge');
    expect(text).toContain('- **timeSeriesId:** 3ab813d1-f76e-4268-b5e1-8ab4dc53e3d5');
    // A water-year computation water_get_series does not read stays null on both surfaces.
    expect(text.split('### Series 4')[1]?.split('### Series 5')[0]).toContain(
      '- **seriesType:** `null`',
    );
  });

  it.each(['field', 'peak'] as const)(
    'passes seriesType "%s" to the service',
    async (seriesType) => {
      mockCatalog.mockResolvedValue({ ...CATALOG, series: [] });
      const result = await runToolContract(waterGetSiteDataCatalog, {
        site: '01646500',
        seriesType,
      });

      expect(result.isError).toBeFalsy();
      expect(mockCatalog).toHaveBeenCalledWith(
        expect.objectContaining({ site: '01646500', seriesType, limit: 100 }),
        expect.anything(),
      );
    },
  );

  it('reads an empty seriesType as omitted (characterization)', async () => {
    mockCatalog.mockResolvedValue({ ...CATALOG, series: [] });
    await runToolContract(waterGetSiteDataCatalog, { site: '01646500', seriesType: '' });
    expect(mockCatalog.mock.calls[0]?.[0]).toMatchObject({ seriesType: undefined });
  });

  it('rejects a series type water_get_series does not read', async () => {
    const result = await runToolContract(waterGetSiteDataCatalog, {
      site: '01646500',
      seriesType: 'water-year',
    });
    expect(result.isError).toBe(true);
    expect(mockCatalog).not.toHaveBeenCalled();
  });

  it('says which rows water_get_series reads, and that null rows are other computations', () => {
    const { description } = waterGetSiteDataCatalog;
    expect(description).toContain('seriesType "field"');
    expect(description).toContain('"peak"');
    expect(description).toContain(
      'Rows with null seriesType are other computations, such as a water-year mean or maximum, and cannot be requested with water_get_series.',
    );
    const rowShape = waterGetSiteDataCatalog.output.shape.series.element.shape;
    expect(rowShape.seriesType.description).toContain('field for a field-measurement series');
    // The peak mapping keys on the computation alone, so neither description names a period.
    expect(rowShape.seriesType.description).toContain(
      'peak for the Max At Event Time computation (annual peaks)',
    );
    const seriesTypeInput = waterGetSiteDataCatalog.input.shape.seriesType.description;
    expect(seriesTypeInput).toContain('annual-peak series (computation Max At Event Time)');
    for (const text of [rowShape.seriesType.description, seriesTypeInput])
      expect(text).not.toContain('Water Year');
    expect(rowShape.timeSeriesId.description).toContain('UUID');
  });
});
