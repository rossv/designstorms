export function snapValueToStep(
  value: number,
  step: number,
  options: { min?: number | null } = {}
): number {
  if (!Number.isFinite(step) || step <= 0 || !Number.isFinite(value)) {
    return value
  }

  const anchor =
    options.min != null && Number.isFinite(options.min) ? (options.min as number) : 0
  const stepsFromAnchor = Math.round((value - anchor) / step)
  const snapped = anchor + stepsFromAnchor * step

  const precision = Math.min(
    12,
    Math.max(
      decimalPlaces(step),
      decimalPlaces(anchor),
      decimalPlaces(value),
      decimalPlaces(snapped)
    )
  )

  if (precision <= 0) {
    return snapped
  }

  const factor = 10 ** precision
  return Math.round(snapped * factor + Number.EPSILON) / factor
}

function decimalPlaces(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }

  const text = value.toString().toLowerCase()
  if (text.includes('e')) {
    const [mantissa, exponentPart] = text.split('e')
    const exponent = Number(exponentPart)
    const mantissaDecimals = mantissa.includes('.')
      ? mantissa.split('.')[1].replace(/0+$/, '').length
      : 0

    if (!Number.isFinite(exponent)) {
      return Math.min(mantissaDecimals, 12)
    }

    if (exponent < 0) {
      return Math.min(mantissaDecimals - exponent, 12)
    }

    return Math.max(0, Math.min(mantissaDecimals - exponent, 12))
  }

  if (text.includes('.')) {
    const decimals = text.split('.')[1].replace(/0+$/, '')
    return Math.min(decimals.length, 12)
  }

  return 0
}
