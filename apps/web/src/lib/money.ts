/**
 * Amounts travel as integers in the budget's minor unit: `minorUnits` digits
 * after the decimal point (0 for TWD, 2 for USD). These helpers convert them
 * for display and input, without floating-point arithmetic on the integer.
 */

const formatters = new Map<number, Intl.NumberFormat>()

function formatter(minorUnits: number): Intl.NumberFormat {
  let f = formatters.get(minorUnits)
  if (!f) {
    f = new Intl.NumberFormat('zh-TW', {
      minimumFractionDigits: minorUnits,
      maximumFractionDigits: minorUnits,
    })
    formatters.set(minorUnits, f)
  }
  return f
}

/** `-12000` with 0 minor units → `-12,000`; `123456` with 2 → `1,234.56`. */
export function formatAmount(amount: number, minorUnits: number): string {
  return formatter(minorUnits).format(amount / 10 ** minorUnits)
}

/**
 * Parses what a person typed (`12,000`, `-1234.5`, `+300`) into minor units,
 * or `null` when it is not an amount in this currency (too many decimals,
 * stray characters). An empty string is 0.
 */
export function parseAmount(text: string, minorUnits: number): number | null {
  const cleaned = text.replaceAll(/[\s,_]/g, '')
  if (cleaned === '') return 0
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(cleaned)
  if (!match) return null
  const [, sign, whole = '', fraction = ''] = match
  if (whole === '' && fraction === '') return null
  if (fraction.length > minorUnits) return null
  const digits = whole + fraction.padEnd(minorUnits, '0')
  const value = Number(digits)
  if (!Number.isSafeInteger(value)) return null
  return sign === '-' ? -value : value
}

/** The input form of an amount: no grouping, `.` as the decimal point. */
export function amountInputValue(amount: number, minorUnits: number): string {
  if (minorUnits === 0) return String(amount)
  const sign = amount < 0 ? '-' : ''
  const digits = String(Math.abs(amount)).padStart(minorUnits + 1, '0')
  return `${sign}${digits.slice(0, -minorUnits)}.${digits.slice(-minorUnits)}`
}
