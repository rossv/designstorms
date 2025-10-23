import { BETA_PRESETS, SCS_TABLES } from './distributions'
import type { StormParams, StormResult, DistributionName } from './types'

export type { StormParams, StormResult, DistributionName } from './types'

export const MAX_FAST_SAMPLES = 1000
const SMOOTH_SPLINE_NODES = 512

const distributionCache = new Map<string, number[]>()

const BETACF_MAX_ITER = 200
const BETACF_FAST_ITER = 100
const BETACF_EPS = 3e-7
const BETACF_FPMIN = Number.MIN_VALUE / BETACF_EPS
const MAX_LOG_EXP = 709
const MIN_LOG_EXP = -745
const EXP_MAX_VALUE = Math.exp(MAX_LOG_EXP)
const LOG_PDF_CLAMP = 1e-12

export const SCS_AVAILABLE_DURATIONS: Record<string, number[]> = Object.keys(SCS_TABLES)
  .reduce((acc, key) => {
    const match = key.match(/^scs_(type_[a-z0-9]+)_(\d+)hr$/i)
    if (!match) return acc
    const [, type, hoursStr] = match
    const hours = Number(hoursStr)
    if (!Number.isFinite(hours)) return acc
    const list = acc[type] ?? []
    if (!list.includes(hours)) {
      list.push(hours)
      list.sort((a, b) => a - b)
    }
    acc[type] = list
    return acc
  }, {} as Record<string, number[]>)

function linspace(n: number): number[] {
  if (n <= 0) return []
  if (n === 1) return [0]
  return Array.from({ length: n }, (_, i) => i / (n - 1))
}

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x))
}

function ensureMonotonic01(values: number[], forceOne: boolean): number[] {
  const out: number[] = []
  let last = 0
  for (let i = 0; i < values.length; i += 1) {
    const raw = values[i]
    const clamped = clamp01(Number.isFinite(raw) ? raw : 0)
    const next = Math.max(last, clamped)
    out.push(next)
    last = next
  }

  if (out.length > 0) {
    out[0] = 0
    if (forceOne && out.length > 1) {
      out[out.length - 1] = 1
    }
  }

  return out
}

function expClamp(logValue: number): number {
  if (!Number.isFinite(logValue)) return 0
  if (logValue <= MIN_LOG_EXP) return 0
  if (logValue >= MAX_LOG_EXP) return EXP_MAX_VALUE
  return Math.exp(logValue)
}

function cacheKey(
  name: DistributionName,
  n: number,
  mode: 'precise' | 'fast',
  customCsv?: string
): string {
  const normalizedCsv = customCsv ? customCsv.trim() : ''
  return `${name}|${mode}|${n}|${normalizedCsv}`
}

function betacf(a: number, b: number, x: number, maxIter: number): number {
  let qab = a + b
  let qap = a + 1
  let qam = a - 1
  let c = 1
  let d = 1 - (qab * x) / qap
  if (Math.abs(d) < BETACF_FPMIN) d = BETACF_FPMIN
  d = 1 / d
  let h = d

  for (let m = 1; m <= maxIter; m += 1) {
    const m2 = 2 * m
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2))
    d = 1 + aa * d
    if (Math.abs(d) < BETACF_FPMIN) d = BETACF_FPMIN
    c = 1 + aa / c
    if (Math.abs(c) < BETACF_FPMIN) c = BETACF_FPMIN
    d = 1 / d
    let delta = d * c
    h *= delta

    aa = -((a + m) * (qab + m) * x) / ((a + m2) * (qap + m2))
    d = 1 + aa * d
    if (Math.abs(d) < BETACF_FPMIN) d = BETACF_FPMIN
    c = 1 + aa / c
    if (Math.abs(c) < BETACF_FPMIN) c = BETACF_FPMIN
    d = 1 / d
    delta = d * c
    h *= delta

    if (Math.abs(delta - 1) < BETACF_EPS) {
      break
    }
  }

  return h
}

