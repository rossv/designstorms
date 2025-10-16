# Manual testing

## Duration dropdown regenerates storms
1. Load the app and ensure a NOAA table is loaded (any location works).
2. Switch between the 6-, 12-, and 24-hour duration presets while keeping the same ARI.
3. After each switch, confirm the hyetograph rescales to the new duration (e.g., the horizontal axis ends at 6 hr when "6-hr" is selected) and the bar pattern matches the updated storm shape rather than the previous duration.

This confirms the regression where the plots previously failed to refresh when the Duration dropdown provided string values.

