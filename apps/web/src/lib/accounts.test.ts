// Run with: node --experimental-strip-types src/lib/accounts.test.ts
import assert from 'node:assert/strict'
import {
  accountCellText,
  accountStatus,
  balancePatch,
  kindPatch,
  lockedReason,
  newAccountRow,
  openingCellPatch,
  openingCellText,
  openingLines,
  rowFromAccount,
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
  groupId: null,
}
const bank = rowFromAccount(saved)
assert.equal(accountStatus(bank), 'clean')
assert.equal(accountStatus({ ...bank, name: '台新活存' }), 'changed')
assert.equal(accountStatus({ ...bank, deleted: true }), 'deleted')

// A new account's kind is picked, its balance typed in its cell (ADR-137):
// a debt is typed as what is owed.
const fresh = newAccountRow('n', '2026-11-20')
assert.equal(accountStatus(fresh), 'new')
assert.ok(lockedReason(bank, 'kind'))
assert.equal(lockedReason(fresh, 'kind'), null)
assert.equal(lockedReason(fresh, 'balance'), null)
assert.equal(lockedReason(fresh, 'onBudget'), null)
assert.equal(accountCellText(fresh, 'kind'), '銀行')
const patched = (row: AccountRow, patch: Partial<AccountRow> | string) => {
  assert.equal(typeof patch, 'object', String(patch))
  return { ...row, ...(patch as Partial<AccountRow>) }
}
const wallet = patched(fresh, balancePatch(fresh, '1,200*2', 0))
assert.equal(wallet.openingBalance, 2400)
assert.equal(accountCellText(wallet, 'balance'), '2400')
assert.equal(typeof balancePatch(fresh, '12元', 0), 'string')
assert.equal(patched(fresh, balancePatch(fresh, '', 0)).openingBalance, 0)
// Changing the kind keeps the amount typed: a card's is what it owes.
const owing = patched(wallet, kindPatch(wallet, '信用卡'))
assert.equal(owing.kind, 'credit_card')
assert.equal(owing.onBudget, true)
assert.equal(owing.openingBalance, -2400)
assert.equal(accountCellText(owing, 'balance'), '2400')
assert.equal(lockedReason(owing, 'onBudget'), '信用卡一定計入預算')
assert.deepEqual(kindPatch(owing, 'credit_card'), {})
assert.equal(typeof kindPatch(owing, '股票'), 'string')
assert.equal(patched(owing, kindPatch(owing, '現金')).openingBalance, 2400)
// A bank account kept off budget stays so as cash; a loan is always off.
const offBudget = { ...wallet, onBudget: false }
assert.equal(patched(wallet, kindPatch(wallet, '貸款')).onBudget, false)
assert.equal(patched(offBudget, kindPatch(offBudget, '現金')).onBudget, false)

// Where it starts is under its line: the day, and a card's latest bill.
const today = new Date(2026, 10, 20)
assert.deepEqual(
  openingLines(fresh).map((l) => l.cells.map((c) => c.key)),
  [['openingDate']],
)
assert.deepEqual(openingLines(bank), [])
const [billLine, dateLine] = openingLines(owing)
const [billed, unbilled] = billLine.cells
assert.deepEqual(
  [billed.key, unbilled.key, dateLine.cells[0].key],
  ['openingBilled', 'openingUnbilled', 'openingDate'],
)
assert.equal(openingCellText(owing, unbilled, 0), '2400')
assert.equal(openingCellText(owing, billed, 0), '')
assert.equal(openingCellText(owing, dateLine.cells[0], 0), '2026/11/20')
// Typing the bill keeps what is not billed; the balance is both.
const split = patched(owing, openingCellPatch(owing, billed, '3000', 0, today))
assert.equal(split.openingBilled, -3000)
assert.equal(split.openingBalance, -5400)
const less = patched(split, openingCellPatch(split, unbilled, '400', 0, today))
assert.equal(less.openingBalance, -3400)
assert.equal(openingCellText(less, billed, 0), '3000')
assert.equal(accountCellText(less, 'balance'), '3400')
assert.equal(
  patched(less, openingCellPatch(less, dateLine.cells[0], '11/5', 0, today))
    .openingDate,
  '2026-11-05',
)
assert.equal(
  typeof openingCellPatch(less, dateLine.cells[0], '', 0, today),
  'string',
)
assert.equal(typeof openingCellPatch(less, billed, 'abc', 0, today), 'string')
// The bill needs the card's days, and goes with :w apart from the rest.
const named = { ...less, name: '國泰 CUBE' }
assert.equal(validateAccount(named, [named])?.field, 'card')
const settled = {
  ...named,
  cardEdit: { statementDay: '5', dueDay: '25', limit: '', autopay: '' },
}
assert.equal(validateAccount(settled, [settled]), null)
const sent = toAccountInput(settled, 0)
assert.equal(sent.openingBalance, -3400)
assert.equal(sent.openingBilled, -3000)
assert.equal(
  toAccountInput({ ...settled, openingBilled: 0 }, 0).openingBilled,
  undefined,
)

const card = {
  kind: 'credit_card' as const,
  onBudget: true,
  openingBalance: -3000,
  openingDate: '2026-11-01',
}
const visa: AccountRow = { ...fresh, ...card }

// Card settings edited in the lines under the card (ADR-117).
assert.equal(accountStatus({ ...visa, base: null }), 'new')
const savedVisa: AccountRow = {
  ...visa,
  base: {
    id: 'n',
    name: visa.name,
    kind: 'credit_card',
    onBudget: true,
    closed: false,
    sortOrder: 0,
    balance: -3000,
    clearedBalance: 0,
    hasActivity: true,
    card: {
      statementDay: 5,
      dueDay: 20,
      creditLimit: null,
      autopayAccountId: null,
    },
    friendId: null,
    groupId: null,
  },
  card: {
    statementDay: 5,
    dueDay: 20,
    creditLimit: null,
    autopayAccountId: null,
  },
}
assert.equal(accountStatus(savedVisa), 'clean')
const edited = {
  ...savedVisa,
  cardEdit: { statementDay: '5', dueDay: '20', limit: '', autopay: '' },
}
// Lines taken unchanged leave it clean; a new due day changes it.
assert.equal(accountStatus(edited), 'clean')
const later = { ...edited, cardEdit: { ...edited.cardEdit, dueDay: '25' } }
assert.equal(accountStatus(later), 'changed')
assert.deepEqual(toAccountInput(later, 0).card, {
  statementDay: 5,
  dueDay: 25,
  creditLimit: null,
  autopayAccountId: null,
})
const half = {
  ...edited,
  name: '國泰卡',
  cardEdit: { ...edited.cardEdit, dueDay: '' },
}
assert.equal(validateAccount(half, [half])?.field, 'card')
assert.equal(toAccountInput(half, 0).card, undefined)

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
