export interface NoaaTableRow {
  label: string
  values: Record<string, number>
}
export interface NoaaTable {
  aris: string[]
  rows: NoaaTableRow[]
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

async function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

async function fetchWithBackoff(
  url: string,
  label: string,
  retries: number,
  baseDelayMs: number
): Promise<string> {
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const attemptNumber = attempt + 1
    try {
      const resp = await fetch(url)
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}${resp.statusText ? ` ${resp.statusText}` : ''}`)
      }
      return await resp.text()
    } catch (err) {
      lastError = err
      if (attempt < retries) {
        const delay = baseDelayMs * 2 ** attempt
        console.warn(
          `${label} attempt ${attemptNumber} failed (${formatError(err)}). Retrying in ${delay} ms...`
        )
        await sleep(delay)
      }
    }
  }

  throw new Error(`${label} failed after ${retries + 1} attempts. Last error: ${formatError(lastError)}`)
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

  const retries = 2
  const baseDelayMs = 500
  const proxyLabel = `Proxy NOAA endpoint (${fetchUrl})`
  const directLabel = `Direct NOAA endpoint (${noaaApiUrl})`

  let txt: string
  let proxyErrorMessage: string | null = null

  try {
    txt = await fetchWithBackoff(fetchUrl, proxyLabel, retries, baseDelayMs)
  } catch (proxyError) {
    // Docs: issue_report.md notes that we retry the proxy before falling back to the direct NOAA endpoint.
    proxyErrorMessage = formatError(proxyError)
    console.warn(
      `${proxyLabel} failed after retries. Falling back to direct NOAA URL. Reason: ${proxyErrorMessage}`
    )
    try {
      txt = await fetchWithBackoff(noaaApiUrl, directLabel, retries, baseDelayMs)
    } catch (directError) {
      const directErrorMessage = formatError(directError)
      throw new Error(
        `${directErrorMessage}. Proxy fallback previously failed with: ${proxyErrorMessage ?? 'unknown error'}`
      )
    }
  }

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

    const nums = (match[2].match(/[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g) ?? []).map(Number);
    const values: Record<string, number> = {};
    for (let i = 0; i < aris.length; i += 1) {
      const val = nums[i];
      values[aris[i]] = Number.isFinite(val) ? val : Number.NaN;
    }
    rows.push({ label, values });
  }

  if (rows.length === 0) return null;
  return { aris, rows };
}
