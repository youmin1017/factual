/**
 * Amounts travel as integers in the budget's minor unit: `minorUnits` digits
 * after the decimal point (0 for TWD, 2 for USD). These helpers convert them
 * for display and input, without floating-point arithmetic on the integer.
 */

/** How digits are grouped: 3 (1,000,000) or 4 (100,0000, by 萬), the user's preference (ADR-122). */
export type Grouping = 3 | 4

let grouping: Grouping = 3

/** Sets the grouping amounts are shown and typed with (from the user's preferences). */
export function setAmountGrouping(g: Grouping): void {
  grouping = g
}

/** Puts a comma before every `size` digits from the right of a run of digits. */
function groupDigits(digits: string, size: number): string {
  let out = ''
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % size === 0) out += ','
    out += digits[i]
  }
  return out
}

/**
 * `-12000` with 0 minor units → `-12,000` (or `-1,2000` grouped by 4);
 * `123456` with 2 → `1,234.56`.
 */
export function formatAmount(
  amount: number,
  minorUnits: number,
  size: Grouping = grouping,
): string {
  const sign = amount < 0 ? '-' : ''
  const plain = amountInputValue(Math.abs(amount), minorUnits)
  const dot = plain.indexOf('.')
  const whole = dot < 0 ? plain : plain.slice(0, dot)
  return sign + groupDigits(whole, size) + (dot < 0 ? '' : plain.slice(dot))
}

/**
 * What is typed into an amount cell with its commas put where the grouping
 * wants them: every number in it (`1200*3` too) is regrouped, decimals
 * left alone.
 */
export function groupAmountText(
  text: string,
  size: Grouping = grouping,
): string {
  return text.replaceAll(
    /(\d[\d,]*)(\.\d*)?/g,
    (_, whole: string, fraction: string | undefined) =>
      groupDigits(whole.replaceAll(',', ''), size) + (fraction ?? ''),
  )
}

/**
 * Where the caret goes after `before` was regrouped into `after`: past
 * as many characters other than commas as it was before.
 */
export function caretAfterGrouping(
  before: string,
  caret: number,
  after: string,
): number {
  const keep = before.slice(0, caret).replaceAll(',', '').length
  let seen = 0
  for (let i = 0; i < after.length; i++) {
    if (seen === keep) return i
    if (after[i] !== ',') seen++
  }
  return after.length
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
