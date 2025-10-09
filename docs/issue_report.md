# Issue Findings

## Typo Fix Task
- **Issue**: The help modal bullet list says "DAT always in in/hr," repeating "in" and reading awkwardly for users reviewing export guidance.
- **Proposed Task**: Update the help text so it explains the DAT export units without the duplicated word (for example, "DAT exports use in/hr").
- **Evidence**: `src/App.svelte` line 996 shows the duplicated wording in the help content.【F:src/App.svelte†L993-L999】

## Bug Fix Task
- **Issue**: `fetchNoaaTable` targets the `fe_text_mean.csv` endpoint even though the project documentation describes consuming `fe_text_depth.csv` for rainfall depths, so the app pulls the wrong NOAA table.
- **Proposed Task**: Change the NOAA request URL (including the dev proxy path) back to `fe_text_depth.csv` so the fetched data matches the documented depth dataset.
- **Evidence**: The README documents `fe_text_depth.csv` as the expected endpoint,【F:README.md†L59-L64】 but `src/lib/noaaClient.ts` currently hardcodes `fe_text_mean.csv` for both direct and proxied requests.【F:src/lib/noaaClient.ts†L10-L22】

## Documentation/Comment Discrepancy Task
- **Issue**: A comment in `fetchNoaaTable` asserts that `fe_text_mean.csv` is the correct endpoint even though the README cites `fe_text_depth.csv`, leaving contradictory guidance for contributors.
- **Proposed Task**: Rewrite or remove the comment so it aligns with the actual endpoint the app should call (and matches the README once the bug above is fixed).
- **Evidence**: The conflicting comment appears on line 11 of `src/lib/noaaClient.ts`, while the README references `fe_text_depth.csv` for the NOAA integration.【F:src/lib/noaaClient.ts†L10-L19】【F:README.md†L59-L64】

## Test Improvement Task
- **Issue**: The `generateStorm` tests verify total depth and timing but never assert that the incremental depths produced by SCS distributions sum to the requested storm depth, leaving room for regressions in the scaling logic.
- **Proposed Task**: Extend the "scales cumulative depth" test (or add a new one) to assert that the sum of `incrementalIn` equals the requested depth and that intensities remain non-negative.
- **Evidence**: `src/lib/__tests__/stormEngine.test.ts` lines 7-19 only check the final cumulative depth and time range without validating incremental totals or intensity sign constraints.【F:src/lib/__tests__/stormEngine.test.ts†L7-L19】
