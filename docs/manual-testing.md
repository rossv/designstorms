# Manual testing

## Duration dropdown regenerates storms
1. Load the app and ensure a NOAA table is loaded (any location works).
2. Switch between the 6-, 12-, and 24-hour duration presets while keeping the same ARI.
3. Observe that the hyetograph plot updates each time to match the selected duration and depth, without retaining the previous curve shape.

This confirms the regression where the plots previously failed to refresh when the Duration dropdown provided string values.