function betaCumulativeFast(n: number, a: number, b: number): number[] {
  if (n <= 0) {
    return []
  }

  if (n === 1) {
    return [0]
  }

  const bins = n - 1
  const logValues: number[] = []

  for (let i = 0; i < bins; i += 1) {
    const x = (i + 0.5) / bins
    const clampedX = Math.min(1 - LOG_PDF_CLAMP, Math.max(LOG_PDF_CLAMP, x))
    const clampedOneMinusX = Math.min(1 - LOG_PDF_CLAMP, Math.max(LOG_PDF_CLAMP, 1 - x))
    const logValue =
      (a - 1) * Math.log(clampedX) + (b - 1) * Math.log(clampedOneMinusX)
    logValues.push(Number.isFinite(logValue) ? logValue : Number.NEGATIVE_INFINITY)
  }

  let maxLog = Number.NEGATIVE_INFINITY
  for (const value of logValues) {
    if (Number.isFinite(value) && value > maxLog) {
      maxLog = value
    }
  }

  if (!Number.isFinite(maxLog)) {
    const uniform = 1 / bins
    const cumulative: number[] = [0]
    let total = 0
    for (let i = 0; i < bins; i += 1) {
      total += uniform
      cumulative.push(total)
    }
    cumulative[cumulative.length - 1] = 1
    return cumulative
  }

  const pdf: number[] = new Array(bins)
  let sum = 0
  for (let i = 0; i < bins; i += 1) {
    const value = Math.exp(logValues[i] - maxLog)
    pdf[i] = value
    sum += value
  }

  if (!Number.isFinite(sum) || sum <= 0) {
    const uniform = 1 / bins
    const cumulative: number[] = [0]
    let total = 0
    for (let i = 0; i < bins; i += 1) {
      total += uniform
      cumulative.push(total)
    }
    cumulative[cumulative.length - 1] = 1
    return cumulative
  }

  const cumulative: number[] = [0]
  let total = 0
  for (let i = 0; i < bins; i += 1) {
    total += pdf[i] / sum
    cumulative.push(total)
  }

  cumulative[cumulative.length - 1] = 1
  return cumulative
}

function betaCDF(
  x: number,
  a: number,
  b: number,
  logGammaA: number,
  logGammaB: number,
  logGammaSum: number,
  mode: 'precise' | 'fast'
): number {
  if (x <= 0) return 0
  if (x >= 1) return 1

  const logBt =
    logGammaSum - logGammaA - logGammaB + a * Math.log(x) + b * Math.log(1 - x)
  const switchPoint = (a + 1) / (a + b + 2)
  const maxIter = mode === 'fast' ? BETACF_FAST_ITER : BETACF_MAX_ITER

  if (x < switchPoint) {
    const cf = betacf(a, b, x, maxIter)
    const cfSafe = Math.max(cf, BETACF_FPMIN)
    const logProduct = logBt - Math.log(a) + Math.log(cfSafe)
    const result = expClamp(logProduct) * (cf / cfSafe)
    return clamp01(result)
  }

  const cf = betacf(b, a, 1 - x, maxIter)
  const cfSafe = Math.max(cf, BETACF_FPMIN)
  const logProduct = logBt - Math.log(b) + Math.log(cfSafe)
  const result = 1 - expClamp(logProduct) * (cf / cfSafe)
  return clamp01(result)
}

// Lanczos approximation for log-gamma
const LANCZOS_COEFFS = [
  676.5203681218851,
  -1259.1392167224028,
  771.3234287776531,
  -176.6150291621406,
  12.507343278686905,
  -0.13857109526572012,
  9.9843695780195716e-6,
  1.5056327351493116e-7
]
const HALF_LOG_TWO_PI = 0.5 * Math.log(2 * Math.PI)

function lgamma(z: number): number {
  if (!Number.isFinite(z)) {
    return Number.NaN
  }

  if (z < 0.5) {
    // Use reflection formula to improve accuracy for small arguments
    return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - lgamma(1 - z)
  }

  let x = 0.99999999999980993
  const adjusted = z - 1
  for (let i = 0; i < LANCZOS_COEFFS.length; i += 1) {
    x += LANCZOS_COEFFS[i] / (adjusted + i + 1)
  }
  const t = adjusted + LANCZOS_COEFFS.length - 0.5
  return HALF_LOG_TWO_PI + (adjusted + 0.5) * Math.log(t) - t + Math.log(x)
}

