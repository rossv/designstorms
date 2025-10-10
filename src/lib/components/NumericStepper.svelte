<script lang="ts">
  import { createEventDispatcher } from 'svelte'

  export let id: string | undefined
  export let value: number = 0
  export let min: number | null = null
  export let max: number | null = null
  export let step = 1
  export let buttonStep: number | null = null
  export let label = ''
  export let disabled = false
  export let showProgress = false

  const dispatch = createEventDispatcher<{ change: { value: number } }>()

  const epsilon = 1e-9
  let inputValue = ''
  let isEditing = false
  let inputElement: HTMLInputElement

  $: if (!isEditing) {
    inputValue = formatValue(value)
  }

  $: isAtMin = min != null && Number.isFinite(value) && value - min <= epsilon
  $: isAtMax = max != null && Number.isFinite(value) && max - value <= epsilon
  $: hasRange =
    showProgress && min != null && max != null && Number.isFinite(max - min) && max - min > epsilon
  $: progressPercent =
    hasRange && min != null && max != null
      ? clampPercent(((value - min) / (max - min)) * 100)
      : 0

  function clampPercent(percent: number) {
    if (!Number.isFinite(percent)) return 0
    return Math.min(100, Math.max(0, percent))
  }

  function formatValue(val: number) {
    if (!Number.isFinite(val)) return ''
    return Number.parseFloat(val.toFixed(Math.min(getStepPrecision(), 6))).toString()
  }

  function getStepPrecision() {
    const text = step.toString()
    const dot = text.indexOf('.')
    return dot === -1 ? 0 : text.length - dot - 1
  }

  function clamp(val: number) {
    let next = val
    if (min != null && next < min) next = min
    if (max != null && next > max) next = max
    return next
  }

  function roundToStep(val: number) {
    if (!Number.isFinite(step) || step <= 0) return val
    const precision = Math.max(getStepPrecision(), 0)
    const factor = 10 ** precision
    if (min != null) {
      const base = Math.round(min * factor)
      const offset = Math.round(val * factor) - base
      const stepUnits = Math.round(step * factor)
      const snapped = Math.round(offset / stepUnits) * stepUnits + base
      return snapped / factor
    }
    return Math.round(val * factor) / factor
  }

  function updateValue(next: number, options: { preserveInput?: boolean } = {}) {
    const clamped = clamp(roundToStep(next))
    const previous = value
    value = clamped
    if (!options.preserveInput) {
      inputValue = formatValue(clamped)
    }
    if (Math.abs(previous - clamped) > epsilon) {
      dispatch('change', { value: clamped })
    }
  }

  function handleInput(event: Event) {
    if (disabled) return
    const target = event.currentTarget as HTMLInputElement
    inputValue = target.value
    if (!target.value.trim()) {
      return
    }
    const parsed = Number(target.value)
    if (Number.isFinite(parsed)) {
      updateValue(parsed, { preserveInput: true })
    }
  }

  function handleBlur(event: FocusEvent) {
    isEditing = false
    if (disabled) return
    const target = event.currentTarget as HTMLInputElement
    commit(target.value)
  }

  function handleFocus() {
    if (disabled) return
    isEditing = true
  }

  function commit(raw: string) {
    if (!raw.trim()) {
      if (min != null) {
        updateValue(min)
      } else if (max != null) {
        updateValue(max)
      } else {
        inputValue = formatValue(value)
      }
      return
    }
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) {
      inputValue = formatValue(value)
      return
    }
    updateValue(parsed)
  }

  function getButtonStepValue() {
    const candidate = buttonStep ?? step
    if (!Number.isFinite(candidate) || candidate <= 0) {
      return step
    }
    return candidate
  }

  function increment() {
    if (disabled) return
    const base = Number.isFinite(value) ? value : min ?? 0
    updateValue(base + getButtonStepValue())
    focusInput()
  }

  function decrement() {
    if (disabled) return
    const base = Number.isFinite(value) ? value : max ?? 0
    updateValue(base - getButtonStepValue())
    focusInput()
  }

  function focusInput() {
    inputElement?.focus()
  }

  function handleKeydown(event: KeyboardEvent) {
    if (disabled) return
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      increment()
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      decrement()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      commit(inputValue)
      focusInput()
    }
  }
</script>

<div class="stepper" data-disabled={disabled} data-focused={isEditing}>
  <button
    type="button"
    class="stepper-button decrement"
    on:click={decrement}
    aria-label={label ? `Decrease ${label}` : 'Decrease'}
    disabled={disabled || isAtMin}
  >
    −
  </button>
  <div class="value-area">
    <input
      id={id}
      bind:this={inputElement}
      class="value-input"
      type="text"
      inputmode="decimal"
      role="spinbutton"
      aria-label={label}
      aria-valuenow={Number.isFinite(value) ? value : undefined}
      aria-valuemin={min ?? undefined}
      aria-valuemax={max ?? undefined}
      autocomplete="off"
      autocorrect="off"
      spellcheck={false}
      disabled={disabled}
      value={inputValue}
      on:input={handleInput}
      on:focus={handleFocus}
      on:blur={handleBlur}
      on:keydown={handleKeydown}
    />
    {#if hasRange}
      <div class="progress-track" aria-hidden="true">
        <div class="progress-fill" style={`width: ${progressPercent}%`} />
      </div>
    {/if}
  </div>
  <button
    type="button"
    class="stepper-button increment"
    on:click={increment}
    aria-label={label ? `Increase ${label}` : 'Increase'}
    disabled={disabled || isAtMax}
  >
    +
  </button>
</div>

<style>
  .stepper {
    display: flex;
    align-items: center;
    gap: 8px;
    background: rgba(15, 19, 26, 0.9);
    border-radius: 999px;
    padding: 4px;
    border: 1px solid var(--border);
    transition: border-color 120ms ease, box-shadow 120ms ease, background 120ms ease;
    width: 100%;
    box-sizing: border-box;
  }

  .stepper[data-disabled='true'] {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .stepper:hover:not([data-disabled='true']) {
    border-color: rgba(110, 231, 255, 0.5);
    background: rgba(21, 27, 36, 0.95);
  }

  .stepper:focus-within {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px rgba(110, 231, 255, 0.25);
  }

  .stepper-button {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    border: none;
    background: rgba(19, 24, 35, 0.95);
    color: var(--text);
    display: grid;
    place-items: center;
    font-size: 18px;
    line-height: 1;
    padding: 0;
    transition: background 120ms ease, transform 120ms ease;
  }

  .stepper-button:hover:not(:disabled) {
    background: rgba(110, 231, 255, 0.2);
  }

  .stepper-button:active:not(:disabled) {
    transform: scale(0.95);
  }

  .stepper-button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .value-area {
    position: relative;
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 0;
  }

  .value-input {
    appearance: textfield;
    -moz-appearance: textfield;
    background: transparent;
    border: none;
    color: var(--text);
    font: inherit;
    text-align: center;
    width: 100%;
    padding: 8px 6px;
    border-radius: 999px;
    outline: none;
  }

  .value-input:focus-visible {
    outline: none;
  }

  .value-input:disabled {
    cursor: not-allowed;
  }

  .value-input::-webkit-outer-spin-button,
  .value-input::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }

  .progress-track {
    position: absolute;
    left: 12px;
    right: 12px;
    bottom: 6px;
    height: 4px;
    background: rgba(110, 231, 255, 0.08);
    border-radius: 999px;
    overflow: hidden;
    pointer-events: none;
  }

  .progress-fill {
    height: 100%;
    background: rgba(110, 231, 255, 0.8);
    border-radius: inherit;
    transition: width 120ms ease;
  }
</style>
