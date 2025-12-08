export interface NoaaTableRow {
  label: string
  values: Record<string, number>
}
export interface NoaaTable {
  aris: string[]
  rows: NoaaTableRow[]
}

export async function fetchNoaaTable(lat: number, lon: number): Promise<string> {
  // NOAA Atlas 14 publishes the mean rainfall depth table at fe_text_mean.csv.
  const noaaApiUrl = `https://hdsc.nws.noaa.gov/cgi-bin/new/fe_text_mean.csv?data=depth&lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}&series=pds&units=english`;

  let fetchUrl = '';

  if (import.meta.env.DEV) {
    // In development, use the local proxy path from vite.config.ts.
    fetchUrl = `/noaa-api/fe_text_mean.csv?data=depth&lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}&series=pds&units=english`;
  } else {
    // In production (GitHub Pages), use a public CORS proxy.
    fetchUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(noaaApiUrl)}`;
  }

  const resp = await fetch(fetchUrl);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: Failed to fetch`);
  const txt = await resp.text();

  if (import.meta.env.DEV) {
    console.log("Raw NOAA Data:", txt);
  }

  return txt;
}

const DURATION_RE =
  /^(\d+(?:\.\d+)?)\s*[- ]\s*(min|minute|minutes|hr|hour|hours|day|days|yr|yrs|year|years)\s*:?$/i;

export function parseNoaaTable(txt: string): NoaaTable | null {
  const lines = txt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const header = lines.find((line) => line.includes('ARI (years)'));
  if (!header) return null;
  const headerTail = header.split('ARI (years)').pop() ?? '';
  const aris = (headerTail.match(/\b\d+\b/g) ?? []).map((ari) => ari);
  if (aris.length === 0) return null;

  const rows: NoaaTableRow[] = [];
  for (const line of lines) {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    const label = match[1].trim().replace(/:+$/, '');
    if (!DURATION_RE.test(label)) continue;

    const rawValues = match[2];
    const usesComma = rawValues.includes(',');

    let parts = rawValues.split(',').map((p) => p.trim());

    if (usesComma) {
      // Some rows include a leading comma (e.g., "5-min:, 0.374,0.437,0.540"),
      // which would otherwise shift the ARI alignment and produce NaN for the
      // first value. Drop the leading empty entry so the numeric depths align.
      if (parts.length > aris.length && parts[0] === '') {
        parts = parts.slice(1);
      }
    } else {
      // When values are space-separated (or mixed with comments), extract the
      // numeric tokens directly without letting extra text shift the columns.
      parts = rawValues.match(/-?\d+(?:\.\d+)?/g) ?? [];
    }
    const values: Record<string, number> = {};

    // We expect the number of comma-separated values to match the number of ARIs.
    // Missing or empty entries are treated as NaN without shifting columns.
    for (let i = 0; i < aris.length; i += 1) {
      const raw = parts[i];
      const val = raw ? Number(raw) : Number.NaN;
      values[aris[i]] = Number.isFinite(val) ? val : Number.NaN;
    }
    rows.push({ label, values });
  }

  if (rows.length === 0) return null;
  return { aris, rows };
}
