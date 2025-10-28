<script lang="ts">
  import { onMount, onDestroy, tick, afterUpdate } from 'svelte'
  import { fade } from 'svelte/transition'
  import L from 'leaflet'
  import markerIcon2xUrl from 'leaflet/dist/images/marker-icon-2x.png'
  import markerIconUrl from 'leaflet/dist/images/marker-icon.png'
  import markerShadowUrl from 'leaflet/dist/images/marker-shadow.png'
  import Plotly from 'plotly.js-dist-min'
  import type { ColorBar, Config, Data, Layout, PlotlyHTMLElement } from 'plotly.js'
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
  import designStormLightIcon from './design_storm.ico'
  import designStormDarkIcon from './design_storm_dark.ico'
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
    stormIsComputing,
    stormResult,
    table as tableStore,
    timestepMin,
    timestepIsLocked,
    type StormResult
  } from './lib/stores'

  let mapDiv: HTMLDivElement
  let plotDiv1: HTMLDivElement
  let plotDiv2: HTMLDivElement
  let plotDiv3: HTMLDivElement
  let isoPlotDiv: HTMLDivElement
  let noaa3dPlotDiv: HTMLDivElement | null = null
  let noaaIntensityPlotDiv: HTMLDivElement | null = null
  let noaaTablistEl: HTMLDivElement | null = null
  let curvePlotDiv: HTMLDivElement | null = null
  let curveModalDialog: HTMLDivElement | null = null
  let customCurveModalDialog: HTMLDivElement | null = null
  let customCurveTextarea: HTMLTextAreaElement | null = null

  let chartsAreRendering = false
  let tableIsRendering = false
  let isoPlotIsRendering = false
  let noaa3dPlotIsRendering = false
  let noaaIntensityPlotIsRendering = false
  let comparisonCurvesAreComputing = false
  let curvePlotIsRendering = false
  let activeRenderToken = 0

  let map: L.Map
  let marker: L.Marker

  const CONTINENTAL_US_CENTER = { lat: 39.8283, lon: -98.5795 }
  const CONTINENTAL_US_ZOOM = 4
  const USER_LOCATION_ZOOM = 9

  function setMapViewToContinentalUs() {
    $lat = CONTINENTAL_US_CENTER.lat
    $lon = CONTINENTAL_US_CENTER.lon
    map?.setView([$lat, $lon], CONTINENTAL_US_ZOOM)
  }

  const noaaVisualTabs = [
    { id: 'isoLines', label: 'Depth Iso-Lines' },
    { id: 'rdi3d', label: '3D RDI Surface' },
    { id: 'intensity', label: 'Intensity Chart' }
  ] as const

  type NoaaVisualKey = (typeof noaaVisualTabs)[number]['id']

  let activeNoaaVisual: NoaaVisualKey = 'isoLines'
  let previousNoaaVisual: NoaaVisualKey = activeNoaaVisual

  const stormRainDrops = Array.from({ length: 8 }, (_, index) => index)

  const defaultMarkerIcons: Partial<L.IconOptions> = {
    iconRetinaUrl: markerIcon2xUrl,
    iconUrl: markerIconUrl,
    shadowUrl: markerShadowUrl
  }

  L.Icon.Default.mergeOptions(defaultMarkerIcons)

  type Theme = 'light' | 'dark'
  const THEME_STORAGE_KEY = 'designstorms:theme'
  let theme: Theme = 'dark'
  let designStormIcon = designStormLightIcon
  let hasExplicitTheme = false
  let prefersLightMedia: MediaQueryList | null = null
  let prefersLightChangeHandler: ((event: MediaQueryListEvent) => void) | null = null

  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = theme
  }

  $: designStormIcon = theme === 'light' ? designStormDarkIcon : designStormLightIcon

  function applyTheme(value: Theme) {
    theme = value
    if (typeof document !== 'undefined') {
      document.documentElement.dataset.theme = value
    }
  }

  function readStoredTheme(): Theme | null {
    try {
      const stored = localStorage.getItem(THEME_STORAGE_KEY)
      if (stored === 'light' || stored === 'dark') {
        return stored
      }
    } catch (error) {
      console.warn('Unable to read stored theme preference.', error)
    }
    return null
  }

  function addMediaQueryListener(mediaQuery: MediaQueryList, handler: (event: MediaQueryListEvent) => void) {
    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handler)
    } else {
      const legacyMediaQuery = mediaQuery as unknown as {
        addListener?: (listener: (event: MediaQueryListEvent) => void) => void
      }
      legacyMediaQuery.addListener?.(handler)
    }
  }

  function removeMediaQueryListener(mediaQuery: MediaQueryList, handler: (event: MediaQueryListEvent) => void) {
    if (typeof mediaQuery.removeEventListener === 'function') {
      mediaQuery.removeEventListener('change', handler)
    } else {
      const legacyMediaQuery = mediaQuery as unknown as {
        removeListener?: (listener: (event: MediaQueryListEvent) => void) => void
      }
      legacyMediaQuery.removeListener?.(handler)
    }
  }

  function initializeTheme() {
    let initialTheme: Theme = theme

    const storedTheme = readStoredTheme()
    if (storedTheme) {
      initialTheme = storedTheme
      hasExplicitTheme = true
    }

    if (!hasExplicitTheme && typeof window !== 'undefined') {
      prefersLightMedia = window.matchMedia('(prefers-color-scheme: light)')
      if (prefersLightMedia.matches) {
        initialTheme = 'light'
      }
      prefersLightChangeHandler = (event: MediaQueryListEvent) => {
        if (!hasExplicitTheme) {
          applyTheme(event.matches ? 'light' : 'dark')
        }
      }
      addMediaQueryListener(prefersLightMedia, prefersLightChangeHandler)
    }

    applyTheme(initialTheme)
  }

  function teardownTheme() {
    if (prefersLightMedia && prefersLightChangeHandler) {
      removeMediaQueryListener(prefersLightMedia, prefersLightChangeHandler)
    }
    prefersLightMedia = null
    prefersLightChangeHandler = null
  }

  function toggleTheme() {
    const nextTheme: Theme = theme === 'dark' ? 'light' : 'dark'
    hasExplicitTheme = true
    applyTheme(nextTheme)
    try {
      localStorage.setItem(THEME_STORAGE_KEY, nextTheme)
    } catch (error) {
      console.warn('Unable to persist theme preference.', error)
    }
  }

  let searchQuery = ''
  let isSearchingLocation = false
  let searchFeedback = ''
  let searchHasError = false

  let autoFetch = true
  let fetchTimer: ReturnType<typeof setTimeout> | null = null
  let lastFetchKey = ''

  let noaaTableScrollEl: HTMLDivElement | null = null
  let observedNoaaScrollEl: HTMLDivElement | null = null
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

  const HUFF_BETA_PARAMS: Record<string, [number, number]> = {
    huff_q1: [1.5, 5.0],
    huff_q2: [2.0, 3.0],
    huff_q3: [3.0, 2.0],
    huff_q4: [5.0, 1.5]
  }

  function formatList(items: string[]): string {
    if (items.length === 0) return ''
    if (items.length === 1) return items[0]
    if (items.length === 2) return `${items[0]} and ${items[1]}`
    return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
  }

  function formatAriValue(value: number | string) {
    const numeric = typeof value === 'number' ? value : Number.parseFloat(value)
    if (Number.isFinite(numeric)) {
      return `${numeric.toLocaleString()}-year`
    }
    return `${value}-year`
  }

  function formatDurationText(label: string | null, hours: number | null) {
    if (label) {
      return label
    }
    if (!Number.isFinite(hours)) {
      return 'the selected duration'
    }
    if ((hours ?? 0) >= 1) {
      const fractionDigits = hours && hours < 10 ? 2 : 1
      return `${hours.toLocaleString(undefined, { maximumFractionDigits: fractionDigits })} hr`
    }
    const minutes = (hours ?? 0) * 60
    const fractionDigits = minutes < 10 ? 1 : 0
    return `${minutes.toLocaleString(undefined, { maximumFractionDigits: fractionDigits })} min`
  }

  function describeInterpolationCells(cells: InterpolationCell[]) {
    if (!cells.length) {
      return ''
    }

    const grouped = new Map<string, Set<string>>()
    cells.forEach((cell) => {
      if (!grouped.has(cell.duration)) {
        grouped.set(cell.duration, new Set())
      }
      grouped.get(cell.duration)?.add(cell.ari)
    })

    const entries = Array.from(grouped.entries()).map(([duration, ariSet]) => {
      const aris = Array.from(ariSet)
        .map((value) => ({ raw: value, numeric: Number.parseFloat(value) }))
        .sort((a, b) => {
          if (Number.isFinite(a.numeric) && Number.isFinite(b.numeric)) {
            return a.numeric - b.numeric
          }
          return a.raw.localeCompare(b.raw)
        })
        .map((entry) => entry.raw)

      return {
        duration,
        durationHr: toHours(duration),
        aris
      }
    })

    entries.sort((a, b) => {
      const diff = a.durationHr - b.durationHr
      if (Number.isFinite(diff)) {
        return diff
      }
      return a.duration.localeCompare(b.duration)
    })

    const pieces = entries.map(({ duration, aris }) => {
      const ariList = formatList(aris.map((value) => formatAriValue(value)))
      return `${duration} row (${ariList})`
    })

    return `the NOAA ${formatList(pieces)}`
  }

  let interpolatedCells: InterpolationCell[] = []
  let isExtrapolating = false
  type NoaaRow = NoaaTable['rows'][number]

  let customCurveDraft = ''
  let showCustomCurveModal = false
  let customCurveLines: string[] = []

  $: customCurveLines = $customCurveCsv.trim()
    ? $customCurveCsv
        .trim()
        .split(/\r?\n/)
    : []

  $: isStormProcessing =
    $stormIsComputing ||
    chartsAreRendering ||
    tableIsRendering ||
    isoPlotIsRendering ||
    noaa3dPlotIsRendering ||
    noaaIntensityPlotIsRendering ||
    comparisonCurvesAreComputing ||
    curvePlotIsRendering
  $: durationEntriesForTable = $tableStore
    ? $tableStore.rows.map((row, index) => ({ label: row.label, row, index }))
    : []
  let showHelp = false
  let showCurveModal = false
  let helpDialog: HTMLDivElement | null = null

  let isLoadingNoaa = false
  let noaaError = ''

  let lastStorm: StormResult | null = null
  
  let lastChangedBy: 'user' | 'duration' = 'user';
  let recentlyRecalculated: 'ari' | 'depth' | 'duration' | null = null;
  let recalculationTimer: ReturnType<typeof setTimeout> | null = null;


  const plotConfig: Partial<Config> = { responsive: true, displaylogo: false, displayModeBar: false }

  function downloadPlot(div: HTMLDivElement | null, filename: string) {
    if (!div) return
    void Plotly.downloadImage(div, { format: 'png', filename })
  }

  function downloadActiveNoaaVisual() {
    if (activeNoaaVisual === 'isoLines') {
      downloadPlot(isoPlotDiv, 'designstorm-noaa-depth-iso-lines')
    } else if (activeNoaaVisual === 'rdi3d') {
      downloadPlot(noaa3dPlotDiv, 'designstorm-noaa-rdi-surface')
    } else if (activeNoaaVisual === 'intensity') {
      downloadPlot(noaaIntensityPlotDiv, 'designstorm-noaa-intensity-visual')
    }
  }

  function handleNoaaTabKeydown(event: KeyboardEvent, index: number) {
    const { key } = event
    const tabButtons = noaaTablistEl
      ? (Array.from(
          noaaTablistEl.querySelectorAll<HTMLButtonElement>('button[role="tab"]')
        ) as HTMLButtonElement[])
      : []

    if (!tabButtons.length) {
      return
    }

    let targetIndex = index

    if (key === 'ArrowRight' || key === 'ArrowDown') {
      event.preventDefault()
      targetIndex = (index + 1) % tabButtons.length
    } else if (key === 'ArrowLeft' || key === 'ArrowUp') {
      event.preventDefault()
      targetIndex = (index - 1 + tabButtons.length) % tabButtons.length
    } else if (key === 'Home') {
      event.preventDefault()
      targetIndex = 0
    } else if (key === 'End') {
      event.preventDefault()
      targetIndex = tabButtons.length - 1
    } else {
      return
    }

    const nextTab = noaaVisualTabs[targetIndex]
    if (!nextTab) {
      return
    }

    activeNoaaVisual = nextTab.id
    tabButtons[targetIndex]?.focus()
  }
  type ChartTheme = {
    text: string
    axisGrid: string
    axisZero: string
    axisLine: string
    hyetographBar: string
    incrementalBar: string
    cumulativeLine: string
    hoverBg: string
    hoverBorder: string
    hoverText: string
    isoPoint: string
    isoPointBorder: string
    isoHighlight: string
    isoHighlightBorder: string
    isoLabel: string
    isoLine: string
    isoColorbarText: string
    isoColorbarTick: string
    isoColorbarOutline: string
    legendBg: string
    legendBorder: string
    sceneBg: string
    sceneText: string
    sceneGrid: string
    sceneZero: string
    sceneLine: string
    comparisonPalette: string[]
    idfPalette: string[]
  }

  const chartThemes: Record<Theme, ChartTheme> = {
    dark: {
      text: '#e7e7e7',
      axisGrid: 'rgba(255,255,255,0.08)',
      axisZero: 'rgba(255,255,255,0.1)',
      axisLine: 'rgba(255,255,255,0.2)',
      hyetographBar: '#6ee7ff',
      incrementalBar: '#a855f7',
      cumulativeLine: '#f97316',
      hoverBg: '#0f172a',
      hoverBorder: '#38bdf8',
      hoverText: '#f8fafc',
      isoPoint: 'rgba(226, 241, 255, 0.85)',
      isoPointBorder: 'rgba(11, 31, 75, 0.9)',
      isoHighlight: '#f8fafc',
      isoHighlightBorder: '#0ea5e9',
      isoLabel: '#0f172a',
      isoLine: 'rgba(15, 23, 42, 0.35)',
      isoColorbarText: '#e7e7e7',
      isoColorbarTick: '#e7e7e7',
      isoColorbarOutline: 'rgba(255, 255, 255, 0.1)',
      legendBg: 'rgba(15, 23, 42, 0.7)',
      legendBorder: 'rgba(148, 163, 184, 0.25)',
      sceneBg: 'rgba(15, 23, 42, 0.85)',
      sceneText: '#e7e7e7',
      sceneGrid: 'rgba(255,255,255,0.08)',
      sceneZero: 'rgba(255,255,255,0.1)',
      sceneLine: 'rgba(255,255,255,0.2)',
      comparisonPalette: [
        '#38bdf8',
        '#22d3ee',
        '#34d399',
        '#f97316',
        '#facc15',
        '#f472b6',
        '#a855f7',
        '#60a5fa',
        '#f87171',
        '#0ea5e9'
      ],
      idfPalette: [
        '#38bdf8',
        '#22d3ee',
        '#34d399',
        '#f97316',
        '#facc15',
        '#f472b6',
        '#a855f7',
        '#60a5fa',
        '#f87171',
        '#0ea5e9'
      ]
    },
    light: {
      text: '#0f172a',
      axisGrid: 'rgba(148, 163, 184, 0.35)',
      axisZero: 'rgba(148, 163, 184, 0.5)',
      axisLine: 'rgba(15, 23, 42, 0.25)',
      hyetographBar: '#0284c7',
      incrementalBar: '#7c3aed',
      cumulativeLine: '#ea580c',
      hoverBg: '#ffffff',
      hoverBorder: 'rgba(148, 163, 184, 0.65)',
      hoverText: '#0f172a',
      isoPoint: 'rgba(148, 197, 240, 0.85)',
      isoPointBorder: 'rgba(30, 64, 175, 0.6)',
      isoHighlight: '#0ea5e9',
      isoHighlightBorder: '#0369a1',
      isoLabel: '#0f172a',
      isoLine: 'rgba(15, 23, 42, 0.35)',
      isoColorbarText: '#0f172a',
      isoColorbarTick: '#0f172a',
      isoColorbarOutline: 'rgba(148, 163, 184, 0.35)',
      legendBg: 'rgba(255, 255, 255, 0.9)',
      legendBorder: 'rgba(148, 163, 184, 0.45)',
      sceneBg: '#f8fafc',
      sceneText: '#0f172a',
      sceneGrid: 'rgba(148, 163, 184, 0.35)',
      sceneZero: 'rgba(148, 163, 184, 0.5)',
      sceneLine: 'rgba(15, 23, 42, 0.25)',
      comparisonPalette: [
        '#0ea5e9',
        '#06b6d4',
        '#10b981',
        '#f97316',
        '#f59e0b',
        '#ec4899',
        '#8b5cf6',
        '#3b82f6',
        '#ef4444',
        '#0369a1'
      ],
      idfPalette: [
        '#0ea5e9',
        '#0891b2',
        '#22c55e',
        '#ea580c',
        '#ca8a04',
        '#d946ef',
        '#7c3aed',
        '#2563eb',
        '#dc2626',
        '#0f172a'
      ]
    }
  }

  function createPlotLayoutBase(theme: ChartTheme): Partial<Layout> {
    return {
      paper_bgcolor: 'transparent',
      plot_bgcolor: 'transparent',
      font: { color: theme.text },
      margin: { l: 60, r: 24, t: 30, b: 45 },
      colorway: theme.comparisonPalette,
      hovermode: 'closest',
      hoverlabel: {
        bgcolor: theme.hoverBg,
        bordercolor: theme.hoverBorder,
        font: { color: theme.hoverText }
      },
      xaxis: {
        gridcolor: theme.axisGrid,
        zerolinecolor: theme.axisZero,
        linecolor: theme.axisLine,
        mirror: true,
        tickfont: { color: theme.text },
        title: { font: { color: theme.text } }
      },
      yaxis: {
        gridcolor: theme.axisGrid,
        zerolinecolor: theme.axisZero,
        linecolor: theme.axisLine,
        mirror: true,
        tickfont: { color: theme.text },
        title: { font: { color: theme.text } }
      }
    }
  }

  let chartTheme: ChartTheme = chartThemes.dark
  let plotLayoutBase: Partial<Layout> = createPlotLayoutBase(chartTheme)

  $: chartTheme = chartThemes[theme] ?? chartThemes.dark
  $: plotLayoutBase = createPlotLayoutBase(chartTheme)

  $: if (previousNoaaVisual !== activeNoaaVisual) {
    if (previousNoaaVisual === 'isoLines' && isoPlotDiv) {
      detachIsoPlotClickHandler()
      Plotly.purge(isoPlotDiv)
      isoPlotReady = false
    } else if (previousNoaaVisual === 'rdi3d' && noaa3dPlotDiv) {
      detachNoaa3dPlotClickHandler()
      Plotly.purge(noaa3dPlotDiv)
      noaa3dPlotReady = false
    } else if (previousNoaaVisual === 'intensity' && noaaIntensityPlotDiv) {
      detachNoaaIntensityPlotClickHandler()
      Plotly.purge(noaaIntensityPlotDiv)
      noaaIntensityPlotReady = false
      noaaIntensityPlotIsRendering = false
    }

    previousNoaaVisual = activeNoaaVisual
  }

  $: if (activeNoaaVisual === 'isoLines' && noaaContourZ.length) {
    void tick().then(() => {
      if (activeNoaaVisual === 'isoLines') {
        drawIsoPlot()
      }
    })
  } else if (activeNoaaVisual === 'rdi3d' && noaaIntensityZ.length) {
    void tick().then(() => {
      if (activeNoaaVisual === 'rdi3d') {
        drawNoaa3dPlot()
      }
    })
  } else if (activeNoaaVisual === 'intensity' && noaaIntensityZ.length) {
    void tick().then(() => {
      if (activeNoaaVisual === 'intensity') {
        drawNoaaIntensityPlot()
      }
    })
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

  let resolvedDistribution: DistributionName = 'scs_type_ii'
  let stormSummaryLines: string[] = []

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
  let plot1Ready = false
  let plot2Ready = false
  let plot3Ready = false
  let isoPlotReady = false
  let noaa3dPlotReady = false
  let noaaIntensityPlotReady = false
  let curvePlotReady = false

  type DurationEntry = ReturnType<typeof getSortedDurationRows>[number]
  type AriEntry = { key: string; value: number }

  let noaaDurationEntries: DurationEntry[] = []
  let noaaAriEntries: AriEntry[] = []
  let noaaContourZ: (number | null)[][] = []
  let noaaIntensityZ: (number | null)[][] = []

  $: {
    const numericDuration = Number($selectedDurationHr)
    const safeDuration = Number.isFinite(numericDuration) ? numericDuration : DEFAULT_DURATION_HOURS
    resolvedDistribution = getBestScsDistribution($distribution, safeDuration, $durationMode)
  }

  $: {
    const lines: string[] = []
    const numericDuration = Number($selectedDurationHr)
    const durationHr = Number.isFinite(numericDuration) ? numericDuration : null
    const durationText = formatDurationText(
      $durationMode === 'custom' ? null : selectedDurationLabel,
      durationHr
    )
    const tableDurationText = formatDurationText(selectedDurationLabel, durationHr)
    const depthValue = Number.isFinite($selectedDepth) ? Number($selectedDepth) : null
    const depthText = depthValue != null ? `${depthValue.toFixed(2)} in` : null
    const ariValue = Number.isFinite($selectedAri) ? Number($selectedAri) : null
    const ariText = ariValue != null ? formatAriValue(ariValue) : null

    const resolvedLabel = getDistributionLabel(resolvedDistribution)

    let distributionLine = ''
    if ($distribution === 'user') {
      if (customCurveLines.length >= 2) {
        distributionLine = `Rainfall pattern comes from the custom CSV (${customCurveLines.length} rows) and is stretched across ${durationText}.`
      } else {
        distributionLine = 'Rainfall pattern falls back to a straight-line ramp because no custom CSV points are loaded.'
      }
    } else if (resolvedDistribution !== $distribution) {
      const modeLabel = $durationMode === 'standard' ? 'preset' : 'custom duration'
      distributionLine = `Rainfall pattern uses the ${resolvedLabel} table as the closest match for the ${modeLabel} of ${durationText}.`
    } else if (resolvedDistribution.startsWith('huff_')) {
      const params = HUFF_BETA_PARAMS[resolvedDistribution]
      if (params) {
        distributionLine = `Rainfall pattern follows the ${resolvedLabel} curve, generated from a Beta distribution (a = ${params[0]}, b = ${params[1]}).`
      } else {
        distributionLine = `Rainfall pattern follows the ${resolvedLabel} curve.`
      }
    } else {
      distributionLine = `Rainfall pattern follows the ${resolvedLabel} curve.`
    }

    if (distributionLine) {
      lines.push(distributionLine)
    }

    const table = $tableStore
    let noaaLine = ''
    if (depthText && ariText) {
      if (table && selectedDurationLabel) {
        const row = table.rows.find((entry) => entry.label === selectedDurationLabel)
        const ariKey = String($selectedAri)
        const tableDepth = row ? row.values[ariKey] : Number.NaN
        const hasExactDepth = Number.isFinite(tableDepth) && Math.abs(Number(tableDepth) - depthValue!) < 0.005

        if (hasExactDepth) {
          noaaLine = `Depth of ${depthText} for the ${durationText} storm comes directly from ${tableDurationText} / ${ariText} in the NOAA table.`
        } else if (interpolatedCells.length) {
          const description = describeInterpolationCells(interpolatedCells)
          if (description) {
            noaaLine = `Depth of ${depthText} for the ${durationText} storm was ${
              isExtrapolating ? 'extrapolated' : 'interpolated'
            } from ${description}.`
          }
        } else {
          noaaLine = `Depth of ${depthText} for the ${durationText} storm was entered manually for ${ariText}.`
        }
      } else {
        noaaLine = `Depth of ${depthText} for the ${durationText} storm was entered manually because no NOAA table is loaded.`
      }
    }

    if (noaaLine) {
      lines.push(noaaLine)
    }

    let computationLine = ''
    if (lastStorm) {
      const effectiveStep = Number(lastStorm.effectiveTimestepMin)
      const sampleCount = Array.isArray(lastStorm.timeMin) ? lastStorm.timeMin.length : null
      if (lastStorm.timestepLocked && Number.isFinite(effectiveStep)) {
        computationLine = `NRCS table locks the timestep at ${effectiveStep.toLocaleString(undefined, { maximumFractionDigits: 2 })} minutes (${sampleCount?.toLocaleString() ?? '0'} points).`
      } else if ($computationMode === 'fast' && Number.isFinite(effectiveStep)) {
        computationLine = `Fast mode condensed the storm to ${sampleCount?.toLocaleString() ?? '0'} steps (about ${effectiveStep.toLocaleString(undefined, { maximumFractionDigits: 2 })} minutes apart).`
      } else if (Number.isFinite(effectiveStep)) {
        computationLine = `Precise mode is using ${sampleCount?.toLocaleString() ?? '0'} steps at ${effectiveStep.toLocaleString(undefined, { maximumFractionDigits: 2 })} minute spacing.`
      } else if (sampleCount != null) {
        computationLine = `Storm output spans ${sampleCount.toLocaleString()} steps.`
      }
    } else if ($computationMode === 'fast') {
      computationLine = `Fast mode will limit the storm to ${MAX_FAST_SAMPLES.toLocaleString()} evenly spaced timesteps if the requested spacing is denser.`
    } else if (Number.isFinite($timestepMin)) {
      computationLine = `Precise mode will follow every ${Number($timestepMin).toLocaleString(undefined, { maximumFractionDigits: 2 })}-minute timestep.`
    }

    if (computationLine) {
      lines.push(computationLine)
    }

    stormSummaryLines = lines.filter(Boolean)
  }

  $: {
    const table = $tableStore

    if (!table || !aris.length) {
      noaaDurationEntries = []
      noaaAriEntries = []
      noaaContourZ = []
      noaaIntensityZ = []
    } else {
      const durationEntries = getSortedDurationRows(table)
      const ariEntries = aris
        .map((key) => ({ key, value: Number(key) }))
        .filter((entry) => Number.isFinite(entry.value))
        .sort((a, b) => a.value - b.value)

      if (!durationEntries.length || !ariEntries.length) {
        noaaDurationEntries = []
        noaaAriEntries = []
        noaaContourZ = []
        noaaIntensityZ = []
      } else {
        const contour = ariEntries.map((ariEntry) =>
          durationEntries.map(({ row }) => {
            const depth = row.values[ariEntry.key]
            return Number.isFinite(depth) ? Number(depth) : null
          })
        )

        const intensity = contour.map((row) =>
          row.map((depth, colIdx) => {
            const durationEntry = durationEntries[colIdx]
            if (!durationEntry || depth == null) {
              return null
            }
            const hours = durationEntry.hr
            return Number.isFinite(hours) && hours > 0 ? depth / hours : null
          })
        )

        noaaDurationEntries = durationEntries
        noaaAriEntries = ariEntries
        noaaContourZ = contour
        noaaIntensityZ = intensity
      }
    }
  }

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

  const handleNoaaScroll = () => {
    updateNoaaStickyOffset()
  }

  function attachNoaaScrollListener() {
    if (observedNoaaScrollEl === noaaTableScrollEl) {
      updateNoaaStickyOffset()
      return
    }

    if (observedNoaaScrollEl) {
      observedNoaaScrollEl.removeEventListener('scroll', handleNoaaScroll)
    }

    if (noaaTableScrollEl) {
      noaaTableScrollEl.addEventListener('scroll', handleNoaaScroll, { passive: true })
      observedNoaaScrollEl = noaaTableScrollEl
      updateNoaaStickyOffset()
    } else {
      observedNoaaScrollEl = null
    }
  }

  function updateNoaaStickyOffset() {
    if (!noaaTableScrollEl) return

    noaaTableScrollEl.style.setProperty('--noaa-scroll-left', `${noaaTableScrollEl.scrollLeft}px`)
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

    if (!map) return

    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        map?.invalidateSize()
      })
    } else {
      map.invalidateSize()
    }
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
      drawNoaa3dPlot()
      drawNoaaIntensityPlot()
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
    isExtrapolating = false
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
      isExtrapolating = false
      return
    }
    const interpolated = interpolateDepthFromAri(row, $selectedAri, table.aris)
    if (interpolated) {
      $selectedDepth = interpolated.depth
      interpolatedCells = interpolated.highlight ?? []
      isExtrapolating = interpolated.extrapolated
      return
    }
    interpolatedCells = []
    isExtrapolating = false
  }

  $: {
    const storm = $stormResult
    lastStorm = storm
    plot1Ready = false
    plot2Ready = false
    plot3Ready = false

    if (!storm) {
      peakIntensity = 0
      totalDepth = 0
      timeAxis = []
      timeColumnLabel = 'Time (hr)'
      tableRows = []
      hasTimestamp = false
      chartsAreRendering = false
      tableIsRendering = false

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
      tableIsRendering = true
      const currentRenderToken = ++activeRenderToken
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

      void tick().then(() => {
        if (currentRenderToken === activeRenderToken) {
          tableIsRendering = false
        }
      })

      const plotPromises: Promise<PlotlyHTMLElement>[] = []

      if (plotDiv1) {
        plotPromises.push(
          Plotly.react(
            plotDiv1,
            [
              {
                x: timeAxis,
                y: storm.intensityInHr,
                type: 'bar',
                name: 'Intensity (in/hr)',
                marker: { color: chartTheme.hyetographBar },
                hovertemplate: `${hoverTimeLabel}: %{x:.2f}<br>Intensity: %{y:.2f} in/hr<extra></extra>`,
                width: barWidth
              }
            ],
            {
              ...plotLayoutBase,
              title: { text: 'Hyetograph (Intensity)', font: { color: chartTheme.text } },
              xaxis: {
                ...plotLayoutBase.xaxis,
                title: { ...(plotLayoutBase.xaxis?.title ?? {}), text: axisTitle }
              },
              yaxis: {
                ...plotLayoutBase.yaxis,
                title: {
                  ...(plotLayoutBase.yaxis?.title ?? {}),
                  text: 'Intensity (in/hr)'
                }
              }
            },
            plotConfig
          )
        )
        plot1Ready = true
      }

      if (plotDiv2) {
        plotPromises.push(
          Plotly.react(
            plotDiv2,
            [
              {
                x: timeAxis,
                y: storm.incrementalIn,
                type: 'bar',
                name: 'Incremental Volume (in)',
                marker: { color: chartTheme.incrementalBar },
                hovertemplate: `${hoverTimeLabel}: %{x:.2f}<br>Incremental: %{y:.3f} in<extra></extra>`,
                width: barWidth
              }
            ],
            {
              ...plotLayoutBase,
              title: { text: 'Incremental Volume', font: { color: chartTheme.text } },
              xaxis: {
                ...plotLayoutBase.xaxis,
                title: { ...(plotLayoutBase.xaxis?.title ?? {}), text: axisTitle }
              },
              yaxis: {
                ...plotLayoutBase.yaxis,
                title: { ...(plotLayoutBase.yaxis?.title ?? {}), text: 'Volume (in)' }
              }
            },
            plotConfig
          )
        )
        plot2Ready = true
      }

      if (plotDiv3) {
        plotPromises.push(
          Plotly.react(
            plotDiv3,
            [
              {
                x: timeAxis,
                y: storm.cumulativeIn,
                type: 'scatter',
                mode: 'lines',
                name: 'Cumulative (in)',
                line: { color: chartTheme.cumulativeLine, width: 3 },
                hovertemplate: `${hoverTimeLabel}: %{x:.2f}<br>Cumulative: %{y:.3f} in<extra></extra>`
              }
            ],
            {
              ...plotLayoutBase,
              title: { text: 'Cumulative Mass Curve', font: { color: chartTheme.text } },
              xaxis: {
                ...plotLayoutBase.xaxis,
                title: { ...(plotLayoutBase.xaxis?.title ?? {}), text: axisTitle }
              },
              yaxis: {
                ...plotLayoutBase.yaxis,
                title: {
                  ...(plotLayoutBase.yaxis?.title ?? {}),
                  text: 'Cumulative Depth (in)'
                }
              }
            },
            plotConfig
          )
        )
        plot3Ready = true
      }

      if (plotPromises.length) {
        chartsAreRendering = true
        Promise.all(plotPromises)
          .catch((error) => {
            console.error('Error rendering storm plots', error)
          })
          .finally(() => {
            if (currentRenderToken === activeRenderToken) {
              chartsAreRendering = false
            }
          })
      } else if (currentRenderToken === activeRenderToken) {
        chartsAreRendering = false
      }
    }

    drawIsoPlot()
    drawNoaa3dPlot()
    drawNoaaIntensityPlot()
  }
  function drawIsoPlot() {
    isoPlotReady = false
    if (activeNoaaVisual !== 'isoLines') {
      isoPlotIsRendering = false
      if (isoPlotDiv) {
        detachIsoPlotClickHandler()
        Plotly.purge(isoPlotDiv)
      }
      return
    }
    if (!isoPlotDiv) {
      isoPlotIsRendering = false
      return
    }

    const table = $tableStore

    if (!table || !aris.length) {
      isoPlotIsRendering = false
      Plotly.purge(isoPlotDiv)
      detachIsoPlotClickHandler()
      return
    }

    const durationEntries = noaaDurationEntries
    if (!durationEntries.length) {
      isoPlotIsRendering = false
      Plotly.purge(isoPlotDiv)
      detachIsoPlotClickHandler()
      return
    }

    const ariEntries = noaaAriEntries
    if (!ariEntries.length) {
      isoPlotIsRendering = false
      Plotly.purge(isoPlotDiv)
      detachIsoPlotClickHandler()
      return
    }

    const contourZ = noaaContourZ

    const customData = ariEntries.map((ariEntry) =>
      durationEntries.map((entry) => [entry.label, ariEntry.key])
    )

    const finiteDepths = contourZ
      .flat()
      .filter((value): value is number => value !== null && Number.isFinite(value))

    if (!finiteDepths.length) {
      isoPlotIsRendering = false
      Plotly.purge(isoPlotDiv)
      detachIsoPlotClickHandler()
      return
    }

    let minDepth = Math.min(...finiteDepths)
    let maxDepth = Math.max(...finiteDepths)

    if (!Number.isFinite(minDepth) || !Number.isFinite(maxDepth)) {
      isoPlotIsRendering = false
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
        font: { color: chartTheme.isoColorbarText, size: isCompact ? 12 : undefined }
      },
      thickness: isCompact ? 10 : 14,
      tickcolor: chartTheme.isoColorbarTick,
      tickfont: { color: chartTheme.isoColorbarTick, size: isCompact ? 10 : 12 },
      outlinecolor: chartTheme.isoColorbarOutline
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
        labelfont: { color: chartTheme.isoLabel, size: isCompact ? 10 : 11 }
      },
      line: { color: chartTheme.isoLine, smoothing: 0.6, width: 1 },
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
        color: chartTheme.isoPoint,
        size: 8,
        line: { color: chartTheme.isoPointBorder, width: 1.5 },
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
            color: chartTheme.isoHighlight,
            size: 12,
            line: { color: chartTheme.isoHighlightBorder, width: 3 },
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
      title: { text: 'NOAA Depth Iso-Lines', font: { color: chartTheme.text } },
      margin: isCompact
        ? { l: 64, r: 26, t: 48, b: 96 }
        : { l: 72, r: 70, t: 40, b: 88 },
      xaxis: {
        ...plotLayoutBase.xaxis,
        title: {
          ...(plotLayoutBase.xaxis?.title ?? {}),
          text: 'Duration (hr)',
          font: {
            ...(plotLayoutBase.xaxis?.title?.font ?? {}),
            size: isCompact ? 12 : undefined
          }
        },
        type: 'log',
        tickmode: 'array',
        tickvals: filteredDurationEntries.map((entry) => entry.hr),
        ticktext: filteredDurationEntries.map((entry) => entry.label),
        tickangle: isCompact ? -45 : 0,
        tickfont: { color: chartTheme.text, size: isCompact ? 10 : 12 },
        automargin: true
      },
      yaxis: {
        ...plotLayoutBase.yaxis,
        title: {
          ...(plotLayoutBase.yaxis?.title ?? {}),
          text: 'Average Recurrence Interval (years)',
          font: {
            ...(plotLayoutBase.yaxis?.title?.font ?? {}),
            size: isCompact ? 12 : undefined
          }
        },
        type: 'log',
        tickmode: 'array',
        tickvals: filteredAriEntries.map((entry) => entry.value),
        ticktext: filteredAriEntries.map((entry) => entry.key),
        tickfont: { color: chartTheme.text, size: isCompact ? 10 : 12 },
        automargin: true
      },
      hovermode: 'closest',
      hoverlabel: {
        bgcolor: chartTheme.hoverBg,
        bordercolor: chartTheme.hoverBorder,
        font: {
          color: chartTheme.hoverText
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

    isoPlotIsRendering = true
    Promise.resolve(
      Plotly.react(isoPlotDiv, data, layout, {
        ...plotConfig,
        displayModeBar: false
      })
    )
      .then(() => {
        attachIsoPlotClickHandler()
        isoPlotReady = true
      })
      .catch((error) => {
        console.error('Error rendering iso-depth plot', error)
      })
      .finally(() => {
        isoPlotIsRendering = false
      })
  }

  function drawNoaa3dPlot() {
    noaa3dPlotReady = false
    if (activeNoaaVisual !== 'rdi3d') {
      noaa3dPlotIsRendering = false
      if (noaa3dPlotDiv) {
        detachNoaa3dPlotClickHandler()
        Plotly.purge(noaa3dPlotDiv)
      }
      return
    }

    if (!noaa3dPlotDiv) {
      noaa3dPlotIsRendering = false
      return
    }

    const table = $tableStore

    if (
      !table ||
      !noaaDurationEntries.length ||
      !noaaAriEntries.length ||
      !noaaContourZ.length ||
      !noaaIntensityZ.length
    ) {
      noaa3dPlotIsRendering = false
      detachNoaa3dPlotClickHandler()
      Plotly.purge(noaa3dPlotDiv)
      return
    }

    const finiteIntensities = noaaIntensityZ
      .flat()
      .filter((value): value is number => value != null && Number.isFinite(value))

    if (!finiteIntensities.length) {
      noaa3dPlotIsRendering = false
      detachNoaa3dPlotClickHandler()
      Plotly.purge(noaa3dPlotDiv)
      return
    }

    const minIntensity = Math.min(...finiteIntensities)
    const maxIntensity = Math.max(...finiteIntensities)

    if (!Number.isFinite(minIntensity) || !Number.isFinite(maxIntensity)) {
      noaa3dPlotIsRendering = false
      detachNoaa3dPlotClickHandler()
      Plotly.purge(noaa3dPlotDiv)
      return
    }

    const customData = noaaAriEntries.map((ariEntry, rowIdx) =>
      noaaDurationEntries.map((durationEntry, colIdx) => {
        const depth = noaaContourZ[rowIdx]?.[colIdx] ?? null
        const intensity = noaaIntensityZ[rowIdx]?.[colIdx] ?? null
        return [
          durationEntry.label,
          durationEntry.hr,
          ariEntry.key,
          Number.isFinite(depth as number) ? depth : null,
          Number.isFinite(intensity as number) ? intensity : null
        ]
      })
    )

    const colorbar: Partial<ColorBar> = {
      title: { text: 'Intensity (in/hr)', font: { color: chartTheme.isoColorbarText } },
      tickcolor: chartTheme.isoColorbarTick,
      tickfont: { color: chartTheme.isoColorbarTick, size: 11 },
      outlinecolor: chartTheme.isoColorbarOutline
    }

    const surfaceTrace: Data = {
      type: 'surface',
      x: noaaDurationEntries.map((entry) => entry.hr),
      y: noaaAriEntries.map((entry) => entry.value),
      z: noaaIntensityZ,
      customdata: customData,
      colorscale: 'Viridis',
      colorbar,
      cmin: minIntensity,
      cmax: maxIntensity,
      opacity: 0.95,
      hovertemplate:
        'Duration: %{customdata[0]} (%{customdata[1]:.2f} hr)<br>' +
        'ARI: %{customdata[2]}-year<br>' +
        'Depth: %{customdata[3]:.2f} in<br>' +
        'Intensity: %{customdata[4]:.2f} in/hr<extra></extra>'
    }

    const dataTraces: Data[] = [surfaceTrace]

    const selectedNoaaTrace = (() => {
      if (!table || !selectedDurationLabel) {
        return null
      }

      const durationIndex = noaaDurationEntries.findIndex(
        (entry) => entry.label === selectedDurationLabel
      )
      const ariIndex = noaaAriEntries.findIndex(
        (entry) => entry.key === String($selectedAri)
      )

      if (durationIndex < 0 || ariIndex < 0) {
        return null
      }

      const durationEntry = noaaDurationEntries[durationIndex]
      const ariEntry = noaaAriEntries[ariIndex]
      const depth = noaaContourZ[ariIndex]?.[durationIndex]
      const intensity = noaaIntensityZ[ariIndex]?.[durationIndex]

      if (!Number.isFinite(intensity as number) || !Number.isFinite(depth as number)) {
        return null
      }

      const highlightDepthValue = Number(depth)
      const highlightIntensityValue = Number(intensity)

      return {
        type: 'scatter3d',
        mode: 'markers',
        x: [durationEntry.hr],
        y: [ariEntry.value],
        z: [highlightIntensityValue],
        marker: {
          color: chartTheme.isoHighlight,
          size: 6,
          line: { color: chartTheme.isoHighlightBorder, width: 2 },
          symbol: 'circle'
        },
        name: 'Selected NOAA cell',
        showlegend: false,
        customdata: [
          [
            durationEntry.label,
            durationEntry.hr,
            ariEntry.key,
            highlightDepthValue,
            highlightIntensityValue
          ]
        ],
        hovertemplate:
          `Duration: ${durationEntry.label} (${durationEntry.hr.toFixed(2)} hr)` +
          `<br>ARI: ${ariEntry.key}-year` +
          `<br>Intensity: ${highlightIntensityValue.toFixed(2)} in/hr` +
          `<br>Depth: ${highlightDepthValue.toFixed(3)} in<extra></extra>`
      } satisfies Data
    })()

    if (selectedNoaaTrace) {
      dataTraces.push(selectedNoaaTrace)
    }

    const durationHrNumeric = Number($selectedDurationHr)
    const ariNumeric = Number($selectedAri)
    const depthNumeric = Number($selectedDepth)

    if (
      Number.isFinite(durationHrNumeric) &&
      durationHrNumeric > 0 &&
      Number.isFinite(ariNumeric) &&
      ariNumeric > 0 &&
      Number.isFinite(depthNumeric) &&
      depthNumeric > 0
    ) {
      const intensityValue = depthNumeric / durationHrNumeric

      if (Number.isFinite(intensityValue) && intensityValue > 0) {
        dataTraces.push({
          type: 'scatter3d',
          mode: 'markers',
          x: [durationHrNumeric],
          y: [ariNumeric],
          z: [intensityValue],
          marker: {
            color: '#ef4444',
            size: 7,
            line: { color: '#b91c1c', width: 2 },
            symbol: 'circle'
          },
          name: 'Current storm parameters',
          showlegend: false,
          hovertemplate:
            'Current Storm' +
            `<br>Duration: ${durationHrNumeric.toFixed(2)} hr` +
            `<br>ARI: ${ariNumeric}-year` +
            `<br>Intensity: ${intensityValue.toFixed(2)} in/hr` +
            `<br>Depth: ${depthNumeric.toFixed(3)} in<extra></extra>`
        })
      }
    }

    const layout: Partial<Layout> = {
      ...plotLayoutBase,
      margin: { l: 10, r: 10, t: 50, b: 20 },
      scene: {
        bgcolor: chartTheme.sceneBg,
        xaxis: {
          type: 'log',
          title: { text: 'Duration (hr)', font: { color: chartTheme.sceneText } },
          gridcolor: chartTheme.sceneGrid,
          zerolinecolor: chartTheme.sceneZero,
          linecolor: chartTheme.sceneLine,
          tickfont: { color: chartTheme.sceneText }
        },
        yaxis: {
          type: 'log',
          title: { text: 'ARI (years)', font: { color: chartTheme.sceneText } },
          gridcolor: chartTheme.sceneGrid,
          zerolinecolor: chartTheme.sceneZero,
          linecolor: chartTheme.sceneLine,
          tickfont: { color: chartTheme.sceneText }
        },
        zaxis: {
          title: { text: 'Intensity (in/hr)', font: { color: chartTheme.sceneText } },
          gridcolor: chartTheme.sceneGrid,
          zerolinecolor: chartTheme.sceneZero,
          linecolor: chartTheme.sceneLine,
          tickfont: { color: chartTheme.sceneText }
        }
      }
    }

    noaa3dPlotIsRendering = true
    Promise.resolve(
      Plotly.react(noaa3dPlotDiv, dataTraces, layout, {
        ...plotConfig,
        displayModeBar: true
      })
    )
      .then(() => {
        attachNoaa3dPlotClickHandler()
        noaa3dPlotReady = true
      })
      .catch((error) => {
        console.error('Error rendering NOAA RDI surface plot', error)
      })
      .finally(() => {
        noaa3dPlotIsRendering = false
      })
  }

  function drawNoaaIntensityPlot() {
    noaaIntensityPlotReady = false
    if (activeNoaaVisual !== 'intensity') {
      noaaIntensityPlotIsRendering = false
      if (noaaIntensityPlotDiv) {
        detachNoaaIntensityPlotClickHandler()
        Plotly.purge(noaaIntensityPlotDiv)
      }
      return
    }

    if (!noaaIntensityPlotDiv) {
      noaaIntensityPlotIsRendering = false
      return
    }

    const table = $tableStore

    if (
      !table ||
      !noaaDurationEntries.length ||
      !noaaAriEntries.length ||
      !noaaIntensityZ.length
    ) {
      noaaIntensityPlotIsRendering = false
      detachNoaaIntensityPlotClickHandler()
      Plotly.purge(noaaIntensityPlotDiv)
      return
    }

    const finiteIntensities = noaaIntensityZ
      .flat()
      .filter((value): value is number => value != null && Number.isFinite(value))

    if (!finiteIntensities.length) {
      noaaIntensityPlotIsRendering = false
      detachNoaaIntensityPlotClickHandler()
      Plotly.purge(noaaIntensityPlotDiv)
      return
    }

    const durationEntries = noaaDurationEntries
    const ariEntries = noaaAriEntries

    const bounds = noaaIntensityPlotDiv.getBoundingClientRect()
    const width = bounds.width || noaaIntensityPlotDiv.clientWidth || 0
    const height = bounds.height || noaaIntensityPlotDiv.clientHeight || 0
    const isCompact = width <= 640

    const maxXTicks = Math.max(3, Math.floor((width || 1) / 70))
    const filteredDurationEntries = reduceTickEntries(durationEntries, maxXTicks)

    const positiveIntensities = finiteIntensities.filter((value) => value > 0)
    const durations = durationEntries.map((entry) => entry.hr)

    const traces: Data[] = ariEntries.map((ariEntry, rowIdx) => {
      const intensities = durationEntries.map((_, colIdx) => {
        const value = noaaIntensityZ[rowIdx]?.[colIdx]
        return Number.isFinite(value as number) ? Number(value) : null
      })

      const hoverText = durationEntries.map((durationEntry, colIdx) => {
        const intensityValue = intensities[colIdx]
        if (!Number.isFinite(intensityValue)) {
          return ''
        }

        const depth = noaaContourZ[rowIdx]?.[colIdx]
        const depthText =
          Number.isFinite(depth as number) && depth != null
            ? `<br>Depth: ${(depth as number).toFixed(2)} in`
            : ''

        return `ARI: ${ariEntry.key}-year` +
          `<br>Duration: ${durationEntry.label} (${durationEntry.hr.toFixed(2)} hr)` +
          `<br>Intensity: ${(intensityValue as number).toFixed(2)} in/hr` +
          depthText
      })

      const customData = durationEntries.map((durationEntry, colIdx) => {
        const depth = noaaContourZ[rowIdx]?.[colIdx]
        return [
          durationEntry.label,
          ariEntry.key,
          Number.isFinite(depth as number) ? Number(depth) : null
        ]
      })

      const color = chartTheme.idfPalette[rowIdx % chartTheme.idfPalette.length]

      return {
        type: 'scatter',
        mode: 'lines+markers',
        x: durations,
        y: intensities,
        text: hoverText,
        hovertemplate: '%{text}<extra></extra>',
        name: `${ariEntry.key}-year`,
        customdata: customData,
        line: { color, width: 2 },
        marker: { color, size: 6 },
        connectgaps: false
      }
    })

    let highlightTrace: Data | null = null
    if (table && selectedDurationLabel) {
      const durationIndex = durationEntries.findIndex(
        (entry) => entry.label === selectedDurationLabel
      )
      const ariIndex = ariEntries.findIndex((entry) => entry.key === String($selectedAri))
      const highlightIntensity =
        durationIndex >= 0 && ariIndex >= 0
          ? noaaIntensityZ[ariIndex]?.[durationIndex]
          : null

      if (
        durationIndex >= 0 &&
        ariIndex >= 0 &&
        Number.isFinite(highlightIntensity as number) &&
        durationEntries[durationIndex].hr > 0
      ) {
        const durationEntry = durationEntries[durationIndex]
        const ariEntry = ariEntries[ariIndex]
        const highlightDepth = noaaContourZ[ariIndex]?.[durationIndex]
        const highlightDepthValue = Number.isFinite(highlightDepth as number)
          ? Number(highlightDepth)
          : null
        const depthSegment =
          Number.isFinite(highlightDepth as number)
            ? `<br>Depth: ${(highlightDepth as number).toFixed(3)} in`
            : ''
        const highlightIntensityValue = Number(highlightIntensity)
        highlightTrace = {
          type: 'scatter',
          mode: 'markers',
          x: [durationEntry.hr],
          y: [highlightIntensityValue],
          marker: {
            color: chartTheme.isoHighlight,
            size: 12,
            line: { color: chartTheme.isoHighlightBorder, width: 3 },
            symbol: 'circle'
          },
          name: 'Selected NOAA cell',
          showlegend: false,
          customdata: [[durationEntry.label, ariEntry.key, highlightDepthValue]],
          hovertemplate:
            `Duration: ${durationEntry.label} (${durationEntry.hr.toFixed(2)} hr)` +
            `<br>ARI: ${ariEntry.key}-year` +
            `<br>Intensity: ${highlightIntensityValue.toFixed(2)} in/hr` +
            `${depthSegment}<extra></extra>`
        }
      }
    }

    const durationHrNumeric = Number($selectedDurationHr)
    let stormTrace: Data | null = null
    if (
      Number.isFinite(durationHrNumeric) &&
      durationHrNumeric > 0 &&
      Number.isFinite($selectedDepth)
    ) {
      const intensityValue = Number($selectedDepth) / durationHrNumeric
      if (Number.isFinite(intensityValue)) {
        stormTrace = {
          type: 'scatter',
          mode: 'markers',
          x: [durationHrNumeric],
          y: [intensityValue],
          marker: {
            color: '#ef4444',
            size: 16,
            line: { color: '#b91c1c', width: 3 },
            symbol: 'x'
          },
          name: 'Current storm parameters',
          showlegend: false,
          hovertemplate:
            `Current Storm` +
            `<br>Duration: ${durationHrNumeric.toFixed(2)} hr` +
            `<br>Intensity: ${intensityValue.toFixed(2)} in/hr` +
            `<br>Depth: ${Number($selectedDepth).toFixed(3)} in<extra></extra>`
        }
      }
    }

    const maxYTicks = Math.max(4, Math.floor((height || 1) / 42))
    const layout: Partial<Layout> = {
      ...plotLayoutBase,
      title: { text: 'Intensity-Duration-Frequency Curves', font: { color: chartTheme.text } },
      margin: isCompact
        ? { l: 64, r: 26, t: 48, b: 96 }
        : { l: 72, r: 60, t: 52, b: 88 },
      xaxis: {
        ...plotLayoutBase.xaxis,
        title: {
          ...(plotLayoutBase.xaxis?.title ?? {}),
          text: 'Duration (hr)',
          font: {
            ...(plotLayoutBase.xaxis?.title?.font ?? {}),
            size: isCompact ? 12 : undefined
          }
        },
        type: 'log',
        tickmode: 'array',
        tickvals: filteredDurationEntries.map((entry) => entry.hr),
        ticktext: filteredDurationEntries.map((entry) => entry.label),
        tickangle: isCompact ? -45 : 0,
        tickfont: { color: chartTheme.text, size: isCompact ? 10 : 12 },
        automargin: true
      },
      yaxis: {
        ...plotLayoutBase.yaxis,
        title: {
          ...(plotLayoutBase.yaxis?.title ?? {}),
          text: 'Intensity (in/hr)',
          font: {
            ...(plotLayoutBase.yaxis?.title?.font ?? {}),
            size: isCompact ? 12 : undefined
          }
        },
        type: positiveIntensities.length ? 'log' : 'linear',
        tickfont: { color: chartTheme.text, size: isCompact ? 10 : 12 },
        nticks: maxYTicks
      },
      legend: {
        bgcolor: chartTheme.legendBg,
        bordercolor: chartTheme.legendBorder,
        borderwidth: 1,
        orientation: isCompact ? 'h' : 'v',
        x: isCompact ? 0.5 : 1,
        y: isCompact ? -0.25 : 1,
        xanchor: isCompact ? 'center' : 'right',
        yanchor: 'top',
        font: { size: isCompact ? 10 : 11, color: chartTheme.text },
        itemsizing: 'constant'
      },
      hovermode: 'closest',
      hoverlabel: {
        bgcolor: chartTheme.hoverBg,
        bordercolor: chartTheme.hoverBorder,
        font: { color: chartTheme.hoverText }
      }
    }

    if (!positiveIntensities.length) {
      layout.yaxis = {
        ...layout.yaxis,
        type: 'linear',
        rangemode: 'tozero'
      }
    }

    const data: Data[] = [
      ...traces,
      ...(highlightTrace ? [highlightTrace] : []),
      ...(stormTrace ? [stormTrace] : [])
    ]

    noaaIntensityPlotIsRendering = true
    Promise.resolve(
      Plotly.react(noaaIntensityPlotDiv, data, layout, {
        ...plotConfig,
        displayModeBar: false
      })
    )
      .then(() => {
        attachNoaaIntensityPlotClickHandler()
        noaaIntensityPlotReady = true
      })
      .catch((error) => {
        console.error('Error rendering NOAA intensity plot', error)
      })
      .finally(() => {
        noaaIntensityPlotIsRendering = false
      })
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

  const handleNoaa3dPlotClick = (event: any) => {
    const table = $tableStore
    if (!table) return
    const point = event?.points?.[0]
    if (!point) return

    const customData = point.customdata
    if (Array.isArray(customData)) {
      const [durationLabel, , ariKey, depth] = customData
      if (
        typeof durationLabel === 'string' &&
        typeof ariKey === 'string' &&
        Number.isFinite(depth as number)
      ) {
        pickCell(durationLabel, ariKey)
        return
      }
    }

    const pointDuration = Number(point.x)
    const pointAri = Number(point.y)
    if (!Number.isFinite(pointDuration) || !Number.isFinite(pointAri)) {
      return
    }

    const ariEntries = noaaAriEntries
    const durationEntries = noaaDurationEntries
    if (!ariEntries.length || !durationEntries.length) {
      return
    }

    const nearestAri = ariEntries.reduce(
      (best, entry) => {
        const diff = Math.abs(entry.value - pointAri)
        return diff < best.diff ? { diff, entry } : best
      },
      { diff: Number.POSITIVE_INFINITY, entry: ariEntries[0] }
    )

    const nearestDuration = durationEntries.reduce(
      (best, entry) => {
        const diff = Math.abs(entry.hr - pointDuration)
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

  function attachNoaa3dPlotClickHandler() {
    if (!noaa3dPlotDiv) return
    const plotElement = noaa3dPlotDiv as any
    if (typeof plotElement?.on === 'function') {
      detachNoaa3dPlotClickHandler()
      plotElement.on('plotly_click', handleNoaa3dPlotClick)
    }
  }

  function detachNoaa3dPlotClickHandler() {
    if (!noaa3dPlotDiv) return
    const plotElement = noaa3dPlotDiv as any
    if (typeof plotElement?.removeListener === 'function') {
      plotElement.removeListener('plotly_click', handleNoaa3dPlotClick)
    }
    if (typeof plotElement?.off === 'function') {
      plotElement.off('plotly_click', handleNoaa3dPlotClick)
    }
  }

  const handleNoaaIntensityPlotClick = (event: any) => {
    const table = $tableStore
    if (!table) return
    const point = event?.points?.[0]
    if (!point) return

    const curveNumber = typeof point.curveNumber === 'number' ? point.curveNumber : null
    const pointIndex = typeof point.pointIndex === 'number' ? point.pointIndex : null

    if (
      curveNumber != null &&
      pointIndex != null &&
      curveNumber >= 0 &&
      pointIndex >= 0 &&
      curveNumber < noaaAriEntries.length &&
      pointIndex < noaaDurationEntries.length
    ) {
      const durationEntry = noaaDurationEntries[pointIndex]
      const ariEntry = noaaAriEntries[curveNumber]
      const depth = durationEntry.row.values[ariEntry.key]
      if (Number.isFinite(depth)) {
        pickCell(durationEntry.label, ariEntry.key)
      }
      return
    }

    const customData = point.customdata
    if (Array.isArray(customData)) {
      const [durationLabel, ariKey, depth] = customData
      if (
        typeof durationLabel === 'string' &&
        typeof ariKey === 'string' &&
        Number.isFinite(depth as number)
      ) {
        pickCell(durationLabel, ariKey)
        return
      }
    }

    const pointDuration = Number(point.x)
    const pointIntensity = Number(point.y)
    if (!Number.isFinite(pointDuration) || !Number.isFinite(pointIntensity)) {
      return
    }

    const durationEntries = noaaDurationEntries
    const ariEntries = noaaAriEntries
    if (!durationEntries.length || !ariEntries.length) {
      return
    }

    const nearestDuration = durationEntries.reduce(
      (best, entry) => {
        const diff = Math.abs(entry.hr - pointDuration)
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

    const hours = nearestDuration.entry.hr
    if (!Number.isFinite(hours) || hours <= 0) {
      return
    }

    let bestAri: { diff: number; entry: AriEntry } | null = null
    for (const entry of ariEntries) {
      const depth = nearestDuration.entry.row.values[entry.key]
      if (!Number.isFinite(depth)) {
        continue
      }
      const intensity = Number(depth) / hours
      if (!Number.isFinite(intensity)) {
        continue
      }
      const diff = Math.abs(intensity - pointIntensity)
      if (!bestAri || diff < bestAri.diff) {
        bestAri = { diff, entry }
      }
    }

    if (!bestAri) {
      return
    }

    const depth = nearestDuration.entry.row.values[bestAri.entry.key]
    if (!Number.isFinite(depth)) {
      return
    }

    pickCell(nearestDuration.entry.label, bestAri.entry.key)
  }

  function attachNoaaIntensityPlotClickHandler() {
    if (!noaaIntensityPlotDiv) return
    const plotElement = noaaIntensityPlotDiv as any
    if (typeof plotElement?.on === 'function') {
      detachNoaaIntensityPlotClickHandler()
      plotElement.on('plotly_click', handleNoaaIntensityPlotClick)
    }
  }

  function detachNoaaIntensityPlotClickHandler() {
    if (!noaaIntensityPlotDiv) return
    const plotElement = noaaIntensityPlotDiv as any
    if (typeof plotElement?.removeListener === 'function') {
      plotElement.removeListener('plotly_click', handleNoaaIntensityPlotClick)
    }
    if (typeof plotElement?.off === 'function') {
      plotElement.off('plotly_click', handleNoaaIntensityPlotClick)
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
      isExtrapolating = false
      return
    }
    const table = $tableStore
    if (!table) {
      interpolatedCells = []
      isExtrapolating = false
      return
    }

    const result = interpolateAriForDuration(table, durationHr, $selectedDepth, {
      preferredLabel: selectedDurationLabel ?? null
    })
    if (!result) {
      interpolatedCells = []
      isExtrapolating = false
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
    isExtrapolating = result.extrapolated
  }

  $: if ($durationMode === 'standard') {
    const numericDuration = Number($selectedDurationHr)
    const presetHours = Number.isFinite(numericDuration)
      ? nearestStandardDuration(numericDuration)
      : DEFAULT_DURATION_HOURS
    const normalizedPreset = String(presetHours) as StandardDurationValue
    if (selectedDurationPreset !== normalizedPreset) {
      selectedDurationPreset = normalizedPreset
    }

    const needsNormalization = !Number.isFinite(numericDuration) || numericDuration !== presetHours
    const hasNonStandardLabel = Boolean(
      selectedDurationLabel && !durationLabelIsStandard(selectedDurationLabel)
    )
    if (hasNonStandardLabel) {
      selectedDurationLabel = null
    }

    if (needsNormalization || lastChangedBy === 'user' || hasNonStandardLabel) {
      if ($selectedDurationHr !== presetHours) {
        $selectedDurationHr = presetHours
      }
      applyStandardPreset(presetHours)
      recalcFromDepthOrDuration()
      lastChangedBy = 'duration'
    }
  }

  function recalcFromAri() {
    const durationHr = ensureNumericDuration()
    if (!Number.isFinite($selectedAri) || !Number.isFinite(durationHr)) {
      isExtrapolating = false
      return
    }
    const table = $tableStore
    if (!table) {
      interpolatedCells = []
      isExtrapolating = false
      return
    }
    const { row, label } = getRowForCalculation(
      table,
      durationHr,
      selectedDurationLabel ?? null
    )
    if (!row || !label) {
      interpolatedCells = []
      isExtrapolating = false
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
      isExtrapolating = result.extrapolated
    } else {
      interpolatedCells = []
      isExtrapolating = false
    }
  }

  function handleDepthInput() {
    if ($durationMode === 'standard') {
      $durationMode = 'custom'
    }
    lastChangedBy = 'user'
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

  function applyStandardPreset(hours: number) {
    if (!Number.isFinite(hours)) {
      return;
    }

    const table = $tableStore;
    if (!table) {
      return;
    }

    const matchingRow = table.rows.find(
      (row) => Math.abs(toHours(row.label) - hours) < 1e-6
    );
    if (!matchingRow) {
      return;
    }

    const currentDepth = Number($selectedDepth);
    const currentAri = Number($selectedAri);
    const hasDepth = Number.isFinite(currentDepth);
    const hasAri = Number.isFinite(currentAri);

    let bestAriKey: string | null = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const ariKey of table.aris) {
      const depthValue = matchingRow.values[ariKey];
      if (!Number.isFinite(depthValue)) {
        continue;
      }
      const numericDepth = Number(depthValue);

      let score = 0;
      if (hasDepth) {
        score = Math.abs(numericDepth - currentDepth);
      } else if (hasAri) {
        const ariValue = Number(ariKey);
        if (!Number.isFinite(ariValue)) {
          continue;
        }
        score = Math.abs(ariValue - currentAri);
      }

      if (score < bestScore) {
        bestScore = score;
        bestAriKey = ariKey;
      }
    }

    if (bestAriKey) {
      pickCell(matchingRow.label, bestAriKey);
    } else {
      selectedDurationLabel = matchingRow.label;
    }
  }

  function handleStandardDurationChange(event: Event) {
    const target = event.currentTarget as HTMLSelectElement | null
    if (!target) {
      handleDurationInput()
      return
    }

    const nextHours = Number(target.value)
    if (!Number.isFinite(nextHours)) {
      return
    }

    if ($selectedDurationHr !== nextHours) {
      $selectedDurationHr = nextHours
    }
    lastChangedBy = 'user'
  }

  function handleAriInput() {
    if ($durationMode === 'standard') {
      $durationMode = 'custom'
    }
    lastChangedBy = 'user'
    recalcFromAri()
  }

  function handleTimestepInput() {
    if (!Number.isFinite($timestepMin) || $timestepMin <= 0) {
      return
    }
  }

  function doCsv() {
    if (!lastStorm) return
    const startDate = $startISO ? new Date($startISO) : null
    const start = startDate && !Number.isNaN(startDate.getTime()) ? $startISO : undefined
    saveCsv(lastStorm, 'design_storm.csv', start)
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
    void refreshComparisonCurves()
  }

  function closeCurveModal() {
    showCurveModal = false
    detachCurvePlotClickHandler()
    if (curvePlotDiv) {
      Plotly.purge(curvePlotDiv)
    }
    curvePlotReady = false
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
    void refreshComparisonCurves()
  }

  async function refreshComparisonCurves() {
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

    comparisonCurvesAreComputing = true
    await tick()

    try {
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
    } finally {
      comparisonCurvesAreComputing = false
    }
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
    curvePlotReady = false
    if (!curvePlotDiv) {
      curvePlotIsRendering = false
      return
    }
    if (!comparisonCurves.length) {
      curvePlotIsRendering = false
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

    const maxDuration =
      selectedCurveDuration ??
      Math.max(...comparisonCurves.map((curve) => curve.timeHr[curve.timeHr.length - 1] ?? 0))

    curvePlotIsRendering = true
    Promise.resolve(
      Plotly.react(
        curvePlotDiv,
        traces,
        {
          ...plotLayoutBase,
          title: {
            text: `${comparisonGroupLabel || 'Distribution'} Comparison — ${maxDuration}-hr`,
            font: { color: chartTheme.text }
          },
          xaxis: {
            ...plotLayoutBase.xaxis,
            title: {
              ...(plotLayoutBase.xaxis?.title ?? {}),
              text: 'Time (hr)'
            },
            range: [0, Math.max(6, maxDuration)]
          },
          yaxis: {
            ...plotLayoutBase.yaxis,
            title: {
              ...(plotLayoutBase.yaxis?.title ?? {}),
              text: 'Rain Fraction'
            },
            range: [0, 1]
          }
        },
        plotConfig
      )
    )
      .then(() => {
        attachCurvePlotClickHandler()
        curvePlotReady = true
      })
      .catch((error) => {
        console.error('Error rendering distribution comparison plot', error)
      })
      .finally(() => {
        curvePlotIsRendering = false
      })
  }

  $: if (curvePlotDiv && comparisonCurves.length) {
    // Re-render comparison curves when the active theme changes
    void chartTheme
    drawComparisonCurves()
  }
  
  function flashRecalculated(param: 'ari' | 'depth' | 'duration'){
      recentlyRecalculated = param;
      if(recalculationTimer) clearTimeout(recalculationTimer);
      recalculationTimer = setTimeout(() => {
          recentlyRecalculated = null;
      }, 500)
  }

  onMount(() => {
    initializeTheme()

    map = L.map(mapDiv, { attributionControl: false, zoomControl: true })
    setMapViewToContinentalUs()
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

    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          $lat = position.coords.latitude
          $lon = position.coords.longitude
          map.setView([$lat, $lon], USER_LOCATION_ZOOM)
        },
        (error) => {
          console.warn('Unable to access geolocation; using continental US view.', error)
          setMapViewToContinentalUs()
        }
      )
    } else {
      console.warn('Geolocation is not supported; using continental US view.')
      setMapViewToContinentalUs()
    }

    void loadNoaa()

    window.addEventListener('resize', handleViewportChange)
    window.addEventListener('scroll', handleViewportChange, { passive: true })
    tableScrollObserver = new ResizeObserver(handleViewportChange)
    attachTableScrollObserver()
    updateTableScrollHeight()
  })

  onDestroy(() => {
    teardownTheme()
    if (fetchTimer) clearTimeout(fetchTimer)
    if (map) map.remove()
    if (plotDiv1) Plotly.purge(plotDiv1)
    if (plotDiv2) Plotly.purge(plotDiv2)
    if (plotDiv3) Plotly.purge(plotDiv3)
    plot1Ready = false
    plot2Ready = false
    plot3Ready = false
    if (noaa3dPlotDiv) {
      detachNoaa3dPlotClickHandler()
      Plotly.purge(noaa3dPlotDiv)
    }
    noaa3dPlotReady = false
    noaa3dPlotIsRendering = false
    if (noaaIntensityPlotDiv) {
      detachNoaaIntensityPlotClickHandler()
      Plotly.purge(noaaIntensityPlotDiv)
    }
    noaaIntensityPlotReady = false
    noaaIntensityPlotIsRendering = false
    if (isoPlotDiv) {
      detachIsoPlotClickHandler()
      Plotly.purge(isoPlotDiv)
    }
    isoPlotReady = false
    if (curvePlotDiv) {
      detachCurvePlotClickHandler()
      Plotly.purge(curvePlotDiv)
    }
    curvePlotReady = false
    window.removeEventListener('resize', handleViewportChange)
    window.removeEventListener('scroll', handleViewportChange)
    tableScrollObserver?.disconnect()
    if (observedNoaaScrollEl) {
      observedNoaaScrollEl.removeEventListener('scroll', handleNoaaScroll)
      observedNoaaScrollEl = null
    }
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
    void refreshComparisonCurves()
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
    attachNoaaScrollListener()
    updateNoaaStickyOffset()
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
    <div class="header-actions">
      <button
        type="button"
        class="theme-toggle"
        on:click={toggleTheme}
        aria-pressed={theme === 'light' ? 'true' : 'false'}
        aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
        title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
      >
        <span class="theme-toggle__icon" aria-hidden="true">
          {theme === 'light' ? '☀️' : '🌙'}
        </span>
        <span class="theme-toggle__label">{theme === 'light' ? 'Light' : 'Dark'}</span>
      </button>
      <div class="badge">Beta</div>
    </div>
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
          <button
            class="primary noaa-refresh-button"
            on:click={() => void loadNoaa()}
            disabled={isLoadingNoaa}
          >
            {#if isLoadingNoaa}
              <span class="noaa-refresh-button__spinner" aria-hidden="true"></span>
              <span class="noaa-refresh-button__text">Refreshing…</span>
            {:else}
              <span class="noaa-refresh-button__text">Refresh NOAA Data</span>
            {/if}
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
        <h2 class="section-title">NOAA Visualizations</h2>
        <div class="noaa-visuals">
          <div
            class="noaa-visuals__tablist"
            role="tablist"
            aria-label="NOAA visualizations"
            aria-orientation="horizontal"
            bind:this={noaaTablistEl}
          >
            {#each noaaVisualTabs as tab, index (tab.id)}
              {@const tabId = `noaa-visual-tab-${tab.id}`}
              {@const panelId = `noaa-visual-panel-${tab.id}`}
              <button
                id={tabId}
                class="noaa-visuals__tab"
                class:active={activeNoaaVisual === tab.id}
                type="button"
                role="tab"
                aria-selected={activeNoaaVisual === tab.id}
                aria-controls={panelId}
                tabindex={activeNoaaVisual === tab.id ? 0 : -1}
                on:click={() => (activeNoaaVisual = tab.id)}
                on:keydown={(event) => handleNoaaTabKeydown(event, index)}
              >
                {tab.label}
              </button>
            {/each}
          </div>
          <div class="noaa-visuals__panels">
            <div
              id="noaa-visual-panel-isoLines"
              role="tabpanel"
              aria-labelledby="noaa-visual-tab-isoLines"
              tabindex={activeNoaaVisual === 'isoLines' ? 0 : -1}
              hidden={activeNoaaVisual !== 'isoLines'}
            >
              {#if activeNoaaVisual === 'isoLines'}
                <div class="iso-plot-container">
                  <button
                    type="button"
                    class="plot-download"
                    on:click={downloadActiveNoaaVisual}
                    aria-label="Download NOAA depth iso-lines plot as PNG"
                    disabled={!isoPlotReady}
                  >
                    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
                      <path
                        d="M10 2a.75.75 0 0 1 .75.75v7.19l2.22-2.22a.75.75 0 1 1 1.06 1.06l-3.5 3.5a.75.75 0 0 1-1.06 0l-3.5-3.5a.75.75 0 1 1 1.06-1.06l2.22 2.22V2.75A.75.75 0 0 1 10 2Zm-5.5 11.5a.75.75 0 0 1 .75-.75h9.5a.75.75 0 0 1 0 1.5h-9.5a.75.75 0 0 1-.75-.75ZM4 16.25a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H4.75a.75.75 0 0 1-.75-.75Z"
                      />
                    </svg>
                  </button>
                  <div
                    class="iso-plot"
                    bind:this={isoPlotDiv}
                    aria-label="Contour plot of NOAA depths by duration and recurrence interval"
                  ></div>
                  {#if !$tableStore}
                    <div class="iso-plot-empty">Load NOAA data to view the depth iso-line preview.</div>
                  {/if}
                </div>
              {/if}
            </div>
            <div
              id="noaa-visual-panel-rdi3d"
              role="tabpanel"
              aria-labelledby="noaa-visual-tab-rdi3d"
              tabindex={activeNoaaVisual === 'rdi3d' ? 0 : -1}
              hidden={activeNoaaVisual !== 'rdi3d'}
            >
              {#if activeNoaaVisual === 'rdi3d'}
                <div class="iso-plot-container">
                  <button
                    type="button"
                    class="plot-download"
                    on:click={downloadActiveNoaaVisual}
                    aria-label="Download NOAA 3D rainfall depth-intensity surface as PNG"
                    disabled={!noaa3dPlotReady}
                  >
                    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
                      <path
                        d="M10 2a.75.75 0 0 1 .75.75v7.19l2.22-2.22a.75.75 0 1 1 1.06 1.06l-3.5 3.5a.75.75 0 0 1-1.06 0l-3.5-3.5a.75.75 0 1 1 1.06-1.06l2.22 2.22V2.75A.75.75 0 0 1 10 2Zm-5.5 11.5a.75.75 0 0 1 .75-.75h9.5a.75.75 0 0 1 0 1.5h-9.5a.75.75 0 0 1-.75-.75ZM4 16.25a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H4.75a.75.75 0 0 1-.75-.75Z"
                      />
                    </svg>
                  </button>
                  <div
                    class="iso-plot"
                    bind:this={noaa3dPlotDiv}
                    aria-label="3D surface of rainfall depth and intensity by duration and recurrence interval"
                  ></div>
                  {#if !$tableStore}
                    <div class="iso-plot-empty">
                      Load NOAA data to view the rainfall depth-intensity surface.
                    </div>
                  {/if}
                </div>
              {/if}
            </div>
            <div
              id="noaa-visual-panel-intensity"
              role="tabpanel"
              aria-labelledby="noaa-visual-tab-intensity"
              tabindex={activeNoaaVisual === 'intensity' ? 0 : -1}
              hidden={activeNoaaVisual !== 'intensity'}
            >
              {#if activeNoaaVisual === 'intensity'}
                <div class="iso-plot-container">
                  <button
                    type="button"
                    class="plot-download"
                    on:click={downloadActiveNoaaVisual}
                    aria-label="Download NOAA intensity-duration-frequency chart as PNG"
                    disabled={!noaaIntensityPlotReady}
                  >
                    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
                      <path
                        d="M10 2a.75.75 0 0 1 .75.75v7.19l2.22-2.22a.75.75 0 1 1 1.06 1.06l-3.5 3.5a.75.75 0 0 1-1.06 0l-3.5-3.5a.75.75 0 1 1 1.06-1.06l2.22 2.22V2.75A.75.75 0 0 1 10 2Zm-5.5 11.5a.75.75 0 0 1 .75-.75h9.5a.75.75 0 0 1 0 1.5h-9.5a.75.75 0 0 1-.75-.75ZM4 16.25a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H4.75a.75.75 0 0 1-.75-.75Z"
                      />
                    </svg>
                  </button>
                  <div
                    class="iso-plot"
                    bind:this={noaaIntensityPlotDiv}
                    aria-label="NOAA intensity-duration-frequency visualization"
                  ></div>
                  {#if !$tableStore || !noaaIntensityZ.length}
                    <div class="iso-plot-empty">
                      Load NOAA data to view the intensity-duration-frequency curves.
                    </div>
                  {/if}
                </div>
              {/if}
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="column column--controls">
      <div class="panel">
        <div class="storm-panel-heading">
          <h2 class="section-title">Storm Parameters</h2>
          <div class="storm-processing-slot" aria-live="polite">
            {#if isStormProcessing}
              <div class="storm-processing-indicator" role="status">
                <span class="storm-processing-indicator__spinner" aria-hidden="true"></span>
                <span class="storm-processing-indicator__text">Processing storm…</span>
              </div>
              <div class="storm-processing-rain" aria-hidden="true" transition:fade>
                {#each stormRainDrops as drop}
                  <span
                    class="storm-processing-rain__drop"
                    style={`animation-delay: ${drop * 120}ms`}
                  ></span>
                {/each}
              </div>
            {/if}
          </div>
        </div>

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
                  Fast mode downsamples the storm to {MAX_FAST_SAMPLES.toLocaleString()} evenly spaced timesteps for quicker updates. Switch back to Precise for the full-resolution dataset.
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
                  bind:value={$selectedDurationHr}
                  on:change={handleStandardDurationChange}
                >
                  {#each STANDARD_DURATION_PRESETS as option}
                    <option value={option.hours}>{option.label}</option>
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
              disabled={$timestepIsLocked}
              bind:value={$timestepMin}
              on:change={handleTimestepInput}
            />
          </div>
          {#if isExtrapolating}
            <p class="field-hint field-hint--warning storm-form__extrapolation-note" role="status">
              <strong>Extrapolation in effect.</strong> Values extend beyond the NOAA table and are estimated using the nearest trend.
            </p>
          {/if}
          <div class="storm-card input-card start-card">
            <label for="start">Start (ISO)</label>
            <div class="start-input">
              <input id="start" type="datetime-local" bind:value={$startISO} />
            </div>
            </div>
          </div>
        </div>


        <div class="actions">
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
      <div class="panel storm-summary-panel">
        <h2 class="section-title">How this storm was built</h2>
        {#if stormSummaryLines.length}
          <ul class="storm-summary-list">
            {#each stormSummaryLines as line}
              <li>{line}</li>
            {/each}
          </ul>
        {:else}
          <p class="empty">Adjust the parameters to see how the storm will be constructed.</p>
        {/if}
      </div>
    </section>

    <section class="column column--visuals">
      <div class="panel plot">
        <button
          type="button"
          class="plot-download"
          on:click={() => downloadPlot(plotDiv1, 'designstorm-hyetograph-intensity')}
          aria-label="Download hyetograph intensity plot as PNG"
          disabled={!plot1Ready}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
            <path
              d="M10 2a.75.75 0 0 1 .75.75v7.19l2.22-2.22a.75.75 0 1 1 1.06 1.06l-3.5 3.5a.75.75 0 0 1-1.06 0l-3.5-3.5a.75.75 0 1 1 1.06-1.06l2.22 2.22V2.75A.75.75 0 0 1 10 2Zm-5.5 11.5a.75.75 0 0 1 .75-.75h9.5a.75.75 0 0 1 0 1.5h-9.5a.75.75 0 0 1-.75-.75ZM4 16.25a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H4.75a.75.75 0 0 1-.75-.75Z"
            />
          </svg>
        </button>
        <div bind:this={plotDiv1} class="plot-area"></div>
      </div>
      <div class="panel plot">
        <button
          type="button"
          class="plot-download"
          on:click={() => downloadPlot(plotDiv2, 'designstorm-incremental-volume')}
          aria-label="Download incremental volume plot as PNG"
          disabled={!plot2Ready}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
            <path
              d="M10 2a.75.75 0 0 1 .75.75v7.19l2.22-2.22a.75.75 0 1 1 1.06 1.06l-3.5 3.5a.75.75 0 0 1-1.06 0l-3.5-3.5a.75.75 0 1 1 1.06-1.06l2.22 2.22V2.75A.75.75 0 0 1 10 2Zm-5.5 11.5a.75.75 0 0 1 .75-.75h9.5a.75.75 0 0 1 0 1.5h-9.5a.75.75 0 0 1-.75-.75ZM4 16.25a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H4.75a.75.75 0 0 1-.75-.75Z"
            />
          </svg>
        </button>
        <div bind:this={plotDiv2} class="plot-area"></div>
      </div>
      <div class="panel plot">
        <button
          type="button"
          class="plot-download"
          on:click={() => downloadPlot(plotDiv3, 'designstorm-cumulative-mass-curve')}
          aria-label="Download cumulative mass curve plot as PNG"
          disabled={!plot3Ready}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
            <path
              d="M10 2a.75.75 0 0 1 .75.75v7.19l2.22-2.22a.75.75 0 1 1 1.06 1.06l-3.5 3.5a.75.75 0 0 1-1.06 0l-3.5-3.5a.75.75 0 1 1 1.06-1.06l2.22 2.22V2.75A.75.75 0 0 1 10 2Zm-5.5 11.5a.75.75 0 0 1 .75-.75h9.5a.75.75 0 0 1 0 1.5h-9.5a.75.75 0 0 1-.75-.75ZM4 16.25a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H4.75a.75.75 0 0 1-.75-.75Z"
            />
          </svg>
        </button>
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
                    <td class="left" data-label={timeColumnLabel}>{row.time.toFixed(2)}</td>
                    <td data-label="Intensity (in/hr)">{row.intensity.toFixed(5)}</td>
                    <td data-label="Incremental (in)">{row.incremental.toFixed(5)}</td>
                    <td data-label="Cumulative (in)">{row.cumulative.toFixed(5)}</td>
                    {#if hasTimestamp}
                      <td class="left" data-label="Datetime">{row.timestamp}</td>
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
          <em>Precise</em> traces every timestep for maximum fidelity. <em>Fast (approx.)</em> downsamples the storm to
          {MAX_FAST_SAMPLES.toLocaleString()} evenly spaced timesteps so long events stay responsive; switch back to
          Precise if results need to be exact.
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
        <div class="curve-plot-wrapper">
          <button
            type="button"
            class="plot-download"
            on:click={() => downloadPlot(curvePlotDiv, 'designstorm-distribution-comparison')}
            aria-label="Download distribution comparison plot as PNG"
            disabled={!curvePlotReady}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
              <path
                d="M10 2a.75.75 0 0 1 .75.75v7.19l2.22-2.22a.75.75 0 1 1 1.06 1.06l-3.5 3.5a.75.75 0 0 1-1.06 0l-3.5-3.5a.75.75 0 1 1 1.06-1.06l2.22 2.22V2.75A.75.75 0 0 1 10 2Zm-5.5 11.5a.75.75 0 0 1 .75-.75h9.5a.75.75 0 0 1 0 1.5h-9.5a.75.75 0 0 1-.75-.75ZM4 16.25a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H4.75a.75.75 0 0 1-.75-.75Z"
              />
            </svg>
          </button>
          <div
            class="curve-plot"
            bind:this={curvePlotDiv}
            aria-label="Cumulative rain fraction by distribution"
          ></div>
        </div>
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
    filter: var(--map-filter);
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
    justify-content: space-between;
    gap: clamp(0.75rem, 1.2vw + 0.5rem, 1.25rem);
    text-align: left;
  }

  .title-group {
    display: flex;
    align-items: center;
    gap: clamp(0.6rem, 0.9vw + 0.4rem, 1rem);
    flex: 1 1 280px;
    min-width: 0;
    flex-wrap: wrap;
  }

  .app-icon {
    width: clamp(40px, 4vw + 24px, 56px);
    height: clamp(40px, 4vw + 24px, 56px);
    border-radius: 12px;
    box-shadow: var(--icon-shadow);
    flex: 0 0 auto;
  }

  .title-text {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .header h1 {
    margin: 0 0 6px;
    font-size: 22px;
    font-weight: 600;
  }

  .badge {
    background: var(--badge-bg);
    color: var(--badge-text);
    border: 1px solid var(--badge-border);
    border-radius: 20px;
    padding: 6px 14px;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .header-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
    flex: 0 0 auto;
  }

  .header .badge {
    margin: 0;
  }

  .theme-toggle {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 14px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--button-bg);
    color: var(--text);
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease, box-shadow 0.15s ease;
  }

  .theme-toggle:hover:not(:disabled),
  .theme-toggle:focus-visible {
    background: var(--button-hover-bg);
    border-color: var(--border);
    outline: none;
  }

  .theme-toggle:focus-visible {
    box-shadow: 0 0 0 2px var(--plot-download-focus-ring);
  }

  .theme-toggle__icon {
    font-size: 16px;
    line-height: 1;
  }

  .theme-toggle__label {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  @media (max-width: 720px) {
    .header {
      justify-content: center;
      text-align: center;
    }

    .title-group {
      justify-content: center;
    }

    .header-actions {
      width: 100%;
      justify-content: center;
    }
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

    .header-actions {
      justify-content: flex-end;
      gap: 12px;
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
    min-width: 0;
    width: 100%;
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

  .storm-panel-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
    margin-bottom: 16px;
    min-height: 34px;
  }

  .storm-panel-heading .section-title {
    margin: 0;
  }

  .storm-processing-slot {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    flex: 0 0 auto;
    min-height: 26px;
    min-width: 0;
    position: relative;
    overflow: hidden;
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
    background: var(--glass-card-bg);
    border: 1px solid var(--glass-card-border);
    border-radius: 18px;
    padding: 18px 20px;
    box-shadow: var(--glass-card-shadow);
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
    align-items: center;
    gap: 6px;
    padding: 4px;
    border-radius: 999px;
    border: 1px solid var(--toggle-border);
    background: var(--toggle-bg);
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
    background: var(--toggle-hover-bg);
    color: var(--text);
  }

  .mode-toggle button.active {
    background: var(--accent);
    color: var(--accent-foreground);
    font-weight: 600;
    box-shadow: var(--accent-shadow);
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

  .input-card__tooltip {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-left: 6px;
    font-size: 12px;
    cursor: help;
    color: var(--muted);
  }

  .input-card__tooltip:hover,
  .input-card__tooltip:focus {
    color: var(--accent);
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

  .storm-form__extrapolation-note {
    grid-column: 1 / -1;
    margin: 0;
  }

  .storm-form__extrapolation-note strong {
    display: block;
    font-weight: 600;
    color: inherit;
    margin-bottom: 4px;
  }

  .custom-curve-preview {
    width: 100%;
    background: var(--info-bg);
    border: 1px solid var(--info-border);
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
    .storm-panel-heading {
      flex-direction: column;
      align-items: flex-start;
      gap: 12px;
    }

    .storm-processing-slot {
      width: 100%;
      justify-content: flex-start;
    }

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

    .actions button {
      flex: 1 1 100%;
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

  .noaa-refresh-button {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    justify-content: center;
  }

  .noaa-refresh-button__spinner {
    width: 16px;
    height: 16px;
    border-radius: 999px;
    border: 2px solid rgba(110, 231, 255, 0.18);
    border-top-color: var(--accent);
    animation: storm-loading-spin 0.8s linear infinite;
  }

  .noaa-refresh-button__text {
    display: inline-flex;
    align-items: center;
    gap: 4px;
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
    position: relative;
    --noaa-scroll-left: 0px;
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
    position: relative;
    z-index: 3;
    background: var(--table-header-ari-bg);
    backdrop-filter: blur(4px);
    border-right: 1px solid var(--table-header-ari-border);
    transform: translateX(var(--noaa-scroll-left));
    will-change: transform;
  }

  .ari-label {
    display: block;
    white-space: normal;
    line-height: 1.3;
  }

  .table-header__duration {
    border-left: 1px solid var(--table-header-divider);
    display: flex;
    align-items: stretch;
  }

  .table-header__duration.column-active {
    background: var(--table-row-active);
  }

  .table-body {
    max-height: 320px;
    overflow-y: auto;
  }

  .table-row {
    border-bottom: 1px solid var(--table-divider);
  }

  .table-row:last-child {
    border-bottom: none;
  }

  .table-row:hover {
    background: var(--table-row-hover);
  }

  .table-row.ari-active {
    background: var(--table-row-active);
  }

  .ari-cell {
    padding: 12px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 2px;
    background: var(--table-ari-cell-bg);
    font-size: 12px;
    position: relative;
    z-index: 2;
    border-right: 1px solid var(--table-sticky-border);
    transform: translateX(var(--noaa-scroll-left));
    will-change: transform;
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
    background: var(--table-cell-hover);
    color: var(--accent-foreground);
  }

  .table-button.cell {
    border-left: 1px solid var(--table-header-divider);
  }

  .table-button.cell.column-active {
    background: var(--table-row-active);
  }

  .table-button.cell:hover:not(:disabled) {
    background: var(--table-cell-hover);
    color: var(--accent-foreground);
  }

  .table-button.cell.column-active:hover:not(:disabled) {
    background: var(--table-cell-column-hover);
  }

  .table-button.cell.selected {
    background: var(--accent);
    color: var(--accent-foreground);
    font-weight: 600;
  }

  .table-button.cell.selected:hover {
    background: var(--accent);
  }

  .table-button.cell.interpolated {
    background: var(--table-interpolated-bg);
    color: var(--accent-foreground);
    font-weight: 600;
  }

  .table-button.cell.interpolated:hover {
    background: var(--table-interpolated-hover);
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

  .actions button {
    flex: 1 1 200px;
    min-width: 0;
  }

  .start-card .start-input {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .start-card .start-input input {
    flex: 1 1 auto;
  }

  .storm-processing-indicator {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 5px 12px;
    border-radius: 999px;
    border: 1px solid var(--processing-border);
    background: var(--processing-bg);
    color: var(--accent);
    font-size: 12px;
    letter-spacing: 0.02em;
    box-shadow: var(--processing-shadow);
    font-weight: 600;
    white-space: nowrap;
    position: relative;
    z-index: 1;
  }

  .storm-processing-indicator__spinner {
    width: 16px;
    height: 16px;
    border-radius: 999px;
    border: 2px solid var(--processing-border);
    border-top-color: var(--accent);
    animation: storm-loading-spin 0.8s linear infinite;
  }

  .storm-processing-rain {
    position: absolute;
    inset: 0;
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    pointer-events: none;
    gap: 6px;
    padding-inline: 4px;
    z-index: 0;
  }

  .storm-processing-rain__drop {
    display: block;
    width: 2px;
    height: 180%;
    border-radius: 999px;
    background: linear-gradient(180deg, transparent 0%, var(--accent) 85%, var(--accent) 100%);
    opacity: 0;
    transform: translate3d(0, -140%, 0);
  }

  @media (prefers-reduced-motion: no-preference) {
    .storm-processing-rain__drop {
      animation: storm-rainfall 1.4s linear infinite;
    }

    @keyframes storm-rainfall {
      0% {
        transform: translate3d(0, -140%, 0);
        opacity: 0;
      }

      25% {
        opacity: 0.8;
      }

      70% {
        opacity: 0.85;
      }

      100% {
        transform: translate3d(12%, 140%, 0);
        opacity: 0;
      }
    }
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
    background: var(--surface-gradient);
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
    background: var(--surface-overlay-gradient);
    backdrop-filter: blur(2px);
    pointer-events: none;
  }

  .plot {
    flex: 0 0 auto;
  }

  .panel.plot {
    position: relative;
  }

  .plot-area {
    height: clamp(220px, 40vh, 320px);
  }

  .plot-download {
    position: absolute;
    bottom: 10px;
    right: 10px;
    width: 30px;
    height: 30px;
    border-radius: 999px;
    border: 1px solid var(--plot-download-border);
    background: var(--plot-download-bg);
    color: var(--plot-download-color);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    opacity: 0.75;
    transition: opacity 0.15s ease, background 0.15s ease, border-color 0.15s ease;
    cursor: pointer;
    z-index: 5;
  }

  .plot-download svg {
    width: 16px;
    height: 16px;
    fill: currentColor;
  }

  .plot-download:hover:not(:disabled),
  .plot-download:focus-visible {
    opacity: 1;
    background: var(--plot-download-hover-bg);
    border-color: var(--plot-download-hover-border);
    outline: none;
  }

  .plot-download:focus-visible {
    box-shadow: 0 0 0 2px var(--plot-download-focus-ring);
  }

  .plot-download:disabled {
    opacity: 0.35;
    cursor: not-allowed;
    pointer-events: none;
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
    border-bottom: 1px solid var(--table-divider);
    text-align: right;
    white-space: nowrap;
  }

  .data-table th {
    background: var(--panel);
    position: sticky;
    top: 0;
    z-index: 1;
    box-shadow: inset 0 -1px 0 var(--table-header-shadow);
  }

  .data-table tr:nth-child(even) {
    background: var(--table-row-stripe);
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
    background: var(--stat-bg);
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

  @media (max-width: 720px) {
    .results .table-scroll {
      border: none;
      border-radius: 0;
      padding: 0;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }

    .data-table th,
    .data-table td {
      font-size: 11px;
      padding: 6px 8px;
    }
  }

  button.ghost {
    background: transparent;
    border: 1px solid var(--border);
    color: inherit;
  }

  button.ghost:hover {
    background: var(--ghost-hover-bg);
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
    background: var(--modal-backdrop-bg);
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
    width: min(720px, calc(100vw - 48px));
    max-height: calc(100vh - 80px);
    overflow: auto;
    padding: 24px 24px 16px;
    box-shadow: var(--modal-shadow);
    outline: none;
    box-sizing: border-box;
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

  .curve-plot-wrapper {
    position: relative;
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
      flex-wrap: nowrap;
      align-items: stretch;
      gap: 8px;
    }

    .search-controls input[type='text'] {
      flex: 1 1 auto;
      min-width: 0;
    }

    .search-controls button[type='submit'] {
      flex: 0 0 auto;
      align-self: stretch;
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
