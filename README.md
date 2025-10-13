# Design Storm Web (TypeScript + Svelte)

Design Storm Web is a GitHub Pages–ready, client-only tool for hydrologists and stormwater
modelers. It combines live NOAA Atlas 14 precipitation tables with a library of temporal
patterns so you can generate design-storm hyetographs, visualize cumulative and intensity
plots, and export the results as CSV or PCSWMM-compatible DAT files.

## Key Features

- Interactive Leaflet map with NOAA Atlas 14 depth lookup by latitude/longitude.
- Support for SCS Types I/IA/II/III, Huff quartiles, beta-based distributions, and
  user-supplied cumulative depth curves.
- Side-by-side cumulative and intensity charts powered by Plotly.js.
- CSV export with tabular precipitation data and DAT export using PCSWMM's
  intensity units (in/hr).
- 100% client-side—no backend services to deploy or maintain.

## Tech Stack

- [Svelte](https://svelte.dev/) + [Vite](https://vitejs.dev/) + TypeScript
- [Leaflet](https://leafletjs.com/) with OpenStreetMap tiles
- [Plotly.js](https://plotly.com/javascript/) for chart rendering

## Getting Started

### Prerequisites

- Node.js 18+ (Node 22 LTS recommended to match the CI configuration)
- npm 9+

### Install and Run the Dev Server

```bash
npm install
npm run dev
```

By default Vite serves the app at http://localhost:5173. The dev server automatically proxies
requests from `/noaa-api/fe_text_mean.csv` to NOAA's Atlas 14 service, so live precipitation
tables are available without additional setup.

### Run Tests and Type Checks

```bash
npm test       # Vitest unit tests
npx svelte-check
```

## Data Sources & Exports

### NOAA Atlas 14 Integration

The app retrieves NOAA Atlas 14 **mean** rainfall depth tables from `fe_text_mean.csv`:

```
https://hdsc.nws.noaa.gov/cgi-bin/new/fe_text_mean.csv?data=depth&lat=<lat>&lon=<lon>&series=pds&units=english
```

- **Development**: `/noaa-api/fe_text_mean.csv` is configured as a Vite proxy target in
  `vite.config.ts`, keeping the browser requests same-origin.
- **Production**: Requests are wrapped in
  `https://api.allorigins.win/raw?url=<encoded NOAA URL>` to avoid CORS issues on GitHub Pages.

If the public proxy is unavailable, data fetches will fail gracefully and no table rows will
populate. Users can still enter depths manually or retry once the proxy is back online.

### Temporal Patterns

SCS storm types rely on NRCS dimensionless cumulative rainfall tables that are resampled to the
selected storm duration. Huff quartiles and additional presets use parameterized Beta(α,β)
distributions on [0, 1]. Custom temporal patterns can be loaded from CSV files containing time and
cumulative fraction columns; the curve is normalized and resampled before intensities are derived.

### Export Formats

- **CSV** – Includes timestamp (if requested), cumulative depth, incremental depth, and intensity.
- **DAT** – Encodes intensities only and always exports in inches per hour to align with PCSWMM's
  expectations.

## Deploying to GitHub Pages

1. Create a repository on GitHub (for example, `design-storm-web`).
2. In `vite.config.ts`, set `base` to `"/<repo-name>/"` (for example, `"/design-storm-web/"`).
3. Push to GitHub and enable Pages on the repository (Source: GitHub Actions).
4. Add the workflow below as `.github/workflows/deploy.yml`:

```yaml
name: Deploy to GitHub Pages
on:
  push:
    branches: [ main ]
  workflow_dispatch:
permissions:
  contents: read
  pages: write
  id-token: write
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - run: npm ci
      - run: npm run build
      - uses: actions/upload-pages-artifact@v3
        with:
          path: dist
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

## Contributing

Open an issue or submit a pull request for enhancements. When reporting bugs, include:

- The location (lat/lon) and storm settings you were using
- Browser and operating system details
- Console/network errors from the developer tools, if available

## License

MIT
