<script lang="ts">
  import { onMount, onDestroy, tick, afterUpdate } from 'svelte'
  import L from 'leaflet'
  import markerIcon2xUrl from 'leaflet/dist/images/marker-icon-2x.png'
  import markerIconUrl from 'leaflet/dist/images/marker-icon.png'
  import markerShadowUrl from 'leaflet/dist/images/marker-shadow.png'
  import Plotly from 'plotly.js-dist-min'
  import type { ColorBar, Config, Data, Layout } from 'plotly.js'
  import { fetchNoaaTable, parseNoaaTable, type NoaaTable } from './lib/noaaClient'
  import { generateStorm, getBestScsDistribution, MAX_FAST_SAMPLES, type StormParams, type DistributionName } from './lib/stormEngine'
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
  import {
    computationMode,
    customCurveCsv,
    distribution,
    durationMode,
    lat,
    lon,
    selectedAri,
    selectedDepth,
    selectedDurationHr,
    startISO,
    stormResult,
    table as tableStore,
    timestepMin,
    type StormResult
  } from './lib/stores'

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

  let searchQuery = ''
  let isSearchingLocation = false
  let searchFeedback = ''
  let searchHasError = false

  let autoFetch = true
  let fetchTimer: ReturnType<typeof setTimeout> | null = null
  let lastFetchKey = ''

  let noaaTableScrollEl: HTMLDivElement | null = null
  let pendingNoaaScrollIndex: number | null = null
  let durations: string[] = []
  let aris: string[] = []
  let durationEntriesForTable: { label: string; row: NoaaRow; index: number }[] = []
  let selectedDurationLabel: string | null = null
  const DEFAULT_DURATION_HOURS = 24
  const MIN_DURATION_HOURS = 1 / 60
  const DEFAULT_ARI_YEARS = 2

  const STANDARD_DURATION_HOURS = [6, 12, 24] as const

  type StandardDurationValue = `${(typeof STANDARD_DURATION_HOURS)[number]}`

  const STANDARD_DURATION_PRESETS = STANDARD_DURATION_HOURS.map((hours) => ({
    hours,
    value: String(hours) as StandardDurationValue,
    label: `${hours}-hr`
  }))

  let selectedDurationPreset: StandardDurationValue = String(
    DEFAULT_DURATION_HOURS
  ) as StandardDurationValue

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

  const INITIAL_SCROLL_LABEL_PATTERNS = [
    /\b24\s*[-–—]?\s*hr\b/i,
    /\b24\s*[-–—]?\s*hour/i,
    /\b1\s*[-–—]?\s*day/i,
    /\b1\s*[-–—]?\s*d\b/i,
    /\b10\s*[-–—]?\s*day/i,
    /\b10\s*[-–—]?\s*d\b/i
  ]

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

  function formatYearLabel(value: number | string) {
    const numeric = typeof value === 'string' ? Number.parseFloat(value) : value
    if (!Number.isFinite(numeric)) {
      return 'years'
    }
    return numeric <= 1 ? 'year' : 'years'
  }

  let interpolatedCells: InterpolationCell[] = []
  type NoaaRow = NoaaTable['rows'][number]

  let customCurveDraft = ''
  let showCustomCurveModal = false
  let customCurveLines: string[] = []

  $: customCurveLines = $customCurveCsv.trim()
    ? $customCurveCsv
        .trim()
        .split(/\r?\n/)
    : []
  $: durationEntriesForTable = $tableStore
    ? $tableStore.rows.map((row, index) => ({ label: row.label, row, index }))
    : []
  let showHelp = false
  let showCurveModal = false
  let helpDialog: HTMLDivElement | null = null

  let isLoadingNoaa = false
  let noaaError = ''

  let lastStorm: StormResult | null = null
  
  let lastChangedBy: 'user' | 'system' = 'user';
  let recentlyRecalculated: 'ari' | 'depth' | 'duration' | null = null;
  let recalculationTimer: ReturnType<typeof setTimeout> | null = null;


  const plotConfig: Partial<Config> = { responsive: true, displaylogo: false, displayModeBar: false }
  const plotLayoutBase: Partial<Layout> = {
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
    if (!Number.isFinite($lat) || !Number.isFinite($lon)) return
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

      $lat = nextLat
      $lon = nextLon
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
    const hadTable = Boolean($tableStore)
    if (fetchTimer) {
      clearTimeout(fetchTimer)
      fetchTimer = null
    }
    if (!Number.isFinite($lat) || !Number.isFinite($lon)) {
      noaaError = 'Enter a valid latitude and longitude.'
      return
    }
    const key = `${$lat.toFixed(3)}:${$lon.toFixed(3)}`
    if (key === lastFetchKey && $tableStore) {
      noaaError = ''
      return
    }
    isLoadingNoaa = true
    noaaError = ''
    try {
      const txt = await fetchNoaaTable($lat, $lon)
      const parsed = parseNoaaTable(txt)
      if (!parsed) throw new Error('NOAA table parse failed')
      $tableStore = parsed
      durations = parsed.rows.map((r) => r.label)
      aris = parsed.aris
      const defaultDurationLabel = parsed.rows.find(
        (r) => Math.abs(toHours(r.label) - DEFAULT_DURATION_HOURS) < 1e-6
      )?.label
      const defaultDurationIndex = defaultDurationLabel
        ? parsed.rows.findIndex((r) => r.label === defaultDurationLabel)
        : -1
      if (!hadTable) {
        const initialScrollIndex = findInitialNoaaScrollIndex(parsed.rows)
        if (initialScrollIndex != null) {
          pendingNoaaScrollIndex = initialScrollIndex
        } else {
          pendingNoaaScrollIndex = defaultDurationIndex >= 0 ? defaultDurationIndex : null
        }
      } else {
        const selectedIndex = selectedDurationLabel
          ? parsed.rows.findIndex((row) => row.label === selectedDurationLabel)
          : -1
        if (selectedIndex >= 0) {
          pendingNoaaScrollIndex = selectedIndex
        } else {
          pendingNoaaScrollIndex = defaultDurationIndex >= 0 ? defaultDurationIndex : null
        }
      }
      if (!hadTable && defaultDurationLabel) {
        selectedDurationLabel = defaultDurationLabel
      } else if (
        !selectedDurationLabel ||
        !parsed.rows.some((r) => r.label === selectedDurationLabel)
      ) {
        selectedDurationLabel = defaultDurationLabel ?? parsed.rows[0]?.label ?? null
      }
      if (!hadTable && aris.includes(String(DEFAULT_ARI_YEARS))) {
        $selectedAri = DEFAULT_ARI_YEARS
      }
      if (!aris.includes(String($selectedAri)) && aris.length) {
        $selectedAri = Number(aris[0])
      }
      if (selectedDurationLabel) {
        applyNoaaSelection()
      }
      lastFetchKey = key
    } catch (e: any) {
      noaaError = e?.message ?? 'Unable to fetch NOAA data.'
      $tableStore = null
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

  function findInitialNoaaScrollIndex(rows: NoaaRow[]): number | null {
    for (const pattern of INITIAL_SCROLL_LABEL_PATTERNS) {
      const matchIndex = rows.findIndex((row) => pattern.test(row.label))
      if (matchIndex >= 0) {
        return matchIndex
      }
    }

    const targetHours = toHours('24 hr')
    let bestIndex = -1
    let bestDiff = Number.POSITIVE_INFINITY

    rows.forEach((row, index) => {
      const hours = toHours(row.label)
      if (!Number.isFinite(hours)) return
      const diff = Math.abs(hours - targetHours)
      if (diff < bestDiff) {
        bestDiff = diff
        bestIndex = index
      }
    })

    return bestIndex >= 0 ? bestIndex : null
  }

  $: isCustomDurationMode = $durationMode === 'custom'

  function durationIsSelectable(label: string) {
    if (isCustomDurationMode) {
      return true
    }
    return durationLabelIsStandard(label)
  }

  function pickCell(durLabel: string, ari: string) {
    const table = $tableStore
    if (!table) return
    if (!durationIsSelectable(durLabel)) return
    selectedDurationLabel = durLabel
    $selectedDurationHr = toHours(durLabel)
    $selectedAri = Number(ari)
    const row = table.rows.find((r) => r.label === durLabel)
    const depth = row?.values[ari]
    if (Number.isFinite(depth)) {
      $selectedDepth = Number(depth)
    }
    interpolatedCells = []
  }

  function applyNoaaSelection() {
    const table = $tableStore
    if (!table || !selectedDurationLabel) return
    const row = table.rows.find((r) => r.label === selectedDurationLabel)
    if (!row) return
    $selectedDurationHr = toHours(selectedDurationLabel)
    const ariKey = String($selectedAri)
    const exactDepth = row.values[ariKey]
    if (Number.isFinite(exactDepth)) {
      $selectedDepth = Number(exactDepth)
      interpolatedCells = []
      return
    }
    const interpolated = interpolateDepthFromAri(row, $selectedAri, table.aris)
    if (interpolated) {
      $selectedDepth = interpolated.depth
      interpolatedCells = interpolated.highlight ?? []
      return
    }
    interpolatedCells = []
  }

  $: {
    const storm = $stormResult
    lastStorm = storm

    if (!storm) {
      peakIntensity = 0
      totalDepth = 0
      timeAxis = []
      timeColumnLabel = 'Time (hr)'
      tableRows = []
      hasTimestamp = false

      if (plotDiv1) Plotly.purge(plotDiv1)
      if (plotDiv2) Plotly.purge(plotDiv2)
      if (plotDiv3) Plotly.purge(plotDiv3)
    } else {
      totalDepth = storm.cumulativeIn[storm.cumulativeIn.length - 1] ?? 0
      peakIntensity = storm.intensityInHr.length
        ? Math.max(...storm.intensityInHr)
        : 0

      const totalMinutes = storm.timeMin[storm.timeMin.length - 1] ?? 0
      const useHours = totalMinutes >= 120
      const timeFactor = useHours ? 1 / 60 : 1
      const axisTitle = useHours ? 'Time (hours)' : 'Time (minutes)'
      const columnLabel = useHours ? 'Time (hr)' : 'Time (min)'
      const hoverTimeLabel = useHours ? 'Time (hr)' : 'Time (min)'
      const stepMinutes =
        storm.timeMin.length > 1
          ? storm.timeMin[1] - storm.timeMin[0]
          : $timestepMin
      const barWidth = stepMinutes * timeFactor
      timeAxis = storm.timeMin.map((t) => t * timeFactor)
      timeColumnLabel = columnLabel

      const startDate = $startISO ? new Date($startISO) : null
      hasTimestamp = Boolean(startDate && !Number.isNaN(startDate.getTime()))
      tableRows = storm.timeMin.map((t, i) => {
        const timestamp = hasTimestamp
          ? formatTimestamp(new Date((startDate as Date).getTime() + t * 60000))
          : undefined
        return {
          time: t * timeFactor,
          intensity: storm.intensityInHr[i],
          incremental: storm.incrementalIn[i],
          cumulative: storm.cumulativeIn[i],
          timestamp
        }
      })

      if (plotDiv1) {
        Plotly.react(
          plotDiv1,
          [
            {
              x: timeAxis,
              y: storm.intensityInHr,
              type: 'bar',
              name: 'Intensity (in/hr)',
              marker: { color: '#6ee7ff' },
              hovertemplate: `${hoverTimeLabel}: %{x:.2f}<br>Intensity: %{y:.2f} in/hr<extra></extra>`,
              width: barWidth
            }
          ],
          {
            ...plotLayoutBase,
            title: { text: 'Hyetograph (Intensity)' },
            xaxis: { ...plotLayoutBase.xaxis, title: { text: axisTitle } },
            yaxis: { ...plotLayoutBase.yaxis, title: { text: 'Intensity (in/hr)' } }
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
              y: storm.incrementalIn,
              type: 'bar',
              name: 'Incremental Volume (in)',
              marker: { color: '#a855f7' },
              hovertemplate: `${hoverTimeLabel}: %{x:.2f}<br>Incremental: %{y:.3f} in<extra></extra>`,
              width: barWidth
            }
          ],
          {
            ...plotLayoutBase,
            title: { text: 'Incremental Volume' },
            xaxis: { ...plotLayoutBase.xaxis, title: { text: axisTitle } },
            yaxis: { ...plotLayoutBase.yaxis, title: { text: 'Volume (in)' } }
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
              y: storm.cumulativeIn,
              type: 'scatter',
              mode: 'lines',
              name: 'Cumulative (in)',
              line: { color: '#f97316', width: 3 },
              hovertemplate: `${hoverTimeLabel}: %{x:.2f}<br>Cumulative: %{y:.3f} in<extra></extra>`
            }
          ],
          {
            ...plotLayoutBase,
            title: { text: 'Cumulative Mass Curve' },
            xaxis: { ...plotLayoutBase.xaxis, title: { text: axisTitle } },
            yaxis: { ...plotLayoutBase.yaxis, title: { text: 'Cumulative Depth (in)' } }
          },
          plotConfig
        )
      }
    }

    drawIsoPlot()
  }
  function drawIsoPlot() {
    if (!isoPlotDiv) return

    const table = $tableStore

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

    const contourZ = ariEntries.map((ariEntry) =>
      durationEntries.map(({ row }) => {
        const depth = row.values[ariEntry.key]
        return Number.isFinite(depth) ? Number(depth) : null
      })
    )

    const customData = ariEntries.map((ariEntry) =>
      durationEntries.map((entry) => [entry.label, ariEntry.key])
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

    const filteredDurationEntries = reduceTickEntries(durationEntries, maxXTicks)
    const filteredAriEntries = reduceTickEntries(ariEntries, maxYTicks)

    const colorbar: Partial<ColorBar> = {
      title: {
        text: 'Depth (in)',
        font: { color: '#e7e7e7', size: isCompact ? 12 : undefined }
      },
      thickness: isCompact ? 10 : 14,
      tickcolor: '#e7e7e7',
      tickfont: { color: '#e7e7e7', size: isCompact ? 10 : 12 },
      outlinecolor: 'rgba(255, 255, 255, 0.1)'
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
      x: durationEntries.map((entry) => entry.hr),
      y: ariEntries.map((entry) => entry.value),
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
        'Duration: %{customdata[0]} (%{x:.2f} hr)<br>ARI: %{customdata[1]}-year<br>Depth: %{z:.2f} in<extra></extra>',
      showscale: true
    }

    const pointXs: number[] = []
    const pointYs: number[] = []
    const pointLabels: string[][] = []
    durationEntries.forEach((duration) => {
      const includeDuration =
        $durationMode !== 'standard' ||
        STANDARD_DURATION_HOURS.some(
          (allowed) => Math.abs(duration.hr - allowed) < 1e-3
        )

      if (!includeDuration) {
        return
      }

      ariEntries.forEach((ari) => {
        const depth = duration.row.values[ari.key]
        if (Number.isFinite(depth)) {
          pointXs.push(duration.hr)
          pointYs.push(ari.value)
          pointLabels.push([duration.label, ari.key])
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
        'Duration: %{customdata[0]} (%{x:.2f} hr)<br>ARI: %{customdata[1]}-year<extra></extra>',
      name: 'NOAA data points',
      showlegend: false
    }

    let highlightTrace: any = null
    if (table && selectedDurationLabel) {
      const highlightDuration = durationEntries.find(
        (entry) => entry.label === selectedDurationLabel
      )
      const highlightAri = ariEntries.find((entry) => entry.key === String($selectedAri))
      const depth = highlightDuration?.row.values[highlightAri?.key ?? '']
      if (highlightDuration && highlightAri && Number.isFinite(depth)) {
        highlightTrace = {
          type: 'scatter',
          mode: 'markers',
          x: [highlightDuration.hr],
          y: [highlightAri.value],
          marker: {
            color: '#f8fafc',
            size: 12,
            line: { color: '#0ea5e9', width: 3 },
            symbol: 'circle'
          },
          name: 'Selected NOAA cell',
          showlegend: false,
          hovertemplate: `Duration: ${highlightDuration.label} (${highlightDuration.hr.toFixed(
            2
          )} hr)<br>ARI: ${highlightAri.value}-year<br>Depth: ${(depth as number).toFixed(3)} in<extra></extra>`
        }
      }
    }

    const layout: Partial<Layout> = {
      ...plotLayoutBase,
      title: { text: 'NOAA Depth Iso-Lines' },
      margin: isCompact
        ? { l: 64, r: 26, t: 48, b: 96 }
        : { l: 72, r: 70, t: 40, b: 88 },
      xaxis: {
        ...plotLayoutBase.xaxis,
        title: {
          text: 'Duration (hr)',
          font: { size: isCompact ? 12 : undefined }
        },
        type: 'log',
        tickmode: 'array',
        tickvals: filteredDurationEntries.map((entry) => entry.hr),
        ticktext: filteredDurationEntries.map((entry) => entry.label),
        tickangle: isCompact ? -45 : 0,
        tickfont: { size: isCompact ? 10 : 12 },
        automargin: true
      },
      yaxis: {
        ...plotLayoutBase.yaxis,
        title: {
          text: 'Average Recurrence Interval (years)',
          font: { size: isCompact ? 12 : undefined }
        },
        type: 'log',
        tickmode: 'array',
        tickvals: filteredAriEntries.map((entry) => entry.value),
        ticktext: filteredAriEntries.map((entry) => entry.key),
        tickfont: { size: isCompact ? 10 : 12 },
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

    const durationHrNumeric = Number($selectedDurationHr)

    let stormTrace: any = null
    if (
      Number.isFinite($selectedAri) &&
      $selectedAri > 0 &&
      Number.isFinite(durationHrNumeric) &&
      durationHrNumeric > 0
    ) {
      const hasDepth = Number.isFinite($selectedDepth)
      const depthText = hasDepth ? `<br>Depth: ${$selectedDepth.toFixed(3)} in` : ''
      stormTrace = {
        type: 'scatter',
        mode: 'markers',
        x: [durationHrNumeric],
        y: [$selectedAri],
        marker: {
          color: '#ef4444',
          size: 16,
          line: { color: '#b91c1c', width: 3 },
          symbol: 'x'
        },
        name: 'Current storm parameters',
        showlegend: false,
        hovertemplate: `Current Storm` +
          `<br>Duration: ${durationHrNumeric.toFixed(2)} hr` +
          `<br>ARI: ${$selectedAri}` +
          depthText +
          '<extra></extra>'
      }
    }

    const data = [
      contourTrace,
      pointsTrace,
      ...(highlightTrace ? [highlightTrace] : []),
      ...(stormTrace ? [stormTrace] : [])
    ]

    Plotly.react(isoPlotDiv, data, layout, {
      ...plotConfig,
      displayModeBar: false
    })

    attachIsoPlotClickHandler()
  }

  const handleIsoPlotClick = (event: any) => {
    const table = $tableStore
    if (!table) return
    const point = event?.points?.[0]
    if (!point) return

    const ariEntries = aris
      .map((key) => ({ key, value: Number(key) }))
      .filter((entry) => Number.isFinite(entry.value))
      .sort((a, b) => a.value - b.value)

    const durationEntries = getSortedDurationRows(table)
    if (!ariEntries.length || !durationEntries.length) return

    const nearestAri = ariEntries.reduce(
      (best, entry) => {
        const diff = Math.abs(entry.value - point.y)
        return diff < best.diff ? { diff, entry } : best
      },
      { diff: Number.POSITIVE_INFINITY, entry: ariEntries[0] }
    )

    const nearestDuration = durationEntries.reduce(
      (best, entry) => {
        const diff = Math.abs(entry.hr - point.x)
        return diff < best.diff ? { diff, entry } : best
      },
      { diff: Number.POSITIVE_INFINITY, entry: durationEntries[0] }
    )

    if (
      $durationMode === 'standard' &&
      !STANDARD_DURATION_HOURS.some(
        (allowed) => Math.abs(nearestDuration.entry.hr - allowed) < 1e-3
      )
    ) {
      return
    }

    const selectedRow = nearestDuration.entry.row
    const ariKey = nearestAri.entry.key
    const depth = selectedRow.values[ariKey]

    if (!Number.isFinite(depth)) {
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

  $: interpolatedCellKeys = new Set(
    interpolatedCells.map((cell) => `${cell.duration}::${cell.ari}`)
  )

  function cellIsInterpolated(durationLabel: string, ari: string) {
    return interpolatedCellKeys.has(`${durationLabel}::${ari}`)
  }

  function ensureNumericDuration() {
    const parsed = Number($selectedDurationHr)
    if (Number.isFinite(parsed) && $selectedDurationHr !== parsed) {
      $selectedDurationHr = parsed
    }
    return parsed
  }

  function recalcFromDepthOrDuration() {
    const durationHr = ensureNumericDuration()
    if (!Number.isFinite($selectedDepth) || !Number.isFinite(durationHr)) {
      return
    }
    const table = $tableStore
    if (!table) {
      interpolatedCells = []
      return
    }

    const result = interpolateAriForDuration(table, durationHr, $selectedDepth, {
      preferredLabel: selectedDurationLabel ?? null
    })
    if (!result) {
      interpolatedCells = []
      return
    }

    if (selectedDurationLabel !== result.label) {
      selectedDurationLabel = result.label
    }

    const newAri = Number(result.ari.toFixed(3))
    if ($selectedAri !== newAri) {
      $selectedAri = newAri
    }
    interpolatedCells = result.highlight ?? []
  }

  $: if ($durationMode === 'standard') {
    let adjusted = false
    if (!matchesStandardDurationHours($selectedDurationHr)) {
      const nearest = nearestStandardDuration($selectedDurationHr)
      if (nearest !== $selectedDurationHr) {
        $selectedDurationHr = nearest
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

  $: if ($durationMode === 'standard') {
    const parsedDuration = Number($selectedDurationHr)
    if (Number.isFinite(parsedDuration) && $selectedDurationHr !== parsedDuration) {
      $selectedDurationHr = parsedDuration
    }

    const fallbackDuration = Number.isFinite(parsedDuration)
      ? nearestStandardDuration(parsedDuration)
      : DEFAULT_DURATION_HOURS
    const normalizedPreset = String(fallbackDuration) as StandardDurationValue
    if (selectedDurationPreset !== normalizedPreset) {
      selectedDurationPreset = normalizedPreset
    }
  }

  function recalcFromAri() {
    const durationHr = ensureNumericDuration()
    if (!Number.isFinite($selectedAri) || !Number.isFinite(durationHr)) {
      return
    }
    const table = $tableStore
    if (!table) {
      interpolatedCells = []
      return
    }
    const { row, label } = getRowForCalculation(
      table,
      durationHr,
      selectedDurationLabel ?? null
    )
    if (!row || !label) {
      interpolatedCells = []
      return
    }
    if (selectedDurationLabel !== label) {
      selectedDurationLabel = label
    }
    const result = interpolateDepthFromAri(row, $selectedAri, table.aris)
    if (result) {
      const newDepth = Number(result.depth.toFixed(3))
      if ($selectedDepth !== newDepth) {
        $selectedDepth = newDepth
      }
      interpolatedCells = result.highlight ?? []
    } else {
      interpolatedCells = []
    }
  }

  function handleDepthInput() {
    lastChangedBy = 'user';
    recalcFromDepthOrDuration()
  }

  function handleDurationInput(event?: Event) {
    lastChangedBy = 'user';

    if (event instanceof CustomEvent) {
      const detail = event.detail as { value?: number } | null;
      const nextValue =
        detail && typeof detail === 'object' && 'value' in detail
          ? Number(detail.value)
          : Number.NaN;
      if (Number.isFinite(nextValue) && $selectedDurationHr !== nextValue) {
        $selectedDurationHr = nextValue;
      }
    } else if (event?.currentTarget instanceof HTMLSelectElement) {
      const parsed = Number(event.currentTarget.value);
      if (Number.isFinite(parsed) && $selectedDurationHr !== parsed) {
        $selectedDurationHr = parsed;
      }
    }

    const durationHr = ensureNumericDuration();

    if ($durationMode === 'standard' && Number.isFinite(durationHr)) {
      if (!matchesStandardDurationHours(durationHr)) {
        const nearest = nearestStandardDuration(durationHr);
        if (nearest !== durationHr) {
          $selectedDurationHr = nearest;
        }
      }
    }

    recalcFromDepthOrDuration();
  }

  function handleStandardDurationChange(event: Event) {
    if (event?.currentTarget instanceof HTMLSelectElement) {
      const raw = event.currentTarget.value;
      const preset = STANDARD_DURATION_PRESETS.find(
        (option) => option.value === raw
      );
      if (preset) {
        if (Number.isFinite(preset.hours)) {
          $selectedDurationHr = preset.hours;
        }
        if (selectedDurationPreset !== preset.value) {
          selectedDurationPreset = preset.value;
        }
      }
    }

    handleDurationInput();
  }

  function handleAriInput() {
    lastChangedBy = 'user';
    recalcFromAri()
  }

  function handleTimestepInput() {
    if (!Number.isFinite($timestepMin) || $timestepMin <= 0) {
      return
    }
  }

  function doCsv() {
    if (!lastStorm) return
    saveCsv(lastStorm, 'design_storm.csv')
  }
  function doDat() {
    if (!lastStorm) return
    const startDate = $startISO ? new Date($startISO) : null
    const start = startDate && !Number.isNaN(startDate.getTime())
      ? $startISO
      : '2003-01-01T00:00'
    savePcswmmDat(lastStorm, $timestepMin, 'design_storm.dat', 'System', start)
  }

  async function openCustomCurveModal() {
    customCurveDraft = $customCurveCsv
    showCustomCurveModal = true
    await tick()
    customCurveModalDialog?.focus()
    customCurveTextarea?.focus()
  }

  function closeCustomCurveModal() {
    showCustomCurveModal = false
  }

  function applyCustomCurveDraft() {
    $customCurveCsv = customCurveDraft
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

    const group = getComparisonGroup($distribution)
    comparisonGroupLabel = group.label

    if (!selectedCurveDuration || !matchesStandardDurationHours(selectedCurveDuration)) {
      const currentDurationHr = Number($selectedDurationHr);
      const preferred = matchesStandardDurationHours(currentDurationHr)
        ? (nearestStandardDuration(currentDurationHr) as (typeof STANDARD_DURATION_HOURS)[number])
        : STANDARD_DURATION_HOURS[0]
      selectedCurveDuration = preferred
    }

    const duration = selectedCurveDuration ?? STANDARD_DURATION_HOURS[0]
    const trimmedCsv = $customCurveCsv.trim()
    const key = `${group.key}|${duration}|${$timestepMin}|${trimmedCsv}`

    if (key === lastCurveParamsKey && comparisonCurves.length) {
      if (
        !selectedCurveDistribution ||
        !comparisonCurves.some((curve) => curve.distribution === selectedCurveDistribution)
      ) {
        const fallback = comparisonCurves.find((curve) => curve.distribution === $distribution)
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
        timestepMin: $timestepMin,
        distribution: member,
        startISO: $startISO,
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
        comparisonCurves.find((curve) => curve.distribution === $distribution) ?? comparisonCurves[0]
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
    const customData = point?.data?.customdata
    const index = point?.pointIndex
    const dist = Array.isArray(customData) && typeof index === 'number'
      ? customData[index]
      : undefined
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

    const traces = comparisonCurves.map(
      (curve) =>
        ({
          x: curve.timeHr,
          y: curve.fraction,
          type: 'scatter',
          mode: 'lines',
          name: curve.label,
          line: { width: curve.distribution === selectedCurveDistribution ? 4 : 2 },
          opacity: curve.distribution === selectedCurveDistribution ? 1 : 0.55,
          hovertemplate: `Time: %{x:.2f} hr<br>Rain fraction: %{y:.3f}<extra></extra>`,
          customdata: curve.fraction.map(() => curve.distribution)
        }) satisfies Data
    )

    const maxDuration = selectedCurveDuration ?? Math.max(...comparisonCurves.map((curve) => curve.timeHr[curve.timeHr.length - 1] ?? 0))

    Plotly.react(
      curvePlotDiv,
      traces,
      {
        ...plotLayoutBase,
        title: { text: `${comparisonGroupLabel || 'Distribution'} Comparison — ${maxDuration}-hr` },
        xaxis: {
          ...plotLayoutBase.xaxis,
          title: { text: 'Time (hr)' },
          range: [0, Math.max(6, maxDuration)]
        },
        yaxis: {
          ...plotLayoutBase.yaxis,
          title: { text: 'Rain Fraction' },
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
      [$lat, $lon],
      9
    )
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '© OpenStreetMap contributors'
    }).addTo(map)

    marker = L.marker([$lat, $lon], { draggable: true }).addTo(map)
    marker.on('dragend', () => {
      const p = marker.getLatLng()
      $lat = p.lat
      $lon = p.lng
    })
    map.on('click', (ev: L.LeafletMouseEvent) => {
      $lat = ev.latlng.lat
      $lon = ev.latlng.lng
    })

    void loadNoaa()

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
    marker.setLatLng([$lat, $lon])
  }

  $: if (autoFetch) {
    const key = `${$lat.toFixed(3)}:${$lon.toFixed(3)}`
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
        `.duration-btn[data-column-index="${pendingNoaaScrollIndex}"]`
      )
      if (target) {
        const container = noaaTableScrollEl
        const targetRect = target.getBoundingClientRect()
        const containerRect = container.getBoundingClientRect()

        const offsetWithinContainer = targetRect.left - containerRect.left + container.scrollLeft
        const targetCenter = offsetWithinContainer + targetRect.width / 2
        const desiredScrollLeft = Math.max(0, targetCenter - container.clientWidth / 2)

        if (typeof container.scrollTo === 'function') {
          container.scrollTo({ left: desiredScrollLeft, behavior: 'smooth' })
        } else {
          container.scrollLeft = desiredScrollLeft
        }
      }
      pendingNoaaScrollIndex = null
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
    <section class="column column--data">
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
              bind:value={$lat}
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
              bind:value={$lon}
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
          {:else if $tableStore}
            <span>Depths pulled for Atlas 14 (Partial Duration Series).</span>
          {:else}
            <span>NOAA data not loaded yet.</span>
          {/if}
        </div>

        {#if $tableStore}
          <div class="noaa-table-scroll" bind:this={noaaTableScrollEl}>
            <div class="noaa-table panel">
              <div
                class="table-header"
                style={`grid-template-columns: minmax(0, var(--ari-column-width, 150px)) repeat(${durationEntriesForTable.length}, minmax(80px, 1fr));`}
              >
                <div class="table-header__ari">
                  <span class="ari-label">Average Recurrence Interval (years)</span>
                </div>
                {#each durationEntriesForTable as entry}
                  {@const isSelectable = isCustomDurationMode || durationLabelIsStandard(entry.label)}
                  <div class="table-header__duration" class:column-active={selectedDurationLabel === entry.label}>
                    <button
                      type="button"
                      class="table-button duration-btn"
                      class:active={selectedDurationLabel === entry.label}
                      data-column-index={entry.index}
                      disabled={!isSelectable}
                      on:click={() => pickCell(entry.label, String($selectedAri))}
                    >
                      {entry.label}
                    </button>
                  </div>
                {/each}
              </div>
              <div class="table-body">
                {#each aris as ariKey}
                  <div
                    class="table-row"
                    class:ari-active={String($selectedAri) === ariKey}
                    style={`grid-template-columns: minmax(0, var(--ari-column-width, 150px)) repeat(${durationEntriesForTable.length}, minmax(80px, 1fr));`}
                  >
                    <div class="ari-cell">
                      <div class="ari-value">
                        <strong>{ariKey}</strong>
                      </div>
                      <div class="ari-caption">{formatYearLabel(ariKey)}</div>
                    </div>
                    {#each durationEntriesForTable as entry}
                      {@const isSelectable = isCustomDurationMode || durationLabelIsStandard(entry.label)}
                      {@const rawDepth = entry.row.values[ariKey]}
                      {@const depthValue = Number.isFinite(rawDepth) ? Number(rawDepth) : null}
                      {@const depthText = depthValue != null ? depthValue.toFixed(3) : ''}
                      <button
                        type="button"
                        class="table-button cell"
                        class:selected={selectedDurationLabel === entry.label && String($selectedAri) === ariKey}
                        class:column-active={selectedDurationLabel === entry.label}
                        class:interpolated={cellIsInterpolated(entry.label, ariKey)}
                        disabled={!isSelectable}
                        data-ari={ariKey}
                        aria-label={`${entry.label} duration, ${ariKey}-year Average Recurrence Interval depth ${depthText ? `${depthText} in` : 'not available'}`}
                        on:click={() => pickCell(entry.label, ariKey)}
                      >
                        {depthText}
                      </button>
                    {/each}
                  </div>
                {/each}
              </div>
            </div>
          </div>
          <div class="small">Tip: Click a table cell to apply the depth, duration, and Average Recurrence Interval to the storm parameters.</div>
        {/if}

      </div>

      <div class="panel">
        <h2 class="section-title">NOAA Depth Iso-Lines</h2>
        <div class="iso-plot-container">
          <div
            class="iso-plot"
            bind:this={isoPlotDiv}
            aria-label="Contour plot of NOAA depths by duration and recurrence interval"
          ></div>
          {#if !$tableStore}
            <div class="iso-plot-empty">Load NOAA data to view the depth iso-line preview.</div>
          {/if}
        </div>
      </div>
    </section>

    <section class="column column--controls">
      <div class="panel">
        <h2 class="section-title">Storm Parameters</h2>

        <div class="storm-form">
          <div class="storm-form__header">
            <div class="storm-card storm-card--distribution">
              <div class="distribution-header">
                <label for="dist">Distribution</label>
                <div class="distribution-actions">
                  <button
                    type="button"
                    class="ghost distribution-compare-button"
                    on:click={openCurveModal}
                  >
                    Compare Distributions
                  </button>
                  <button
                    id="curve-button"
                    type="button"
                    class="ghost custom-curve-button"
                    on:click={openCustomCurveModal}
                  >
                    {customCurveLines.length ? 'Edit Custom Curve' : 'Add Custom Curve'}
                  </button>
                </div>
              </div>
              <select id="dist" bind:value={$distribution}>
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
              {#if customCurveLines.length}
                <div class="custom-curve-preview" aria-live="polite">
                  <pre>{customCurveLines.slice(0, 3).join('\n')}</pre>
                  {#if customCurveLines.length > 3}
                    <div class="custom-curve-preview-more">
                      +{customCurveLines.length - 3} additional row{customCurveLines.length - 3 === 1 ? '' : 's'}
                    </div>
                  {/if}
                </div>
              {:else}
                <div class="field-hint">No custom curve provided yet.</div>
              {/if}
              <div class="field-hint">Note: Huff distributions are approximated using Beta distributions.</div>
            </div>
            <div class="storm-card storm-card--mode">
              <div class="mode-header">
                <span class="mode-label">Mode</span>
                <div class="mode-toggle-groups">
                  <div class="mode-toggle" role="group" aria-label="Duration mode">
                    <button
                      type="button"
                      class:active={$durationMode === 'standard'}
                      on:click={() => ($durationMode = 'standard')}
                    >
                      Standard
                    </button>
                    <button
                      type="button"
                      class:active={$durationMode === 'custom'}
                      on:click={() => ($durationMode = 'custom')}
                    >
                      Custom
                    </button>
                  </div>
                  <div class="mode-toggle" role="group" aria-label="Computation mode">
                    <button
                      type="button"
                      class:active={$computationMode === 'precise'}
                      on:click={() => ($computationMode = 'precise')}
                    >
                      Precise
                    </button>
                    <button
                      type="button"
                      class:active={$computationMode === 'fast'}
                      on:click={() => ($computationMode = 'fast')}
                    >
                      Fast (approx.)
                    </button>
                  </div>
                </div>
              </div>
              {#if $durationMode === 'custom'}
                <div class="mode-note field-hint field-hint--warning">
                  <strong>Note:</strong> Custom durations interpolate from the nearest available NRCS curve (Types II &amp; III include 6-, 12-, and 24-hr tables), which may still differ from true short-duration storm patterns.
                </div>
              {:else}
                <p class="mode-note">Quickly select 6-, 12-, or 24-hour durations using the presets below.</p>
              {/if}
              <p class="mode-note mode-note--computation">
                {#if $computationMode === 'fast'}
                  Fast mode caps the cumulative sampling at {MAX_FAST_SAMPLES.toLocaleString()} points for quicker estimates. Switch back to Precise for full resolution.
                {:else}
                  Precise mode follows every timestep for maximum fidelity. Use Fast (approx.) if storms take too long to compute.
                {/if}
              </p>
            </div>
          </div>

          <div class="storm-form__inputs">
            <div class="storm-card input-card">
              <label for="depth">Depth (in)</label>
              <NumericStepper
                id="depth"
                label="Depth (in)"
                min={0}
                step={0.1}
                bind:value={$selectedDepth}
                on:change={handleDepthInput}
                recalculated={recentlyRecalculated === 'depth'}
              />
            </div>
            <div class="storm-card input-card input-card--duration">
              <label for="duration">Duration (hr)</label>
              {#if $durationMode === 'standard'}
                <select
                  id="duration"
                  bind:value={selectedDurationPreset}
                  on:change={handleStandardDurationChange}
                >
                  {#each STANDARD_DURATION_PRESETS as option}
                    <option value={option.value}>{option.label}</option>
                  {/each}
                </select>
              {:else}
                <NumericStepper
                  id="duration"
                  label="Duration (hr)"
                  min={MIN_DURATION_HOURS}
                  step={MIN_DURATION_HOURS}
                  buttonStep={1}
                  bind:value={$selectedDurationHr}
                  on:change={handleDurationInput}
                  recalculated={recentlyRecalculated === 'duration'}
                />
              {/if}
            </div>
            <div class="storm-card input-card">
              <label for="ari">Average Recurrence Interval (years)</label>
              <NumericStepper
                id="ari"
                label="Average Recurrence Interval (years)"
                min={0}
                step={1}
                bind:value={$selectedAri}
                on:change={handleAriInput}
                recalculated={recentlyRecalculated === 'ari'}
              />
            </div>
            <div class="storm-card input-card">
              <label for="timestep">Timestep (min)</label>
              <NumericStepper
                id="timestep"
                label="Timestep (min)"
                min={0.1}
                step={1}
                bind:value={$timestepMin}
                on:change={handleTimestepInput}
              />
            </div>
            <div class="storm-card input-card">
              <label for="start">Start (ISO)</label>
              <input id="start" type="datetime-local" bind:value={$startISO} />
            </div>
          </div>
        </div>


        <div class="actions">
          <button class="primary" type="button" disabled aria-disabled="true">
            Storm updates automatically
          </button>
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
            <div class="stat-value">{$selectedAri} {formatYearLabel($selectedAri)}</div>
          </div>
        </div>
      </div>
    </section>

    <section class="column column--visuals">
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
          <p class="empty">Adjust the parameters to see the time series table.</p>
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
    >
      <div class="modal-content">
        <h2 id="help-title">Design Storm Generator</h2>
        <p>
          <strong>Purpose.</strong>
          Build synthetic hyetographs from NOAA Atlas 14 rainfall tables paired with NRCS and analytical
          temporal distributions. Atlas 14 lookups combine a location search, draggable map marker, manual
          coordinate entry, and an auto-refresh toggle so the latest Partial Duration Series depths are always
          in view.
        </p>
        <h3>Quick Start</h3>
        <ol>
          <li>
            Search for a place or drag the marker. Enable <em>Auto refresh when location changes</em> to fetch a
            new table automatically, or click <em>Refresh NOAA Data</em> to pull depths on demand.
          </li>
          <li>
            Review the Atlas 14 table and the companion iso-line chart, then click a table cell to apply its
            duration, Average Recurrence Interval, and depth to the storm parameters.
          </li>
          <li>
            Pick a distribution, toggle between <em>Standard</em> and <em>Custom</em> duration entry, and choose a
            computation mode. <em>Compare Distributions</em> opens normalized cumulative curves across 6-, 12-,
            and 24-hour presets, while <em>Add Custom Curve</em> imports a CSV cumulative fraction table.
          </li>
          <li>
            Adjust timestep and optional start time if you need timestamped outputs. Charts and the storm table
            refresh automatically—export CSV (timestamp, incremental, cumulative, intensity columns) or DAT
            (intensities only, in/hr) when ready.
          </li>
        </ol>
        <h3>Computation Modes</h3>
        <p>
          <em>Precise</em> traces every timestep for maximum fidelity. <em>Fast (approx.)</em> caps the cumulative
          sampling resolution for quicker estimates on long storms; switch back to Precise if results need to be
          exact.
        </p>
        <h3>Interpolation</h3>
        <p>
          Manually editing <i>Return period</i> interpolates the <i>Depth</i> along the selected duration row.
          Editing <i>Duration</i> or <i>Total depth</i> nudges the <i>Return period</i> so the trio of values stays
          consistent with the NOAA table, and any interpolated Atlas 14 cells are highlighted.
        </p>
        <h3>Methods</h3>
        <p>
          Temporal patterns originate from NRCS dimensionless cumulative rainfall tables (Types I, IA, II, III)
          resampled to the storm duration—Type II/III include 6-, 12-, and 24-hour tables and custom durations
          snap to the closest available curve before resampling—or from parameterized Beta(α,β) distributions on
          [0, 1] for the remaining presets. No circular shifting is applied. User CSV curves are trimmed,
          normalized, and interpolated to match the storm duration.
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

  .column--visuals {
    grid-column: 1 / -1;
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

    .column--visuals {
      grid-column: 1 / -1;
    }

    .header {
      flex-wrap: nowrap;
    }
  }

  @media (min-width: 1200px) {
    .layout {
      grid-template-columns: minmax(0, 1.05fr) minmax(0, 0.95fr) minmax(0, 1.25fr);
    }

    .column--visuals {
      grid-column: auto;
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

  .storm-form {
    display: flex;
    flex-direction: column;
    gap: 28px;
  }

  .storm-form__header {
    display: grid;
    gap: 24px;
    grid-template-columns: minmax(0, 1.2fr) minmax(280px, 0.8fr);
    align-items: stretch;
  }

  .storm-card {
    background: rgba(15, 19, 26, 0.9);
    border: 1px solid rgba(58, 71, 90, 0.55);
    border-radius: 18px;
    padding: 18px 20px;
    box-shadow: 0 16px 32px rgba(5, 12, 18, 0.45);
    backdrop-filter: blur(12px);
    display: flex;
    flex-direction: column;
    gap: 18px;
  }

  .storm-card select,
  .storm-card input,
  .storm-card :global(.stepper) {
    width: 100%;
  }

  .storm-card label {
    margin: 0;
  }

  .storm-card--distribution {
    gap: 20px;
  }

  .distribution-header {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .distribution-header label {
    font-size: 12px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .distribution-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }

  .distribution-actions button {
    flex: 1 1 160px;
  }

  .storm-card--mode {
    gap: 22px;
  }

  .mode-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
  }

  .mode-label {
    font-size: 12px;
    color: var(--muted);
    letter-spacing: 0.16em;
    text-transform: uppercase;
  }

  .mode-toggle-groups {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .mode-toggle {
    display: inline-flex;
    gap: 6px;
    padding: 4px;
    border-radius: 999px;
    border: 1px solid rgba(110, 231, 255, 0.18);
    background: rgba(8, 13, 20, 0.82);
  }

  .mode-toggle button {
    background: transparent;
    border: none;
    padding: 6px 18px;
    border-radius: 999px;
    font-size: 13px;
    color: var(--muted);
    transition: background 120ms ease, color 120ms ease;
  }

  .mode-toggle button:hover:not(:disabled) {
    background: rgba(110, 231, 255, 0.08);
    color: var(--text);
  }

  .mode-toggle button.active {
    background: var(--accent);
    color: #05121a;
    font-weight: 600;
    box-shadow: 0 0 0 1px rgba(5, 18, 26, 0.25);
  }

  .mode-note {
    font-size: 13px;
    line-height: 1.5;
    color: var(--muted);
    margin: 0;
  }

  .mode-note--computation {
    margin-top: 10px;
  }

  .storm-form__inputs {
    display: grid;
    gap: 18px;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  }

  .input-card {
    gap: 14px;
  }

  .field-hint {
    font-size: 12px;
    color: var(--muted);
    line-height: 1.4;
  }

  .field-hint--warning {
    padding: 8px 10px;
    background: rgba(234, 179, 8, 0.1);
    border: 1px solid rgba(234, 179, 8, 0.3);
    border-radius: 8px;
  }

  .custom-curve-preview {
    width: 100%;
    background: rgba(148, 163, 184, 0.12);
    border: 1px solid rgba(148, 163, 184, 0.35);
    border-radius: 10px;
    padding: 12px 14px;
    font-size: 13px;
    line-height: 1.4;
  }

  .custom-curve-preview pre {
    margin: 0;
    font-family: 'JetBrains Mono', 'Fira Mono', 'SFMono-Regular', Menlo, Monaco, Consolas, 'Liberation Mono',
      'Courier New', monospace;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .custom-curve-preview-more {
    margin-top: 8px;
    font-size: 12px;
    color: var(--muted);
  }

  .custom-curve-modal textarea {
    width: 100%;
    min-height: 160px;
    resize: vertical;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  @media (max-width: 1200px) {
    .storm-form__header {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  @media (max-width: 720px) {
    .storm-form {
      gap: 24px;
    }

    .storm-card {
      padding: 16px;
      gap: 16px;
    }

    .distribution-actions {
      flex-direction: column;
    }

    .distribution-actions button {
      flex: 1 1 auto;
      width: 100%;
    }
  }

  @media (max-width: 540px) {
    .storm-form__header {
      gap: 20px;
    }

    .mode-header {
      flex-direction: column;
      align-items: stretch;
    }

    .mode-toggle-groups {
      width: 100%;
      flex-direction: column;
      gap: 10px;
    }

    .mode-toggle {
      width: 100%;
      justify-content: center;
    }

    .mode-toggle button {
      flex: 1 1 50%;
    }
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
    overflow: auto;
    -webkit-overflow-scrolling: touch;
  }

  .noaa-table {
    padding: 0;
    overflow: visible;
    width: max-content;
    min-width: 100%;
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .table-header,
  .table-row {
    display: grid;
    align-items: stretch;
  }

  .table-header {
    background: rgba(255, 255, 255, 0.03);
    border-bottom: 1px solid var(--border);
  }

  .table-header__ari {
    padding: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
    text-align: center;
    position: sticky;
    left: 0;
    z-index: 3;
    background: rgba(15, 23, 42, 0.85);
    backdrop-filter: blur(4px);
    border-right: 1px solid rgba(255, 255, 255, 0.06);
  }

  .ari-label {
    display: block;
    white-space: normal;
    line-height: 1.3;
  }

  .table-header__duration {
    border-left: 1px solid rgba(255, 255, 255, 0.04);
    display: flex;
    align-items: stretch;
  }

  .table-header__duration.column-active {
    background: rgba(110, 231, 255, 0.12);
  }

  .table-body {
    max-height: 320px;
    overflow-y: auto;
  }

  .table-row {
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  }

  .table-row:last-child {
    border-bottom: none;
  }

  .table-row:hover {
    background: rgba(110, 231, 255, 0.08);
  }

  .table-row.ari-active {
    background: rgba(110, 231, 255, 0.12);
  }

  .ari-cell {
    padding: 12px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 2px;
    background: rgba(15, 23, 42, 0.75);
    font-size: 12px;
    position: sticky;
    left: 0;
    z-index: 2;
    border-right: 1px solid rgba(255, 255, 255, 0.06);
  }

  .ari-value {
    font-size: 13px;
    letter-spacing: 0.04em;
  }

  .ari-caption {
    font-size: 10px;
    color: var(--muted);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .table-button {
    background: transparent;
    border: none;
    color: inherit;
    font: inherit;
    padding: 10px 12px;
    width: 100%;
    cursor: pointer;
    border-radius: 0;
    text-align: center;
  }

  .table-button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .table-button:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .duration-btn {
    font-weight: 600;
  }

  .duration-btn.active {
    background: rgba(110, 231, 255, 0.18);
    color: #04131c;
  }

  .table-button.cell {
    border-left: 1px solid rgba(255, 255, 255, 0.04);
  }

  .table-button.cell.column-active {
    background: rgba(110, 231, 255, 0.12);
  }

  .table-button.cell:hover:not(:disabled) {
    background: rgba(110, 231, 255, 0.18);
    color: #04131c;
  }

  .table-button.cell.column-active:hover:not(:disabled) {
    background: rgba(110, 231, 255, 0.24);
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
    background: rgba(249, 115, 22, 0.6);
    color: #04131c;
    font-weight: 600;
  }

  .table-button.cell.interpolated:hover {
    background: rgba(249, 115, 22, 0.75);
  }

  @media (max-width: 720px) {
    .table-button {
      padding: 8px 10px;
      font-size: 12px;
    }

    .ari-cell {
      padding: 10px;
    }

    .table-header__ari {
      font-size: 10px;
    }
  }

  textarea {
    resize: vertical;
  }

  .actions {
    display: flex;
    gap: 10px;
    margin: 14px 0;
    align-items: center;
    flex-wrap: wrap;
  }

  .storm-loading {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border-radius: 999px;
    border: 1px solid rgba(110, 231, 255, 0.35);
    background: rgba(110, 231, 255, 0.08);
    color: var(--accent);
    font-size: 13px;
    letter-spacing: 0.02em;
    margin: 4px 0 18px;
    box-shadow: 0 8px 20px rgba(5, 18, 26, 0.35);
  }

  .storm-loading__spinner {
    width: 18px;
    height: 18px;
    border-radius: 999px;
    border: 2px solid rgba(110, 231, 255, 0.2);
    border-top-color: var(--accent);
    animation: storm-loading-spin 0.8s linear infinite;
  }

  @keyframes storm-loading-spin {
    to {
      transform: rotate(360deg);
    }
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
