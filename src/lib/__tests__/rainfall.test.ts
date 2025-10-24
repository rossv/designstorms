import { describe, it, expect } from 'vitest'
import { interpolateAriFromDepth, interpolateDepthFromAri } from '../rainfall'
import type { NoaaTableRow } from '../noaaClient'

const sampleRow: NoaaTableRow = {
  label: '24-hr',
  values: {
    '1': 2,
    '2': 3,
    '5': 4
  }
}

const aris = ['1', '2', '5']

describe('interpolateAriFromDepth', () => {
  it('extrapolates below the table minimum depth', () => {
    const result = interpolateAriFromDepth(sampleRow, 1, aris)
    expect(result).not.toBeNull()
    expect(result?.ari).toBeCloseTo(0)
    expect(result?.extrapolated).toBe(true)
    expect(result?.highlight).toEqual([
      { duration: '24-hr', ari: '1' },
      { duration: '24-hr', ari: '2' }
    ])
  })

  it('extrapolates above the table maximum depth', () => {
    const result = interpolateAriFromDepth(sampleRow, 5, aris)
    expect(result).not.toBeNull()
    expect(result?.ari).toBeCloseTo(8)
    expect(result?.extrapolated).toBe(true)
    expect(result?.highlight).toEqual([
      { duration: '24-hr', ari: '2' },
      { duration: '24-hr', ari: '5' }
    ])
  })
})

describe('interpolateDepthFromAri', () => {
  it('extrapolates below the table minimum ARI', () => {
    const result = interpolateDepthFromAri(sampleRow, 0.5, aris)
    expect(result).not.toBeNull()
    expect(result?.depth).toBeCloseTo(1.5)
    expect(result?.extrapolated).toBe(true)
    expect(result?.highlight).toEqual([
      { duration: '24-hr', ari: '1' },
      { duration: '24-hr', ari: '2' }
    ])
  })

  it('extrapolates above the table maximum ARI', () => {
    const result = interpolateDepthFromAri(sampleRow, 10, aris)
    expect(result).not.toBeNull()
    expect(result?.depth).toBeCloseTo(5.6666667)
    expect(result?.extrapolated).toBe(true)
    expect(result?.highlight).toEqual([
      { duration: '24-hr', ari: '2' },
      { duration: '24-hr', ari: '5' }
    ])
  })
})
