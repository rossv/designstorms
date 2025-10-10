<script lang="ts">
  import { onMount, onDestroy, tick, afterUpdate } from 'svelte'
  import * as L from 'leaflet'
  import markerIcon2xUrl from 'leaflet/dist/images/marker-icon-2x.png'
  import markerIconUrl from 'leaflet/dist/images/marker-icon.png'
  import markerShadowUrl from 'leaflet/dist/images/marker-shadow.png'
  import Plotly from 'plotly.js-dist-min'
  import { fetchNoaaTable, parseNoaaTable, type NoaaTable } from './lib/noaaClient'
  import { generateStorm, type StormParams, type DistributionName } from './lib/stormEngine'
  import { saveCsv, savePcswmmDat } from './lib/export'
  import NumericStepper from './lib/components/NumericStepper.svelte'
  import designStormIcon from './design_storm.ico'

  let mapDiv: HTMLDivElement
  let plotDiv1: HTMLDivElement
  let plotDiv2: HTMLDivElement
  let plotDiv3: HTMLDivElement

  let map: L.Map
  let marker: L.Marker

  const defaultMarkerIcons: Partial<L.IconOptions> = {
    iconRetinaUrl: markerIcon2xUrl,
    iconUrl: markerIconUrl,
    shadowUrl: markerShadowUrl
  }

  L.Icon.Default.mergeOptions(defaultMarkerIcons)

  let lat = 40.4406
  let lon = -79.9959

  let searchQuery = ''
  let isSearchingLocation = false
  let searchFeedback = ''
  let searchHasError = false

  let autoFetch = true
  let fetchTimer: ReturnType<typeof setTimeout> | null = null
  let lastFetchKey = ''

  let table: NoaaTable | null = null
  let durations: string[] = []
  let aris: string[] = []
  let selectedDurationLabel: string | null = null
  let selectedAri = 10
  let selectedDepth = 1.0
  let selectedDurationHr = 24

  let interpolatedCells: { duration: string; ari: string }[] = []
  type NoaaRow = NoaaTable['rows'][number]

  let timestepMin = 5
  let distribution: DistributionName = 'scs_type_ii'
  let startISO = '2003-01-01T00:00'
  let customCurveCsv = ''
  let showHelp = false
  let helpDialog: HTMLDivElement | null = null

  let isLoadingNoaa = false
  let noaaError = ''

  let lastStorm: ReturnType<typeof generateStorm> | null = null
  
  let lockedParameter: 'ari' | 'depth' | 'duration' | null = null;
  let lastChangedBy: 'user' | 'system' = 'user';
  let recentlyRecalculated: 'ari' | 'depth' | 'duration' | null = null;
  let recalculationTimer: ReturnType<typeof setTimeout> | null = null;


  const plotConfig = { responsive: true, displaylogo: false, displayModeBar: false }
  const plotLayoutBase = {
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    font: { color: '#e7e7e7' },
    margin: { l: 60, r: 24, t: 30, b: 45 },
    xaxis: {
      gridcolor: 'rgba(255,255,255,0.08)',
      zerolinecolor: 'rgba(255,255,255,0.1)',
      linecolor: 'rgba(255,255,255,0.2)',
      mirror: true
    },
    yaxis: {
      gridcolor: 'rgba(255,255,255,0.08)',
      zerolinecolor: 'rgba(255,255,255,0.1)',
      linecolor: 'rgba(255,255,255,0.2)',
      mirror: true
    },
    hovermode: 'closest'
  }

  let peakIntensity = 0
  let totalDepth = 0
  let timeAxis: number[] = []
  let timeColumnLabel = 'Time (hr)'
  let tableRows: {
    time: number
    intensity: number
    incremental: number
    cumulative: number
    timestamp?: string
  }[] = []
  let hasTimestamp = false

  let tableScrollEl: HTMLDivElement | null = null
  let tableScrollObserver: ResizeObserver | null = null
  let observedTableScrollEl: HTMLDivElement | null = null
  let tableScrollMaxHeight = 320

  function formatTimestamp(date: Date) {
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const year = date.getFullYear()
    const hour = String(date.getHours()).padStart(2, '0')
    const minute = String(date.getMinutes()).padStart(2, '0')
    return `${month}-${day}-${year} ${hour}:${minute}`
  }

  function attachTableScrollObserver() {
    if (!tableScrollObserver) return
    if (observedTableScrollEl && observedTableScrollEl !== tableScrollEl) {
      tableScrollObserver.unobserve(observedTableScrollEl)
    }
    if (tableScrollEl && observedTableScrollEl !== tableScrollEl) {
      tableScrollObserver.observe(tableScrollEl)
    }
    observedTableScrollEl = tableScrollEl
  }

  function updateTableScrollHeight() {
    if (!tableScrollEl) return

    const rect = tableScrollEl.getBoundingClientRect()
    const pageElement = tableScrollEl.closest('.page')
    let paddingBottom = 0

    if (pageElement instanceof HTMLElement) {
      const computed = getComputedStyle(pageElement)
      paddingBottom = parseFloat(computed.paddingBottom) || 0
    }

    const clearance = 12
    const minHeight = 200
    const available = window.innerHeight - rect.top - paddingBottom - clearance
    const nextHeight = Math.max(minHeight, available)

    if (Math.abs(nextHeight - tableScrollMaxHeight) > 1) {
      tableScrollMaxHeight = nextHeight
    }
  }

  const handleViewportChange = () => {
    updateTableScrollHeight()
  }

  function scheduleNoaaFetch(delay = 700) {
    if (!autoFetch) return
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return
    if (fetchTimer) clearTimeout(fetchTimer)
    fetchTimer = setTimeout(() => {
      void loadNoaa()
    }, delay)
  }

  type NominatimResult = {
    lat: string
    lon: string
    display_name?: string
  }

  async function searchLocation(event?: SubmitEvent) {
    event?.preventDefault()
    const query = searchQuery.trim()
    if (!query) {
      searchFeedback = 'Enter a city, address, or ZIP code to search.'
      searchHasError = true
      return
    }

    searchFeedback = ''
    searchHasError = false
    isSearchingLocation = true

    try {
      const response = await fetch(
        `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`,
        {
          headers: {
            Accept: 'application/json'
          }
        }
      )
      if (!response.ok) {
        throw new Error('Search request failed')
      }

      const results: NominatimResult[] = await response.json()
      const match = results[0]

      if (!match) {
        searchFeedback = 'No results found for that search.'
        searchHasError = true
        return
      }

      const nextLat = parseFloat(match.lat)
      const nextLon = parseFloat(match.lon)

      if (!Number.isFinite(nextLat) || !Number.isFinite(nextLon)) {
        searchFeedback = 'Location data was returned in an unexpected format.'
        searchHasError = true
        return
      }

      lat = nextLat
      lon = nextLon
      lastFetchKey = ''
      if (map) {
        const zoom = map.getZoom()
        map.setView([nextLat, nextLon], Math.max(zoom, 10))
      }

      searchFeedback = match.display_name
        ? `Centered on ${match.display_name}`
        : 'Location found. Map centered on the result.'
    } catch (error) {
      searchFeedback = 'Unable to search for that location right now.'
      searchHasError = true
    } finally {
      isSearchingLocation = false
    }
  }

  async function loadNoaa() {
    if (fetchTimer) {
      clearTimeout(fetchTimer)
      fetchTimer = null
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      noaaError = 'Enter a valid latitude and longitude.'
      return
    }
    const key = `${lat.toFixed(3)}:${lon.toFixed(3)}`
    if (key === lastFetchKey && table) {
      noaaError = ''
      return
    }
    isLoadingNoaa = true
    noaaError = ''
    try {
      const txt = await fetchNoaaTable(lat, lon)
      const parsed = parseNoaaTable(txt)
      if (!parsed) throw new Error('NOAA table parse failed')
      table = parsed
      durations = parsed.rows.map((r) => r.label)
      aris = parsed.aris
      if (!aris.includes(String(selectedAri)) && aris.length) {
        selectedAri = Number(aris[0])
      }
      if (
        !selectedDurationLabel ||
        !parsed.rows.some((r) => r.label === selectedDurationLabel)
      ) {
        selectedDurationLabel = parsed.rows[0]?.label ?? null
      }
      if (selectedDurationLabel) {
        applyNoaaSelection()
      }
      lastFetchKey = key
    } catch (e: any) {
      noaaError = e?.message ?? 'Unable to fetch NOAA data.'
      table = null
      durations = []
      aris = []
      selectedDurationLabel = null
      lastFetchKey = ''
    } finally {
      isLoadingNoaa = false
    }
  }

  function pickCell(durLabel: string, ari: string) {
    if (!table) return
    selectedDurationLabel = durLabel
    selectedDurationHr = toHours(durLabel)
    selectedAri = Number(ari)
    const row = table.rows.find((r) => r.label === durLabel)
    const depth = row?.values[ari]
    if (Number.isFinite(depth)) {
      selectedDepth = Number(depth)
    }
    interpolatedCells = []
    makeStorm()
  }

  function toHours(label: string): number {
    const m = label.toLowerCase()
    const num = parseFloat(m)
    if (m.includes('min')) return num / 60
    if (m.includes('hr') || m.includes('hour')) return num
    return num * 24
  }

  function applyNoaaSelection() {
    if (!table || !selectedDurationLabel) return
    const row = table.rows.find((r) => r.label === selectedDurationLabel)
    if (!row) return
    selectedDurationHr = toHours(selectedDurationLabel)
    const ariKey = String(selectedAri)
    const exactDepth = row.values[ariKey]
    if (Number.isFinite(exactDepth)) {
      selectedDepth = Number(exactDepth)
      interpolatedCells = []
      makeStorm()
      return
    }
    const interpolated = interpolateDepthFromAri(row, selectedAri)
    if (interpolated) {
      selectedDepth = interpolated.depth
      interpolatedCells = interpolated.highlight ?? []
      makeStorm()
      return
    }
    interpolatedCells = []
    makeStorm()
  }

  function makeStorm() {
    const params: StormParams = {
      depthIn: selectedDepth,
      durationHr: selectedDurationHr,
      timestepMin,
      distribution,
      startISO,
      customCurveCsv: customCurveCsv.trim() || undefined
    }
    lastStorm = generateStorm(params)
    totalDepth = lastStorm.cumulativeIn[lastStorm.cumulativeIn.length - 1] ?? 0
    peakIntensity = Math.max(...lastStorm.intensityInHr)

    const totalMinutes = lastStorm.timeMin[lastStorm.timeMin.length - 1] ?? 0
    const useHours = totalMinutes >= 120
    const timeFactor = useHours ? 1 / 60 : 1
    const axisTitle = useHours ? 'Time (hours)' : 'Time (minutes)'
    const columnLabel = useHours ? 'Time (hr)' : 'Time (min)'
    const hoverTimeLabel = useHours ? 'Time (hr)' : 'Time (min)'
    const stepMinutes =
      lastStorm.timeMin.length > 1
        ? lastStorm.timeMin[1] - lastStorm.timeMin[0]
        : timestepMin
    const barWidth = stepMinutes * timeFactor
    timeAxis = lastStorm.timeMin.map((t) => t * timeFactor)
    timeColumnLabel = columnLabel

    const startDate = startISO ? new Date(startISO) : null
    hasTimestamp = Boolean(startDate && !Number.isNaN(startDate.getTime()))
    tableRows = lastStorm.timeMin.map((t, i) => {
      const timestamp = hasTimestamp
        ? formatTimestamp(new Date((startDate as Date).getTime() + t * 60000))
        : undefined
      return {
        time: t * timeFactor,
        intensity: lastStorm.intensityInHr[i],
        incremental: lastStorm.incrementalIn[i],
        cumulative: lastStorm.cumulativeIn[i],
        timestamp
      }
    })

    if (plotDiv1) {
      Plotly.react(
        plotDiv1,
        [
          {
            x: timeAxis,
            y: lastStorm.intensityInHr,
            type: 'bar',
            name: 'Intensity (in/hr)',
            marker: { color: '#6ee7ff' },
            hovertemplate: `${hoverTimeLabel}: %{x:.2f}<br>Intensity: %{y:.2f} in/hr<extra></extra>`,
            width: barWidth
          }
        ],
        {
          ...plotLayoutBase,
          title: 'Hyetograph (Intensity)',
          xaxis: { ...plotLayoutBase.xaxis, title: axisTitle },
          yaxis: { ...plotLayoutBase.yaxis, title: 'Intensity (in/hr)' }
        },
        plotConfig
      )
    }

    if (plotDiv2) {
      Plotly.react(
        plotDiv2,
        [
          {
            x: timeAxis,
            y: lastStorm.incrementalIn,
            type: 'bar',
            name: 'Incremental Volume (in)',
            marker: { color: '#a855f7' },
            hovertemplate: `${hoverTimeLabel}: %{x:.2f}<br>Incremental: %{y:.3f} in<extra></extra>`,
            width: barWidth
          }
        ],
        {
          ...plotLayoutBase,
          title: 'Incremental Volume',
          xaxis: { ...plotLayoutBase.xaxis, title: axisTitle },
          yaxis: { ...plotLayoutBase.yaxis, title: 'Volume (in)' }
        },
        plotConfig
      )
    }

    if (plotDiv3) {
      Plotly.react(
        plotDiv3,
        [
          {
            x: timeAxis,
            y: lastStorm.cumulativeIn,
            type: 'scatter',
            mode: 'lines',
            name: 'Cumulative (in)',
            line: { color: '#f97316', width: 3 },
            hovertemplate: `${hoverTimeLabel}: %{x:.2f}<br>Cumulative: %{y:.3f} in<extra></extra>`
          }
        ],
        {
          ...plotLayoutBase,
          title: 'Cumulative Mass Curve',
          xaxis: { ...plotLayoutBase.xaxis, title: axisTitle },
          yaxis: { ...plotLayoutBase.yaxis, title: 'Cumulative Depth (in)' }
        },
        plotConfig
      )
    }
  }

  function getRowForCalculation() {
    if (!table) {
      return { row: null as NoaaRow | null, label: null as string | null }
    }
    if (selectedDurationLabel) {
      const existing = table.rows.find((r) => r.label === selectedDurationLabel)
      if (existing) {
        return { row: existing, label: existing.label }
      }
    }
    return findClosestRow(selectedDurationHr)
  }

  function findClosestRow(durationHr: number) {
    if (!table || !Number.isFinite(durationHr)) {
      return { row: null as NoaaRow | null, label: null as string | null }
    }
    let bestRow: NoaaRow | null = null
    let bestLabel: string | null = null
    let bestDiff = Number.POSITIVE_INFINITY
    for (const r of table.rows) {
      const diff = Math.abs(toHours(r.label) - durationHr)
      if (diff < bestDiff) {
        bestDiff = diff
        bestRow = r
        bestLabel = r.label
      }
    }
    return { row: bestRow, label: bestLabel }
  }

  function getRowPoints(row: NoaaRow) {
    if (!table) return [] as { key: string; ari: number; depth: number }[]
    return table.aris
      .map((key) => ({
        key,
        ari: Number.parseFloat(key),
        depth: row.values[key]
      }))
      .filter((pt) => Number.isFinite(pt.ari) && Number.isFinite(pt.depth))
      .sort((a, b) => a.ari - b.ari)
  }

  function interpolateAriFromDepth(
    row: NoaaRow,
    targetDepth: number
  ) {
    const points = getRowPoints(row)
    if (!points.length || !Number.isFinite(targetDepth)) return null
    if (targetDepth <= points[0].depth) {
      return { ari: points[0].ari, highlight: null as { duration: string; ari: string }[] | null }
    }
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i]
      const b = points[i + 1]
      const low = Math.min(a.depth, b.depth)
      const high = Math.max(a.depth, b.depth)
      if (targetDepth >= low && targetDepth <= high) {
        const span = b.depth - a.depth
        if (Math.abs(span) < 1e-9) {
          return { ari: b.ari, highlight: null }
        }
        const ratio = (targetDepth - a.depth) / span
        const interpolatedAri = a.ari + ratio * (b.ari - a.ari)
        const highlight =
          ratio > 0 && ratio < 1
            ? [
                { duration: row.label, ari: a.key },
                { duration: row.label, ari: b.key }
              ]
            : null
        return { ari: interpolatedAri, highlight }
      }
    }
    const last = points[points.length - 1]
    return { ari: last.ari, highlight: null }
  }

  function interpolateDepthFromAri(
    row: NoaaRow,
    targetAri: number
  ) {
    const points = getRowPoints(row)
    if (!points.length || !Number.isFinite(targetAri)) return null
    if (targetAri <= points[0].ari) {
      return { depth: points[0].depth, highlight: null as { duration: string; ari: string }[] | null }
    }
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i]
      const b = points[i + 1]
      if (targetAri >= a.ari && targetAri <= b.ari) {
        const span = b.ari - a.ari
        if (Math.abs(span) < 1e-9) {
          return { depth: b.depth, highlight: null }
        }
        const ratio = (targetAri - a.ari) / span
        const interpolatedDepth = a.depth + ratio * (b.depth - a.depth)
        const highlight =
          ratio > 0 && ratio < 1
            ? [
                { duration: row.label, ari: a.key },
                { duration: row.label, ari: b.key }
              ]
            : null
        return { depth: interpolatedDepth, highlight }
      }
    }
    const last = points[points.length - 1]
    return { depth: last.depth, highlight: null }
  }

  function cellIsInterpolated(durationLabel: string, ari: string) {
    return interpolatedCells.some(
      (cell) => cell.duration === durationLabel && cell.ari === ari
    )
  }

  type DurationInterpolationResult = {
    ari: number
    label: string | null
    highlight: { duration: string; ari: string }[] | null
  }

  function getSortedDurationRows() {
    if (!table) return [] as { hr: number; label: string; row: NoaaRow }[]
    return table.rows
      .map((row) => ({ hr: toHours(row.label), label: row.label, row }))
      .filter((entry) => Number.isFinite(entry.hr))
      .sort((a, b) => a.hr - b.hr)
  }

  function interpolateAriForDuration(
    durationHr: number,
    depth: number
  ): DurationInterpolationResult | null {
    if (!Number.isFinite(durationHr) || !Number.isFinite(depth) || !table) {
      return null
    }

    const entries = getSortedDurationRows()
    if (!entries.length) {
      return null
    }

    const exactMatch = entries.find((entry) => entry.label === selectedDurationLabel)
    if (exactMatch && Math.abs(exactMatch.hr - durationHr) < 1e-6) {
      const result = interpolateAriFromDepth(exactMatch.row, depth)
      if (!result) return null
      return { ari: result.ari, label: exactMatch.label, highlight: result.highlight }
    }

    if (durationHr <= entries[0].hr) {
      const result = interpolateAriFromDepth(entries[0].row, depth)
      if (!result) return null
      return { ari: result.ari, label: entries[0].label, highlight: result.highlight }
    }

    const lastEntry = entries[entries.length - 1]
    if (durationHr >= lastEntry.hr) {
      const result = interpolateAriFromDepth(lastEntry.row, depth)
      if (!result) return null
      return { ari: result.ari, label: lastEntry.label, highlight: result.highlight }
    }

    for (let i = 0; i < entries.length - 1; i += 1) {
      const lower = entries[i]
      const upper = entries[i + 1]
      if (durationHr >= lower.hr && durationHr <= upper.hr) {
        const span = upper.hr - lower.hr
        if (span < 1e-6) {
          const fallback = interpolateAriFromDepth(upper.row, depth)
          if (!fallback) return null
          return { ari: fallback.ari, label: upper.label, highlight: fallback.highlight }
        }

        const lowerResult = interpolateAriFromDepth(lower.row, depth)
        const upperResult = interpolateAriFromDepth(upper.row, depth)
        if (!lowerResult || !upperResult) {
          const fallback = lowerResult ?? upperResult
          if (!fallback) return null
          const fallbackLabel = lowerResult ? lower.label : upper.label
          return {
            ari: fallback.ari,
            label: fallbackLabel,
            highlight: fallback.highlight
          }
        }

        const ratio = (durationHr - lower.hr) / span
        const interpolatedAri = lowerResult.ari + ratio * (upperResult.ari - lowerResult.ari)

        const combinedHighlights = [
          ...(lowerResult.highlight ?? []),
          ...(upperResult.highlight ?? [])
        ]

        const uniqueHighlights = combinedHighlights.filter((cell, index, array) => {
          const key = `${cell.duration}:${cell.ari}`
          return (
            index ===
            array.findIndex((candidate) => `${candidate.duration}:${candidate.ari}` === key)
          )
        })

        return {
          ari: interpolatedAri,
          label: ratio < 0.5 ? lower.label : upper.label,
          highlight: uniqueHighlights.length ? uniqueHighlights : null
        }
      }
    }

    return null
  }

  function recalcFromDepthOrDuration() {
    if (!Number.isFinite(selectedDepth) || !Number.isFinite(selectedDurationHr)) {
      return
    }
    if (!table) {
      interpolatedCells = []
      makeStorm()
      return
    }

    const result = interpolateAriForDuration(selectedDurationHr, selectedDepth)
    if (!result) {
      interpolatedCells = []
      makeStorm()
      return
    }

    if (selectedDurationLabel !== result.label) {
      selectedDurationLabel = result.label
    }

    const newAri = Number(result.ari.toFixed(3))
    if (selectedAri !== newAri) {
      selectedAri = newAri
    }
    interpolatedCells = result.highlight ?? []
    makeStorm()
  }

  function recalcFromAri() {
    if (!Number.isFinite(selectedAri) || !Number.isFinite(selectedDurationHr)) {
      return
    }
    if (!table) {
      interpolatedCells = []
      return
    }
    const { row, label } = getRowForCalculation()
    if (!row || !label) {
      interpolatedCells = []
      return
    }
    if (selectedDurationLabel !== label) {
      selectedDurationLabel = label
    }
    const result = interpolateDepthFromAri(row, selectedAri)
    if (result) {
      const newDepth = Number(result.depth.toFixed(3))
      if (selectedDepth !== newDepth) {
        selectedDepth = newDepth
        makeStorm()
      } else {
        makeStorm()
      }
      interpolatedCells = result.highlight ?? []
    } else {
      interpolatedCells = []
      makeStorm()
    }
  }

  function handleDepthInput() {
    lastChangedBy = 'user';
    if(lockedParameter === 'depth') return;
    if(lockedParameter === 'ari'){
        // ToDo recalculate duration
    } else { // duration or null
        recalcFromDepthOrDuration()
    }
  }

  function handleDurationInput() {
    lastChangedBy = 'user';
    if(lockedParameter === 'duration') return;

    if(lockedParameter === 'ari'){
        // ToDo recalculate depth
    } else { // depth or null
        recalcFromDepthOrDuration()
    }
  }

  function handleAriInput() {
    lastChangedBy = 'user';
    if(lockedParameter === 'ari') return;
    if(lockedParameter === 'depth'){
        // ToDo recalculate duration
    } else { // duration or null
        recalcFromAri()
    }
  }

  function handleTimestepInput() {
    if (!Number.isFinite(timestepMin) || timestepMin <= 0) {
      return
    }
    makeStorm()
  }

  function doCsv() {
    if (!lastStorm) return
    saveCsv(lastStorm, 'design_storm.csv')
  }
  function doDat() {
    if (!lastStorm) return
    const startDate = startISO ? new Date(startISO) : null
    const start = startDate && !Number.isNaN(startDate.getTime())
      ? startISO
      : '2003-01-01T00:00'
    savePcswmmDat(lastStorm, timestepMin, 'design_storm.dat', 'System', start)
  }

  async function openHelp() {
    showHelp = true
    await tick()
    helpDialog?.focus()
  }

  function closeHelp() {
    showHelp = false
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && showHelp) {
      event.preventDefault()
      closeHelp()
    }
  }
  
  function setLocked(param: 'ari' | 'depth' | 'duration' | null){
      if(lockedParameter === param){
          lockedParameter = null;
      } else {
          lockedParameter = param;
      }
  }
  
  function flashRecalculated(param: 'ari' | 'depth' | 'duration'){
      recentlyRecalculated = param;
      if(recalculationTimer) clearTimeout(recalculationTimer);
      recalculationTimer = setTimeout(() => {
          recentlyRecalculated = null;
      }, 500)
  }

  onMount(() => {
    map = L.map(mapDiv, { attributionControl: false, zoomControl: true }).setView(
      [lat, lon],
      9
    )
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '© OpenStreetMap contributors'
    }).addTo(map)

    marker = L.marker([lat, lon], { draggable: true }).addTo(map)
    marker.on('dragend', () => {
      const p = marker.getLatLng()
      lat = p.lat
      lon = p.lng
    })
    map.on('click', (ev: L.LeafletMouseEvent) => {
      lat = ev.latlng.lat
      lon = ev.latlng.lng
    })

    void loadNoaa()
    makeStorm()

    window.addEventListener('resize', handleViewportChange)
    window.addEventListener('scroll', handleViewportChange, { passive: true })
    tableScrollObserver = new ResizeObserver(handleViewportChange)
    attachTableScrollObserver()
    updateTableScrollHeight()
  })

  onDestroy(() => {
    if (fetchTimer) clearTimeout(fetchTimer)
    if (map) map.remove()
    if (plotDiv1) Plotly.purge(plotDiv1)
    if (plotDiv2) Plotly.purge(plotDiv2)
    if (plotDiv3) Plotly.purge(plotDiv3)
    window.removeEventListener('resize', handleViewportChange)
    window.removeEventListener('scroll', handleViewportChange)
    tableScrollObserver?.disconnect()
  })

  $: if (marker) {
    marker.setLatLng([lat, lon])
  }

  $: if (autoFetch) {
    const key = `${lat.toFixed(3)}:${lon.toFixed(3)}`
    if (key !== lastFetchKey) {
      scheduleNoaaFetch()
    }
  }

  afterUpdate(() => {
    attachTableScrollObserver()
    updateTableScrollHeight()
  })