function cumulativeFromDistribution(
  name: DistributionName,
  n: number,
  customCsv?: string,
  mode: 'precise' | 'fast' = 'precise'
): number[] {
  const key = cacheKey(name, n, mode, customCsv)
  const cached = distributionCache.get(key)
  if (cached) {
    return cached
  }

  let result: number[]

  if (name.startsWith('scs_')) {
    const base = (SCS_TABLES as any)[name] as number[]
    if (!base) {
      console.warn(`SCS table for ${name} not found. Falling back to linear.`)
      result = linspace(n)
    } else {
      const m = base.length
      const out: number[] = []
      const denom = Math.max(1, n - 1)
      for (let i = 0; i < n; i++) {
        const t = i / denom
        const idx = t * (m - 1)
        const i0 = Math.floor(idx)
        const i1 = Math.min(m - 1, i0 + 1)
        const frac = idx - i0
        out.push(base[i0] * (1 - frac) + base[i1] * frac)
      }
      result = out
    }
    distributionCache.set(key, result)
    return result
  }

  if (name === 'user') {
    if (customCsv) {
      const rows = customCsv.split(/\r?\n/).map((r) => r.trim()).filter(Boolean)
      const pts: [number, number][] = []
      for (const r of rows) {
        const parts = r.split(/[;,\s]+/).map((x) => Number(x))
        if (parts.length >= 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
          pts.push([clamp01(parts[0]), clamp01(parts[1])])
        }
      }
      if (pts.length >= 2) {
        pts.sort((a, b) => a[0] - b[0])
        const out: number[] = []
        const denom = Math.max(1, n - 1)
        for (let i = 0; i < n; i++) {
          const t = i / denom
          let j = 1
          while (j < pts.length && pts[j][0] < t) j += 1
          const [x0, y0] = pts[Math.max(0, j - 1)]
          const [x1, y1] = pts[Math.min(pts.length - 1, j)]
          const frac = clamp01((t - x0) / Math.max(1e-9, x1 - x0))
          out.push(y0 * (1 - frac) + y1 * frac)
        }

        const maxv = out.reduce(
          (max, value) => (Number.isFinite(value) ? Math.max(max, value) : max),
          0
        )

        if (maxv > 0) {
          const normalized: number[] = []
          let last = 0
          for (const value of out) {
            const next = clamp01(value / maxv)
            last = Math.max(last, next)
            normalized.push(last)
          }
          distributionCache.set(key, normalized)
          return normalized
        }
      }
    }
    result = linspace(n)
    distributionCache.set(key, result)
    return result
  }

  const preset = (BETA_PRESETS as any)[name] as [number, number] | undefined
  if (!preset) {
    result = linspace(n)
    distributionCache.set(key, result)
    return result
  }

  const [a, b] = preset
  if (mode === 'fast') {
    result = betaCumulativeFast(n, a, b)
  } else {
    const logGammaA = lgamma(a)
    const logGammaB = lgamma(b)
    const logGammaSum = lgamma(a + b)
    const out = linspace(n).map((t) => betaCDF(t, a, b, logGammaA, logGammaB, logGammaSum, mode))
    const maxv = out[out.length - 1] || 0
    if (maxv <= 0) {
      result = linspace(n)
      distributionCache.set(key, result)
      return result
    }
    result = out.map((v) => v / maxv)
  }
  distributionCache.set(key, result)
  return result
}

export function getBestScsDistribution(
  baseName: string,
  durationHr: number,
  durationMode: 'standard' | 'custom'
): DistributionName {
  if (!baseName.startsWith('scs_')) return baseName as DistributionName
  if (baseName in SCS_TABLES) return baseName as DistributionName

  const type = baseName.replace('scs_', '')
  const available = SCS_AVAILABLE_DURATIONS[type]
  if (!available || available.length === 0) {
    return baseName as DistributionName
  }

  const sorted = [...available].sort((a, b) => a - b)

  if (durationMode === 'standard') {
    const desired = durationHr
    const match = sorted.find((hours) => desired <= hours)
    const best = match ?? sorted[sorted.length - 1]
    return `scs_${type}_${best}hr` as DistributionName
  }

  const desired = durationHr
  let best = sorted[0]
  let bestDiff = Math.abs(best - desired)
  for (const hours of sorted) {
    const diff = Math.abs(hours - desired)
    if (diff < bestDiff || (diff === bestDiff && hours > best)) {
      best = hours
      bestDiff = diff
    }
  }
  return `scs_${type}_${best}hr` as DistributionName
}


