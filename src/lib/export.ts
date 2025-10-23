import type { StormResult } from './types'

export function saveCsv(
  storm: StormResult,
  filename = 'design_storm.csv',
  startISO?: string,
) {
  let includeTimestamp = false
  let startDate: Date | null = null

  if (startISO) {
    const parsed = new Date(startISO)
    if (!Number.isNaN(parsed.getTime())) {
      startDate = parsed
      includeTimestamp = true
    }
  }

  const headerColumns = includeTimestamp
    ? ['timestamp', 'time_min', 'incremental_in', 'cumulative_in', 'intensity_in_hr']
    : ['time_min', 'incremental_in', 'cumulative_in', 'intensity_in_hr']
  const header = `${headerColumns.join(',')}\n`

  const rows = storm.timeMin
    .map((t, i) => {
      const columns: string[] = []

      if (includeTimestamp && startDate) {
        const timestamp = new Date(startDate.getTime() + t * 60000)
        columns.push(formatTimestamp(timestamp))
      }

      columns.push(
        t.toFixed(5),
        storm.incrementalIn[i].toFixed(5),
        storm.cumulativeIn[i].toFixed(5),
        storm.intensityInHr[i].toFixed(5),
      )

      return columns.join(',')
    })
    .join('\n')

  downloadText(header + rows, filename)
}

function formatTimestamp(date: Date) {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const year = date.getFullYear()
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  return `${month}-${day}-${year} ${hour}:${minute}`
}

function parseTimezoneOffsetMinutes(value: string): number | null {
  const tzMatch = value.match(/(Z|[+-]\d{2}:?\d{2})$/)
  if (!tzMatch) return null
  const token = tzMatch[1]
  if (token === 'Z') return 0
  const sign = token[0] === '-' ? -1 : 1
  const hours = Number(token.slice(1, 3))
  const minutes = Number(token.slice(token.length - 2))
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null
  return sign * (hours * 60 + minutes)
}

export function formatPcswmmDat(
  storm: StormResult,
  timestepMin: number,
  gauge = 'System',
  startISO = '2003-01-01T00:00'
): string {
  const start = new Date(startISO)
  if (Number.isNaN(start.getTime())) {
    throw new Error('Invalid start date for PCSWMM export')
  }

  const explicitOffset = parseTimezoneOffsetMinutes(startISO)

  let txt = ';Rainfall (in/hr)\n;PCSWMM generated rain gauges file (please do not edit)\n'
  for (let i = 0; i < storm.intensityInHr.length; i++) {
    const tsEpoch = start.getTime() + storm.timeMin[i] * 60 * 1000
    const ts = new Date(tsEpoch)

    let y: number
    let mo: number
    let d: number
    let h: number
    let m: number

    if (explicitOffset !== null) {
      const localMs = tsEpoch + explicitOffset * 60 * 1000
      const local = new Date(localMs)
      y = local.getUTCFullYear()
      mo = local.getUTCMonth() + 1
      d = local.getUTCDate()
      h = local.getUTCHours()
      m = local.getUTCMinutes()
    } else {
      y = ts.getFullYear()
      mo = ts.getMonth() + 1
      d = ts.getDate()
      h = ts.getHours()
      m = ts.getMinutes()
    }

    txt += `${gauge}\t${y}\t${mo}\t${d}\t${h}\t${m}\t${storm.intensityInHr[i].toFixed(5)}\n`
  }
  return txt
}

export function savePcswmmDat(
  storm: StormResult,
  timestepMin: number,
  filename = 'design_storm.dat',
  gauge = 'System',
  startISO = '2003-01-01T00:00'
) {
  const txt = formatPcswmmDat(storm, timestepMin, gauge, startISO)
  downloadText(txt, filename)
}

function downloadText(text: string, filename: string) {
  const blob = new Blob([text], { type: 'text/plain' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  document.body.appendChild(a)
  a.click()
  setTimeout(() => {
    URL.revokeObjectURL(a.href)
    a.remove()
  }, 0)
}
