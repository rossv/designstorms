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
    const dataLine = lines[3]
    const [, year, month, day, hour, minute] = dataLine.split('\t')
    expect([year, month, day, hour, minute]).toEqual(['2024', '1', '1', '0', '5'])
  })

  it('uses the provided storm times when formatting rows', () => {
    const storm: StormResult = {
      timeMin: [0, 15, 30, 37],
      incrementalIn: [0.1, 0.1, 0.1, 0.1],
      cumulativeIn: [0.1, 0.2, 0.3, 0.4],
      intensityInHr: [1, 1, 1, 1]
    }

    const txt = formatPcswmmDat(storm, 15, 'Gauge', '2024-01-01T00:00:00Z')
    const lines = txt.trim().split('\n').slice(2)
    const lastLine = lines[lines.length - 1]
    const [, year, month, day, hour, minute] = lastLine.split('\t')
    expect([year, month, day, hour, minute]).toEqual(['2024', '1', '1', '0', '37'])
  })
})
