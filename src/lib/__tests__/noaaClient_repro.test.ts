import { describe, expect, it } from 'vitest'
import { parseNoaaTable } from '../noaaClient'

describe('NOAA table parsing reproduction', () => {
    it('incorrectly parses rows with extra numeric-like text', () => {
        const sample = `
Station: Example
Duration Header: ARI (years) 2 10
10-year: 1.1 2.2 (Note: 3.3 is not data)
`
        // The current regex might pick up 3.3 as a value if it blindly extracts numbers
        const result = parseNoaaTable(sample)
        expect(result).not.toBeNull()
        const row = result?.rows.find(r => r.label === '10-year')
        // If it picks up 3.3, it might assign it to a column or ignore it if columns are fixed
        // But if columns are dynamic or if it shifts data, it's bad.
        // The code:
        // const nums = (match[2].match(...) ?? []).map(Number);
        // values[aris[i]] = nums[i]

        // If aris has 2 items (2, 10), it expects 2 numbers.
        // If nums has 3 numbers (1.1, 2.2, 3.3), it takes the first 2.
        // So 1.1 and 2.2. This seems fine actually, unless the extra number is at the start.

        expect(row?.values['2']).toBe(1.1)
        expect(row?.values['10']).toBe(2.2)
    })

    it('fails if comments appear before data', () => {
        const sample = `
Station: Example
Duration Header: ARI (years) 2 10
10-year: (est. 1.1) 2.2
`
        // Regex might pick up 1.1 and 2.2.
        // If text is "est 1.1", regex finds 1.1.
        // Seems robust enough for simple comments?

        const result = parseNoaaTable(sample)
        const row = result?.rows.find(r => r.label === '10-year')
        expect(row?.values['2']).toBe(1.1)
        expect(row?.values['10']).toBe(2.2)
    })

    it('fails if scientific notation is used weirdly', () => {
        // NOAA data is usually simple floats.
    })

    it('handles leading commas in data rows (repro missing 1-year)', () => {
        const sample = `
Station: Example
Duration Header: ARI (years) 1 2 5
5-min:, 0.374,0.437,0.540
`
        const result = parseNoaaTable(sample)
        expect(result).not.toBeNull()
        const row = result?.rows.find(r => r.label === '5-min')

        // The bug is that the leading comma causes the first value to be parsed as NaN or empty
        // and the values shift or are just wrong.
        // With the bug, row?.values['1'] might be NaN or undefined

        expect(row?.values['1']).toBe(0.374)
        expect(row?.values['2']).toBe(0.437)
        expect(row?.values['5']).toBe(0.540)
    })
})
