// Run with `node --experimental-strip-types src/lib/money.test.ts`
// (`pnpm test`). Kept dependency-free on purpose.
import assert from 'node:assert/strict'
import {
  amountInputValue,
  caretAfterGrouping,
  formatAmount,
  groupAmountText,
  parseAmount,
} from './money.ts'

assert.equal(parseAmount('12,000', 0), 12000)
assert.equal(parseAmount(' -1 234 ', 0), -1234)
assert.equal(parseAmount('+300', 0), 300)
assert.equal(parseAmount('', 0), 0)
assert.equal(parseAmount('1.5', 0), null)
assert.equal(parseAmount('1.5', 2), 150)
assert.equal(parseAmount('-0.05', 2), -5)
assert.equal(parseAmount('.5', 2), 50)
assert.equal(parseAmount('1.234', 2), null)
assert.equal(parseAmount('12a', 0), null)
assert.equal(parseAmount('-', 0), null)
assert.equal(parseAmount('99999999999999999999', 0), null)

assert.equal(formatAmount(-12000, 0), '-12,000')
assert.equal(formatAmount(123456, 2), '1,234.56')
assert.equal(formatAmount(0, 0), '0')
assert.equal(formatAmount(5, 2), '0.05')
// Grouped by 4 (萬) when the user prefers it.
assert.equal(formatAmount(100000000, 0, 4), '1,0000,0000')
assert.equal(formatAmount(-12000, 0, 4), '-1,2000')
assert.equal(formatAmount(1234567, 2, 4), '1,2345.67')
assert.equal(formatAmount(9999, 0, 4), '9999')

// Typing into an amount cell: commas follow the grouping, in every number.
assert.equal(groupAmountText('1000000'), '1,000,000')
assert.equal(groupAmountText('1000000', 4), '100,0000')
assert.equal(groupAmountText('12,34,5'), '12,345')
assert.equal(groupAmountText('1200*3+10000'), '1,200*3+10,000')
assert.equal(groupAmountText('1234.5678'), '1,234.5678')
assert.equal(groupAmountText('-5'), '-5')
assert.equal(groupAmountText(''), '')
// The caret stays after the same digit.
assert.equal(caretAfterGrouping('1000', 4, '1,000'), 5)
assert.equal(caretAfterGrouping('10000', 2, '10,000'), 2)
assert.equal(caretAfterGrouping('1,0000', 6, '10,000'), 6)
assert.equal(caretAfterGrouping('1,000', 0, '1,000'), 0)

assert.equal(amountInputValue(-12000, 0), '-12000')
assert.equal(amountInputValue(5, 2), '0.05')
assert.equal(amountInputValue(-123456, 2), '-1234.56')

console.log('money: ok')
