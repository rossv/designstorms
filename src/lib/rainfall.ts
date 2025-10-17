import type { NoaaTable, NoaaTableRow } from './noaaClient'

export interface InterpolationCell {
  duration: string
  ari: string
}

interface RowPoint {
  key: string
  ari: number
  depth: number
}

export interface AriInterpolationResult {
  ari: number
  highlight: InterpolationCell[] | null
}

export interface DepthInterpolationResult {
  depth: number
  highlight: InterpolationCell[] | null
}

export interface DurationInterpolationResult {
  ari: number
  label: string | null
  highlight: InterpolationCell[] | null
}

export function toHours(label: string): number {
  const normalized = label.trim().toLowerCase()
  const value = Number.parseFloat(normalized)
  if (!Number.isFinite(value)) {
    return Number.NaN
  }
  if (normalized.includes('min')) {
    return value / 60
  }
  if (normalized.includes('year') || normalized.includes('yr')) {
    return value * 24 * 365
  }
  if (normalized.includes('hr') || normalized.includes('hour')) {
    return value
  }
  return value * 24
}

function getRowPoints(row: NoaaTableRow, aris: string[]): RowPoint[] {
  return aris
    .map((key) => ({
      key,
      ari: Number.parseFloat(key),
      depth: row.values[key]
    }))
    .filter((pt) => Number.isFinite(pt.ari) && Number.isFinite(pt.depth))
    .sort((a, b) => a.ari - b.ari)
}

export function getSortedDurationRows(
  table: NoaaTable,
): { hr: number; label: string; row: NoaaTableRow }[] {
  return table.rows
    .map((row) => ({ hr: toHours(row.label), label: row.label, row }))
    .filter((entry) => Number.isFinite(entry.hr))
    .sort((a, b) => a.hr - b.hr)
}

export function findClosestRow(
  table: NoaaTable,
  durationHr: number,
): { row: NoaaTableRow | null; label: string | null } {
  if (!Number.isFinite(durationHr)) {
    return { row: null, label: null }
  }

  let bestRow: NoaaTableRow | null = null
  let bestLabel: string | null = null
  let bestDiff = Number.POSITIVE_INFINITY

  for (const row of table.rows) {
    const hours = toHours(row.label)
    if (!Number.isFinite(hours)) continue
    const diff = Math.abs(hours - durationHr)
    if (diff < bestDiff) {
      bestDiff = diff
      bestRow = row
      bestLabel = row.label
    }
  }

  return { row: bestRow, label: bestLabel }
}

export function getRowForCalculation(
  table: NoaaTable,
  durationHr: number,
  preferredLabel: string | null = null,
): { row: NoaaTableRow | null; label: string | null } {
  if (preferredLabel) {
    const existing = table.rows.find((row) => row.label === preferredLabel)
    if (existing) {
      return { row: existing, label: existing.label }
    }
  }
  return findClosestRow(table, durationHr)
}

export function interpolateAriFromDepth(
  row: NoaaTableRow,
  targetDepth: number,
  aris: string[],
): AriInterpolationResult | null {
  const points = getRowPoints(row, aris)
  if (!points.length || !Number.isFinite(targetDepth)) {
    return null
  }

  if (targetDepth <= points[0].depth) {
    return { ari: points[0].ari, highlight: null }
  }

  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i]
    const b = points[i + 1]
    const low = Math.min(a.depth, b.depth)
    const high = Math.max(a.depth, b.depth)

    if (targetDepth >= low && targetDepth <= high) {
      const span = b.depth - a.depth
      if (Math.abs(span) < 1e-9) {
        return { ari: b.ari, highlight: null }
      }

      const ratio = (targetDepth - a.depth) / span
      const interpolatedAri = a.ari + ratio * (b.ari - a.ari)
      const highlight =
        ratio > 0 && ratio < 1
          ? [
              { duration: row.label, ari: a.key },
              { duration: row.label, ari: b.key }
            ]
          : null

      return { ari: interpolatedAri, highlight }
    }
  }

  const last = points[points.length - 1]
  return { ari: last.ari, highlight: null }
}

