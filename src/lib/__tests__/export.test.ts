import { describe, expect, it, vi } from 'vitest'
import { formatPcswmmDat, saveCsv } from '../export'
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

  it('uses actual storm sample times when the final interval is shorter', () => {
    const storm: StormResult = {
      timeMin: [0, 7, 14, 21, 28, 35, 42, 49, 56, 60],
      incrementalIn: Array(10).fill(0.1),
      cumulativeIn: Array.from({ length: 10 }, (_, i) => (i + 1) * 0.1),
      intensityInHr: Array(10).fill(1)
    }

    const txt = formatPcswmmDat(storm, 7, 'Gauge', '2024-01-01T00:00:00Z')
    const lines = txt.trim().split('\n').slice(2)
    const lastLine = lines[lines.length - 1]
    const [, year, month, day, hour, minute] = lastLine.split('\t')
    expect([year, month, day, hour, minute]).toEqual(['2024', '1', '1', '1', '0'])
  })
})

describe('saveCsv', () => {
  async function captureCsvText(storm: StormResult, startISO?: string) {
    const originalDocument = globalThis.document
    const appendChild = vi.fn()
    const anchor = {
      href: '',
      download: '',
      click: vi.fn(),
      remove: vi.fn()
    }
    const mockDocument = {
      createElement: vi.fn(() => anchor),
      body: { appendChild }
    } as unknown as Document
    ;(globalThis as unknown as { document: Document }).document = mockDocument

    const createUrlSpy = vi
      .spyOn(URL, 'createObjectURL')
      .mockImplementation(() => 'blob:mock')
    const revokeUrlSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    saveCsv(storm, 'out.csv', startISO)

    expect(createUrlSpy).toHaveBeenCalledTimes(1)
    const blob = createUrlSpy.mock.calls[0]?.[0]
    if (!(blob instanceof Blob)) {
      throw new Error('CSV export did not create a Blob')
    }
    const text = await blob.text()

    await new Promise((resolve) => setTimeout(resolve, 0))

    createUrlSpy.mockRestore()
    revokeUrlSpy.mockRestore()
    if (originalDocument) {
      ;(globalThis as unknown as { document: Document }).document = originalDocument
    } else {
      delete (globalThis as { document?: Document }).document
    }

    return text
  }

  it('exports CSV without timestamps when no start time is provided', async () => {
    const storm: StormResult = {
      timeMin: [0, 5],
      incrementalIn: [0.1, 0.2],
      cumulativeIn: [0.1, 0.3],
      intensityInHr: [0, 2.4],
      effectiveTimestepMin: 5,
      timestepLocked: false
    }

    const csv = await captureCsvText(storm)
    const lines = csv.trim().split('\n')

    expect(lines[0]).toBe('time_min,incremental_in,cumulative_in,intensity_in_hr')
    expect(lines[1]).toBe('0.00000,0.10000,0.10000,0.00000')
    expect(lines[2]).toBe('5.00000,0.20000,0.30000,2.40000')
  })

  it('includes ISO timestamps when a start time is present', async () => {
    const storm: StormResult = {
      timeMin: [0, 5],
      incrementalIn: [0.1, 0.2],
      cumulativeIn: [0.1, 0.3],
      intensityInHr: [0, 2.4],
      effectiveTimestepMin: 5,
      timestepLocked: false
    }

    const csv = await captureCsvText(storm, '2024-01-01T00:00:00Z')
    const lines = csv.trim().split('\n')

    expect(lines[0]).toBe('timestamp_iso,time_min,incremental_in,cumulative_in,intensity_in_hr')
    expect(lines[1]).toBe('2024-01-01T00:00:00.000Z,0.00000,0.10000,0.10000,0.00000')
    expect(lines[2]).toBe('2024-01-01T00:05:00.000Z,5.00000,0.20000,0.30000,2.40000')
  })
})
