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

  it('ignores a leading empty value so ARIs stay aligned', () => {
    const sample = `
Station: Example
Duration Header: ARI (years) 1 2 5
5-min:, 0.374,0.437,0.540
`

    const result = parseNoaaTable(sample)
    expect(result).not.toBeNull()
    const row = result?.rows.find((r) => r.label === '5-min')

    expect(row?.values['1']).toBe(0.374)
    expect(row?.values['2']).toBe(0.437)
    expect(row?.values['5']).toBe(0.540)
  })
})

describe('duration label conversions', () => {
  it('converts year-based durations to hours', () => {
    expect(toHours('10-year')).toBeCloseTo(10 * 24 * 365)
    expect(toHours('0.5 yr')).toBeCloseTo(0.5 * 24 * 365)
  })
})
