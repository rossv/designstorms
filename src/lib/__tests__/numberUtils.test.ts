import { describe, expect, it } from 'vitest'
import { snapValueToStep } from '../numberUtils'

describe('snapValueToStep', () => {
  it('snaps values using the provided step relative to the minimum anchor', () => {
    expect(snapValueToStep(3.14, 0.5, { min: 0 })).toBeCloseTo(3.0, 10)
    expect(snapValueToStep(3.26, 0.5, { min: 0 })).toBeCloseTo(3.5, 10)
    expect(snapValueToStep(0.18, 0.25, { min: 0.1 })).toBeCloseTo(0.1, 10)
  })

  it('preserves repeating decimal steps such as one-minute storm durations', () => {
    const minuteStep = 1 / 60
    const fiveMinutes = 5 / 60
    const sevenMinutes = 7 / 60

    expect(snapValueToStep(0.083333333, minuteStep, { min: 0 })).toBeCloseTo(
      fiveMinutes,
      10
    )
    expect(snapValueToStep(0.116666666, minuteStep, { min: 0 })).toBeCloseTo(
      sevenMinutes,
      10
    )
  })

  it('returns the original value when the step is invalid', () => {
    expect(snapValueToStep(1.25, Number.NaN, { min: 0 })).toBe(1.25)
    expect(snapValueToStep(1.25, 0, { min: 0 })).toBe(1.25)
  })
})
