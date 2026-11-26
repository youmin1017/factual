// Run with: node --experimental-strip-types src/lib/splitting.test.ts
import assert from 'node:assert/strict'
import {
  applyMemberForm,
  deleteBlocked,
  insertIndex,
  lockedReason,
  memberFormFields,
  membersText,
  newPartyRow,
  partyBalanceText,
  partyPatch,
  partyRows,
  partyStatus,
  placeByKind,
  toBatch,
  validateParty,
} from './splitting.ts'
import type { Friend, Group } from './split.ts'
import type { PartyRow } from './splitting.ts'

const friend = (
  id: string,
  name: string,
  extra: Partial<Friend> = {},
): Friend => ({
  id,
  displayName: name,
  placeholder: true,
  budgetId: 'b',
  accountId: `a-${id}`,
  balance: 0,
  expenseCount: 0,
  ...extra,
})
const member = (userId: string, displayName: string, extra = {}) => ({
  userId,
  displayName,
  placeholder: true,
  role: 'member' as const,
  paid: 0,
  share: 0,
  balance: 0,
  ...extra,
})
const trip: Group = {
  id: 'trip',
  name: '花蓮',
  currency: 'TWD',
  archived: false,
  createdBy: 'me',
  members: [
    member('me', '我', {
      role: 'admin',
      paid: 3000,
      share: 1000,
      balance: 2000,
    }),
    member('ming', '小明', { share: 1000, balance: -1000 }),
    member('hua', '小華', { share: 1000, balance: -1000 }),
  ],
  budgetId: 'b',
  accountId: 'a-trip',
  balance: 2000,
  expenseCount: 1,
}
const friends = [
  friend('ming', '小明', { expenseCount: 2, balance: 300 }),
  friend('hua', '小華'),
  friend('joe', 'Joe', { placeholder: false }),
]
const rows = partyRows([trip], friends, 'me')

// Groups first, then friends; the caller is not listed as a member.
assert.deepEqual(
  rows.map((r) => [r.kind, r.name]),
  [
    ['group', '花蓮'],
    ['friend', '小明'],
    ['friend', '小華'],
    ['friend', 'Joe'],
  ],
)
assert.deepEqual(rows[0].members, ['ming', 'hua'])
assert.equal(membersText(rows[0], rows), '小明、小華')
assert.ok(rows.every((r) => partyStatus(r, 'me') === 'clean'))
assert.equal(partyBalanceText(rows[0], 0), '群組 欠我 2,000')
assert.equal(partyBalanceText(rows[1], 0), '小明 欠我 300')
assert.equal(partyBalanceText(rows[2], 0), '已結清')

// New lines go to the end of their kind; a kind change moves the line.
assert.equal(insertIndex(rows, 'group', 3), 1)
assert.equal(insertIndex(rows, 'friend', 0), 1)
assert.equal(insertIndex([], 'friend', 0), 0)
const added = [...rows, newPartyRow('n', 'friend')]
assert.deepEqual(
  placeByKind(added.with(4, { ...added[4], kind: 'group' }), 'n').map(
    (r) => r.id,
  ),
  ['trip', 'n', 'ming', 'hua', 'joe'],
)

// Cells and what can be changed.
assert.deepEqual(partyPatch('name', ' 阿明 '), { name: '阿明' })
assert.equal(typeof partyPatch('name', ' '), 'string')
assert.deepEqual(partyPatch('kind', '群組'), { kind: 'group' })
assert.equal(lockedReason(rows[3], 'name') !== null, true)
assert.equal(lockedReason(rows[1], 'kind') !== null, true)
assert.equal(lockedReason(newPartyRow('n', 'friend'), 'kind'), null)
assert.equal(lockedReason(rows[1], 'members') !== null, true)

// The members form lists friends without an account of their own.
const fields = memberFormFields(rows[0], rows)
assert.deepEqual(
  fields.map((f) => f.key),
  ['ming', 'hua'],
)
assert.deepEqual(applyMemberForm(rows[0], { ming: 'yes', hua: 'no' }, rows), {
  members: ['ming'],
})
assert.equal(
  typeof applyMemberForm(rows[0], { ming: 'no', hua: 'no' }, rows),
  'string',
)

// Validation.
assert.equal(validateParty(rows[0], rows), null)
assert.equal(validateParty({ ...rows[2], name: '小明' }, rows)?.field, 'name')
assert.equal(
  validateParty({ ...rows[0], members: ['ming'] }, rows)?.message,
  '小華 還有群組裡的分帳，不能移除',
)
assert.equal(
  validateParty({ ...rows[0], archived: true }, rows)?.field,
  'archived',
)
assert.equal(
  validateParty({ ...newPartyRow('g', 'group'), name: '室友' }, rows)?.field,
  'members',
)

// Deleting: not while expenses or a group keep them.
assert.match(deleteBlocked(rows[0], rows) ?? '', /封存/)
assert.match(deleteBlocked(rows[1], rows) ?? '', /分帳/)
assert.match(deleteBlocked(rows[2], rows) ?? '', /花蓮/)
assert.equal(deleteBlocked(rows[3], rows), null)

// What :w sends: changes only, a new friend and the group naming them.
const edited: Array<PartyRow> = [
  { ...rows[0], name: '花蓮三日', members: ['ming', 'hua', 'new'] },
  rows[1],
  rows[2],
  { ...rows[3], deleted: true },
  { ...newPartyRow('new', 'friend'), name: '阿華' },
]
assert.deepEqual(toBatch(edited, 'me'), {
  friends: [{ id: 'new', displayName: '阿華' }],
  groups: [
    {
      id: 'trip',
      name: '花蓮三日',
      members: ['ming', 'hua', 'new'],
      archived: false,
    },
  ],
  deleteFriends: ['joe'],
  deleteGroups: [],
})

console.log('splitting: ok')
