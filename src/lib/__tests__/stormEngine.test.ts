import { describe, expect, it } from 'vitest'
import { generateStorm, MAX_FAST_SAMPLES } from '../stormEngine'
import { SCS_TABLES } from '../distributions'

const minutes = (hrs: number) => hrs * 60
const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

function evaluateScsBaseline(
  table: number[],
  timeMin: number[],
  depthIn: number,
  durationHr: number
) {
  const durationMin = durationHr * 60
  const normalizedTimes = timeMin.map((t) =>
    clamp01(durationMin > 0 ? t / durationMin : 0)
  )
  const n = table.length
  const baselineNormalized = normalizedTimes.map((nt) => {
    if (n <= 1) {
      return table[0] ?? 0
    }
    const scaledIndex = clamp01(nt) * (n - 1)
    const lower = Math.floor(scaledIndex)
    const upper = Math.min(n - 1, lower + 1)
    const frac = upper === lower ? 0 : scaledIndex - lower
    const v0 = table[lower] ?? 0
    const v1 = table[upper] ?? v0
    return v0 * (1 - frac) + v1 * frac
  })

  const cumulative: number[] = []
  let last = 0
  for (let i = 0; i < baselineNormalized.length; i += 1) {
    const normalized = clamp01(baselineNormalized[i] ?? 0)
    const scaled = normalized * depthIn
    const monotonic = Math.max(last, scaled)
    const bounded = Math.min(monotonic, depthIn)
    cumulative.push(bounded)
    last = bounded
  }
  if (cumulative.length > 0) {
    cumulative[0] = 0
    cumulative[cumulative.length - 1] = depthIn
  }

  const incremental = cumulative.map((value, idx) => {
    if (idx === 0) return 0
    const prev = cumulative[idx - 1] ?? 0
    return Math.max(0, value - prev)
  })

  const intensity = incremental.map((value, idx) => {
    if (idx === 0) return 0
    const dt = timeMin[idx]! - timeMin[idx - 1]!
    if (!Number.isFinite(dt) || dt <= 0) return 0
    return (value / dt) * 60
  })

  return { cumulative, incremental, intensity }
}

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

  it('uses native SCS spacing for standard durations', () => {
    const params = {
      depthIn: 3,
      durationHr: 24,
      timestepMin: 5,
      distribution: 'scs_type_ii' as const,
      customCurveCsv: '',
      durationMode: 'standard' as const
    }

    const storm = generateStorm(params)
    const table = SCS_TABLES.scs_type_ii_24hr
    const expectedLength = table.length
    const expectedDurationMin = params.durationHr * 60
    const expectedTimestep = expectedLength > 1
      ? expectedDurationMin / (expectedLength - 1)
      : expectedDurationMin

    expect(storm.timeMin.length).toBe(expectedLength)
    expect(storm.timeMin.at(-1)).toBe(expectedDurationMin)
    expect(storm.effectiveTimestepMin).toBeCloseTo(expectedTimestep, 6)
    expect(storm.timestepLocked).toBe(true)
    if (storm.timeMin.length > 1) {
      expect(storm.timeMin[1] - storm.timeMin[0]).toBeCloseTo(expectedTimestep, 6)
    }
    expect(storm.cumulativeIn.at(-1)).toBeCloseTo(params.depthIn, 6)
  })

  it('uses the same samples in fast mode when timesteps are below the cap', () => {
    const baseParams = {
      depthIn: 2,
      durationHr: 4,
      timestepMin: 30,
      distribution: 'scs_type_ii' as const,
      customCurveCsv: ''
    }

    const precise = generateStorm({ ...baseParams, computationMode: 'precise' })
    const fast = generateStorm({ ...baseParams, computationMode: 'fast' })

    expect(precise.timeMin.length).toBeLessThan(MAX_FAST_SAMPLES)
    expect(fast.cumulativeIn).toEqual(precise.cumulativeIn)
    expect(fast.incrementalIn).toEqual(precise.incrementalIn)
    expect(fast.intensityInHr).toEqual(precise.intensityInHr)
  })

  it('keeps cumulative totals monotonic and close to precise output in fast mode', () => {
    const params = {
      depthIn: 5,
      durationHr: 72,
      timestepMin: 0.25,
      distribution: 'scs_type_ii' as const,
      customCurveCsv: ''
    }

    const precise = generateStorm({ ...params, computationMode: 'precise' })
    const fast = generateStorm({ ...params, computationMode: 'fast' })

    expect(fast.timeMin.length).toBe(Math.min(precise.timeMin.length, MAX_FAST_SAMPLES))
    expect(fast.cumulativeIn.at(-1)).toBeCloseTo(precise.cumulativeIn.at(-1) ?? 0, 6)

    const samplePreciseAt = (time: number) => {
      if (!precise.timeMin.length) return 0
      if (time <= precise.timeMin[0]!) {
        return precise.cumulativeIn[0] ?? 0
      }
      for (let i = 1; i < precise.timeMin.length; i += 1) {
        const t1 = precise.timeMin[i] ?? 0
        if (time <= t1) {
          const t0 = precise.timeMin[i - 1] ?? t1
          const v0 = precise.cumulativeIn[i - 1] ?? 0
          const v1 = precise.cumulativeIn[i] ?? v0
          const span = t1 - t0
          const frac = span > 0 ? (time - t0) / span : 0
          return v0 * (1 - frac) + v1 * frac
        }
      }
      return precise.cumulativeIn.at(-1) ?? 0
    }

    const maxDiff = fast.timeMin.reduce((max, time, index) => {
      const baseline = samplePreciseAt(time)
      const value = fast.cumulativeIn[index] ?? 0
      return Math.max(max, Math.abs(value - baseline))
    }, 0)
    expect(maxDiff).toBeLessThan(0.1)

    for (let i = 1; i < fast.cumulativeIn.length; i += 1) {
      expect(fast.cumulativeIn[i]).toBeGreaterThanOrEqual(fast.cumulativeIn[i - 1] - 1e-6)
    }
  })

  it('keeps fast beta distributions within a small tolerance of precise output', () => {
    const params = {
      depthIn: 3,
      durationHr: 12,
      timestepMin: 5,
      distribution: 'huff_q2' as const,
      customCurveCsv: ''
    }

    const precise = generateStorm({ ...params, computationMode: 'precise' })
    const fast = generateStorm({ ...params, computationMode: 'fast' })

    expect(fast.timeMin.length).toBe(precise.timeMin.length)
    expect(fast.cumulativeIn.at(-1)).toBeCloseTo(precise.cumulativeIn.at(-1) ?? 0, 6)

    const maxDiff = fast.cumulativeIn.reduce((max, value, index) => {
      const baseline = precise.cumulativeIn[index] ?? 0
      return Math.max(max, Math.abs(value - baseline))
    }, 0)

    expect(maxDiff).toBeLessThan(0.2)
  })

  it('smooths SCS storms when enabled and preserves totals and peak intensity', () => {
    const params = {
      depthIn: 3,
      durationHr: 24,
      timestepMin: 5,
      distribution: 'scs_type_ii_24hr' as const,
      customCurveCsv: '',
      durationMode: 'standard' as const
    }

    const stepped = generateStorm(params)
    const smoothed = generateStorm({ ...params, smoothingEnabled: true })

    expect(stepped.timestepLocked).toBe(true)
    expect(stepped.smoothingApplied).toBe(false)

    expect(smoothed.timestepLocked).toBe(false)
    expect(smoothed.smoothingApplied).toBe(true)

    expect(smoothed.timeMin.length).toBe(
      Math.ceil((params.durationHr * 60) / params.timestepMin) + 1
    )
    expect(smoothed.cumulativeIn.length).toBe(smoothed.timeMin.length)
    expect(smoothed.incrementalIn.length).toBe(smoothed.timeMin.length)
    expect(smoothed.intensityInHr.length).toBe(smoothed.timeMin.length)
    expect(smoothed.cumulativeIn.at(-1)).toBeCloseTo(params.depthIn, 6)
    expect(
      smoothed.incrementalIn.reduce((sum, value) => sum + value, 0)
    ).toBeCloseTo(params.depthIn, 6)
    expect(smoothed.cumulativeIn).not.toEqual(stepped.cumulativeIn)

    const table = SCS_TABLES.scs_type_ii_24hr
    const baseline = evaluateScsBaseline(table, smoothed.timeMin, params.depthIn, params.durationHr)
    const baselinePeak = baseline.intensity.reduce(
      (max, value) => (Number.isFinite(value) ? Math.max(max, value) : max),
      0
    )
    const smoothedPeak = smoothed.intensityInHr.reduce(
      (max, value) => (Number.isFinite(value) ? Math.max(max, value) : max),
      0
    )

    expect(smoothedPeak).toBeCloseTo(baselinePeak, 6)
  })

  it('falls back to linear behavior when smoothing is requested but unsupported', () => {
    const params = {
      depthIn: 2,
      durationHr: 3,
      timestepMin: 10,
      distribution: 'huff_q1' as const,
      customCurveCsv: ''
    }

    const baseline = generateStorm(params)
    const attempted = generateStorm({ ...params, smoothingEnabled: true })

    expect(attempted.smoothingApplied).toBe(false)
    expect(attempted.cumulativeIn).toEqual(baseline.cumulativeIn)
    expect(attempted.incrementalIn).toEqual(baseline.incrementalIn)
    expect(attempted.intensityInHr).toEqual(baseline.intensityInHr)
  })
})
