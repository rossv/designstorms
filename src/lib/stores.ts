import { derived, writable } from 'svelte/store'
import type { NoaaTable } from './noaaClient'
import { generateStorm, type StormParams, type DistributionName } from './stormEngine'

export type StormResult = ReturnType<typeof generateStorm>

type DurationMode = 'standard' | 'custom'
type ComputationMode = 'precise' | 'fast'
type SmoothingMode = 'linear' | 'smooth'

export const lat = writable(40.4406)
export const lon = writable(-79.9959)

export const table = writable<NoaaTable | null>(null)

export const selectedAri = writable(10)
export const selectedDepth = writable(1.0)
export const selectedDurationHr = writable(24)

export const timestepMin = writable(5)
export const distribution = writable<DistributionName>('scs_type_ii')
export const startISO = writable('2003-01-01T00:00')
export const customCurveCsv = writable('')
export const durationMode = writable<DurationMode>('standard')
export const computationMode = writable<ComputationMode>('precise')
export const smoothingMode = writable<SmoothingMode>('linear')

export const stormParams = derived(
  [
    selectedDepth,
    selectedDurationHr,
    timestepMin,
    distribution,
    startISO,
    customCurveCsv,
    durationMode,
    computationMode,
    smoothingMode
  ],
  ([
    depthIn,
    durationHr,
    timestep,
    dist,
    start,
    curveCsv,
    mode,
    computeMode,
    smoothMode
  ]) => {
    if (!Number.isFinite(durationHr) || durationHr <= 0) {
      return null
    }
    if (!Number.isFinite(depthIn) || depthIn < 0) {
      return null
    }
    if (!Number.isFinite(timestep) || timestep <= 0) {
      return null
    }

    const params: StormParams = {
      depthIn,
      durationHr,
      timestepMin: timestep,
      distribution: dist,
      startISO: start,
      customCurveCsv: curveCsv.trim() || undefined,
      durationMode: mode,
      computationMode: computeMode,
      smoothingMode: smoothMode
    }

    return params
  }
)

export const stormIsComputing = writable(false)

export const stormResult = derived(
  stormParams,
  ($stormParams, set) => {
    if (!$stormParams) {
      stormIsComputing.set(false)
      set(null)
      return
    }

    let cancelled = false
    let finalizeHandle: ReturnType<typeof setTimeout> | null = null
    stormIsComputing.set(true)

    const handle = setTimeout(() => {
      if (cancelled) return
      const result = generateStorm($stormParams)
      set(result)

      finalizeHandle = setTimeout(() => {
        if (cancelled) return
        stormIsComputing.set(false)
        finalizeHandle = null
      }, 150)
    }, 0)

    return () => {
      cancelled = true
      clearTimeout(handle)
      if (finalizeHandle) {
        clearTimeout(finalizeHandle)
        finalizeHandle = null
      }
    }
  },
  null as StormResult | null
)
