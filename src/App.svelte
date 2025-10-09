<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import * as L from 'leaflet'
  import Plotly from 'plotly.js-dist-min'
  import { fetchNoaaTable, parseNoaaTable, type NoaaTable } from './lib/noaaClient'
  import { generateStorm, type StormParams, type DistributionName } from './lib/stormEngine'
  import { saveCsv, savePcswmmDat } from './lib/export'

  let mapDiv: HTMLDivElement
  let plotDiv1: HTMLDivElement
  let plotDiv2: HTMLDivElement

  let map: L.Map
  let marker: L.Marker

  let lat = 40.4406
  let lon = -79.9959

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

  let timestepMin = 5
  let distribution: DistributionName = 'scs_type_ii'
  let startISO = '2003-01-01T00:00'
  let customCurveCsv = ''

  let isLoadingNoaa = false
  let noaaError = ''

  let lastStorm: ReturnType<typeof generateStorm> | null = null

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

  function scheduleNoaaFetch(delay = 700) {
    if (!autoFetch) return
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return
    if (fetchTimer) clearTimeout(fetchTimer)
    fetchTimer = setTimeout(() => {
      void loadNoaa()
    }, delay)
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
        selectedAri = parseInt(aris[0], 10)
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
    selectedAri = parseInt(ari, 10)
    const row = table.rows.find((r) => r.label === durLabel)
    const depth = row?.values[ari]
    if (Number.isFinite(depth)) {
      selectedDepth = Number(depth)
    }
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
    const ariKey = String(selectedAri)
    const depth = row?.values[ariKey]
    if (Number.isFinite(depth)) {
      selectedDepth = Number(depth)
      selectedDurationHr = toHours(selectedDurationLabel)
    }
    selectedAri = parseInt(ariKey, 10)
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

    Plotly.react(
      plotDiv1,
      [
        {
          x: lastStorm.timeMin,
          y: lastStorm.intensityInHr,
          type: 'scatter',
          mode: 'lines',
          name: 'Intensity (in/hr)',
          line: { color: '#6ee7ff', width: 3 },
          fill: 'tozeroy',
          fillcolor: 'rgba(110, 231, 255, 0.2)'
        }
      ],
      {
        ...plotLayoutBase,
        title: 'Hyetograph',
        xaxis: { ...plotLayoutBase.xaxis, title: 'Time (minutes)' },
        yaxis: { ...plotLayoutBase.yaxis, title: 'Intensity (in/hr)' }
      },
      plotConfig
    )

    Plotly.react(
      plotDiv2,
      [
        {
          x: lastStorm.timeMin,
          y: lastStorm.cumulativeIn,
          type: 'scatter',
          mode: 'lines',
          name: 'Cumulative (in)',
          line: { color: '#a855f7', width: 3 }
        }
      ],
      {
        ...plotLayoutBase,
        title: 'Cumulative Depth',
        xaxis: { ...plotLayoutBase.xaxis, title: 'Time (minutes)' },
        yaxis: { ...plotLayoutBase.yaxis, title: 'Depth (in)' }
      },
      plotConfig
    )
  }

  function doCsv() {
    if (!lastStorm) return
    saveCsv(lastStorm, 'design_storm.csv')
  }
  function doDat() {
    if (!lastStorm) return
    savePcswmmDat(lastStorm, timestepMin, 'design_storm.dat')
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
  })

  onDestroy(() => {
    if (fetchTimer) clearTimeout(fetchTimer)
    if (map) map.remove()
    if (plotDiv1) Plotly.purge(plotDiv1)
    if (plotDiv2) Plotly.purge(plotDiv2)
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
</script>

<div class="page">
  <header class="panel header">
    <div>
      <h1>Design Storm Generator</h1>
      <p class="small">Ported from the original Python tool. Adjust the map or inputs to refresh NOAA Atlas 14 rainfall depths and generate storm hyetographs.</p>
    </div>
    <div class="badge">Beta</div>
  </header>

  <div class="layout">
    <section class="column">
      <div class="panel">
        <h2 class="section-title">Location &amp; NOAA Depths</h2>
        <div class="map" bind:this={mapDiv}></div>

        <div class="grid cols-2">
          <div>
            <label for="lat">Latitude</label>
            <input id="lat" type="number" step="0.0001" bind:value={lat} on:change={() => (lastFetchKey = '')} />
          </div>
          <div>
            <label for="lon">Longitude</label>
            <input id="lon" type="number" step="0.0001" bind:value={lon} on:change={() => (lastFetchKey = '')} />
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
          <div class="noaa-table panel">
            <div class="table-header">
              <div>
                <strong>Duration</strong>
              </div>
              <div class="grid aris" style={`grid-template-columns: repeat(${aris.length}, minmax(60px, 1fr));`}>
                {#each aris as a}
                  <div><strong>{a}</strong></div>
                {/each}
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
                      <button
                        type="button"
                        class={`table-button cell ${selectedDurationLabel === row.label && String(selectedAri) === a ? 'selected' : ''}`}
                        on:click={() => pickCell(row.label, a)}
                      >
                        {Number.isFinite(row.values[a]) ? row.values[a].toFixed(3) : ''}
                      </button>
                    {/each}
                  </div>
                </div>
              {/each}
            </div>
          </div>
          <div class="small">Tip: Click a table cell to apply the depth, duration, and ARI to the storm parameters.</div>
        {/if}
      </div>

      <div class="panel">
        <h2 class="section-title">Storm Parameters</h2>
        <div class="grid cols-3">
          <div>
            <label for="depth">Depth (in)</label>
            <input id="depth" type="number" min="0" step="0.001" bind:value={selectedDepth} />
          </div>
          <div>
            <label for="duration">Duration (hr)</label>
            <input id="duration" type="number" min="0.1" step="0.1" bind:value={selectedDurationHr} />
          </div>
          <div>
            <label for="timestep">Timestep (min)</label>
            <input id="timestep" type="number" min="0.1" step="0.1" bind:value={timestepMin} />
          </div>
        </div>

        <div class="grid cols-3">
          <div>
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
            <label for="ari">ARI (years)</label>
            <select id="ari" bind:value={selectedAri} on:change={applyNoaaSelection}>
              {#if aris.length}
                {#each aris as a}
                  <option value={parseInt(a, 10)}>{a}</option>
                {/each}
              {:else}
                <option value={selectedAri}>{selectedAri}</option>
              {/if}
            </select>
          </div>
          <div>
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
        </div>

        <div class="stats">
          <div class="stat-box">
            <div class="stat-title">Total Depth</div>
            <div class="stat-value">{totalDepth.toFixed(3)} in</div>
          </div>
          <div class="stat-box">
            <div class="stat-title">Peak Intensity</div>
            <div class="stat-value">{peakIntensity.toFixed(2)} in/hr</div>
          </div>
          <div class="stat-box">
            <div class="stat-title">Selected ARI</div>
            <div class="stat-value">{selectedAri} yr</div>
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
    </section>
  </div>
</div>

<style>
  :global(.leaflet-pane) {
    filter: saturate(0.9) brightness(0.9);
  }

  .page {
    min-height: 100vh;
    padding: 18px;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
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

  .layout {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
    flex: 1;
  }

  .column {
    display: flex;
    flex-direction: column;
    gap: 16px;
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

  .map {
    height: 260px;
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

  .noaa-table {
    margin-top: 16px;
    padding: 0;
    overflow: hidden;
  }

  .table-header,
  .table-row {
    display: grid;
    grid-template-columns: 120px 1fr;
  }

  .table-header {
    background: rgba(255, 255, 255, 0.03);
    border-bottom: 1px solid var(--border);
  }

  .table-header > div,
  .table-row > div {
    padding: 10px;
    font-size: 12px;
  }

  .table-body {
    max-height: 320px;
    overflow: auto;
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

  textarea {
    resize: vertical;
  }

  .actions {
    display: flex;
    gap: 10px;
    margin: 14px 0;
  }

  .plot {
    flex: 1;
  }

  .plot-area {
    height: 260px;
  }

  .stats {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
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

  @media (max-width: 1024px) {
    .layout {
      grid-template-columns: 1fr;
    }

    .plot-area {
      height: 220px;
    }
  }
</style>
