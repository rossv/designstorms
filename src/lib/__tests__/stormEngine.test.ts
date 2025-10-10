import { describe, expect, it } from 'vitest'
import { generateStorm } from '../stormEngine'

const minutes = (hrs: number) => hrs * 60

describe('generateStorm', () => {
  it('scales cumulative depth to requested total', () => {
    const storm = generateStorm({
      depthIn: 3.25,
      durationHr: 2,
      timestepMin: 30,
      distribution: 'scs_type_i',
      customCurveCsv: ''
    })

    expect(storm.cumulativeIn.at(-1)).toBeCloseTo(3.25, 6)
    expect(storm.timeMin[0]).toBe(0)
    expect(storm.timeMin.at(-1)).toBe(minutes(2))
    expect(storm.incrementalIn.reduce((sum, step) => sum + step, 0)).toBeCloseTo(3.25, 6)
    expect(storm.incrementalIn.every((step) => step >= 0)).toBe(true)
    expect(storm.intensityInHr.every((intensity) => intensity >= 0)).toBe(true)
  })

  it('interpolates custom user curve by timestep', () => {
    const storm = generateStorm({
      depthIn: 2,
      durationHr: 1,
      timestepMin: 15,
      distribution: 'user',
      customCurveCsv: '0,0\n1,1'
    })

    expect(storm.cumulativeIn).toEqual([
      0,
      0.5,
      1,
      1.5,
      2
    ])
    expect(storm.incrementalIn).toEqual([
      0,
      0.5,
      0.5,
      0.5,
      0.5
    ])
    expect(storm.intensityInHr).toEqual([
      0,
      2,
      2,
      2,
      2
    ])
  })

  it('clamps the final timestep and preserves totals when duration is not divisible', () => {
    const depthIn = 2
    const timestepMin = 7
    const durationMin = minutes(1)
    const storm = generateStorm({
      depthIn,
      durationHr: 1,
      timestepMin,
      distribution: 'scs_type_i',
      customCurveCsv: ''
    })

    expect(storm.timeMin.at(-1)).toBe(durationMin)
    expect(storm.timeMin.at(-2)).toBe(durationMin - (durationMin % timestepMin || timestepMin))

    const steps = storm.timeMin.slice(1).map((t, idx) => t - storm.timeMin[idx])
    expect(steps.at(-1)).toBeCloseTo(durationMin % timestepMin || timestepMin, 6)
    expect(steps.every((step) => step > 0 && step <= timestepMin)).toBe(true)

    expect(storm.cumulativeIn.at(-1)).toBeCloseTo(depthIn, 6)
    expect(storm.incrementalIn.reduce((sum, step) => sum + step, 0)).toBeCloseTo(depthIn, 6)

    const finalIncrement = storm.incrementalIn.at(-1) ?? 0
    const finalDuration = steps.at(-1) ?? 0
    const expectedFinalIntensity = finalDuration > 0 ? (finalIncrement / finalDuration) * 60 : 0
    expect(storm.intensityInHr.at(-1)).toBeCloseTo(expectedFinalIntensity, 6)
  })

  it('handles zero-duration storms without NaNs', () => {
    const storm = generateStorm({
      depthIn: 1,
      durationHr: 0,
      timestepMin: 5,
      distribution: 'scs_type_i',
      customCurveCsv: ''
    })

    expect(storm.timeMin).toEqual([0])
    expect(storm.cumulativeIn).toEqual([0])
    expect(storm.incrementalIn).toEqual([0])
    expect(storm.intensityInHr).toEqual([0])
  })

  it('falls back to an even distribution when user curve data is missing', () => {
    const storm = generateStorm({
      depthIn: 1.5,
      durationHr: 1,
      timestepMin: 20,
      distribution: 'user',
      customCurveCsv: ''
    })

    expect(storm.cumulativeIn.at(-1)).toBeCloseTo(1.5, 6)
    expect(storm.cumulativeIn).toEqual([
      0,
      0.5,
      1,
      1.5
    ])
    expect(storm.incrementalIn).toEqual([
      0,
      0.5,
      0.5,
      0.5
    ])
    expect(storm.intensityInHr).toEqual([
      0,
      1.5,
      1.5,
      1.5
    ])
  })

  it('clamps user-defined curves outside of provided points', () => {
    const storm = generateStorm({
      depthIn: 2,
      durationHr: 1,
      timestepMin: 15,
      distribution: 'user',
      customCurveCsv: '0.25,0\n0.75,1'
    })

    expect(storm.cumulativeIn[0]).toBe(0)
    expect(Math.min(...storm.cumulativeIn)).toBeGreaterThanOrEqual(0)
    expect(storm.cumulativeIn.at(-1)).toBeCloseTo(2, 6)
  })
})
