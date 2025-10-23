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
    const dataLine = lines[2]
    const [, year, month, day, hour, minute] = dataLine.split('\t')
    expect([year, month, day, hour, minute]).toEqual(['2024', '1', '1', '0', '5'])
  })

  it('uses the actual final sample time when the last interval is shortened', () => {
    const storm: StormResult = {
      timeMin: [0, 7, 14, 21, 28, 35, 42, 49, 56, 60],
      incrementalIn: Array(10).fill(0.1),
      cumulativeIn: Array.from({ length: 10 }, (_, idx) => (idx + 1) * 0.1),
      intensityInHr: Array(10).fill(0.5)
    }

    const txt = formatPcswmmDat(storm, 7, 'Gauge', '2024-01-01T00:00:00-05:00')
    const lines = txt.trim().split('\n')
    const dataLines = lines.slice(2)
    expect(dataLines).toHaveLength(storm.intensityInHr.length)

    const lastLine = dataLines.at(-1) ?? ''
    const [, year, month, day, hour, minute] = lastLine.split('\t')
    expect([year, month, day, hour, minute]).toEqual(['2024', '1', '1', '1', '0'])
  })
})
