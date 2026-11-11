/**
 * @fileoverview US state and territory postal codes mapped to FIPS state codes. Sixty-four come
 * from the USGS Water Data OGC `states` collection (`states?country_code=US`, read 2026-11-11: its
 * coded rows beside `US-00` "Unspecified"). The other three — FM, MH, and PW, the freely associated
 * states — are absent from that collection, but `monitoring-locations` files sites under their
 * FIPS codes (Micronesian sites on the ZP11 and GST clocks carry `state_code` 64), so they take the
 * FIPS 5-2 codes 64, 68, and 70. The OGC `state_code` queryable takes FIPS digits only —
 * `state_code=MD` answers 200 with no rows — so a postal code is translated before it is sent.
 * @module services/waterdata/state-fips-codes
 */

const STATE_FIPS_CODES: ReadonlyMap<string, string> = new Map([
  ['AL', '01'], // Alabama
  ['AK', '02'], // Alaska
  ['AZ', '04'], // Arizona
  ['AR', '05'], // Arkansas
  ['CA', '06'], // California
  ['CO', '08'], // Colorado
  ['CT', '09'], // Connecticut
  ['DE', '10'], // Delaware
  ['DC', '11'], // District of Columbia
  ['FL', '12'], // Florida
  ['GA', '13'], // Georgia
  ['HI', '15'], // Hawaii
  ['ID', '16'], // Idaho
  ['IL', '17'], // Illinois
  ['IN', '18'], // Indiana
  ['IA', '19'], // Iowa
  ['KS', '20'], // Kansas
  ['KY', '21'], // Kentucky
  ['LA', '22'], // Louisiana
  ['ME', '23'], // Maine
  ['MD', '24'], // Maryland
  ['MA', '25'], // Massachusetts
  ['MI', '26'], // Michigan
  ['MN', '27'], // Minnesota
  ['MS', '28'], // Mississippi
  ['MO', '29'], // Missouri
  ['MT', '30'], // Montana
  ['NE', '31'], // Nebraska
  ['NV', '32'], // Nevada
  ['NH', '33'], // New Hampshire
  ['NJ', '34'], // New Jersey
  ['NM', '35'], // New Mexico
  ['NY', '36'], // New York
  ['NC', '37'], // North Carolina
  ['ND', '38'], // North Dakota
  ['OH', '39'], // Ohio
  ['OK', '40'], // Oklahoma
  ['OR', '41'], // Oregon
  ['PA', '42'], // Pennsylvania
  ['RI', '44'], // Rhode Island
  ['SC', '45'], // South Carolina
  ['SD', '46'], // South Dakota
  ['TN', '47'], // Tennessee
  ['TX', '48'], // Texas
  ['UT', '49'], // Utah
  ['VT', '50'], // Vermont
  ['VA', '51'], // Virginia
  ['WA', '53'], // Washington
  ['WV', '54'], // West Virginia
  ['WI', '55'], // Wisconsin
  ['WY', '56'], // Wyoming
  ['AS', '60'], // American Samoa
  ['FM', '64'], // Federated States of Micronesia — not in the states collection
  ['UM', '65'], // Palmyra Atoll
  ['GU', '66'], // Guam
  ['JQ', '67'], // Johnston Atoll
  ['MH', '68'], // Marshall Islands — not in the states collection
  ['MP', '69'], // Northern Mariana Islands
  ['PW', '70'], // Palau — not in the states collection
  ['MQ', '71'], // Midway Islands
  ['PR', '72'], // Puerto Rico
  ['YQ', '73'], // Ryukyu Islands, Southern
  ['SQ', '74'], // Swan Islands
  ['NI', '76'], // Navassa Island
  ['IQ', '77'], // U.S. Misc Pacific Islands
  ['VI', '78'], // Virgin Islands
  ['WQ', '79'], // Wake Island
]);

/** The FIPS state code for a postal code in any case (`md` → `24`); undefined for an unknown code. */
export function stateFipsCode(postalCode: string): string | undefined {
  return STATE_FIPS_CODES.get(postalCode.toUpperCase());
}
