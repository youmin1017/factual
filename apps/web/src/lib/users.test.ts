// Run with: node --experimental-strip-types src/lib/users.test.ts
import assert from 'node:assert/strict'
import {
  accountLines,
  deleteBlocked,
  linkUrl,
  lockedReason,
  loginText,
  newJoinRow,
  newResetRow,
  noPasswords,
  ownLines,
  passwordProblem,
  profileChange,
  toBatch,
  unlinkProblem,
  userPatch,
  userRows,
  userStatus,
  usernameOf,
  validateUserRow,
  whenText,
} from './users.ts'
import type { OpenLink, UserSummary } from './users.ts'

const user = (
  id: string,
  username: string,
  extra: Partial<UserSummary> = {},
): UserSummary => ({
  id,
  username,
  displayName: username.toUpperCase(),
  role: 'member',
  active: true,
  hasPassword: true,
  identities: 0,
  lastLoginAt: null,
  createdAt: '2026-11-01T00:00:00Z',
  ...extra,
})

const link = (id: string, extra: Partial<OpenLink> = {}): OpenLink => ({
  id,
  purpose: 'join',
  userId: null,
  note: '',
  createdBy: 'ADMIN',
  createdAt: '2026-11-20T00:00:00Z',
  expiresAt: '2026-11-27T00:00:00Z',
  token: null,
  ...extra,
})

const users = [
  user('me', 'admin', { role: 'admin' }),
  user('ming', 'ming', { identities: 2 }),
]

// Users first, then the links, oldest first.
{
  const rows = userRows(users, [
    link('late', { createdAt: '2026-11-21T00:00:00Z' }),
    link('early', { purpose: 'reset', userId: 'ming' }),
  ])
  assert.deepEqual(
    rows.map((r) => r.id),
    ['me', 'ming', 'early', 'late'],
  )
  assert.equal(rows[2].kind, 'reset')
  assert.equal(usernameOf(rows[2], rows), 'ming')
  assert.ok(rows.every((r) => userStatus(r) === 'clean'))
  assert.equal(loginText(rows[1]), '密碼、第三方 2')
  assert.equal(whenText(rows[0]), '還沒登入過')
  assert.match(whenText(rows[3]), /前有效$/)
}

// The caller cannot change their own role or disable themselves.
{
  const [me, ming] = userRows(users, [])
  assert.ok(lockedReason(me, 'role', 'me'))
  assert.ok(lockedReason(me, 'active', 'me'))
  assert.equal(lockedReason(ming, 'role', 'me'), null)
  assert.ok(lockedReason(ming, 'detail', 'me'), 'names are the user’s own')
  // Only a new link's note is typed.
  assert.equal(lockedReason(newJoinRow('n'), 'detail', 'me'), null)
  assert.ok(lockedReason(userRows([], [link('x')])[0], 'detail', 'me'))
}

// Roles are picked by their names.
{
  const ming = userRows(users, [])[1]
  const admin = userPatch(ming, 'role', '管理員')
  assert.ok(typeof admin !== 'string')
  assert.equal(admin.role, 'admin')
  assert.equal(userStatus(admin), 'changed')
  assert.equal(typeof userPatch(ming, 'role', 'owner'), 'string')
}

// The batch: changed users, new links (dropped ones left out), revoked links.
{
  const rows = userRows(users, [link('old'), link('keep')])
  const edited = [
    rows[0],
    { ...rows[1], active: false },
    { ...rows[2], deleted: true },
    rows[3],
    newJoinRow('new', ' 阿華 '),
    newResetRow('reset', 'ming'),
    { ...newJoinRow('gone'), deleted: true },
  ]
  assert.deepEqual(toBatch(edited), {
    users: [{ id: 'ming', role: 'member', active: false }],
    links: [
      { id: 'new', purpose: 'join', userId: null, note: '阿華' },
      { id: 'reset', purpose: 'reset', userId: 'ming', note: '' },
    ],
    revoke: ['old'],
  })
  assert.equal(validateUserRow(edited[5], edited), null)
  assert.ok(validateUserRow(newResetRow('r', 'nobody'), edited))
}

