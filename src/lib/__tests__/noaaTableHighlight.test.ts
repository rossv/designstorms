import { render } from '@testing-library/svelte'
import { describe, expect, it } from 'vitest'
import NoaaHighlightHarness from './NoaaHighlightHarness.svelte'

const sampleRow = {
  label: '24 hr',
  values: {
    '5': 1.5,
    '10': 2.0
  }
}

const aris = ['5', '10']

describe('NOAA table interpolation highlighting', () => {
  it('highlights the bounding cells when the ARI falls between table values', () => {
    const { container } = render(NoaaHighlightHarness, {
      props: {
        row: sampleRow,
        aris,
        targetAri: 7
      }
    })

    const lowerCell = container.querySelector('[data-ari="5"]')
    const upperCell = container.querySelector('[data-ari="10"]')

    expect(lowerCell?.classList.contains('interpolated')).toBe(true)
    expect(upperCell?.classList.contains('interpolated')).toBe(true)
  })
})