export function generateStorm(params: StormParams): StormResult {
  const {
    depthIn,
    durationHr,
    timestepMin,
    distribution,
    customCurveCsv,
    durationMode,
    computationMode = 'precise',
    smoothingMode = 'linear'
  } = params
  const durationMin = durationHr * 60

  if (durationMin <= 0 || timestepMin <= 0) {
    return {
      timeMin: [0],
      incrementalIn: [0],
      cumulativeIn: [0],
      intensityInHr: [0]
    }
  }

  let finalDistribution = distribution
  if (distribution.startsWith('scs_')) {
    finalDistribution = getBestScsDistribution(distribution, durationHr, durationMode || 'custom')
  }

  const rawSampleCount = Math.ceil(durationMin / timestepMin) + 1
  let sampleCount = computationMode === 'fast'
    ? Math.min(rawSampleCount, MAX_FAST_SAMPLES)
    : rawSampleCount

  let timeMin: number[]

  if (
    computationMode === 'fast' &&
    rawSampleCount > MAX_FAST_SAMPLES &&
    MAX_FAST_SAMPLES > 1
  ) {
    const effectiveTimestep = durationMin / (MAX_FAST_SAMPLES - 1)
    sampleCount = MAX_FAST_SAMPLES
    timeMin = Array.from({ length: sampleCount }, (_, i) => {
      if (i === sampleCount - 1) return durationMin
      return Math.min(i * effectiveTimestep, durationMin)
    })
  } else {
    sampleCount = rawSampleCount
    timeMin = Array.from({ length: sampleCount }, (_, i) => {
      if (i === sampleCount - 1) return durationMin
      return Math.min(i * timestepMin, durationMin)
    })
  }

  const normalizedTimes = timeMin.map((t) => clamp01(t / durationMin))
  const baseSamples = cumulativeFromDistribution(
    finalDistribution,
    sampleCount,
    customCurveCsv,
    computationMode
  )
  const baseCumulative = baseSamples.length > 0 ? baseSamples : [0]

  const normalizedCumulative = (() => {
    const length = normalizedTimes.length
    if (length === 0) {
      return []
    }

    if (baseCumulative.length <= 1) {
      const value = clamp01(baseCumulative[0] ?? 0)
      const linear = new Array(length).fill(value)
      if (length > 0) {
        linear[0] = 0
        if (length > 1) {
          linear[length - 1] = 1
        }
      }
      return linear
    }

    if (smoothingMode === 'smooth') {
      const ensureOne = length > 1
      const splineNodes = buildSplineNodes(baseCumulative, SMOOTH_SPLINE_NODES)
      return ensureMonotonic01(
        evaluateMonotoneSpline(splineNodes, normalizedTimes),
        ensureOne
      )
    }

    const linear = evaluateLinearCumulative(baseCumulative, normalizedTimes).map((value, index) => {
      if (index === 0) return 0
      if (index === length - 1) return 1
      return clamp01(Number.isFinite(value) ? value : 0)
    })
    if (linear.length === 1) {
      linear[0] = clamp01(linear[0] ?? 0)
    }
    return linear
  })()

  const cumulativeIn = normalizedCumulative.map((value) => value * depthIn)

  if (cumulativeIn.length > 0) {
    cumulativeIn[cumulativeIn.length - 1] = depthIn
  }

  const incrementalIn = cumulativeIn.map((value, idx) => {
    const prev = idx > 0 ? cumulativeIn[idx - 1] : 0
    return Math.max(0, value - prev)
  })

  const intensityInHr = incrementalIn.map((depth, idx) => {
    if (idx === 0) return 0
    const dt = timeMin[idx] - timeMin[idx - 1]
    if (dt <= 0) return 0
    return (depth / dt) * 60
  })

  return { timeMin, incrementalIn, cumulativeIn, intensityInHr }
}

function evaluateLinearCumulative(baseCumulative: number[], normalizedTimes: number[]): number[] {
  if (baseCumulative.length <= 1) {
    return new Array(normalizedTimes.length).fill(baseCumulative[0] ?? 0)
  }

  const sampleLastIndex = Math.max(1, baseCumulative.length - 1)
  return normalizedTimes.map((nt) => {
    const scaledIndex = clamp01(nt) * sampleLastIndex
    const lowerIndex = Math.min(baseCumulative.length - 1, Math.floor(scaledIndex))
    const upperIndex = Math.min(baseCumulative.length - 1, lowerIndex + 1)
    const frac = upperIndex === lowerIndex ? 0 : scaledIndex - lowerIndex
    const v0 = baseCumulative[lowerIndex] ?? baseCumulative[baseCumulative.length - 1] ?? 0
    const v1 = baseCumulative[upperIndex] ?? baseCumulative[baseCumulative.length - 1] ?? v0
    return v0 * (1 - frac) + v1 * frac
  })
}

