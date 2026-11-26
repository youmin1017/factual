// Run with: node --experimental-strip-types src/lib/accounts.test.ts
import assert from 'node:assert/strict'
import {
  accountStatus,
  applyCard,
  applySetup,
  cardValues,
  formOf,
  lockedReason,
  newAccountRow,
  rowFromAccount,
  setupFields,
  setupValues,
  toAccountInput,
  validateAccount,
} from './accounts.ts'
import { loanFieldValues } from './loan.ts'
import type { Account, AccountRow } from './accounts.ts'

const saved: Account = {
  id: 'bank',
  name: '台新',
  kind: 'bank',
  onBudget: true,
  closed: false,
  sortOrder: 0,
  balance: 50000,
  clearedBalance: 50000,
  hasActivity: true,
  card: null,
  friendId: null,
}
const bank = rowFromAccount(saved)
assert.equal(accountStatus(bank), 'clean')
assert.equal(accountStatus({ ...bank, name: '台新活存' }), 'changed')
assert.equal(accountStatus({ ...bank, deleted: true }), 'deleted')

// A new account is set up in the form: a debt is typed as what is owed.
const fresh = newAccountRow('n', '2026-11-20')
assert.equal(accountStatus(fresh), 'new')
assert.equal(formOf(fresh, 'kind'), 'setup')
assert.equal(formOf(bank, 'kind'), null)
assert.ok(lockedReason(bank, 'kind'))
assert.equal(lockedReason(fresh, 'kind'), null)
assert.deepEqual(
  setupFields(setupValues(fresh, 0)).map((f) => f.key),
  ['kind', 'onBudget', 'balance', 'date'],
)
assert.deepEqual(
  setupFields({ ...setupValues(fresh, 0), kind: 'credit_card' }).map(
    (f) => f.key,
  ),
  ['kind', 'balance', 'date'],
)
const card = applySetup(
  { kind: 'credit_card', onBudget: 'no', balance: '3000', date: '2026-11-01' },
  0,
)
assert.deepEqual(card, {
  kind: 'credit_card',
  onBudget: true,
  openingBalance: -3000,
  openingDate: '2026-11-01',
})
assert.equal(
  typeof applySetup({ ...setupValues(fresh, 0), balance: '1.5' }, 0),
  'string',
)
// Reading the form back gives the same values.
const visa: AccountRow = { ...fresh, ...(card as Partial<AccountRow>) }
assert.equal(setupValues(visa, 0).balance, '3000')

// Card settings.
assert.deepEqual(
  applyCard({ statementDay: '5', dueDay: '20', limit: '', autopay: 'bank' }, 0),
  {
    card: {
      statementDay: 5,
      dueDay: 20,
      creditLimit: null,
      autopayAccountId: 'bank',
    },
  },
)
assert.deepEqual(applyCard(cardValues(null, 0), 0), { card: null })
assert.equal(
  typeof applyCard(
    { statementDay: '32', dueDay: '1', limit: '', autopay: '' },
    0,
  ),
  'string',
)

// What is sent: an existing account only says what can change.
assert.deepEqual(toAccountInput({ ...visa, name: '國泰卡' }, 2), {
  id: 'n',
  name: '國泰卡',
  kind: 'credit_card',
  onBudget: true,
  openingBalance: -3000,
  openingDate: '2026-11-01',
  closed: false,
  sortOrder: 2,
})
assert.equal(toAccountInput(bank, 0).openingBalance, 0)

// Validation.
assert.equal(validateAccount({ ...fresh, name: ' ' }, [])?.field, 'name')
assert.equal(
  validateAccount({ ...fresh, name: '台新' }, [bank])?.message,
  '已經有叫「台新」的帳戶',
)
assert.equal(validateAccount({ ...bank, closed: true }, [])?.field, 'status')
assert.ok(validateAccount({ ...bank, deleted: true }, [])?.message)
assert.equal(
  validateAccount(
    { ...bank, base: { ...saved, hasActivity: false }, deleted: true },
    [],
  ),
  null,
)

// A loan's terms edited under its line go with :w.
const house: AccountRow = {
  ...newAccountRow('h', '2026-11-20'),
  name: '房貸',
  kind: 'loan',
  onBudget: false,
}
const terms = {
  ...loanFieldValues(null, 0, '2026-11-20'),
  principal: '1000000',
  months: '240',
  rates: [{ from: '2026-11-20', rate: '2' }],
}
assert.equal(
  toAccountInput({ ...house, loan: terms }, 0).loan?.principal,
  1000000,
)
assert.equal(toAccountInput(house, 0).loan, undefined)
assert.equal(accountStatus({ ...bank, kind: 'loan', loan: terms }), 'changed')
assert.match(
  validateAccount({ ...house, loan: { ...terms, principal: '' } }, [])
    ?.message ?? '',
  /^貸款條件：/,
)
assert.equal(validateAccount({ ...house, loan: terms }, []), null)

console.log('accounts: ok')
