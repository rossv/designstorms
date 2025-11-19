import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { tick } from 'svelte'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../App.svelte'
import type { NoaaTable } from '../noaaClient'

vi.mock('leaflet', () => {
  const noop = () => {}

  return {
    default: {
      Icon: { Default: { mergeOptions: noop } },
      map: () => ({ setView: noop, on: noop, remove: noop }),
      tileLayer: () => ({ addTo: noop }),
      marker: () => ({
        addTo() {
          return this
        },
        on: noop,
        getLatLng: () => ({ lat: 0, lng: 0 })
      })
    }
  }
})

vi.mock('plotly.js-dist-min', () => ({
  __esModule: true,
  default: {
    react: () => Promise.resolve(),
    purge: () => {},
    downloadImage: () => Promise.resolve()
  }
}))

vi.mock('../stormEngine', () => ({
  generateStorm: () => ({
    timeMin: [0],
    incrementalIn: [0],
    cumulativeIn: [0],
    intensityInHr: [0],
    effectiveTimestepMin: 1,
    timestepLocked: false
  }),
  getBestScsDistribution: (name: string) => name,
  MAX_FAST_SAMPLES: 1
}))

const sampleTable: NoaaTable = {
  aris: ['5', '10', '25'],
  rows: [
    {
      label: '24 hr',
      values: { '5': 1.5, '10': 2.1, '25': 2.8 }
    },
    {
      label: '12 hr',
      values: { '5': 1.2, '10': 1.8, '25': 2.4 }
    }
  ]
}

const { fetchNoaaTableMock, parseNoaaTableMock } = vi.hoisted(() => ({
  fetchNoaaTableMock: vi.fn(() => Promise.resolve('mock-table')),
  parseNoaaTableMock: vi.fn(() => sampleTable)
}))

vi.mock('../noaaClient', () => ({
  fetchNoaaTable: fetchNoaaTableMock,
  parseNoaaTable: parseNoaaTableMock
}))

function setupGlobals() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }))
  })

  class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  Object.defineProperty(window, 'ResizeObserver', {
    writable: true,
    value: ResizeObserver
  })
}

describe('App NOAA table interpolation highlight', () => {
  beforeEach(() => {
    setupGlobals()
    fetchNoaaTableMock.mockClear()
    parseNoaaTableMock.mockClear()
  })

  it('highlights bounding cells when the ARI input falls between NOAA values', async () => {
    const { container } = render(App)

    const refreshButton = await screen.findByRole('button', { name: /Refresh NOAA Data/i })
    await fireEvent.click(refreshButton)

    await waitFor(() => {
      expect(fetchNoaaTableMock).toHaveBeenCalledTimes(1)
      expect(parseNoaaTableMock).toHaveBeenCalledTimes(1)
    })

    const durationButton = await screen.findAllByRole('button', { name: '24 hr' })
    await fireEvent.click(durationButton[0])

    const ariInput = screen.getByLabelText('Average Recurrence Interval (years)')
    await fireEvent.input(ariInput, { target: { value: '7' } })
    await tick()

    const lowerCell = container.querySelector('button[data-ari="5"][aria-label^="24 hr duration"]')
    const upperCell = container.querySelector('button[data-ari="10"][aria-label^="24 hr duration"]')

    if (!lowerCell || !upperCell) {
      throw new Error('NOAA table cells not rendered for 24 hr duration row')
    }

    await waitFor(() => {
      expect(lowerCell.classList.contains('interpolated')).toBe(true)
      expect(upperCell.classList.contains('interpolated')).toBe(true)
    })
  })
})