function buildSplineNodes(baseCumulative: number[], limit: number): number[] {
  if (baseCumulative.length <= limit) {
    return baseCumulative.slice()
  }

  const nodes: number[] = []
  const denom = Math.max(1, limit - 1)
  const baseLastIndex = Math.max(1, baseCumulative.length - 1)

  for (let i = 0; i < limit; i += 1) {
    const t = i / denom
    const scaledIndex = t * baseLastIndex
    const lowerIndex = Math.min(baseLastIndex, Math.floor(scaledIndex))
    const upperIndex = Math.min(baseLastIndex, lowerIndex + 1)
    const frac = upperIndex === lowerIndex ? 0 : scaledIndex - lowerIndex
    const v0 = baseCumulative[lowerIndex] ?? baseCumulative[baseLastIndex] ?? 0
    const v1 = baseCumulative[upperIndex] ?? baseCumulative[baseLastIndex] ?? v0
    nodes.push(v0 * (1 - frac) + v1 * frac)
  }

  return nodes
}

function evaluateMonotoneSpline(baseCumulative: number[], normalizedTimes: number[]): number[] {
  if (baseCumulative.length <= 2) {
    return evaluateLinearCumulative(baseCumulative, normalizedTimes)
  }

  const n = baseCumulative.length
  const xs = baseCumulative.map((_, idx) => (n === 1 ? 0 : idx / (n - 1)))
  const ys = baseCumulative.slice()
  const hs: number[] = []
  const deltas: number[] = []

  for (let i = 0; i < n - 1; i += 1) {
    const h = xs[i + 1] - xs[i]
    hs[i] = h
    const diff = ys[i + 1] - ys[i]
    deltas[i] = h !== 0 ? diff / h : 0
  }

  const tangents: number[] = new Array(n).fill(0)
  tangents[0] = deltas[0] ?? 0
  tangents[n - 1] = deltas[n - 2] ?? 0

  for (let i = 1; i < n - 1; i += 1) {
    const deltaPrev = deltas[i - 1] ?? 0
    const deltaNext = deltas[i] ?? 0
    if (deltaPrev <= 0 || deltaNext <= 0) {
      tangents[i] = 0
      continue
    }
    const hPrev = hs[i - 1] ?? 0
    const hNext = hs[i] ?? 0
    const w1 = 2 * hNext + hPrev
    const w2 = hNext + 2 * hPrev
    const denominator = w1 / deltaPrev + w2 / deltaNext
    tangents[i] = denominator !== 0 ? (w1 + w2) / denominator : 0
  }

  const results: number[] = []

  for (const tRaw of normalizedTimes) {
    const t = clamp01(Number.isFinite(tRaw) ? tRaw : 0)
    if (t <= xs[0]) {
      results.push(ys[0])
      continue
    }
    if (t >= xs[n - 1]) {
      results.push(ys[n - 1])
      continue
    }

    let segmentIndex = Math.floor(t * (n - 1))
    if (segmentIndex >= n - 1) {
      segmentIndex = n - 2
    } else if (segmentIndex < 0) {
      segmentIndex = 0
    }

    while (segmentIndex < n - 2 && t > xs[segmentIndex + 1]) {
      segmentIndex += 1
    }
    while (segmentIndex > 0 && t < xs[segmentIndex]) {
      segmentIndex -= 1
    }

    const x0 = xs[segmentIndex]
    const x1 = xs[segmentIndex + 1]
    const y0 = ys[segmentIndex]
    const y1 = ys[segmentIndex + 1]
    const h = x1 - x0

    if (h <= 0) {
      results.push(y0)
      continue
    }

    const tau = (t - x0) / h
    const tau2 = tau * tau
    const tau3 = tau2 * tau

    const h00 = 2 * tau3 - 3 * tau2 + 1
    const h10 = tau3 - 2 * tau2 + tau
    const h01 = -2 * tau3 + 3 * tau2
    const h11 = tau3 - tau2

    const m0 = tangents[segmentIndex] ?? 0
    const m1 = tangents[segmentIndex + 1] ?? 0

    const value = h00 * y0 + h10 * h * m0 + h01 * y1 + h11 * h * m1
    results.push(value)
  }

  return results
}
