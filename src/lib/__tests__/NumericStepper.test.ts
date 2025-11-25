import { render, fireEvent } from '@testing-library/svelte'
import { describe, expect, it } from 'vitest'
import NumericStepper from '../components/NumericStepper.svelte'

const withinRange = (values: number[], min: number, max: number) => {
  expect(Math.min(...values)).toBeGreaterThanOrEqual(min)
  expect(Math.max(...values)).toBeLessThanOrEqual(max)
}

describe('NumericStepper', () => {
  it('keeps emitted values within the provided bounds', async () => {
    const min = 1
    const max = 10
    const changeEvents: number[] = []

    const { component, getByRole } = render(NumericStepper, {
      props: { value: 9, min, max }
    })

    component.$on('change', (event) => {
      changeEvents.push(event.detail.value)
    })

    const input = getByRole('spinbutton') as HTMLInputElement

    // Arrow up to the upper bound
    await fireEvent.keyDown(input, { key: 'ArrowUp' })
    await fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input.value).toBe('10')

    // Arrow down past the lower bound
    for (let i = 0; i < 15; i += 1) {
      await fireEvent.keyDown(input, { key: 'ArrowDown' })
    }
    expect(input.value).toBe('1')

    // Clear the input and blur to trigger defaulting to the minimum
    input.value = ''
    await fireEvent.input(input)
    await fireEvent.blur(input)
    expect(input.value).toBe('1')

    withinRange(changeEvents, min, max)
  })
})
