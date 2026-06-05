---
name: usgs-water-mcp-server
description: "US surface and groundwater data via USGS — real-time streamflow, gage height, groundwater levels, and historical daily series."
version: 0.0.0
status: idea
category: external-data
hosted: false
subdomain: ""
port: 0
tools: 0
resources: 0
prompts: 0
rating: unrated
stars: 0
open_issues: 0
auth: none
framework: mcp-ts-core
core_version: ""
npm: "@cyanheads/usgs-water-mcp-server"
created: 2026-05-30
error_handling: unaudited
response_enrichment: unaudited
needs_migration: false
pattern: multi-endpoint single-source
complexity: medium
api-deps: USGS Water Services (NWIS iv/dv/site/gwlevels) + USGS Water Data OGC API
api-cost: free (no key)
hostable: true
composes-with: earthquake-mcp-server, nws-weather-mcp-server, noaa-cdo-mcp-server, epa-mcp-server, open-meteo-mcp-server
---

# usgs-water-mcp-server

US surface-water and groundwater data from the USGS — real-time streamflow (discharge), gage height, groundwater levels, water temperature, and decades of historical daily values, from ~1.9M monitoring sites. Keyless.

The fleet has the *other* USGS surface, `earthquake` (seismic), but nothing on **hydrology** — river levels, flood/drought conditions, streamflow. This is the natural sibling: same agency, same "monitor the physical environment" framing, totally distinct domain. It rounds out the environment cluster (NWS weather, NOAA climate, EPA, GBIF) with the water dimension.

**Audience:** Anglers, paddlers, rafters, flood/drought watchers, hydrologists, farmers, environmental researchers, agents answering "is the river runnable / flooding?" or "how does this year's flow compare?"

## User Goals

- Find monitoring sites near a place or along a river
- Get the current streamflow and gage height at a site
- Pull a historical daily series for trend/percentile analysis
- Check groundwater levels for a well/aquifer
- Compare current conditions against normal (percentiles)

## API Surface

USGS exposes the stable legacy **NWIS Water Services** and a newer **Water Data OGC API** (live, the long-term replacement). Sites are keyed by USGS site number (e.g. `01646500`); measurements by 5-digit **parameter code** (`00060` discharge, `00065` gage height, `00010` water temp, `72019` groundwater depth).

| Endpoint | Purpose | Notes |
|:---------|:--------|:------|
| `waterservices.usgs.gov/nwis/iv` | Instantaneous (real-time, ~15-min) values | Current conditions; WaterML/JSON |
| `waterservices.usgs.gov/nwis/dv` | Daily values | Historical series, long records |
| `waterservices.usgs.gov/nwis/site` | Site metadata | Location, type, available parameters (RDB) |
| `waterservices.usgs.gov/nwis/gwlevels` | Groundwater levels | Wells/aquifers |
| `waterservices.usgs.gov/nwis/stat` | Statistics | Daily/monthly percentiles for "vs normal" |
| `api.waterdata.usgs.gov/ogcapi/v0` | Modern OGC API | Collections (e.g. `latest-continuous`); the forward path |

Parameter and site codes are the core vocabulary — the server must make code discovery easy (`00060` is not guessable).

## Tool Surface (sketch)

```
water_find_sites     — find monitoring sites by coordinates+radius, bounding box, state,
                       or HUC, optionally filtered to sites measuring a given parameter
                       (e.g. only streamflow sites). Returns site number, name, type
                       (stream | well | lake | spring), coordinates, and available
                       parameters. Required first step — downstream tools key on site
                       number, and parameter availability varies by site.

water_get_readings   — latest instantaneous readings for one or more sites: streamflow
                       (cfs), gage height (ft), water temp, etc., each with timestamp and
                       qualifier. "What's the river doing right now?" Batch-friendly.

water_get_series     — historical series for a site + parameter over a date range.
                       Daily values (long records) or instantaneous (recent, finer).
                       Large ranges spill to DataCanvas for SQL/percentile analysis.
                       "How does this spring's flow compare to the last 20 years?"

water_get_groundwater_levels — groundwater levels for a well/site: depth-to-water over time.
                       Distinct workflow (wells, aquifers) from surface flow.

water_list_parameters — static lookup table of well-known USGS parameter codes (00060
                       discharge, 00065 gage height, 00010 water temp, 72019 groundwater
                       depth, etc.) with human-readable names and units. Solves the
                       "opaque 5-digit code" problem without a network call.

water_get_conditions — current value placed in context against the site's historical
                       percentiles (via the stat service): "today's flow is in the 12th
                       percentile — well below normal (drought)." Turns a raw number into
                       a judgment. Read-only.
```

## Design Notes

- Medium complexity from the **site/parameter code system** (opaque 5-digit codes), the iv-vs-dv-vs-gwlevels split, mixed response formats (WaterML/JSON vs. RDB tab-delimited for site), and the in-flight **NWIS → OGC API modernization** (both live today).
- **Use NWIS as the stable primary** and treat the OGC API as the forward path — note the migration in design so the server can adopt OGC collections incrementally without a rewrite. Don't build solely on either.
- **Parameter discovery is the UX crux.** Bake the common codes into descriptions (`00060` discharge, `00065` gage height, `00010` temp) and have `water_find_sites` report which parameters each site offers — agents can't guess codes. `water_list_parameters` exposes the full well-known code table as a keyless, no-network lookup.
- `water_get_conditions` (current vs. percentile) is the highest-value tool — it answers the real question (flood? drought? normal?) instead of handing back cubic-feet-per-second the agent must interpret.
- Coverage is **US + territories**; absence of a site ≠ no water — it's no gage. Real-time values carry provisional/approved qualifiers — surface them, don't hide.
- Composes with `earthquake` (USGS sibling — shared hazard-monitoring framing), `nws-weather` (rain forecast + river response = flood outlook), `noaa-cdo` (precipitation history behind a drought), `epa` (water *quality* alongside *quantity*), `open-meteo` (precip driving streamflow anywhere).
- Moonshot: a "flood/drought watch" workflow for a place — find the nearest gage, compare current flow to percentiles, fold in the NWS precip forecast, and return a rising/falling/normal verdict.
- README one-liner: "Real-time streamflow, river levels, and groundwater from USGS — is the river runnable, flooding, or low?"
