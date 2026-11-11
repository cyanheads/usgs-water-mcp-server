/**
 * @fileoverview CQL2-text literal builders: quoting and the `IN` list the OGC collections accept
 * over GET (verified live: `monitoring_location_number IN ('01646500','364643089212301')`).
 * @module tests/services/cql2-text.test
 */

import { describe, expect, it } from 'vitest';
import { cqlIn, cqlString } from '@/services/waterdata/cql2-text.js';

describe('cql2-text literals', () => {
  it('single-quotes a string and doubles embedded quotes', () => {
    expect(cqlString('ST')).toBe("'ST'");
    expect(cqlString("O'Brien Creek")).toBe("'O''Brien Creek'");
    expect(cqlString("''")).toBe("''''''");
    expect(cqlString('')).toBe("''");
  });

  it('builds an IN list over quoted values', () => {
    expect(cqlIn('monitoring_location_number', ['01646500', '364643089212301'])).toBe(
      "monitoring_location_number IN ('01646500','364643089212301')",
    );
    expect(cqlIn('site_type_code', ["x' OR 1=1 --"])).toBe("site_type_code IN ('x'' OR 1=1 --')");
  });
});
