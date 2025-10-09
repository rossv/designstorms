<script lang="ts">
  import { onMount } from 'svelte'
  import * as L from 'leaflet'
  import Plotly from 'plotly.js-dist-min'
  import { fetchNoaaTable, parseNoaaTable, type NoaaTable } from './lib/noaaClient'
  import { generateStorm, type StormParams, type DistributionName } from './lib/stormEngine'
  import { saveCsv, savePcswmmDat } from './lib/export'

  let mapDiv: HTMLDivElement
  let plotDiv1: HTMLDivElement
  let plotDiv2: HTMLDivElement

  let lat = 40.4406
  let lon = -79.9959
  let marker: L.Marker

  let durations: string[] = []
  let aris: string[] = []
  let table: NoaaTable | null = null
  let selectedDepth = 1.0
  let selectedDurationHr = 24
  let selectedAri = 10

  // controls
  let timestepMin = 5
  let distribution: DistributionName = 'scs_type_ii'
  let startISO = '2003-01-01T00:00'
  let customCurveCsv = ''

  let lastStorm: ReturnType<typeof generateStorm> | null = null

  onMount(() => {
    const map = L.map(mapDiv, { attributionControl: false }).setView([lat, lon], 10)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18
    }).addTo(map)
    marker = L.marker([lat, lon], { draggable: true }).addTo(map)
    marker.on('dragend', () => {
      const p = marker.getLatLng()
      lat = p.lat; lon = p.lng
    })
  })

  async function loadNoaa() {
    try {
      const txt = await fetchNoaaTable(lat, lon)
      table = parseNoaaTable(txt)
      if (!table) throw new Error('NOAA parse failed')
      durations = table.rows.map(r => r.label)
      aris = table.aris
    } catch (e:any) {
      alert('Failed fetching NOAA table: ' + e.message)
    }
  }

  function pickCell(durLabel: string, ari: string) {
    if (!table) return
    const r = table.rows.find(r => r.label === durLabel)
    const depth = r?.values[ari]
    if (depth == null || isNaN(depth)) return
    selectedDurationHr = toHours(durLabel)
    selectedAri = parseInt(ari, 10)
    selectedDepth = depth
  }

  function toHours(label: string): number {
    const m = label.toLowerCase()
    const num = parseFloat(m)
    if (m.includes('min')) return num/60
    if (m.includes('hr') || m.includes('hour')) return num
    return num*24
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
    // charts
    Plotly.newPlot(plotDiv1, [{
      x: lastStorm.timeMin, y: lastStorm.intensityInHr, mode: 'lines', name: 'Intensity (in/hr)'
    }], { paper_bgcolor: 'transparent', plot_bgcolor: 'transparent', xaxis: {title:'Time (min)'}, yaxis:{title:'Intensity (in/hr)'} })
    Plotly.newPlot(plotDiv2, [{
      x: lastStorm.timeMin, y: lastStorm.cumulativeIn, mode: 'lines', name: 'Cumulative (in)'
    }], { paper_bgcolor: 'transparent', plot_bgcolor: 'transparent', xaxis: {title:'Time (min)'}, yaxis:{title:'Depth (in)'} })
  }

  function doCsv() {
    if (!lastStorm) return
    saveCsv(lastStorm, 'design_storm.csv')
  }
  function doDat() {
    if (!lastStorm) return
    savePcswmmDat(lastStorm, timestepMin, 'design_storm.dat')
  }
</script>

<div class="grid cols-2" style="height: 100vh; box-sizing: border-box; padding: 12px;">
  <div class="panel" style="display:flex; flex-direction:column; gap:12px;">
    <div id="map" bind:this={mapDiv} style="height:300px; border-radius:12px; overflow:hidden;"></div>
    <div class="grid cols-3">
      <div>
        <label for="depth">Depth (in)</label>
        <input id="depth" type="number" min="0" step="0.001" bind:value={selectedDepth} />
      </div>
      <div>
        <label for="dur">Duration (hr)</label>
        <input id="dur" type="number" min="0.1" step="0.1" bind:value={selectedDurationHr} />
      </div>
      <div>
        <label for="step">Timestep (min)</label>
        <input id="step" type="number" min="0.1" step="0.1" bind:value={timestepMin} />
      </div>
    </div>
    
    <div class="grid cols-3">
      <div>
        <label for="dist">Distribution</label>
        <select id="dist" bind:value={distribution}>
          ...
        </select>
      </div>
      <div>
        <label for="start">Start (ISO)</label>
        <input id="start" type="datetime-local" bind:value={startISO} />
      </div>
      <div>
        <label for="curve">Custom Curve CSV</label>
        <input id="curve" placeholder="t (0..1), cum (0..1)" bind:value={customCurveCsv} />
      </div>
    </div>

    {#if table}
      <div class="panel" style="overflow:auto; max-height: 40vh;">
        <table class="table">
          <thead>
            <tr>
              <th>Duration</th>
              {#each aris as a}<th>{a}</th>{/each}
            </tr>
          </thead>
          <tbody>
            {#each table.rows as r}
              <tr>
                <td>{r.label}</td>
                {#each aris as a}
                  <td on:click={() => pickCell(r.label,a)} style="cursor:pointer;">
                    {Number.isFinite(r.values[a]) ? r.values[a].toFixed(3) : ''}
                  </td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>

  <div class="panel" style="display:flex; flex-direction:column; gap:12px;">
    <div class="grid cols-3">
      <div><label>Depth (in)</label><input type="number" min="0" step="0.001" bind:value={selectedDepth}></div>
      <div><label>Duration (hr)</label><input type="number" min="0.1" step="0.1" bind:value={selectedDurationHr}></div>
      <div><label>Timestep (min)</label><input type="number" min="0.1" step="0.1" bind:value={timestepMin}></div>
    </div>
    <div class="grid cols-3">
      <div>
        <label>Distribution</label>
        <select bind:value={distribution}>
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
      <div><label>Start (ISO)</label><input type="datetime-local" bind:value={startISO}></div>
      <div><label>Custom Curve CSV</label><input placeholder="t (0..1), cum (0..1)" bind:value={customCurveCsv}></div>
    </div>
    <div style="display:flex; gap:8px;">
      <button class="primary" on:click={makeStorm}>Generate</button>
      <button on:click={doCsv}>Export CSV</button>
      <button on:click={doDat}>Export DAT</button>
    </div>

    <div class="panel">
      <div bind:this={plotDiv1} style="height:240px;"></div>
    </div>
    <div class="panel">
      <div bind:this={plotDiv2} style="height:240px;"></div>
    </div>
    <div class="small">Tip: Click a depth cell in the NOAA table to set Depth/Duration/ARI.</div>
  </div>
</div>

<style>
  :global(.leaflet-pane) { filter: saturate(0.9) brightness(0.9) }
</style>
