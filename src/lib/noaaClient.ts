export interface NoaaTableRow {
  label: string
  values: Record<string, number>
}
export interface NoaaTable {
  aris: string[]
  rows: NoaaTableRow[]
}

export async function fetchNoaaTable(lat: number, lon: number): Promise<string> {
  // Use the local proxy server
  const url = `/noaa-api/fe_text_depth.csv?data=depth&lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}&series=pds&units=english`
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  return await resp.text()
}

const DURATION_RE = /^(\d+(?:\.\d+)?)\s*[- ]\s*(min|minute|minutes|hr|hour|hours|day|days)\s*:?$/i

export function parseNoaaTable(txt: string): NoaaTable | null {
  const lines = txt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const header = lines.find((line) => line.includes('ARI (years)'))
  if (!header) return null
  const headerTail = header.split('ARI (years)').pop() ?? ''
  const aris = (headerTail.match(/\b\d+\b/g) ?? []).map((ari) => ari)
  if (aris.length === 0) return null

  const rows: NoaaTableRow[] = []
  for (const line of lines) {
    const match = line.match(/^([^:]+):\s*(.*)$/)
    if (!match) continue
    const label = match[1].trim().replace(/:+$/, '')
    if (!DURATION_RE.test(label)) continue

    const nums = (match[2].match(/[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g) ?? []).map(Number)
    const values: Record<string, number> = {}
    for (let i = 0; i < aris.length; i += 1) {
      const val = nums[i]
      values[aris[i]] = Number.isFinite(val) ? val : Number.NaN
    }
    rows.push({ label, values })
  }

  if (rows.length === 0) return null
  return { aris, rows }
}
