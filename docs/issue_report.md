# Issue Reporting & Maintenance Notes

This document captures the current maintenance status of Design Storm Generator and serves as a checklist for
future debugging sessions.

## How to Report an Issue

Please include the details below when filing an issue so problems can be reproduced quickly:

- Map location (latitude/longitude) and the duration/return period that was selected
- Distribution type (e.g., SCS Type II, Huff Q3, custom curve) and whether the duration mode was
  <em>Standard</em> or <em>Custom</em>
- Computation mode (<em>Precise</em> or <em>Fast (approx.)</em>)
- Export format that triggered the problem (CSV or DAT) and whether timestamps were enabled
- Browser name and version, along with any console or network errors

Providing a screenshot of the NOAA table and generated charts is especially helpful when storms do not
scale as expected.

## Troubleshooting Checklist

- **NOAA data missing** – Confirm the dev server proxy (`/noaa-api/fe_text_mean.csv`) or production proxy
  (`https://api.allorigins.win/raw`) is reachable. The app will show an empty table when the proxy or
  NOAA endpoint is unavailable.
- **Custom curve rejected** – Ensure the CSV includes two columns (time and cumulative fraction) and that
  the cumulative values increase monotonically from 0 to 1. The importer trims, normalizes, and resamples the
  curve to match the storm duration.
- **DAT export confusion** – DAT files only contain intensities in inches per hour. Use the CSV export
  (with a valid start time if you need timestamps) for timestamp, cumulative depth, or incremental
  depth columns.
- **Atlas 14 iso-lines missing** – The contour preview appears only after a table is loaded. Verify that the
  NOAA fetch succeeded (status text under the refresh button) and that JavaScript errors are not preventing
  Plotly from rendering.

## Known Limitations

- Atlas 14 requests depend on the public AllOrigins proxy when deployed statically. If the proxy is down
  there is currently no automatic fallback.
- Temporal distributions are not circularly shifted. Rotating a curve must be done manually before
  importing a custom CSV.
- The project does not yet include automated regression tests for cumulative depth scaling—additions are
  welcome.

## Development Reminders

- Run `npm test` and `npx svelte-check` before opening a pull request.
- Update the README and help modal whenever distribution presets, exports, or NOAA integration behaviour
  changes so end-user documentation stays accurate.
