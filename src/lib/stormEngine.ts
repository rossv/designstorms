import { BETA_PRESETS, SCS_TABLES } from './distributions'
import type { StormParams, StormResult, DistributionName } from './types'

export const MAX_FAST_SAMPLES = 1000

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

function betaCDF(x: number, a: number, b: number): number {
  // Simpson integration of Beta PDF to approximate CDF
  const N = 200
  const h = x / N
  let s = 0
  const betaPdf = (t:number) => Math.pow(t, a-1)*Math.pow(1-t, b-1)
  for (let i=0;i<=N;i++){
    const coef = (i===0 || i===N) ? 1 : (i%2===0 ? 2 : 4)
    s += coef * betaPdf(i*h)
  }
  const betaFunc = (a:number,b:number) => Math.exp(lgamma(a)+lgamma(b)-lgamma(a+b))
  return (h/3) * s / betaFunc(a,b)
}

// Lanczos approximation for log-gamma
function lgamma(z:number): number {
  const p = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7
  ]
  let x = 0.99999999999980993
  for (let i=0;i<p.length;i++) x += p[i]/(z+i+1)
  const t = z + p.length - 0.5
  return 0.5*Math.log(2*Math.PI) + (z+0.5)*Math.log(t) - t + Math.log(x) - Math.log(z)
}

function cumulativeFromDistribution(name: DistributionName, n: number, customCsv?: string): number[] {
  if (name.startsWith('scs_')) {
    const base = (SCS_TABLES as any)[name] as number[]
    if (!base) {
      console.warn(`SCS table for ${name} not found. Falling back to linear.`);
      return linspace(n);
    }
    const m = base.length
    const out: number[] = []
    const denom = Math.max(1, n - 1)
    for (let i = 0; i < n; i++) {
      const t = i / denom
      const idx = t*(m-1)
      const i0 = Math.floor(idx)
      const i1 = Math.min(m-1, i0+1)
      const frac = idx - i0
      out.push(base[i0]*(1-frac) + base[i1]*frac)
    }
    return out
  }
  if (name === 'user') {
    if (customCsv) {
      const rows = customCsv.split(/\r?\n/).map(r => r.trim()).filter(Boolean)
      const pts: [number, number][] = []
      for (const r of rows) {
        const parts = r.split(/[;,\s]+/).map((x) => Number(x))
        if (parts.length >= 2 && isFinite(parts[0]) && isFinite(parts[1])) {
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
          while (j < pts.length && pts[j][0] < t) j++
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
          return normalized
        }
      }
    }
    return linspace(n)
  }
  const preset = (BETA_PRESETS as any)[name] as [number, number] | undefined
  if (!preset) {
    return linspace(n)
  }
  const [a, b] = preset
  const out = linspace(n).map((t) => betaCDF(t, a, b))
  const maxv = out[out.length - 1] || 0
  if (maxv <= 0) {
    return linspace(n)
  }
  return out.map((v) => v / maxv)
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
    computationMode = 'precise'
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

  const n = Math.ceil(durationMin / timestepMin) + 1
  const timeMin = Array.from({ length: n }, (_, i) => {
    if (i === n - 1) return durationMin
    return Math.min(i * timestepMin, durationMin)
  })

  const normalizedTimes = timeMin.map((t) => clamp01(t / durationMin))
  const sampleCount = computationMode === 'fast' ? Math.min(n, MAX_FAST_SAMPLES) : n
  const baseSamples = cumulativeFromDistribution(finalDistribution, sampleCount, customCurveCsv)
  const baseCumulative = baseSamples.length > 0 ? baseSamples : [0]
  const sampleLastIndex = Math.max(1, baseCumulative.length - 1)

  const cumulativeIn = normalizedTimes.map((nt) => {
    if (n === 1 || baseCumulative.length === 1) {
      return (baseCumulative[0] ?? 0) * depthIn
    }
    const scaledIndex = clamp01(nt) * sampleLastIndex
    const lowerIndex = Math.min(baseCumulative.length - 1, Math.floor(scaledIndex))
    const upperIndex = Math.min(baseCumulative.length - 1, lowerIndex + 1)
    const frac = upperIndex === lowerIndex ? 0 : scaledIndex - lowerIndex
    const v0 = baseCumulative[lowerIndex] ?? baseCumulative[baseCumulative.length - 1] ?? 0
    const v1 = baseCumulative[upperIndex] ?? baseCumulative[baseCumulative.length - 1] ?? v0
    return (v0 * (1 - frac) + v1 * frac) * depthIn
  })

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
