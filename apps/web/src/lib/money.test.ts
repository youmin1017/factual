// Run with `node --experimental-strip-types src/lib/money.test.ts`
// (`pnpm test`). Kept dependency-free on purpose.
import assert from 'node:assert/strict'
import { amountInputValue, formatAmount, parseAmount } from './money.ts'

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

assert.equal(amountInputValue(-12000, 0), '-12000')
assert.equal(amountInputValue(5, 2), '0.05')
assert.equal(amountInputValue(-123456, 2), '-1234.56')

console.log('money: ok')
