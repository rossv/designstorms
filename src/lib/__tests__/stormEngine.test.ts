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

  it('normalizes custom curves that do not end at 1', () => {
    const storm = generateStorm({
      depthIn: 1,
      durationHr: 1,
      timestepMin: 30,
      distribution: 'user',
      customCurveCsv: '0,0\n0.5,0.4\n1,0.8'
    })

    expect(storm.cumulativeIn).toEqual([
      0,
      0.5,
      1
    ])
    expect(storm.incrementalIn).toEqual([
      0,
      0.5,
      0.5
    ])
    expect(storm.intensityInHr).toEqual([
      0,
      1,
      1
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

  it('uses the closest available SCS data for Type I when shorter durations are requested', () => {
    const storm = generateStorm({
      depthIn: 1,
      durationHr: 6,
      timestepMin: 60,
      distribution: 'scs_type_i',
      customCurveCsv: '',
      durationMode: 'custom'
    })

    const increments = storm.incrementalIn.slice(1)
    const first = increments[0] ?? 0
    const allEqual = increments.every((value) => Math.abs(value - first) < 1e-6)
    expect(allEqual).toBe(false)
  })

  it('uses the closest available SCS data for Type IA when shorter durations are requested', () => {
    const storm = generateStorm({
      depthIn: 1,
      durationHr: 6,
      timestepMin: 60,
      distribution: 'scs_type_ia',
      customCurveCsv: '',
      durationMode: 'custom'
    })

    const increments = storm.incrementalIn.slice(1)
    const first = increments[0] ?? 0
    const allEqual = increments.every((value) => Math.abs(value - first) < 1e-6)
    expect(allEqual).toBe(false)
  })
})
