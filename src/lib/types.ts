export type DistributionName = 'scs_type_i' | 'scs_type_ia' | 'scs_type_ii' | 'scs_type_iii' | 'huff_q1' | 'huff_q2' | 'huff_q3' | 'huff_q4' | 'user'

export interface StormResult {
  timeMin: number[]
  incrementalIn: number[]
  cumulativeIn: number[]
  intensityInHr: number[]
}

export interface StormParams {
  depthIn: number
  durationHr: number
  timestepMin: number
  distribution: DistributionName
  startISO?: string
  customCurveCsv?: string
}