// Users are not deleted; links lead to the join or reset page.
{
  const [me] = userRows(users, [])
  assert.ok(deleteBlocked(me))
  assert.equal(deleteBlocked(newJoinRow('n')), null)
  assert.equal(
    linkUrl('https://money.test', newJoinRow('n'), 'tok'),
    'https://money.test/join/tok',
  )
  assert.equal(
    linkUrl('https://money.test', newResetRow('r', 'ming'), 'tok'),
    'https://money.test/reset/tok',
  )
}

// The caller's own line is their profile: names typed, sent apart from the batch.
{
  const rows = userRows(users, [])
  assert.equal(lockedReason(rows[0], 'name', 'me'), null)
  assert.equal(lockedReason(rows[0], 'detail', 'me'), null)
  assert.ok(lockedReason(rows[1], 'name', 'me'))
  // Without the permission, nobody else's role or access.
  assert.ok(lockedReason(rows[1], 'role', 'me', false))
  assert.ok(lockedReason(rows[1], 'active', 'me', false))
  const renamed = userPatch(rows[0], 'name', ' boss ')
  assert.ok(typeof renamed !== 'string')
  assert.equal(renamed.username, 'boss')
  assert.equal(typeof userPatch(rows[0], 'name', 'two words'), 'string')
  assert.equal(typeof userPatch(rows[0], 'detail', ''), 'string')
  const edited = [renamed, rows[1]]
  assert.deepEqual(profileChange(edited, 'me'), {
    username: 'boss',
    displayName: 'ADMIN',
  })
  assert.equal(profileChange(rows, 'me'), null)
  assert.deepEqual(toBatch(edited).users, [], 'names do not go in the batch')
  assert.equal(userStatus(renamed), 'changed')
}

// Under the caller's line: the password group, then the accounts group.
{
  const identity = {
    id: 'i1',
    providerCode: 'old',
    providerName: 'Old',
    providerIcon: '',
    email: 'me@old.test',
    createdAt: '2026-11-01T00:00:00Z',
    lastLoginAt: null,
  }
  const accounts = accountLines(
    [{ code: 'google', name: 'Google', icon: 'google' }],
    [identity],
  )
  assert.deepEqual(
    accounts.map((a) => [a.code, a.disabled, a.identity?.id ?? null]),
    [
      ['google', false, null],
      ['old', true, 'i1'],
    ],
  )
  const closed = ownLines(new Set(), true, accounts)
  assert.deepEqual(
    closed.map((l) => l.kind),
    ['group', 'group'],
  )
  const open = ownLines(new Set(['password', 'accounts']), false, accounts)
  assert.deepEqual(
    open.map((l) =>
      l.kind === 'password'
        ? l.field
        : l.kind === 'account'
          ? l.account.code
          : l.group,
    ),
    ['password', 'next', 'again', 'accounts', 'google', 'old'],
    'no current password to ask for when there is none',
  )

  // Unlinking the only way in is refused, unless a password is being set.
  assert.ok(unlinkProblem(accounts, new Set(['i1']), false, false))
  assert.equal(unlinkProblem(accounts, new Set(['i1']), false, true), null)
  assert.equal(unlinkProblem(accounts, new Set(['i1']), true, false), null)
}

// Passwords: none typed is fine; otherwise checked before anything is sent.
{
  assert.equal(passwordProblem(noPasswords, true), null)
  const p = { current: '', next: 'longenough', again: 'longenough' }
  assert.equal(passwordProblem(p, true)?.field, 'current')
  assert.equal(passwordProblem(p, false), null)
  assert.equal(
    passwordProblem({ ...p, next: 'short', again: 'short' }, false)?.field,
    'next',
  )
  assert.equal(
    passwordProblem({ ...p, again: 'different' }, false)?.field,
    'again',
  )
}

console.log('users: ok')
