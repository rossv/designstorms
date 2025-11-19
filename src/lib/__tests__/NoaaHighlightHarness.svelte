<script lang="ts">
  import { interpolateDepthFromAri, type InterpolationCell } from '../rainfall'
  import type { NoaaTableRow } from '../noaaClient'

  export let row: NoaaTableRow
  export let aris: string[]
  export let targetAri: number

  let interpolatedCells: InterpolationCell[] = []

  $: {
    const result = interpolateDepthFromAri(row, targetAri, aris)
    interpolatedCells = result?.highlight ?? []
  }

  $: interpolatedCellKeys = new Set(
    interpolatedCells.map((cell) => `${cell.duration}::${cell.ari}`)
  )

  function cellIsInterpolated(ari: string) {
    return interpolatedCellKeys.has(`${row.label}::${ari}`)
  }
</script>

{#each aris as ari}
  <div data-ari={ari} class:interpolated={cellIsInterpolated(ari)}>
    {row.values[ari]}
  </div>
{/each}