export function interpolateDepthFromAri(
  row: NoaaTableRow,
  targetAri: number,
  aris: string[],
): DepthInterpolationResult | null {
  const points = getRowPoints(row, aris)
  if (!points.length || !Number.isFinite(targetAri)) {
    return null
  }

  if (targetAri <= points[0].ari) {
    return { depth: points[0].depth, highlight: null }
  }

  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i]
    const b = points[i + 1]
    if (targetAri >= a.ari && targetAri <= b.ari) {
      const span = b.ari - a.ari
      if (Math.abs(span) < 1e-9) {
        return { depth: b.depth, highlight: null }
      }

      const ratio = (targetAri - a.ari) / span
      const interpolatedDepth = a.depth + ratio * (b.depth - a.depth)
      const highlight =
        ratio > 0 && ratio < 1
          ? [
              { duration: row.label, ari: a.key },
              { duration: row.label, ari: b.key }
            ]
          : null

      return { depth: interpolatedDepth, highlight }
    }
  }

  const last = points[points.length - 1]
  return { depth: last.depth, highlight: null }
}

export function interpolateAriForDuration(
  table: NoaaTable,
  durationHr: number,
  depth: number,
  options: { preferredLabel?: string | null } = {},
): DurationInterpolationResult | null {
  if (!Number.isFinite(durationHr) || !Number.isFinite(depth)) {
    return null
  }

  const entries = getSortedDurationRows(table)
  if (!entries.length) {
    return null
  }

  const preferredLabel = options.preferredLabel ?? null
  if (preferredLabel) {
    const exact = entries.find((entry) => entry.label === preferredLabel)
    if (exact && Math.abs(exact.hr - durationHr) < 1e-6) {
      const result = interpolateAriFromDepth(exact.row, depth, table.aris)
      if (!result) return null
      return { ari: result.ari, label: exact.label, highlight: result.highlight }
    }
  }

  if (durationHr <= entries[0].hr) {
    const result = interpolateAriFromDepth(entries[0].row, depth, table.aris)
    if (!result) return null
    return { ari: result.ari, label: entries[0].label, highlight: result.highlight }
  }

  const lastEntry = entries[entries.length - 1]
  if (durationHr >= lastEntry.hr) {
    const result = interpolateAriFromDepth(lastEntry.row, depth, table.aris)
    if (!result) return null
    return { ari: result.ari, label: lastEntry.label, highlight: result.highlight }
  }

  for (let i = 0; i < entries.length - 1; i += 1) {
    const lower = entries[i]
    const upper = entries[i + 1]
    if (durationHr >= lower.hr && durationHr <= upper.hr) {
      const span = upper.hr - lower.hr
      if (span < 1e-6) {
        const fallback = interpolateAriFromDepth(upper.row, depth, table.aris)
        if (!fallback) return null
        return { ari: fallback.ari, label: upper.label, highlight: fallback.highlight }
      }

      const lowerResult = interpolateAriFromDepth(lower.row, depth, table.aris)
      const upperResult = interpolateAriFromDepth(upper.row, depth, table.aris)

      if (!lowerResult || !upperResult) {
        const fallback = lowerResult ?? upperResult
        if (!fallback) return null
        const fallbackLabel = lowerResult ? lower.label : upper.label
        return { ari: fallback.ari, label: fallbackLabel, highlight: fallback.highlight }
      }

      const ratio = (durationHr - lower.hr) / span
      const interpolatedAri = lowerResult.ari + ratio * (upperResult.ari - lowerResult.ari)

      const combinedHighlights = [
        ...(lowerResult.highlight ?? []),
        ...(upperResult.highlight ?? [])
      ]

      const uniqueHighlights = combinedHighlights.filter((cell, index, array) => {
        const key = `${cell.duration}:${cell.ari}`
        return (
          index === array.findIndex((candidate) => `${candidate.duration}:${candidate.ari}` === key)
        )
      })

      return {
        ari: interpolatedAri,
        label: ratio < 0.5 ? lower.label : upper.label,
        highlight: uniqueHighlights.length ? uniqueHighlights : null
      }
    }
  }

  return null
}
