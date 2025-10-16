import { describe, expect, it } from 'vitest'
import { getBestScsDistribution } from '../stormEngine'

describe('getBestScsDistribution fallback', () => {
  it('defaults Type I storms to 24hr tables when shorter durations requested', () => {
    const result6hr = getBestScsDistribution('scs_type_i', 6, 'custom')
    const result12hr = getBestScsDistribution('scs_type_i', 12, 'standard')

    expect(result6hr).toBe('scs_type_i_24hr')
    expect(result12hr).toBe('scs_type_i_24hr')
  })

  it('defaults Type IA storms to 24hr tables when shorter durations requested', () => {
    const result6hr = getBestScsDistribution('scs_type_ia', 6, 'custom')
    const result12hr = getBestScsDistribution('scs_type_ia', 12, 'standard')

    expect(result6hr).toBe('scs_type_ia_24hr')
    expect(result12hr).toBe('scs_type_ia_24hr')
  })
})
