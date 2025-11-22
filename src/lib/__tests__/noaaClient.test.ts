import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchNoaaTable } from '../noaaClient'

type MockResponse = {
  ok: boolean
  status: number
  statusText: string
  text: () => Promise<string>
}

function createResponse(body: string, init?: Partial<MockResponse>): MockResponse {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: () => Promise.resolve(body),
    ...init
  }
}

describe('fetchNoaaTable', () => {
  const originalEnv = { ...import.meta.env }
  const lat = 12.3456789
  const lon = 98.7654321

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    ;(import.meta as any).env = originalEnv
  })

  it('returns proxy data when the primary endpoint succeeds immediately', async () => {
    const proxyUrl = (import.meta.env.DEV
      ? `/noaa-api/fe_text_mean.csv?data=depth&lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}&series=pds&units=english`
      : `https://api.allorigins.win/raw?url=${encodeURIComponent(
          `https://hdsc.nws.noaa.gov/cgi-bin/new/fe_text_mean.csv?data=depth&lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}&series=pds&units=english`
        )}`)

    const fetchMock = vi.fn(async () => createResponse('proxy-ok'))
    vi.stubGlobal('fetch', fetchMock)

    const resultPromise = fetchNoaaTable(lat, lon)
    await vi.runAllTimersAsync()
    const result = await resultPromise

    expect(result).toBe('proxy-ok')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(proxyUrl)
  })

  it('retries the proxy and falls back to the direct NOAA URL on repeated failures', async () => {
    const proxyUrl = (import.meta.env.DEV
      ? `/noaa-api/fe_text_mean.csv?data=depth&lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}&series=pds&units=english`
      : `https://api.allorigins.win/raw?url=${encodeURIComponent(
          `https://hdsc.nws.noaa.gov/cgi-bin/new/fe_text_mean.csv?data=depth&lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}&series=pds&units=english`
        )}`)

    const directUrl = `https://hdsc.nws.noaa.gov/cgi-bin/new/fe_text_mean.csv?data=depth&lat=${lat
      .toFixed(6)}&lon=${lon.toFixed(6)}&series=pds&units=english`

    const responses = [
      () => Promise.resolve(createResponse('proxy-error', { ok: false, status: 500, statusText: 'Server Error' })),
      () => Promise.reject(new Error('network down')),
      () => Promise.resolve(createResponse('proxy-error', { ok: false, status: 502, statusText: 'Bad Gateway' })),
      () => Promise.resolve(createResponse('direct-success'))
    ]

    const fetchMock = vi.fn(async () => {
      const responder = responses.shift()
      if (!responder) throw new Error('exhausted responses')
      return responder()
    })
    vi.stubGlobal('fetch', fetchMock)

    const resultPromise = fetchNoaaTable(lat, lon)
    await vi.runAllTimersAsync()
    const result = await resultPromise

    expect(result).toBe('direct-success')
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(fetchMock.mock.calls.slice(0, 3).every((call) => call[0] === proxyUrl)).toBe(true)
    expect(fetchMock.mock.calls[3][0]).toBe(directUrl)
  })

  it('reports which endpoints failed when both proxy and direct requests error', async () => {
    const directUrl = `https://hdsc.nws.noaa.gov/cgi-bin/new/fe_text_mean.csv?data=depth&lat=${lat
      .toFixed(6)}&lon=${lon.toFixed(6)}&series=pds&units=english`

    const fetchMock = vi.fn(async () => createResponse('unavailable', { ok: false, status: 503, statusText: 'Unavailable' }))
    vi.stubGlobal('fetch', fetchMock)

    const resultPromise = fetchNoaaTable(lat, lon)
    const handledPromise = resultPromise.catch((err) => err)
    await vi.runAllTimersAsync()
    const error = await handledPromise

    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toMatch(/Proxy NOAA endpoint/)
    expect(message).toMatch(/Proxy fallback previously failed/)
    expect(message).toMatch(/Direct NOAA endpoint/)
    expect(fetchMock).toHaveBeenLastCalledWith(directUrl)
  })
})
