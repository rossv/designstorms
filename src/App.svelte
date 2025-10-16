<script lang="ts">
  import { onMount, onDestroy, tick, afterUpdate } from 'svelte'
  import * as L from 'leaflet'
  import markerIcon2xUrl from 'leaflet/dist/images/marker-icon-2x.png'
  import markerIconUrl from 'leaflet/dist/images/marker-icon.png'
  import markerShadowUrl from 'leaflet/dist/images/marker-shadow.png'
  import Plotly from 'plotly.js-dist-min'
  import { fetchNoaaTable, parseNoaaTable, type NoaaTable } from './lib/noaaClient'
  import {
    generateStorm,
    getBestScsDistribution,
    type StormParams,
    type DistributionName
  } from './lib/stormEngine'
  import {
    toHours,
    getSortedDurationRows,
    getRowForCalculation,
    interpolateAriForDuration,
    interpolateDepthFromAri,
    type InterpolationCell
  } from './lib/rainfall'
  import { saveCsv, savePcswmmDat } from './lib/export'
  import NumericStepper from './lib/components/NumericStepper.svelte'
  import designStormIcon from './design_storm.ico'

  let mapDiv: HTMLDivElement
  let plotDiv1: HTMLDivElement
  let plotDiv2: HTMLDivElement
  let plotDiv3: HTMLDivElement
  let isoPlotDiv: HTMLDivElement
  let curvePlotDiv: HTMLDivElement | null = null
  let curveModalDialog: HTMLDivElement | null = null
  let customCurveModalDialog: HTMLDivElement | null = null
  let customCurveTextarea: HTMLTextAreaElement | null = null

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
  let noaaTableScrollEl: HTMLDivElement | null = null
  let pendingNoaaScrollIndex: number | null = null
  let durations: string[] = []
  let aris: string[] = []
  let selectedDurationLabel: string | null = null
  const DEFAULT_DURATION_HOURS = 24
  const MIN_DURATION_HOURS = 1 / 60
  const DEFAULT_ARI_YEARS = 2

  let selectedAri = 10
  let selectedDepth = 1.0
  let selectedDurationHr = 24
  let durationMode: 'standard' | 'custom' = 'standard'
  const STANDARD_DURATION_HOURS = [6, 12, 24] as const

  const SCS_COMPARISON_DISTRIBUTIONS: DistributionName[] = [
    'scs_type_i',
    'scs_type_ia',
    'scs_type_ii',
    'scs_type_iii'
  ]

  const HUFF_COMPARISON_DISTRIBUTIONS: DistributionName[] = [
    'huff_q1',
    'huff_q2',
    'huff_q3',
    'huff_q4'
  ]

  type ComparisonGroup = {
    key: string
    label: string
    members: DistributionName[]
  }

  const DISTRIBUTION_LABELS: Partial<Record<DistributionName, string>> = {
    scs_type_i: 'SCS Type I',
    scs_type_ia: 'SCS Type IA',
    scs_type_ii: 'SCS Type II',
    scs_type_iii: 'SCS Type III',
    scs_type_i_24hr: 'SCS Type I (24-hr)',
    scs_type_ia_24hr: 'SCS Type IA (24-hr)',
    scs_type_ii_6hr: 'SCS Type II (6-hr)',
    scs_type_ii_12hr: 'SCS Type II (12-hr)',
    scs_type_ii_24hr: 'SCS Type II (24-hr)',
    scs_type_iii_6hr: 'SCS Type III (6-hr)',
    scs_type_iii_12hr: 'SCS Type III (12-hr)',
    scs_type_iii_24hr: 'SCS Type III (24-hr)',
    huff_q1: 'Huff Q1',
    huff_q2: 'Huff Q2',
    huff_q3: 'Huff Q3',
    huff_q4: 'Huff Q4',
    user: 'User CSV'
  }

  function getDistributionLabel(name: DistributionName) {
    if (DISTRIBUTION_LABELS[name]) {
      return DISTRIBUTION_LABELS[name] as string
    }
    return name
      .replace(/scs_/i, 'SCS ')
      .replace(/_/g, ' ')
      .replace(/\b(hr)\b/i, 'hr')
      .replace(/\b(q)(\d)/i, 'Q$2')
      .replace(/\btype\b/i, 'Type')
      .replace(/\biii\b/i, 'III')
      .replace(/\bia\b/i, 'IA')
  }

  function getComparisonGroup(name: DistributionName): ComparisonGroup {
    if (name.startsWith('huff_')) {
      return {
        key: 'huff',
        label: 'Huff Quartiles',
        members: HUFF_COMPARISON_DISTRIBUTIONS
      }
    }
    if (name.startsWith('scs_type')) {
      return {
        key: 'scs',
        label: 'SCS Dimensionless Distributions',
        members: SCS_COMPARISON_DISTRIBUTIONS
      }
    }
    return {
      key: name,
      label: getDistributionLabel(name),
      members: [name]
    }
  }

  let interpolatedCells: InterpolationCell[] = []
  type NoaaRow = NoaaTable['rows'][number]

  let timestepMin = 5
  let distribution: DistributionName = 'scs_type_ii'
  let startISO = '2003-01-01T00:00'
  let customCurveCsv = ''
  let customCurveDraft = ''
  let showCustomCurveModal = false
  let customCurveLines: string[] = []

  $: customCurveLines = customCurveCsv.trim()
    ? customCurveCsv
        .trim()
        .split(/\r?\n/)
    : []
  let showHelp = false
  let showCurveModal = false
  let helpDialog: HTMLDivElement | null = null

  let isLoadingNoaa = false
  let noaaError = ''

  let lastStorm: ReturnType<typeof generateStorm> | null = null
  
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

  type ComparisonCurve = {
    distribution: DistributionName
    label: string
    timeHr: number[]
    fraction: number[]
    rows: { time: number; fraction: number }[]
  }

  let comparisonCurves: ComparisonCurve[] = []
  let selectedCurveDuration: (typeof STANDARD_DURATION_HOURS)[number] | null = null
  let selectedCurveDistribution: DistributionName | null = null
  let lastCurveParamsKey = ''
  let selectedCurveData: ComparisonCurve | null = null
  let comparisonGroupLabel = ''

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

  function reduceTickEntries<T>(entries: T[], maxCount: number) {
    if (!Number.isFinite(maxCount) || maxCount <= 0) {
      return entries
    }

    if (entries.length <= maxCount) {
      return entries
    }

    const step = Math.ceil(entries.length / maxCount)
    return entries.filter((_, index) => index % step === 0 || index === entries.length - 1)
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
    const hadTable = Boolean(table)
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
      const defaultDurationLabel = parsed.rows.find(
        (r) => Math.abs(toHours(r.label) - DEFAULT_DURATION_HOURS) < 1e-6
      )?.label
      const defaultDurationIndex = defaultDurationLabel
        ? parsed.rows.findIndex((r) => r.label === defaultDurationLabel)
        : -1
      pendingNoaaScrollIndex = defaultDurationIndex >= 0 ? defaultDurationIndex : null
      if (!hadTable && defaultDurationLabel) {
        selectedDurationLabel = defaultDurationLabel
      } else if (
        !selectedDurationLabel ||
        !parsed.rows.some((r) => r.label === selectedDurationLabel)
      ) {
        selectedDurationLabel = defaultDurationLabel ?? parsed.rows[0]?.label ?? null
      }
      if (!hadTable && aris.includes(String(DEFAULT_ARI_YEARS))) {
        selectedAri = DEFAULT_ARI_YEARS
      }
      if (!aris.includes(String(selectedAri)) && aris.length) {
        selectedAri = Number(aris[0])
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
      drawIsoPlot()
    } finally {
      isLoadingNoaa = false
    }
  }

  function matchesStandardDurationHours(hours: number) {
    return STANDARD_DURATION_HOURS.some((standard) => Math.abs(hours - standard) < 1e-6)
  }

  function hasComparisonCurveForDuration(name: DistributionName, duration: number) {
    if (!name.startsWith('scs_type')) {
      return true
    }

    const matched = getBestScsDistribution(name, duration, 'standard')
    const match = matched.match(/_(\d+)hr$/i)
    if (!match) {
      return true
    }
    const bestDuration = Number(match[1])
    if (!Number.isFinite(bestDuration)) {
      return true
    }
    return Math.abs(bestDuration - duration) < 1e-6
  }

  function nearestStandardDuration(hours: number) {
    if (!Number.isFinite(hours)) {
      return DEFAULT_DURATION_HOURS
    }
    return STANDARD_DURATION_HOURS.reduce((best, candidate) => {
      const bestDiff = Math.abs(best - hours)
      const candidateDiff = Math.abs(candidate - hours)
      if (candidateDiff < bestDiff) {
        return candidate
      }
      return best
    })
  }

  function durationLabelIsStandard(label: string) {
    const hours = toHours(label)
    if (!Number.isFinite(hours)) {
      return false
    }
    return matchesStandardDurationHours(hours)
  }

  function durationIsSelectable(label: string) {
    if (durationMode === 'custom') {
      return true
    }
    return durationLabelIsStandard(label)
  }

  let previousDurationMode: 'standard' | 'custom' = durationMode

  $: if (durationMode !== previousDurationMode) {
    previousDurationMode = durationMode
    makeStorm()
  }

  function pickCell(durLabel: string, ari: string) {
    if (!table) return
    if (!durationIsSelectable(durLabel)) return
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
    const interpolated = interpolateDepthFromAri(row, selectedAri, table.aris)
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
      customCurveCsv: customCurveCsv.trim() || undefined,
      durationMode
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

    drawIsoPlot()
  }

  function drawIsoPlot() {
    if (!isoPlotDiv) return

    if (!table || !aris.length) {
      Plotly.purge(isoPlotDiv)
      detachIsoPlotClickHandler()
      return
    }

    const durationEntries = getSortedDurationRows(table)
    if (!durationEntries.length) {
      Plotly.purge(isoPlotDiv)
      detachIsoPlotClickHandler()
      return
    }

    const ariEntries = aris
      .map((key) => ({ key, value: Number(key) }))
      .filter((entry) => Number.isFinite(entry.value))
      .sort((a, b) => a.value - b.value)

    if (!ariEntries.length) {
      Plotly.purge(isoPlotDiv)
      detachIsoPlotClickHandler()
      return
    }

    const contourZ = durationEntries.map(({ row }) =>
      ariEntries.map((entry) => {
        const depth = row.values[entry.key]
        return Number.isFinite(depth) ? Number(depth) : null
      })
    )

    const customData = durationEntries.map((entry) =>
      ariEntries.map(() => entry.label)
    )

    const finiteDepths = contourZ
      .flat()
      .filter((value): value is number => value !== null && Number.isFinite(value))

    if (!finiteDepths.length) {
      Plotly.purge(isoPlotDiv)
      detachIsoPlotClickHandler()
      return
    }

    let minDepth = Math.min(...finiteDepths)
    let maxDepth = Math.max(...finiteDepths)

    if (!Number.isFinite(minDepth) || !Number.isFinite(maxDepth)) {
      Plotly.purge(isoPlotDiv)
      detachIsoPlotClickHandler()
      return
    }

    minDepth = Math.floor(minDepth * 2) / 2
    maxDepth = Math.ceil(maxDepth * 2) / 2

    if (maxDepth - minDepth < 0.5) {
      maxDepth = minDepth + 0.5
    }

    const bounds = isoPlotDiv.getBoundingClientRect()
    const width = bounds.width || isoPlotDiv.clientWidth || 0
    const height = bounds.height || isoPlotDiv.clientHeight || 0
    const isCompact = width <= 640

    const maxXTicks = Math.max(3, Math.floor((width || 1) / 70))
    const maxYTicks = Math.max(4, Math.floor((height || 1) / 38))

    const filteredAriEntries = reduceTickEntries(ariEntries, maxXTicks)
    const filteredDurationEntries = reduceTickEntries(durationEntries, maxYTicks)

    const colorbar: Partial<Plotly.ColorBar> = {
      title: 'Depth (in)',
      thickness: isCompact ? 10 : 14,
      tickcolor: '#e7e7e7',
      tickfont: { color: '#e7e7e7', size: isCompact ? 10 : 12 },
      outlinecolor: 'rgba(255, 255, 255, 0.1)',
      titlefont: { color: '#e7e7e7', size: isCompact ? 12 : undefined }
    }

    if (isCompact) {
      colorbar.orientation = 'h'
      colorbar.lenmode = 'fraction'
      colorbar.len = 0.6
      colorbar.x = 0.5
      colorbar.y = -0.32
      colorbar.xanchor = 'center'
      colorbar.yanchor = 'top'
      colorbar.ticklen = 3
    } else {
      colorbar.orientation = 'v'
      colorbar.len = 1
      colorbar.x = 1.05
      colorbar.y = 0.5
      colorbar.ticklen = 5
    }

    const contourTrace = {
      type: 'contour',
      x: ariEntries.map((entry) => entry.value),
      y: durationEntries.map((entry) => entry.hr),
      z: contourZ,
      customdata: customData,
      contours: {
        coloring: 'heatmap',
        start: minDepth,
        end: maxDepth,
        size: 0.5,
        showlabels: true,
        labelfont: { color: '#0f172a', size: isCompact ? 10 : 11 }
      },
      line: { color: 'rgba(15, 23, 42, 0.35)', smoothing: 0.6, width: 1 },
      colorscale: [
        [0, '#e2f1ff'],
        [0.2, '#bfd7ff'],
        [0.4, '#89b3ff'],
        [0.6, '#4f7dd9'],
        [0.8, '#20499f'],
        [1, '#0b1f4b']
      ],
      colorbar,
      hovertemplate:
        'ARI: %{x}<br>Duration: %{customdata} (%{y:.2f} hr)<br>Depth: %{z:.2f} in<extra></extra>',
      showscale: true
    }

    const pointXs: number[] = []
    const pointYs: number[] = []
    const pointLabels: string[] = []
    durationEntries.forEach((duration) => {
      if (durationMode === 'standard' && !durationIsSelectable(duration.label)) {
        return
      }
      ariEntries.forEach((ari) => {
        const depth = duration.row.values[ari.key]
        if (Number.isFinite(depth)) {
          pointXs.push(ari.value)
          pointYs.push(duration.hr)
          pointLabels.push(duration.label)
        }
      })
    })

    const pointsTrace = {
      type: 'scatter',
      mode: 'markers',
      x: pointXs,
      y: pointYs,
      customdata: pointLabels,
      marker: {
        color: 'rgba(226, 241, 255, 0.85)',
        size: 8,
        line: { color: 'rgba(11, 31, 75, 0.9)', width: 1.5 },
        symbol: 'circle'
      },
      hovertemplate:
        'ARI: %{x}<br>Duration: %{customdata} (%{y:.2f} hr)<extra></extra>',
      name: 'NOAA data points',
      showlegend: false
    }

    let stormParametersTrace: any = null
    const stormDuration = Number(selectedDurationHr)
    const stormAri = Number(selectedAri)
    const stormDepth = Number(selectedDepth)
    if (stormDuration > 0 && Number.isFinite(stormDuration) && stormAri > 0 && Number.isFinite(stormAri)) {
      const depthLine = Number.isFinite(stormDepth) ? `<br>Depth: ${stormDepth.toFixed(3)} in` : ''
      stormParametersTrace = {
        type: 'scatter',
        mode: 'markers',
        x: [stormAri],
        y: [stormDuration],
        marker: {
          color: '#ef4444',
          size: 12,
          line: { color: '#fee2e2', width: 2 },
          symbol: 'diamond'
        },
        name: 'Current storm parameters',
        showlegend: false,
        hovertemplate: `Selected Storm — ARI: ${stormAri}<br>Duration: ${stormDuration.toFixed(2)} hr${depthLine}<extra></extra>`
      }
    }

    let highlightTrace: any = null
    if (table && selectedDurationLabel) {
      const highlightDuration = durationEntries.find(
        (entry) => entry.label === selectedDurationLabel
      )
      const highlightAri = ariEntries.find((entry) => entry.key === String(selectedAri))
      const depth = highlightDuration?.row.values[highlightAri?.key ?? '']
      if (highlightDuration && highlightAri && Number.isFinite(depth)) {
        highlightTrace = {
          type: 'scatter',
          mode: 'markers',
          x: [highlightAri.value],
          y: [highlightDuration.hr],
          marker: {
            color: '#f8fafc',
            size: 12,
            line: { color: '#0ea5e9', width: 3 },
            symbol: 'circle'
          },
          name: 'Selected NOAA cell',
          showlegend: false,
          hovertemplate: `ARI: ${highlightAri.value}<br>Duration: ${highlightDuration.label} (${highlightDuration.hr.toFixed(
            2
          )} hr)<br>Depth: ${(depth as number).toFixed(3)} in<extra></extra>`
        }
      }
    }

    const layout: Partial<Plotly.Layout> = {
      ...plotLayoutBase,
      title: 'NOAA Depth Iso-Lines',
      margin: isCompact
        ? { l: 64, r: 26, t: 48, b: 96 }
        : { l: 72, r: 70, t: 40, b: 88 },
      xaxis: {
        ...plotLayoutBase.xaxis,
        title: 'Average Recurrence Interval (years)',
        type: 'log',
        tickmode: 'array',
        tickvals: filteredAriEntries.map((entry) => entry.value),
        ticktext: filteredAriEntries.map((entry) => entry.key),
        tickangle: isCompact ? -45 : 0,
        tickfont: { size: isCompact ? 10 : 12 },
        titlefont: { size: isCompact ? 12 : undefined },
        automargin: true
      },
      yaxis: {
        ...plotLayoutBase.yaxis,
        title: 'Duration (hr)',
        type: 'log',
        tickmode: 'array',
        tickvals: filteredDurationEntries.map((entry) => entry.hr),
        ticktext: filteredDurationEntries.map((entry) => entry.label),
        tickfont: { size: isCompact ? 10 : 12 },
        titlefont: { size: isCompact ? 12 : undefined },
        automargin: true
      },
      hovermode: 'closest',
      hoverlabel: {
        bgcolor: '#0f172a',
        bordercolor: '#38bdf8',
        font: {
          color: '#f8fafc'
        }
      }
    }

    const data: any[] = [contourTrace]
    if (pointXs.length) {
      data.push(pointsTrace)
    }
    if (stormParametersTrace) {
      data.push(stormParametersTrace)
    }
    if (highlightTrace) {
      data.push(highlightTrace)
    }

    Plotly.react(isoPlotDiv, data, layout, {
      ...plotConfig,
      displayModeBar: false
    })

    if (pointXs.length) {
      attachIsoPlotClickHandler()
    } else {
      detachIsoPlotClickHandler()
    }
  }

  const handleIsoPlotClick = (event: any) => {
    if (durationMode !== 'custom') return
    const point = event?.points?.[0]
    if (!point || point.data?.name !== 'NOAA data points') return

    const ariEntries = aris
      .map((key) => ({ key, value: Number(key) }))
      .filter((entry) => Number.isFinite(entry.value))
      .sort((a, b) => a.value - b.value)

    const durationEntries = getSortedDurationRows(table!)
    if (!ariEntries.length || !durationEntries.length) return

    const nearestAri = ariEntries.reduce(
      (best, entry) => {
        const diff = Math.abs(entry.value - point.x)
        return diff < best.diff ? { diff, entry } : best
      },
      { diff: Number.POSITIVE_INFINITY, entry: ariEntries[0] }
    )

    const nearestDuration = durationEntries.reduce(
      (best, entry) => {
        const diff = Math.abs(entry.hr - point.y)
        return diff < best.diff ? { diff, entry } : best
      },
      { diff: Number.POSITIVE_INFINITY, entry: durationEntries[0] }
    )

    const selectedRow = nearestDuration.entry.row
    const ariKey = nearestAri.entry.key
    const depth = selectedRow.values[ariKey]

    if (!Number.isFinite(depth)) {
      return
    }

    if (!durationIsSelectable(nearestDuration.entry.label)) {
      return
    }

    pickCell(nearestDuration.entry.label, ariKey)
  }

  function attachIsoPlotClickHandler() {
    if (!isoPlotDiv) return
    const plotElement = isoPlotDiv as any
    if (typeof plotElement.removeListener === 'function') {
      plotElement.removeListener('plotly_click', handleIsoPlotClick)
    } else if (typeof plotElement.off === 'function') {
      plotElement.off('plotly_click', handleIsoPlotClick)
    }
    if (typeof plotElement.on === 'function') {
      plotElement.on('plotly_click', handleIsoPlotClick)
    }
  }

  function detachIsoPlotClickHandler() {
    if (!isoPlotDiv) return
    const plotElement = isoPlotDiv as any
    if (typeof plotElement.removeListener === 'function') {
      plotElement.removeListener('plotly_click', handleIsoPlotClick)
    } else if (typeof plotElement.off === 'function') {
      plotElement.off('plotly_click', handleIsoPlotClick)
    }
  }

  function cellIsInterpolated(durationLabel: string, ari: string) {
    return interpolatedCells.some(
      (cell) => cell.duration === durationLabel && cell.ari === ari
    )
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

    const result = interpolateAriForDuration(table, selectedDurationHr, selectedDepth, {
      preferredLabel: selectedDurationLabel ?? null
    })
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

  $: if (durationMode === 'standard') {
    let adjusted = false
    if (!matchesStandardDurationHours(selectedDurationHr)) {
      const nearest = nearestStandardDuration(selectedDurationHr)
      if (nearest !== selectedDurationHr) {
        selectedDurationHr = nearest
        adjusted = true
      }
    }
    if (selectedDurationLabel && !durationLabelIsStandard(selectedDurationLabel)) {
      selectedDurationLabel = null
      adjusted = true
    }
    if (adjusted) {
      recalcFromDepthOrDuration()
    }
  }

  function recalcFromAri() {
    if (!Number.isFinite(selectedAri) || !Number.isFinite(selectedDurationHr)) {
      return
    }
    if (!table) {
      interpolatedCells = []
      return
    }
    const { row, label } = getRowForCalculation(
      table,
      selectedDurationHr,
      selectedDurationLabel ?? null
    )
    if (!row || !label) {
      interpolatedCells = []
      return
    }
    if (selectedDurationLabel !== label) {
      selectedDurationLabel = label
    }
    const result = interpolateDepthFromAri(row, selectedAri, table.aris)
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
    recalcFromDepthOrDuration()
  }

  function handleDurationInput() {
    lastChangedBy = 'user';
    if (durationMode === 'standard') {
        if (selectedDurationHr !== 6 && selectedDurationHr !== 12 && selectedDurationHr !== 24) {
            if (selectedDurationHr < 9) selectedDurationHr = 6;
            else if (selectedDurationHr < 18) selectedDurationHr = 12;
            else selectedDurationHr = 24;
        }
    }
    recalcFromDepthOrDuration()
  }

  function handleAriInput() {
    lastChangedBy = 'user';
    recalcFromAri()
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

  async function openCustomCurveModal() {
    customCurveDraft = customCurveCsv
    showCustomCurveModal = true
    await tick()
    customCurveModalDialog?.focus()
    customCurveTextarea?.focus()
  }

  function closeCustomCurveModal() {
    showCustomCurveModal = false
  }

  function applyCustomCurveDraft() {
    customCurveCsv = customCurveDraft
    closeCustomCurveModal()
  }

  async function openHelp() {
    showHelp = true
    await tick()
    helpDialog?.focus()
  }

  function closeHelp() {
    showHelp = false
  }

  async function openCurveModal() {
    showCurveModal = true
    await tick()
    curveModalDialog?.focus()
    refreshComparisonCurves()
  }

  function closeCurveModal() {
    showCurveModal = false
    detachCurvePlotClickHandler()
    if (curvePlotDiv) {
      Plotly.purge(curvePlotDiv)
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      if (showCustomCurveModal) {
        event.preventDefault()
        closeCustomCurveModal()
        return
      }
      if (showCurveModal) {
        event.preventDefault()
        closeCurveModal()
        return
      }
      if (showHelp) {
        event.preventDefault()
        closeHelp()
      }
    }
  }

  function handleBackdropClick(event: MouseEvent) {
    if (event.target === event.currentTarget) {
      closeHelp()
    }
  }

  function handleCurveBackdropClick(event: MouseEvent) {
    if (event.target === event.currentTarget) {
      closeCurveModal()
    }
  }

  function handleCustomCurveBackdropClick(event: MouseEvent) {
    if (event.target === event.currentTarget) {
      closeCustomCurveModal()
    }
  }

  function updateSelectedCurveData() {
    selectedCurveData =
      selectedCurveDistribution != null
        ? comparisonCurves.find((curve) => curve.distribution === selectedCurveDistribution) ?? null
        : null
  }

  function setComparisonDuration(duration: (typeof STANDARD_DURATION_HOURS)[number]) {
    if (selectedCurveDuration === duration) {
      return
    }
    selectedCurveDuration = duration
    refreshComparisonCurves()
  }

  function refreshComparisonCurves() {
    if (!showCurveModal) return

    const group = getComparisonGroup(distribution)
    comparisonGroupLabel = group.label

    if (!selectedCurveDuration || !matchesStandardDurationHours(selectedCurveDuration)) {
      const preferred = matchesStandardDurationHours(selectedDurationHr)
        ? (nearestStandardDuration(selectedDurationHr) as (typeof STANDARD_DURATION_HOURS)[number])
        : STANDARD_DURATION_HOURS[0]
      selectedCurveDuration = preferred
    }

    const duration = selectedCurveDuration ?? STANDARD_DURATION_HOURS[0]
    const trimmedCsv = customCurveCsv.trim()
    const key = `${group.key}|${duration}|${timestepMin}|${trimmedCsv}`

    if (key === lastCurveParamsKey && comparisonCurves.length) {
      if (
        !selectedCurveDistribution ||
        !comparisonCurves.some((curve) => curve.distribution === selectedCurveDistribution)
      ) {
        const fallback = comparisonCurves.find((curve) => curve.distribution === distribution)
          ?? comparisonCurves[0]
        selectedCurveDistribution = fallback ? fallback.distribution : null
      }
      updateSelectedCurveData()
      drawComparisonCurves()
      return
    }

    lastCurveParamsKey = key

    const availableMembers = group.members.filter((member) =>
      hasComparisonCurveForDuration(member, duration)
    )

    comparisonCurves = availableMembers.map((member) => {
      const params: StormParams = {
        depthIn: 1,
        durationHr: duration,
        timestepMin,
        distribution: member,
        startISO,
        customCurveCsv: trimmedCsv || undefined,
        durationMode: 'standard'
      }

      const result = generateStorm(params)
      const totalDepth = result.cumulativeIn[result.cumulativeIn.length - 1] || 1
      const timeHr = result.timeMin.map((t) => t / 60)
      const fraction = result.cumulativeIn.map((value) =>
        totalDepth === 0 ? 0 : Math.min(1, Math.max(0, value / totalDepth))
      )

      if (timeHr.length > 0) {
        timeHr[timeHr.length - 1] = duration
      }
      if (fraction.length > 0) {
        fraction[fraction.length - 1] = 1
      }

      const rows = timeHr.map((time, index) => ({
        time,
        fraction: fraction[index] ?? 0
      }))

      return {
        distribution: member,
        label: getDistributionLabel(member),
        timeHr,
        fraction,
        rows
      }
    })

    if (comparisonCurves.length === 0) {
      selectedCurveDistribution = null
      selectedCurveData = null
      drawComparisonCurves()
      return
    }

    if (
      !selectedCurveDistribution ||
      !comparisonCurves.some((curve) => curve.distribution === selectedCurveDistribution)
    ) {
      const preferred =
        comparisonCurves.find((curve) => curve.distribution === distribution) ?? comparisonCurves[0]
      selectedCurveDistribution = preferred ? preferred.distribution : null
    }

    updateSelectedCurveData()
    drawComparisonCurves()
  }

  function setSelectedCurveDistribution(name: DistributionName) {
    if (!comparisonCurves.some((curve) => curve.distribution === name)) {
      return
    }
    selectedCurveDistribution = name
    updateSelectedCurveData()
    drawComparisonCurves()
  }

  const handleCurvePlotClick = (event: any) => {
    const point = event?.points?.[0]
    const dist = point?.data?.meta
    if (typeof dist === 'string') {
      setSelectedCurveDistribution(dist as DistributionName)
    }
  }

  function attachCurvePlotClickHandler() {
    if (!curvePlotDiv) return
    const plotElement = curvePlotDiv as any
    if (plotElement && typeof plotElement.on === 'function') {
      detachCurvePlotClickHandler()
      plotElement.on('plotly_click', handleCurvePlotClick)
    }
  }

  function detachCurvePlotClickHandler() {
    if (!curvePlotDiv) return
    const plotElement = curvePlotDiv as any
    if (plotElement) {
      if (typeof plotElement.removeListener === 'function') {
        plotElement.removeListener('plotly_click', handleCurvePlotClick)
      }
      if (typeof plotElement.off === 'function') {
        plotElement.off('plotly_click', handleCurvePlotClick)
      }
    }
  }

  function drawComparisonCurves() {
    if (!curvePlotDiv) return
    if (!comparisonCurves.length) {
      Plotly.purge(curvePlotDiv)
      detachCurvePlotClickHandler()
      return
    }

    const traces = comparisonCurves.map((curve) => ({
      x: curve.timeHr,
      y: curve.fraction,
      type: 'scatter',
      mode: 'lines',
      name: curve.label,
      line: { width: curve.distribution === selectedCurveDistribution ? 4 : 2 },
      opacity: curve.distribution === selectedCurveDistribution ? 1 : 0.55,
      hovertemplate: `Time: %{x:.2f} hr<br>Rain fraction: %{y:.3f}<extra></extra>`,
      meta: curve.distribution
    }))

    const maxDuration = selectedCurveDuration ?? Math.max(...comparisonCurves.map((curve) => curve.timeHr[curve.timeHr.length - 1] ?? 0))

    Plotly.react(
      curvePlotDiv,
      traces,
      {
        ...plotLayoutBase,
        title: `${comparisonGroupLabel || 'Distribution'} Comparison — ${maxDuration}-hr`,
        xaxis: {
          ...plotLayoutBase.xaxis,
          title: 'Time (hr)',
          range: [0, Math.max(6, maxDuration)]
        },
        yaxis: {
          ...plotLayoutBase.yaxis,
          title: 'Rain Fraction',
          range: [0, 1]
        }
      },
      plotConfig
    )

    attachCurvePlotClickHandler()
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
    if (isoPlotDiv) {
      detachIsoPlotClickHandler()
      Plotly.purge(isoPlotDiv)
    }
    if (curvePlotDiv) {
      detachCurvePlotClickHandler()
      Plotly.purge(curvePlotDiv)
    }
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

  $: if (showCurveModal) {
    refreshComparisonCurves()
  }

  $: selectedCurveData =
    selectedCurveDistribution != null
      ? comparisonCurves.find((curve) => curve.distribution === selectedCurveDistribution) ?? null
      : null

  afterUpdate(() => {
    if (pendingNoaaScrollIndex != null && noaaTableScrollEl) {
      const target = noaaTableScrollEl.querySelector<HTMLButtonElement>(
        `.duration-btn[data-row-index="${pendingNoaaScrollIndex}"]`
      )
      if (target) {
        target.scrollIntoView({ block: 'center', inline: 'nearest' })
        pendingNoaaScrollIndex = null
      }
    }

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
          <div class="noaa-table-scroll" bind:this={noaaTableScrollEl}>
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
                {#each table.rows as row, index}
                  {@const isSelectable =
                    durationMode === 'custom' || durationLabelIsStandard(row.label)}
                  <div
                    class={`table-row ${selectedDurationLabel === row.label ? 'active' : ''} ${
                      isSelectable ? '' : 'disabled'
                    }`}
                  >
                    <div>
                      <button
                        type="button"
                        class={`table-button duration-btn ${selectedDurationLabel === row.label ? 'active' : ''}`}
                        data-row-index={index}
                        disabled={!isSelectable}
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
                          disabled={!isSelectable}
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

        <div class="storm-parameters-grid">
            <div class="field field--distribution">
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

            <div class="field field--duration-mode">
                <label for="duration-mode-tabs">Duration Mode</label>
                <div class="tabs" id="duration-mode-tabs">
                    <button class={durationMode === 'standard' ? 'active' : ''} on:click={() => durationMode = 'standard'}>Standard</button>
                    <button class={durationMode === 'custom' ? 'active' : ''} on:click={() => durationMode = 'custom'}>Custom</button>
                </div>
            </div>

            <div class="field">
                <label for="depth">Depth (in)</label>
                <NumericStepper
                  id="depth"
                  label="Depth (in)"
                  min={0}
                  step={0.1}
                  bind:value={selectedDepth}
                  on:change={handleDepthInput}
                  recalculated={recentlyRecalculated === 'depth'}
                />
            </div>
            <div class="field">
                <label for="duration">Duration (hr)</label>
                {#if durationMode === 'standard'}
                     <select id="duration" bind:value={selectedDurationHr} on:change={handleDurationInput}>
                        <option value={6}>6-hr</option>
                        <option value={12}>12-hr</option>
                        <option value={24}>24-hr</option>
                    </select>
                {:else}
                    <NumericStepper
                      id="duration-custom"
                      label="Duration (hr)"
                      min={MIN_DURATION_HOURS}
                      step={MIN_DURATION_HOURS}
                      buttonStep={1}
                      bind:value={selectedDurationHr}
                      on:change={handleDurationInput}
                      recalculated={recentlyRecalculated === 'duration'}
                    />
                {/if}
            </div>

            <div class="field">
                <label for="ari">Recurrence (years)</label>
                <NumericStepper
                  id="ari"
                  label="Average Recurrence Interval (years)"
                  min={0}
                  step={1}
                  bind:value={selectedAri}
                  on:change={handleAriInput}
                  recalculated={recentlyRecalculated === 'ari'}
                />
            </div>
            <div class="field">
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

            <div class="field field--start-time">
                <label for="start">Start (ISO)</label>
                <input id="start" type="datetime-local" bind:value={startISO} />
            </div>

            <div class="field field--custom-curve">
              <label for="curve-button">Custom Curve CSV</label>
              <button
                id="curve-button"
                type="button"
                class="ghost custom-curve-button"
                on:click={openCustomCurveModal}
              >
                {customCurveLines.length ? `Edit Curve (${customCurveLines.length} points)` : 'Add Custom Curve'}
              </button>
            </div>

        </div>

        {#if durationMode === 'custom'}
            <div class="disclaimer">
                <strong>Note:</strong> Custom durations interpolate from the nearest available NRCS curve (Types II & III include 6, 12, and 24-hr tables), which may differ from true short-duration storm patterns.
            </div>
        {/if}
        <div class="small">Note: Huff distributions are approximated using Beta distributions.</div>


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

      <div class="panel">
        <h2 class="section-title">NOAA Depth Iso-Lines</h2>
        <div class="iso-plot-container">
          <div class="iso-plot" bind:this={isoPlotDiv} aria-label="Contour plot of NOAA depths by duration and recurrence interval"></div>
          {#if !table}
            <div class="iso-plot-empty">Load NOAA data to view the depth iso-line preview.</div>
          {/if}
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
                    <td>{row.intensity.toFixed(5)}</td>
                    <td>{row.incremental.toFixed(5)}</td>
                    <td>{row.cumulative.toFixed(5)}</td>
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

{#if showCustomCurveModal}
  <div
    class="modal-backdrop"
    role="presentation"
    tabindex="-1"
    on:click={handleCustomCurveBackdropClick}
    on:keydown={handleKeydown}
  >
    <div
      class="modal custom-curve-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="custom-curve-title"
      tabindex="-1"
      bind:this={customCurveModalDialog}
      on:click|stopPropagation
    >
      <div class="modal-content">
        <h2 id="custom-curve-title">Custom Curve CSV</h2>
        <p class="small">
          Provide normalized cumulative pairs in CSV format (time fraction, cumulative depth fraction).
        </p>
        <label class="sr-only" for="custom-curve-textarea">Custom curve CSV input</label>
        <textarea
          id="custom-curve-textarea"
          rows="6"
          placeholder="t (0..1), cumulative (0..1)"
          bind:this={customCurveTextarea}
          bind:value={customCurveDraft}
        ></textarea>
        <div class="field-hint">
          The curve will be trimmed, normalized, and interpolated to match the selected storm duration.
        </div>
      </div>
      <div class="modal-actions">
        <button type="button" on:click={closeCustomCurveModal}>Cancel</button>
        <button type="button" class="primary" on:click={applyCustomCurveDraft}>
          Save Curve
        </button>
      </div>
    </div>
  </div>
{/if}

{#if showHelp}
  <div
    class="modal-backdrop"
    role="presentation"
    tabindex="-1"
    on:click={handleBackdropClick}
    on:keydown={handleKeydown}
  >
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
          official NRCS dimensionless cumulative rainfall tables (Types I/IA at 24 hours and Types II/III at
          6, 12, and 24 hours); other presets rely on Beta(α,β) shapes.
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
          <li>
            Export your results. CSV includes timestamps, incremental depth, cumulative depth, and
            intensity columns. DAT exports contain intensities only and are always reported in inches per
            hour to match PCSWMM expectations.
          </li>
        </ol>
        <h3>Interpolation</h3>
        <p>
          When <i>Use NOAA selection</i> is <b>unchecked</b>, editing <i>Return period</i> will interpolate
          <i>Depth</i> along the selected duration row. Editing <i>Duration</i> or <i>Total depth</i> updates
          <i>Return period</i> to stay consistent.
        </p>
        <h3>Methods</h3>
        <p>
          Temporal patterns originate either from NRCS dimensionless cumulative rainfall tables (Types I, IA,
          II, III) resampled to the storm duration—Type II/III include 6-, 12-, and 24-hour tables and custom
          durations snap to the closest available curve before resampling—or from predefined Beta(α,β)
          distributions on [0,1] for the remaining presets. No circular shifting is applied. User-supplied
          curves are normalized and resampled.
        </p>
      </div>
      <div class="modal-actions">
        <button type="button" on:click={closeHelp}>Close</button>
      </div>
    </div>
  </div>
{/if}

{#if showCurveModal}
  <div
    class="modal-backdrop"
    role="presentation"
    tabindex="-1"
    on:click={handleCurveBackdropClick}
    on:keydown={handleKeydown}
  >
    <div
      class="modal curve-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="curve-modal-title"
      tabindex="-1"
      bind:this={curveModalDialog}
      on:click|stopPropagation
    >
      <div class="modal-content">
        <h2 id="curve-modal-title">Distribution Comparison Curves</h2>
        <p class="small">
          Compare cumulative rain fraction over time across available {comparisonGroupLabel || 'selected'}
          distributions. Choose a standard duration to update the plot, and click a curve to inspect its normalized
          values.
        </p>
        <div class="curve-controls">
          <span class="curve-group-label">{comparisonGroupLabel || 'Distributions'}</span>
          <div class="curve-duration-toggle" role="group" aria-label="Select storm duration">
            {#each STANDARD_DURATION_HOURS as option}
              <button
                type="button"
                class={`curve-duration-button ${option === selectedCurveDuration ? 'active' : ''}`}
                aria-pressed={option === selectedCurveDuration}
                on:click={() => setComparisonDuration(option)}
              >
                {option}-hr
              </button>
            {/each}
          </div>
        </div>
        <div class="curve-plot" bind:this={curvePlotDiv} aria-label="Cumulative rain fraction by distribution"></div>
        {#if comparisonCurves.length}
          {#if selectedCurveData}
            <div class="curve-table">
              <h3>
                {selectedCurveData.label}
                {#if selectedCurveDuration != null}
                  — {selectedCurveDuration}-hr Values
                {/if}
              </h3>
              <div class="table-scroll curve-table-scroll">
                <table class="data-table">
                  <thead>
                    <tr>
                      <th class="left">Time (hr)</th>
                      <th>Rain Fraction</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each selectedCurveData.rows as row}
                      <tr>
                        <td class="left">{row.time.toFixed(2)}</td>
                        <td>{row.fraction.toFixed(3)}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            </div>
          {:else}
            <p class="empty">Select a curve to view its values.</p>
          {/if}
        {:else}
          <p class="empty">Unable to generate comparison curves. Adjust parameters and try again.</p>
        {/if}
      </div>
      <div class="modal-actions">
        <button type="button" on:click={closeCurveModal}>Close</button>
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

  .storm-form-layout {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 16px 20px;
    align-items: end;
  }

  .field--distribution { grid-column: 1 / 3; }
  .field--duration-mode { grid-column: 3 / 5; }
  .field--start-time { grid-column: 1 / 3; }
  .field--custom-curve { grid-column: 3 / 5; }


  .form-col {
      display: flex;
      flex-direction: column;
      gap: 16px;
  }

    .duration-controls {
        display: flex;
        flex-direction: column;
        gap: 8px;
    }

    .tabs {
        display: flex;
        background-color: #0f131a;
        border-radius: 8px;
        padding: 4px;
    }

    .tabs button {
        flex: 1;
        padding: 6px 12px;
        border: none;
        background: transparent;
        color: var(--muted);
        cursor: pointer;
        border-radius: 6px;
        transition: background-color 0.2s, color 0.2s;
    }

    .tabs button.active {
        background-color: var(--accent);
        color: #05121a;
        font-weight: 600;
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

  .disclaimer {
      font-size: 12px;
      color: var(--muted);
      padding: 8px;
      background: rgba(234, 179, 8, 0.1);
      border: 1px solid rgba(234, 179, 8, 0.3);
      border-radius: 8px;
      margin-top: 12px;
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

  .iso-plot-container {
    position: relative;
    min-height: clamp(320px, 45vh, 460px);
    border-radius: 16px;
    border: 1px solid var(--border);
    background: linear-gradient(135deg, rgba(15, 23, 42, 0.6), rgba(8, 47, 73, 0.45));
    overflow: hidden;
  }

  .iso-plot {
    width: 100%;
    height: 100%;
  }

  .iso-plot-empty {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
    text-align: center;
    color: var(--muted);
    font-size: 14px;
    background: linear-gradient(135deg, rgba(2, 6, 23, 0.8), rgba(8, 47, 73, 0.65));
    backdrop-filter: blur(2px);
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
    background: var(--panel);
    position: sticky;
    top: 0;
    z-index: 1;
    box-shadow: inset 0 -1px 0 rgba(255, 255, 255, 0.06);
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
    .storm-form-layout {
      grid-template-columns: 1fr;
    }
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

  .curve-modal .modal-content {
    max-width: min(640px, 90vw);
  }

  .curve-controls {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin: 16px 0 12px;
    flex-wrap: wrap;
  }

  .curve-group-label {
    font-size: 12px;
    color: var(--muted);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .curve-duration-toggle {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .curve-duration-button {
    padding: 6px 12px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: transparent;
    color: inherit;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    transition: background 0.15s ease, border-color 0.15s ease;
  }

  .curve-duration-button.active,
  .curve-duration-button:hover {
    background: rgba(110, 231, 255, 0.15);
    border-color: rgba(110, 231, 255, 0.4);
  }

  .curve-plot {
    width: 100%;
    min-height: 320px;
  }

  .curve-table h3 {
    margin: 0;
  }

  .curve-table-scroll {
    max-height: 240px;
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
</style>

