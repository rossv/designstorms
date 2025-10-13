import { describe, expect, it } from 'vitest'
import { formatPcswmmDat } from '../export'
import type { StormResult } from '../types'

describe('formatPcswmmDat', () => {
  it('respects explicit timezone offsets when formatting rows', () => {
    const storm: StormResult = {
      timeMin: [0, 5, 10],
      incrementalIn: [0.1, 0.2, 0.3],
      cumulativeIn: [0.1, 0.3, 0.6],
      intensityInHr: [1.2345678, 0.5, 0.25]
    }

    const txt = formatPcswmmDat(storm, 5, 'Gauge', '2024-01-01T00:00:00-05:00')
    const lines = txt.trim().split('\n')
    const dataLines = lines.slice(2)
    expect(dataLines).toHaveLength(storm.intensityInHr.length)

    const [firstLine, secondLine] = dataLines
    const [, ...firstParts] = firstLine.split('\t')
    const [, ...secondParts] = secondLine.split('\t')

    expect(firstParts.slice(0, 5)).toEqual(['2024', '1', '1', '0', '0'])
    expect(secondParts.slice(0, 5)).toEqual(['2024', '1', '1', '0', '5'])
  })
})
