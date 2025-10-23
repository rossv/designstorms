export type DistributionName = 
  'scs_type_i' | 'scs_type_ia' | 'scs_type_ii' | 'scs_type_iii' | 
  'scs_type_i_24hr' | 'scs_type_ia_24hr' |
  'scs_type_ii_6hr' | 'scs_type_ii_12hr' | 'scs_type_ii_24hr' |
  'scs_type_iii_6hr' | 'scs_type_iii_12hr' | 'scs_type_iii_24hr' |
  'huff_q1' | 'huff_q2' | 'huff_q3' | 'huff_q4' | 'user'

export interface StormResult {
  timeMin: number[]
  incrementalIn: number[]
  cumulativeIn: number[]
  intensityInHr: number[]
  effectiveTimestepMin: number
  timestepLocked: boolean
}

export interface StormParams {
  depthIn: number
  durationHr: number
  timestepMin: number
  distribution: DistributionName
  startISO?: string
  customCurveCsv?: string
  durationMode?: 'standard' | 'custom'
  computationMode?: 'precise' | 'fast'
  smoothingMode?: 'linear' | 'smooth'
}
