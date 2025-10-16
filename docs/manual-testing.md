# Manual testing

## Duration dropdown regenerates storms
1. Load the app and ensure a NOAA table is loaded (any location works).
2. Switch between the 6-, 12-, and 24-hour duration presets while keeping the same ARI.
3. After each switch, confirm the hyetograph rescales to the new duration (e.g., the horizontal axis ends at 6 hr when "6-hr" is selected) and the bar pattern matches the updated storm shape rather than the previous duration.

This confirms the regression where the plots previously failed to refresh when the Duration dropdown provided string values.

## Distribution comparison modal lists normalized curves
1. Load the app and choose each SCS and Huff preset.
2. Click **Compare Distributions**.
3. Confirm the modal plots cumulative rain fraction curves for the selected group and that switching the duration buttons (6-, 12-, 24-hr) updates both the plot and the table values beneath it.

## Custom curve import resamples to match duration
1. Click **Add Custom Curve** and paste a short normalized CSV (e.g., `0,0`, `0.5,0.3`, `1,1`).
2. Save the curve and switch between Standard and Custom duration modes.
3. Verify that the preview reflects the uploaded CSV and that the hyetograph updates when the duration changes, confirming the curve is being normalized and resampled.

