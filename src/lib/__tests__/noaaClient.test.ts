import { describe, expect, it } from 'vitest'

import { parseNoaaTable } from '../noaaClient'
import { toHours } from '../rainfall'

describe('NOAA table parsing', () => {
  it('parses duration rows that include year units', () => {
    const sample = `
Station: Example
Duration Header: ARI (years) 2 10 25
10-year: 1.1 2.2 3.3
60-day: 4.4 5.5 6.6
`

    const result = parseNoaaTable(sample)
    expect(result).not.toBeNull()
    expect(result?.rows.map((row) => row.label)).toContain('10-year')
  })
})

describe('duration label conversions', () => {
  it('converts year-based durations to hours', () => {
    expect(toHours('10-year')).toBeCloseTo(10 * 24 * 365)
    expect(toHours('0.5 yr')).toBeCloseTo(0.5 * 24 * 365)
  })
})
