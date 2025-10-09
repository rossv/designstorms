# Design Storm Web (TypeScript + Svelte)

A GitHub Pages–ready, client-only app to build design-storm hyetographs (SCS I/IA/II/III, Huff quartiles, user curves), fetch NOAA Atlas 14 depths live by lat/lon, visualize intensity/cumulative, and export CSV / PCSWMM DAT.

## Stack
- Svelte + Vite + TypeScript
- Leaflet (OSM tiles)
- Plotly.js for charts
- Pure client-side; zero backend

## Dev
```bash
npm i
npm run dev
```
Open http://localhost:5173

## Build & Deploy (GitHub Pages)
1. Create a repo on GitHub (e.g., `design-storm-web`).
2. In `vite.config.ts`, set `base` to `"/<repo-name>/"` (e.g., `"/design-storm-web/"`).
3. Push, then enable Pages on the repo (Source: GitHub Actions).
4. Add the workflow below at `.github/workflows/deploy.yml`.

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

## NOAA Atlas 14
The app calls NOAA's free-text CSV endpoint directly from the browser:
```
https://hdsc.nws.noaa.gov/cgi-bin/new/fe_text_depth.csv?data=depth&lat=<lat>&lon=<lon>&series=pds&units=english
```
If CORS ever breaks, add a manual "Download CSV" flow or a tiny proxy.

## License
MIT
