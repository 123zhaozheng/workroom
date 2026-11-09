# Stats research notes (round 4)

- Chart library: ECharts has calendar/heatmap/scatter built in but is ~400 KB+ even tree-shaken and brings its own theming; the repo already depends on Recharts (lazy). Decision: Recharts for area / donut / histogram, custom SVG for calendar heatmap, punch card, waffle and sparklines (no new dependency; tokens, dark mode and a11y handled in one place). Details: docs/ui.md §10.
- Palette: reference categorical palette (8 slots) from the dataviz skill; `validate_palette.js` run for light and dark: all gates PASS (adjacent CVD dE 9.1 light / 8.4 dark, normal-vision floor 19.6 / 19.3, dark contrast >= 3:1). Three light slots are < 3:1 contrast, so every series has a text legend with values and a tooltip. Sequential heat colours are one hue (blue), quantile-binned; status colours are the fixed status set and always have a text legend.
- Calendar / punch card level thresholds are data quantiles (25/50/75/92 %), shown in the legend tooltip, so a few busy days do not wash out everything else.
- Percentile definition: nearest rank. Success rate excludes cancelled / awaiting / in-progress from the denominator so a user pressing stop is not counted as a model failure.
- Time zones: bucketing is done in SQLite with `strftime(..., '+N minutes')`; week buckets start Monday (`date(x, '-6 days', 'weekday 1')`).