</script>

<svelte:window on:keydown={handleKeydown} />

<div class="page">
  <header class="panel header">
    <div class="title-group">
      <img src={designStormIcon} alt="Design Storm" class="app-icon" />
      <div class="title-text">
        <h1>Design Storm Generator</h1>
      </div>
    </div>
    <div class="badge">Beta</div>
  </header>

  <div class="layout">
    <section class="column">
      <div class="panel">
        <h2 class="section-title">Location &amp; NOAA Depths</h2>
        <div class="location-search">
          <form class="search-form" on:submit|preventDefault={searchLocation}>
            <label for="location-query">Search for a city</label>
            <div class="search-controls">
              <input
                id="location-query"
                type="text"
                placeholder="City, address, or ZIP"
                bind:value={searchQuery}
                on:input={() => {
                  searchFeedback = ''
                  searchHasError = false
                }}
              />
              <button type="submit" disabled={isSearchingLocation}>
                {isSearchingLocation ? 'Searching…' : 'Search'}
              </button>
            </div>
          </form>
          {#if searchFeedback}
            <div class={`search-feedback ${searchHasError ? 'error' : ''}`}>
              {searchFeedback}
            </div>
          {/if}
        </div>

        <div class="map" bind:this={mapDiv}></div>

        <div class="grid cols-2">
          <div>
            <label for="lat">Latitude</label>
            <NumericStepper
              id="lat"
              label="Latitude"
              min={-90}
              max={90}
              step={0.0001}
              buttonStep={0.1}
              bind:value={lat}
              showProgress
              on:change={() => {
                lastFetchKey = ''
              }}
            />
          </div>
          <div>
            <label for="lon">Longitude</label>
            <NumericStepper
              id="lon"
              label="Longitude"
              min={-180}
              max={180}
              step={0.0001}
              buttonStep={0.1}
              bind:value={lon}
              showProgress
              on:change={() => {
                lastFetchKey = ''
              }}
            />
          </div>
        </div>

        <div class="options-row">
          <label class="checkbox">
            <input type="checkbox" bind:checked={autoFetch} />
            Auto refresh when location changes
          </label>
          <button class="primary" on:click={() => void loadNoaa()} disabled={isLoadingNoaa}>
            {isLoadingNoaa ? 'Refreshing…' : 'Refresh NOAA Data'}
          </button>
        </div>
        <div class="noaa-status">
          {#if isLoadingNoaa}
            <span>Fetching rainfall frequencies from NOAA Atlas 14…</span>
          {:else if noaaError}
            <span class="error">{noaaError}</span>
          {:else if table}
            <span>Depths pulled for Atlas 14 (Partial Duration Series).</span>
          {:else}
            <span>NOAA data not loaded yet.</span>
          {/if}
        </div>

        {#if table}
          <div class="noaa-table-scroll">
            <div class="noaa-table panel">
              <div class="table-header">
                <div>
                  <strong>Duration</strong>
                </div>
                <div class="ari-header">
                  <span class="ari-label">Average Recurrence Interval (years)</span>
                  <div class="grid aris" style={`grid-template-columns: repeat(${aris.length}, minmax(60px, 1fr));`}>
                    {#each aris as a}
                      <div><strong>{a}</strong></div>
                    {/each}
                  </div>
                </div>
              </div>
              <div class="table-body">
                {#each table.rows as row}
                  <div class={`table-row ${selectedDurationLabel === row.label ? 'active' : ''}`}>
                    <div>
                      <button
                        type="button"
                        class={`table-button duration-btn ${selectedDurationLabel === row.label ? 'active' : ''}`}
                        on:click={() => pickCell(row.label, String(selectedAri))}
                      >
                        {row.label}
                      </button>
                    </div>
                    <div class="grid aris" style={`grid-template-columns: repeat(${aris.length}, minmax(60px, 1fr));`}>
                      {#each aris as a}
                        {@const depth = Number.isFinite(row.values[a]) ? row.values[a].toFixed(3) : ''}
                        <button
                          type="button"
                          class={`table-button cell ${
                            selectedDurationLabel === row.label && String(selectedAri) === a
                              ? 'selected'
                              : ''
                          } ${cellIsInterpolated(row.label, a) ? 'interpolated' : ''}`}
                          data-ari={a}
                          aria-label={`${a}-year Average Recurrence Interval depth ${depth ? `${depth} in` : 'not available'} for ${row.label}`}
                          on:click={() => pickCell(row.label, a)}
                        >
                        {depth}
                        </button>
                      {/each}
                    </div>
                  </div>
                {/each}
              </div>
            </div>
          </div>
          <div class="small">Tip: Click a table cell to apply the depth, duration, and Average Recurrence Interval to the storm parameters.</div>
        {/if}
      </div>

      <div class="panel">
        <h2 class="section-title">Storm Parameters</h2>
        <div class="grid cols-3 form-grid">
          <div class="parameter-input">
            <label for="depth">Depth (in)</label>
            <div class="input-with-lock">
                <NumericStepper
                  id="depth"
                  label="Depth (in)"
                  min={0}
                  step={0.1}
                  bind:value={selectedDepth}
                  on:change={handleDepthInput}
                  class:recalculated={recentlyRecalculated === 'depth'}
                />
                <button 
                  class="lock-button" 
                  class:locked={lockedParameter === 'depth'}
                  on:click={() => setLocked('depth')}
                  title="Lock this parameter"
                >
                  {lockedParameter === 'depth' ? '🔒' : '🔓'}
                </button>
            </div>
          </div>
          <div class="parameter-input">
            <label for="duration">Duration (hr)</label>
            <div class="input-with-lock">
                <NumericStepper
                  id="duration"
                  label="Duration (hr)"
                  min={0.1}
                  step={1}
                  bind:value={selectedDurationHr}
                  on:change={handleDurationInput}
                  class:recalculated={recentlyRecalculated === 'duration'}
                />
                <button 
                  class="lock-button" 
                  class:locked={lockedParameter === 'duration'}
                  on:click={() => setLocked('duration')}
                  title="Lock this parameter"
                >
                  {lockedParameter === 'duration' ? '🔒' : '🔓'}
                </button>
            </div>
          </div>
          <div class="parameter-input">
            <label for="ari">Average Recurrence Interval (years)</label>
            <div class="input-with-lock">
                <NumericStepper
                  id="ari"
                  label="Average Recurrence Interval (years)"
                  min={0}
                  step={1}
                  bind:value={selectedAri}
                  on:change={handleAriInput}
                  class:recalculated={recentlyRecalculated === 'ari'}
                />
                <button 
                  class="lock-button" 
                  class:locked={lockedParameter === 'ari'}
                  on:click={() => setLocked('ari')}
                  title="Lock this parameter"
                >
                  {lockedParameter === 'ari' ? '🔒' : '🔓'}
                </button>
            </div>
          </div>
        </div>

        <div class="grid cols-3 form-grid form-grid--secondary">
          <div class="align-center">
            <label for="dist">Distribution</label>
            <select id="dist" bind:value={distribution}>
              <option value="scs_type_i">SCS Type I</option>
              <option value="scs_type_ia">SCS Type IA</option>
              <option value="scs_type_ii">SCS Type II</option>
              <option value="scs_type_iii">SCS Type III</option>
              <option value="huff_q1">Huff Q1</option>
              <option value="huff_q2">Huff Q2</option>
              <option value="huff_q3">Huff Q3</option>
              <option value="huff_q4">Huff Q4</option>
              <option value="user">User CSV (cumulative 0..1)</option>
            </select>
          </div>
          <div>
            <label for="timestep">Timestep (min)</label>
            <NumericStepper
              id="timestep"
              label="Timestep (min)"
              min={0.1}
              step={1}
              bind:value={timestepMin}
              on:change={handleTimestepInput}
            />
          </div>
          <div class="align-center">
            <label for="start">Start (ISO)</label>
            <input id="start" type="datetime-local" bind:value={startISO} />
          </div>
        </div>

        <div>
          <label for="curve">Custom Curve CSV</label>
          <textarea
            id="curve"
            rows="3"
            placeholder="t (0..1), cumulative (0..1)"
            bind:value={customCurveCsv}
          ></textarea>
        </div>

        <div class="actions">
          <button class="primary" on:click={makeStorm}>Generate Storm</button>
          <button on:click={doCsv} disabled={!lastStorm}>Export CSV</button>
          <button on:click={doDat} disabled={!lastStorm}>Export DAT</button>
          <button class="ghost help-button" type="button" on:click={openHelp}>Help / Docs</button>
        </div>

        <div class="stats grid cols-3">
          <div class="stat-box">
            <div class="stat-title">Total Depth</div>
            <div class="stat-value">{totalDepth.toFixed(3)} in</div>
          </div>
          <div class="stat-box">
            <div class="stat-title">Peak Intensity</div>
            <div class="stat-value">{peakIntensity.toFixed(2)} in/hr</div>
          </div>
          <div class="stat-box">
            <div class="stat-title">Selected Average Recurrence Interval</div>
            <div class="stat-value">{selectedAri} years</div>
          </div>
        </div>
      </div>
    </section>

    <section class="column">
      <div class="panel plot">
        <div bind:this={plotDiv1} class="plot-area"></div>
      </div>
      <div class="panel plot">
        <div bind:this={plotDiv2} class="plot-area"></div>
      </div>
      <div class="panel plot">
        <div bind:this={plotDiv3} class="plot-area"></div>
      </div>
      <div class="panel results">
        <h2 class="section-title">Storm Table</h2>
        {#if tableRows.length}
          <div
            class="table-scroll"
            bind:this={tableScrollEl}
            style:max-height={`${tableScrollMaxHeight}px`}
          >
            <table class="data-table">
              <thead>
                <tr>
                  <th class="left">{timeColumnLabel}</th>
                  <th>Intensity (in/hr)</th>
                  <th>Incremental (in)</th>
                  <th>Cumulative (in)</th>
                  {#if hasTimestamp}
                    <th class="left">Datetime</th>
                  {/if}
                </tr>
              </thead>
              <tbody>
                {#each tableRows as row}
                  <tr>
                    <td class="left">{row.time.toFixed(2)}</td>
                    <td>{row.intensity.toFixed(2)}</td>
                    <td>{row.incremental.toFixed(3)}</td>
                    <td>{row.cumulative.toFixed(3)}</td>
                    {#if hasTimestamp}
                      <td class="left">{row.timestamp}</td>
                    {/if}
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else}
          <p class="empty">Generate a storm to see the time series table.</p>
        {/if}
      </div>
    </section>
  </div>
</div>

{#if showHelp}
  <div class="modal-backdrop" role="presentation" on:click={closeHelp} on:keydown={handleKeydown}>
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="help-title"
      tabindex="-1"
      bind:this={helpDialog}
      on:click|stopPropagation
    >
      <div class="modal-content">
        <h2 id="help-title">Design Storm Generator</h2>
        <p>
          <strong>Purpose.</strong>
          Build synthetic hyetographs from NOAA Atlas 14 depths and temporal patterns. SCS storm types use
          official NRCS dimensionless cumulative rainfall tables; other presets rely on Beta(α,β) shapes.
          Optionally, supply a custom cumulative curve (CSV).
        </p>
        <h3>Workflow</h3>
        <ol>
          <li>Pick a location on the map (NOAA table refreshes automatically).</li>
          <li>
            Click a cell in the NOAA table to set <em>Return period (Average Recurrence Interval)</em>,
            <em>Depth</em>, and <em>Duration</em>.
          </li>
          <li>
            Choose a distribution (SCS types use dimensionless tables; Huff quartiles use Beta
            approximations).
          </li>
          <li>Export CSV / DAT (DAT always in in/hr).</li>
        </ol>
        <h3>Interpolation</h3>
        <p>
          When <i>Use NOAA selection</i> is <b>unchecked</b>:
        editing <i>Return period</i> will interpolate <i>Depth</i> along the selected duration row.
        Editing <i>Duration</i> or <i>Total depth</i> updates <i>Return period</i> to stay consistent.</p>
        <h3>Methods</h3>
        <p>
          Temporal patterns originate either from NRCS dimensionless cumulative rainfall tables (Types I, IA,
          II, III) resampled to the storm duration or from predefined Beta(α,β) distributions on [0,1] for the
          remaining presets. No circular shifting is applied. User-supplied curves are normalized and
          resampled.
        </p>
      </div>
      <div class="modal-actions">
        <button type="button" on:click={closeHelp}>Close</button>
      </div>
    </div>
  </div>
{/if}

<style>
  :global(.leaflet-pane) {
    filter: saturate(0.9) brightness(0.9);
  }

  .page {
    min-height: 100vh;
    padding: clamp(1.25rem, 2.5vw + 1rem, 2.75rem);
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: clamp(1.25rem, 1.5vw + 1rem, 2rem);
  }

  .header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: clamp(0.75rem, 1.2vw + 0.5rem, 1.25rem);
    text-align: center;
  }

  .title-group {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: clamp(0.6rem, 0.9vw + 0.4rem, 1rem);
  }

  .app-icon {
    width: clamp(40px, 4vw + 24px, 56px);
    height: clamp(40px, 4vw + 24px, 56px);
    border-radius: 12px;
    box-shadow: 0 10px 24px rgba(0, 0, 0, 0.35);
    flex: 0 0 auto;
  }

  .title-text {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .header h1 {
    margin: 0 0 6px;
    font-size: 22px;
    font-weight: 600;
  }

  .badge {
    background: rgba(110, 231, 255, 0.15);
    color: #6ee7ff;
    border: 1px solid rgba(110, 231, 255, 0.4);
    border-radius: 20px;
    padding: 6px 14px;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .header > * {
    flex: 1 1 100%;
  }

  .header .badge {
    flex: 0 0 auto;
    margin-inline: auto;
  }

  .layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: clamp(1.25rem, 1.5vw + 1rem, 2rem);
    flex: 1;
  }

  @media (min-width: 600px) {
    .layout {
      gap: clamp(1.5rem, 1vw + 1.25rem, 2.25rem);
    }

    .header {
      gap: clamp(0.75rem, 0.6vw + 0.75rem, 1.5rem);
    }
  }

  @media (min-width: 768px) {
    .header {
      justify-content: space-between;
      text-align: left;
    }

    .title-group {
      justify-content: flex-start;
    }

    .header > * {
      flex: 0 0 auto;
    }

    .header .badge {
      margin-inline: 0 0;
      margin-left: auto;
    }
  }

  @media (min-width: 900px) {
    .layout {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: clamp(1.75rem, 1.5vw + 1.5rem, 2.5rem);
    }

    .header {
      flex-wrap: nowrap;
    }
  }

  .column {
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-height: 0;
  }

  .section-title {
    font-size: 14px;
    font-weight: 600;
    margin-top: 0;
    margin-bottom: 12px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
  }

  .location-search {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 12px;
  }

  .location-search label {
    font-size: 12px;
    color: var(--muted);
    display: block;
    margin-bottom: 6px;
  }

  .search-controls {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .search-controls input[type='text'] {
    flex: 1;
    min-width: 0;
  }

  .location-search button[type='submit'] {
    white-space: nowrap;
  }

  .search-feedback {
    font-size: 12px;
    color: var(--muted);
  }

  .search-feedback.error {
    color: var(--err);
  }

  .map {
    height: clamp(240px, 32vh, 360px);
    border-radius: 14px;
    overflow: hidden;
    margin-bottom: 12px;
  }

  .options-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-top: 12px;
    flex-wrap: wrap;
  }

  .form-grid {
    gap: 14px;
  }

  .form-grid + .form-grid {
    margin-top: 18px;
  }

  .form-grid--secondary {
    align-items: stretch;
  }

  .form-grid--secondary .align-center {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 6px;
    height: 100%;
  }

  .checkbox {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--muted);
  }

  .checkbox input[type='checkbox'] {
    width: 16px;
    height: 16px;
  }

  .noaa-status {
    margin-top: 8px;
    font-size: 12px;
    color: var(--muted);
  }

  .noaa-status .error {
    color: var(--err);
  }

  .noaa-table-scroll {
    margin-top: 16px;
    border-radius: 16px;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }

  .noaa-table {
    padding: 0;
    overflow: visible;
    width: max-content;
    min-width: 100%;
  }

  .table-header,
  .table-row {
    display: grid;
    grid-template-columns: minmax(120px, auto) minmax(0, 1fr);
  }

  .table-header {
    background: rgba(255, 255, 255, 0.03);
    border-bottom: 1px solid var(--border);
  }

  .ari-header {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .ari-label {
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .table-header > div,
  .table-row > div {
    padding: 10px;
    font-size: 12px;
  }

  .table-body {
    max-height: 320px;
    overflow-y: auto;
  }

  .table-row {
    border-bottom: 1px solid rgba(255, 255, 255, 0.04);
  }

  .table-row:hover {
    background: rgba(255, 255, 255, 0.04);
  }

  .table-row.active {
    background: rgba(110, 231, 255, 0.06);
  }

  .table-button {
    background: transparent;
    border: none;
    color: inherit;
    font: inherit;
    padding: 8px 10px;
    text-align: left;
    width: 100%;
    cursor: pointer;
    border-radius: 0;
  }

  .table-button:hover {
    background: rgba(110, 231, 255, 0.12);
  }

  .table-button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .duration-btn {
    font-weight: 600;
  }

  .duration-btn.active {
    background: rgba(110, 231, 255, 0.08);
  }

  .aris {
    gap: 0;
    border-left: 1px solid rgba(255, 255, 255, 0.04);
    min-width: max-content;
  }

  .table-button.cell {
    text-align: center;
    border-left: 1px solid rgba(255, 255, 255, 0.04);
  }

  .table-button.cell:first-child {
    border-left: none;
  }

  .table-button.cell:hover {
    background: rgba(110, 231, 255, 0.12);
  }

  .table-button.cell.selected {
    background: var(--accent);
    color: #04131c;
    font-weight: 600;
  }

  .table-button.cell.selected:hover {
    background: var(--accent);
  }

  .table-button.cell.interpolated {
    background: rgba(249, 115, 22, 0.4);
    color: #04131c;
    font-weight: 600;
  }

  .table-button.cell.interpolated:hover {
    background: rgba(249, 115, 22, 0.55);
  }

  textarea {
    resize: vertical;
  }

  @media (max-width: 600px) {
    .noaa-table-scroll {
      overflow-x: visible;
    }

    .noaa-table {
      width: 100%;
      min-width: 0;
    }

    .table-header {
      display: none;
    }

    .table-body {
      max-height: none;
      overflow: visible;
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 12px;
    }

    .table-row {
      grid-template-columns: 1fr;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.02);
      overflow: hidden;
    }

    .table-row > div {
      padding: 0;
    }

    .table-row > div:first-child {
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }

    .table-row.active {
      background: rgba(110, 231, 255, 0.06);
    }

    .duration-btn {
      text-align: center;
      padding: 14px;
    }

    .duration-btn.active {
      background: rgba(110, 231, 255, 0.12);
    }

    .aris {
      border-left: none;
      padding: 12px;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 10px;
      min-width: 0;
    }

    .table-button.cell {
      border-left: none;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 12px;
      text-align: left;
      padding: 12px;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 4px;
    }

    .table-button.cell::before {
      content: 'Average Recurrence Interval — ' attr(data-ari) ' yr';
      font-size: 11px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--muted);
    }

    .table-button.cell.selected,
    .table-button.cell.interpolated {
      color: #04131c;
    }

    .table-button.cell.selected::before,
    .table-button.cell.interpolated::before {
      color: rgba(4, 19, 28, 0.7);
    }
  }

  .actions {
    display: flex;
    gap: 10px;
    margin: 14px 0;
    align-items: center;
    flex-wrap: wrap;
  }

  .plot {
    flex: 0 0 auto;
  }

  .plot-area {
    height: clamp(220px, 40vh, 320px);
  }

  .results {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }

  .table-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: auto;
    max-height: none;
    border: 1px solid var(--border);
    border-radius: 10px;
  }

  .data-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    min-width: 100%;
  }

  .data-table th,
  .data-table td {
    padding: 8px 10px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    text-align: right;
    white-space: nowrap;
  }

  .data-table th {
    background: rgba(255, 255, 255, 0.05);
    position: sticky;
    top: 0;
    z-index: 1;
  }

  .data-table tr:nth-child(even) {
    background: rgba(255, 255, 255, 0.02);
  }

  .data-table .left {
    text-align: left;
  }

  .empty {
    font-size: 12px;
    color: var(--muted);
    margin: 0;
  }

  .stats {
    margin-top: 12px;
  }

  .stat-box {
    background: #0f131a;
    border-radius: 12px;
    padding: 12px;
    border: 1px solid var(--border);
  }

  .stat-title {
    font-size: 11px;
    letter-spacing: 0.06em;
    color: var(--muted);
    text-transform: uppercase;
  }

  .stat-value {
    margin-top: 6px;
    font-size: 20px;
    font-weight: 600;
  }

  button.ghost {
    background: transparent;
    border: 1px solid var(--border);
    color: inherit;
  }

  button.ghost:hover {
    background: rgba(255, 255, 255, 0.05);
  }

  .help-button {
    margin-left: auto;
  }

  @media (max-width: 720px) {
    .form-grid {
      gap: 18px;
    }
  }

  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(5, 12, 18, 0.78);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    box-sizing: border-box;
    z-index: 1000;
  }

  .modal {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 16px;
    max-width: 720px;
    width: min(720px, 100%);
    max-height: calc(100vh - 80px);
    overflow: auto;
    padding: 24px 24px 16px;
    box-shadow: 0 30px 60px rgba(0, 0, 0, 0.45);
    outline: none;
  }

  .modal-content h2 {
    margin-top: 0;
  }

  .modal-content h3 {
    margin-top: 20px;
    margin-bottom: 8px;
  }

  .modal-content p {
    line-height: 1.6;
  }

  .modal-content ol {
    padding-left: 20px;
  }

  .modal-actions {
    margin-top: 20px;
    display: flex;
    justify-content: flex-end;
  }

  .modal-actions button {
    min-width: 90px;
  }

  @media (max-width: 640px) {
    .page {
      padding: 16px;
    }

    .search-controls {
      flex-direction: column;
      align-items: stretch;
      gap: 10px;
    }

    .search-controls button[type='submit'] {
      align-self: flex-start;
    }

    .grid.cols-2 {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 10px;
    }

    .options-row {
      flex-direction: column;
      align-items: flex-start;
      gap: 10px;
    }

    .options-row button {
      align-self: flex-start;
    }

    .map {
      height: clamp(260px, 48vh, 420px);
    }
  }

  @media (max-width: 1024px) {
    .layout {
      grid-template-columns: 1fr;
    }

    .plot-area {
      height: clamp(200px, 45vh, 280px);
    }
  }

  @media (max-width: 600px) {
    .column {
      gap: 14px;
    }

    .panel.plot {
      padding: 10px;
    }

    .data-table {
      font-size: 11px;
    }

    .data-table th,
    .data-table td {
      padding: 6px 8px;
    }
  }
  .input-with-lock {
    display: flex;
    align-items: center;
  }
  .lock-button {
    margin-left: 8px;
    background: transparent;
    border: 1px solid var(--border);
    color: var(--muted);
    width: 36px;
    height: 36px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .lock-button.locked {
    background: var(--accent);
    color: #04131c;
  }
  
  .recalculated {
      transition: box-shadow 0.5s ease-out;
      box-shadow: 0 0 0 2px var(--accent);
  }
</style>
