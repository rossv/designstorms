<script lang="ts">
  import { createEventDispatcher } from 'svelte'

  export let value: number = 0
  export let min: number = Number.NEGATIVE_INFINITY
  export let max: number = Number.POSITIVE_INFINITY
  export let step = 1
  export let label = ''
  export let disabled = false
  export let inputId: string | undefined = undefined
  export let name: string | undefined = undefined

  const dispatch = createEventDispatcher<{ change: number }>()

  let isFocused = false
  let inputValue = formatValue(value)

  $: {
    const clamped = clampValue(value)
    if (clamped !== value) {
      value = clamped
      if (!isFocused) {
        inputValue = formatValue(clamped)
      }
    } else if (!isFocused) {
      inputValue = formatValue(value)
    }
  }

  let hasRange = false
  $: hasRange = Number.isFinite(min) && Number.isFinite(max) && max > min
  $: progress = hasRange ? ((value - min) / (max - min)) * 100 : 0

  function formatValue(val: number) {
    return Number.isFinite(val) ? `${val}` : ''
  }

  function clampValue(val: number) {
    if (!Number.isFinite(val)) return val
    let next = val
    if (Number.isFinite(min)) {
      next = Math.max(min, next)
    }
    if (Number.isFinite(max)) {
      next = Math.min(max, next)
    }
    return next
  }

  function commit(next: number) {
    const clamped = clampValue(next)
    const changed = clamped !== value
    value = clamped
    inputValue = formatValue(clamped)
    if (changed) {
      dispatch('change', clamped)
    }
  }

  function handleInput(event: Event) {
    const target = event.currentTarget as HTMLInputElement
    inputValue = target.value
    const trimmed = target.value.trim()
    if (!trimmed || trimmed === '-' || trimmed === '+') {
      return
    }
    const parsed = Number(trimmed)
    if (Number.isFinite(parsed)) {
      commit(parsed)
    }
  }

  function handleBlur() {
    isFocused = false
    if (!inputValue.trim()) {
      inputValue = formatValue(value)
      return
    }
    const parsed = Number(inputValue)
    if (Number.isFinite(parsed)) {
      commit(parsed)
    } else {
      inputValue = formatValue(value)
    }
  }

  function increment(multiplier = 1) {
    const base = Number.isFinite(value) ? value : Number.isFinite(min) ? min : 0
    commit(base + step * multiplier)
  }

  function decrement(multiplier = 1) {
    const base = Number.isFinite(value) ? value : Number.isFinite(max) ? max : 0
    commit(base - step * multiplier)
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      increment(event.shiftKey ? 10 : 1)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      decrement(event.shiftKey ? 10 : 1)
    } else if (event.key === 'Enter') {
      const parsed = Number(inputValue)
      if (Number.isFinite(parsed)) {
        commit(parsed)
      } else {
        inputValue = formatValue(value)
      }
    }
  }
</script>

<div class="numeric-stepper {disabled ? 'disabled' : ''}">
  <button
    type="button"
    class="step-button"
    aria-label={`Decrease ${label || 'value'}`}
    on:click={() => decrement()}
    disabled={disabled || (Number.isFinite(min) && value <= min)}
  >
    −
  </button>
  <div class="value-container">
    <input
      type="number"
      class="value-input"
      aria-label={label}
      id={inputId}
      name={name}
      value={inputValue}
      on:focus={() => {
        isFocused = true
      }}
      on:input={handleInput}
      on:blur={handleBlur}
      on:keydown={handleKeydown}
      step={step}
      min={Number.isFinite(min) ? String(min) : undefined}
      max={Number.isFinite(max) ? String(max) : undefined}
      disabled={disabled}
    />
    {#if hasRange}
      <div class="progress-track">
        <div class="progress-fill" style={`width: ${Math.min(100, Math.max(0, progress))}%`}></div>
      </div>
    {/if}
  </div>
  <button
    type="button"
    class="step-button"
    aria-label={`Increase ${label || 'value'}`}
    on:click={() => increment()}
    disabled={disabled || (Number.isFinite(max) && value >= max)}
  >
    +
  </button>
</div>

<style>
  .numeric-stepper {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    background: rgba(255, 255, 255, 0.06);
    border-radius: 999px;
    padding: 0.25rem;
    transition: background 0.2s ease;
    width: 100%;
  }

  .numeric-stepper:hover {
    background: rgba(255, 255, 255, 0.1);
  }

  .numeric-stepper.disabled {
    opacity: 0.6;
    pointer-events: none;
  }

  .step-button {
    width: 32px;
    height: 32px;
    border-radius: 999px;
    border: none;
    background: rgba(0, 0, 0, 0.35);
    color: #fff;
    font-size: 1.25rem;
    line-height: 1;
    display: grid;
    place-items: center;
    cursor: pointer;
    transition: background 0.2s ease, transform 0.15s ease;
  }

  .step-button:hover:not(:disabled) {
    background: rgba(0, 0, 0, 0.5);
    transform: translateY(-1px);
  }

  .step-button:active:not(:disabled) {
    transform: translateY(0);
  }

  .step-button:disabled {
    background: rgba(0, 0, 0, 0.2);
    cursor: not-allowed;
  }

  .value-container {
    position: relative;
    display: flex;
    align-items: center;
    min-width: 80px;
    flex: 1;
  }

  .value-input {
    width: 100%;
    text-align: center;
    background: transparent;
    border: none;
    color: #fff;
    font-size: 1rem;
    padding: 0.35rem 0.75rem;
    border-radius: 999px;
    outline: none;
    appearance: textfield;
  }

  .value-input:focus {
    box-shadow: 0 0 0 2px rgba(99, 179, 237, 0.6);
    background: rgba(0, 0, 0, 0.35);
  }

  .value-input::-webkit-outer-spin-button,
  .value-input::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }

  .progress-track {
    position: absolute;
    left: 0.5rem;
    right: 0.5rem;
    bottom: 0.35rem;
    height: 3px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.15);
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #63b3ed, #4299e1);
    border-radius: 999px;
    transition: width 0.2s ease;
  }
</style>
