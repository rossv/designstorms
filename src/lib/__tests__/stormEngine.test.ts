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
})
