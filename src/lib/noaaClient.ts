export interface NoaaTableRow {
  label: string
  values: Record<string, number>
}
export interface NoaaTable {
  aris: string[]
  rows: NoaaTableRow[]
}

export async function fetchNoaaTable(lat: number, lon: number): Promise<string> {
  const url = `https://hdsc.nws.noaa.gov/cgi-bin/new/fe_text_depth.csv?data=depth&lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}&series=pds&units=english`
  const resp = await fetch(url, { headers: { 'User-Agent': 'design-storm-web' } })
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  return await resp.text()
}

export function parseNoaaTable(txt: string) /*: NoaaTable | null*/ {
  const lines = txt.split(/\r?\n/).map(l=>l.trim()).filter(Boolean)
  const header = lines.find(l => l.includes('ARI (years)'))
  if (!header) return null as any
  const aris = (header.split('ARI (years)')[1] || '').match(/\b\d+\b/g) || []
  if (aris.length === 0) return null as any
  const rows: NoaaTableRow[] = []
  for (const ln of lines) {
    const m = ln.match(/^([^,;:]+?)\s*[:,-]\s*(.*)$/)
    if (!m) continue
    const label = m[1].trim().replace(/:+$/,'')
    if (!/^\d+(?:\.\d+)?\s*(?:min|minutes|hr|hour|hours|day|days)$/i.test(label)) continue
    const nums = (m[2].match(/[-+]?\d*\.\d+|[-+]?\d+/g) || []).map(Number)
    const vals: Record<string, number> = {}
    for (let i=0;i<aris.length;i++) {
      vals[aris[i]] = Number.isFinite(nums[i]) ? nums[i] : NaN
    }
    rows.push({ label, values: vals })
  }
  if (rows.length === 0) return null as any
  return { aris, rows } as any
}
