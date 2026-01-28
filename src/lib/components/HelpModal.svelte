<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import { scale } from "svelte/transition";

  export let show = false;

  const dispatch = createEventDispatcher();

  function close() {
    dispatch("close");
  }

  function handleBackdropClick(event: MouseEvent) {
    if (event.target === event.currentTarget) {
      close();
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      close();
    }
  }

  type Tab = "quickstart" | "docs" | "credits";
  let activeTab: Tab = "quickstart";

  const tabs: { id: Tab; label: string }[] = [
    { id: "quickstart", label: "Quickstart" },
    { id: "docs", label: "Documentation" },
    { id: "credits", label: "Credits" },
  ];
</script>

<svelte:window on:keydown={handleKeydown} />

{#if show}
  <div
    class="modal-backdrop"
    role="presentation"
    tabindex="-1"
    on:click={handleBackdropClick}
  >
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="help-title"
      transition:scale={{ start: 0.95, duration: 200 }}
    >
      <div class="modal-header">
        <h2 id="help-title">Design Storm Generator</h2>
        <div class="tabs" role="tablist">
          {#each tabs as tab}
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              class="tab-button"
              class:active={activeTab === tab.id}
              on:click={() => (activeTab = tab.id)}
            >
              {tab.label}
            </button>
          {/each}
        </div>
      </div>

      <div class="modal-content">
        {#if activeTab === "quickstart"}
          <div role="tabpanel" class="tab-panel">
            <p>
              <strong>Purpose.</strong>
              Build synthetic hyetographs from NOAA Atlas 14 rainfall tables paired
              with NRCS and analytical temporal distributions. Atlas 14 lookups combine
              a location search, draggable map marker, manual coordinate entry, and
              an auto-refresh toggle so the latest Partial Duration Series depths
              are always in view.
            </p>
            <h3>Quick Start</h3>
            <ol>
              <li>
                Search for a place or drag the marker. Enable <em
                  >Auto refresh when location changes</em
                >
                to fetch a new table automatically, or click
                <em>Refresh NOAA Data</em> to pull depths on demand.
              </li>
              <li>
                Review the Atlas 14 table and the companion iso-line chart, then
                click a table cell to apply its duration, Average Recurrence
                Interval, and depth to the storm parameters.
              </li>
              <li>
                Pick a distribution, toggle between <em>Standard</em> and
                <em>Custom</em>
                duration entry, and choose a computation mode.
                <em>Compare Distributions</em>
                opens normalized cumulative curves across 6-, 12-, and 24-hour presets,
                while <em>Add Custom Curve</em> imports a CSV cumulative fraction
                table.
              </li>
              <li>
                Adjust timestep and optional start time if you need timestamped
                outputs. Charts and the storm table refresh automatically—export
                CSV (timestamp, incremental, cumulative, intensity columns) or
                DAT (intensities only, in/hr) when ready.
              </li>
            </ol>
          </div>
        {:else if activeTab === "docs"}
          <div role="tabpanel" class="tab-panel">
            <h3>Atlas 14 Distribution Limits</h3>
            <div
              class="help-warning field-hint field-hint--danger"
              role="alert"
            >
              <strong
                >Stay within NOAA's published 6-, 12-, and 24-hour tables.</strong
              >
              <ul>
                <li>
                  Temporal ratios were validated only for those durations—using
                  them elsewhere assumes storm behavior that was never analyzed.
                </li>
                <li>
                  Sub-6-hour convective storms have sharper peaks; slicing a
                  6-hour pattern smooths intensities unrealistically and
                  understates cloudburst rainfall rates.
                </li>
                <li>
                  Multi-day events rarely follow a single 24-hour shape;
                  stretching the curve can mask multiple peaks and skew runoff
                  totals.
                </li>
              </ul>
              <p>
                Atlas 14 depths are statistical totals, not intra-storm
                patterns. If you need other durations, pair the correct depth
                with a different temporal pattern (Huff quartiles, SCS
                distributions, observed hyetographs, or a vetted CSV) instead of
                interpolating the nested ratios.
              </p>
              <p class="help-warning__bottom-line">
                Document assumptions for reviews—regulators expect recognized
                distributions and may reject homemade patterns.
              </p>
            </div>
            <h3>Computation Modes</h3>
            <p>
              <em>Precise</em> traces every timestep for maximum fidelity.
              <em>Fast (approx.)</em>
              downsamples the storm to evenly spaced timesteps so long events stay
              responsive. When that cap triggers you'll see a hyetograph note with
              the smoothed timestep so it's clear intensities are aggregated; switch
              back to Precise if results need to be exact.
            </p>
            <h3>Hyetograph Display</h3>
            <p>
              Hyetographs are rendered as stepped intensity bars that align with
              the computed timestep. Fast (approx.) mode may condense long
              storms to coarser bars to stay responsive; switch back to Precise
              if you need the requested timestep.
            </p>
            <h3>Interpolation</h3>
            <p>
              Manually editing <i>Return period</i> interpolates the
              <i>Depth</i>
              along the selected duration row. Editing <i>Duration</i> or
              <i>Total depth</i>
              nudges the <i>Return period</i> so the trio of values stays consistent
              with the NOAA table, and any interpolated Atlas 14 cells are highlighted.
            </p>
            <h3>Methods</h3>
            <p>
              Temporal patterns originate from NRCS dimensionless cumulative
              rainfall tables (Types I, IA, II, III) resampled to the storm
              duration—Type II/III include 6-, 12-, and 24-hour tables and
              custom durations snap to the closest available curve before
              resampling—or from parameterized Beta(α,β) distributions on [0, 1]
              for the remaining presets. No circular shifting is applied. User
              CSV curves are trimmed, normalized, and interpolated to match the
              storm duration.
            </p>
          </div>
        {:else if activeTab === "credits"}
          <div role="tabpanel" class="tab-panel">
            <h3>Credits</h3>
            <p>
              Designed and built by <strong>Ross Volkwein</strong> for water resources
              engineering professionals.
            </p>
            <p>
              <strong>Version History</strong><br />
              v1.0.0 - Initial Release<br />
              v1.1.0 - Added NOAA Atlas 14 integration<br />
              v1.2.0 - Beta release with enhanced UI and help
            </p>
            <p>
              Data provided by NOAA Atlas 14 Precipitation Frequency Data
              Server.
            </p>
          </div>
        {/if}
      </div>

      <div class="modal-actions">
        <button type="button" on:click={close}>Close</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: var(--modal-backdrop-bg, rgba(0, 0, 0, 0.4));
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    box-sizing: border-box;
    z-index: 1000;
  }

  .modal {
    background: var(--panel, #fff);
    border: 1px solid var(--border, #ccc);
    border-radius: 16px;
    max-width: 720px;
    width: min(720px, calc(100vw - 48px));
    max-height: calc(100vh - 80px);
    display: flex;
    flex-direction: column;
    box-shadow: var(--modal-shadow, 0 4px 6px -1px rgba(0, 0, 0, 0.1));
    outline: none;
    box-sizing: border-box;
  }

  .modal-header {
    padding: 24px 24px 0;
    flex: 0 0 auto;
  }

  .modal-header h2 {
    margin: 0 0 16px;
    font-size: 20px;
    font-weight: 600;
  }

  .tabs {
    display: flex;
    gap: 24px;
    border-bottom: 1px solid var(--border, #eee);
  }

  .tab-button {
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    padding: 8px 4px;
    font-size: 14px;
    font-weight: 500;
    color: var(--muted, #666);
    cursor: pointer;
    transition:
      color 0.2s,
      border-color 0.2s;
  }

  .tab-button:hover {
    color: var(--text, #333);
  }

  .tab-button.active {
    color: var(--accent, #007bff);
    border-bottom-color: var(--accent, #007bff);
  }

  .modal-content {
    padding: 24px;
    overflow-y: auto;
    flex: 1;
  }

  .tab-panel {
    animation: fade-in 0.2s ease-out;
  }

  @keyframes fade-in {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .modal-actions {
    padding: 16px 24px;
    border-top: 1px solid var(--border, #eee);
    display: flex;
    justify-content: flex-end;
    flex: 0 0 auto;
  }

  .modal-actions button {
    min-width: 90px;
    padding: 8px 16px;
    border-radius: 6px;
    border: 1px solid var(--border, #ccc);
    background: var(--button-bg, #eee);
    color: var(--text, #333);
    font-weight: 500;
    cursor: pointer;
  }

  .modal-actions button:hover {
    background: var(--button-hover-bg, #ddd);
  }

  h3 {
    margin-top: 20px;
    margin-bottom: 8px;
    font-size: 16px;
    font-weight: 600;
  }

  h3:first-child {
    margin-top: 0;
  }

  p {
    line-height: 1.6;
    margin-bottom: 16px;
  }

  ol,
  ul {
    padding-left: 20px;
    margin-bottom: 16px;
  }

  li {
    margin-bottom: 8px;
    line-height: 1.5;
  }

  .help-warning {
    margin: 18px 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .field-hint--danger {
    padding: 10px 12px;
    background: rgba(239, 68, 68, 0.12);
    border: 1px solid rgba(239, 68, 68, 0.42);
    border-radius: 8px;
    color: #fca5a5;
  }

  .field-hint--danger strong {
    color: inherit;
  }

  .help-warning__bottom-line {
    margin: 0;
    font-weight: 600;
  }
</style>
