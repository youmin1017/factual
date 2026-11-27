import type { Schemas } from './api'

// The users page (ADR-131, ADR-132, ADR-136): the instance's users and its
// open one-time links as one grid, as the 分帳 page has groups and friends
// (ADR-116), saved with :w. Everyone has it: who may manage users sees them
// all and the links, anyone else only their own line. A user's role is
// picked from the list and `x` disables or enables them; `o` adds a join
// link and `:reset` a link that sets a user's password; `dd` revokes a link.
// The caller's own line is their profile: its username and display name
// are typed, and under it fold their password and their sign-in accounts.
// A link can be copied (`yy`, or its button) while it can be used: the
// server keeps its token sealed (ADR-135); it never goes into a draft. Pure,
// tested with node.

export type UserSummary = Schemas['UserSummary']
export type OpenLink = Schemas['OpenLink']
export type UsersBatch = Schemas['UsersBatch']
export type InstanceRole = Schemas['InstanceRole']

export type UserRowKind = 'user' | 'join' | 'reset'

export type UserColumn =
  | 'name'
  | 'detail'
  | 'role'
  | 'login'
  | 'when'
  | 'active'

export const userColumns: Array<UserColumn> = [
  'name',
  'detail',
  'role',
  'login',
  'when',
  'active',
]

export const userLabels: Record<UserColumn, string> = {
  name: '帳號',
  detail: '名稱／備註',
  role: '角色',
  login: '登入方式',
  when: '上次登入／期限',
  active: '啟用',
}

export const roleLabels: Record<InstanceRole, string> = {
  admin: '管理員',
  member: '一般使用者',
}

export interface UserRow {
  /** The user's id, or the link's (chosen here for a new one). */
  id: string
  kind: UserRowKind
  /** The saved user or link; null for a link not saved yet. */
  base: UserSummary | OpenLink | null
  /** A saved link marked to be revoked, or a new one to drop. */
  deleted: boolean
  role: InstanceRole
  active: boolean
  /** A user's username and display name (only the caller's own are edited). */
  username: string
  displayName: string
  /** A link's note: who it is for. */
  note: string
  /** The user a reset link is for. */
  userId: string | null
}

export type UserRowStatus = 'clean' | 'new' | 'changed' | 'deleted'

export interface UserProblem {
  field: UserColumn | null
  message: string
}

function userOf(row: UserRow): UserSummary | null {
  return row.kind === 'user' && row.base ? (row.base as UserSummary) : null
}

function linkOf(row: UserRow): OpenLink | null {
  return row.kind !== 'user' && row.base ? (row.base as OpenLink) : null
}

export function rowFromUser(u: UserSummary): UserRow {
  return {
    id: u.id,
    kind: 'user',
    base: u,
    deleted: false,
    role: u.role,
    active: u.active,
    username: u.username,
    displayName: u.displayName,
    note: '',
    userId: null,
  }
}

export function rowFromLink(l: OpenLink): UserRow {
  return {
    id: l.id,
    kind: l.purpose,
    base: l,
    deleted: false,
    role: 'member',
    active: true,
    username: '',
    displayName: '',
    note: l.note,
    userId: l.userId,
  }
}

/** The page's lines: the users, then the links, oldest first. */
export function userRows(
  users: Array<UserSummary>,
  links: Array<OpenLink>,
): Array<UserRow> {
  return [
    ...users.map(rowFromUser),
    ...links
      .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(rowFromLink),
  ]
}

export function newJoinRow(id: string, note = ''): UserRow {
  return {
    id,
    kind: 'join',
    base: null,
    deleted: false,
    role: 'member',
    active: true,
    username: '',
    displayName: '',
    note,
    userId: null,
  }
}

export function newResetRow(id: string, userId: string): UserRow {
  return { ...newJoinRow(id), kind: 'reset', userId }
}

export function userStatus(row: UserRow): UserRowStatus {
  if (row.deleted) return 'deleted'
  if (!row.base) return 'new'
  const u = userOf(row)
  if (
    u &&
    (u.role !== row.role ||
      u.active !== row.active ||
      u.username !== row.username ||
      u.displayName !== row.displayName)
  )
    return 'changed'
  return 'clean'
}

/** The caller's new username and display name, or null when unchanged. */
export function profileChange(
  rows: Array<UserRow>,
  me: string,
): { username: string; displayName: string } | null {
  const row = rows.find((r) => r.kind === 'user' && r.id === me)
  const u = row ? userOf(row) : null
  if (!row || !u) return null
  if (u.username === row.username && u.displayName === row.displayName)
    return null
  return { username: row.username, displayName: row.displayName }
}

/** What :w sends to POST /users/batch. */
export function toBatch(rows: Array<UserRow>): UsersBatch {
  return {
    users: rows
      .filter((r) => {
        const u = userOf(r)
        return u !== null && (u.role !== r.role || u.active !== r.active)
      })
      .map((r) => ({ id: r.id, role: r.role, active: r.active })),
    links: rows
      .filter((r) => r.kind !== 'user' && !r.base && !r.deleted)
      .map((r) => ({
        id: r.id,
        purpose: r.kind as 'join' | 'reset',
        userId: r.kind === 'reset' ? r.userId : null,
        note: r.note.trim(),
      })),
    revoke: rows
      .filter((r) => r.kind !== 'user' && r.base && r.deleted)
      .map((r) => r.id),
  }
}

/** The user a line is about: the user's own line, or the one a reset link is for. */
export function usernameOf(row: UserRow, rows: Array<UserRow>): string {
  const id = row.kind === 'user' ? row.id : row.userId
  const u = rows.find((r) => r.kind === 'user' && r.id === id)
  return u ? (userOf(u)?.username ?? '') : ''
}

/**
 * Why a cell cannot be edited, or null; `me` is the caller's id, `manage`
 * whether they may manage users.
 */
export function lockedReason(
  row: UserRow,
  column: UserColumn,
  me: string,
  manage = true,
): string | null {
  if (row.deleted) return '這一列已標記作廢，按 u 復原或 dd 取消'
  if (row.kind === 'user') {
    switch (column) {
      case 'role':
        if (row.id === me) return '不能改自己的角色'
        return manage ? null : '只有管理員能改角色'
      case 'active':
        if (row.id === me) return '不能停用自己'
        return manage ? null : '只有管理員能停用使用者'
      case 'name':
      case 'detail':
        return row.id === me ? null : '帳號和名稱只有本人能改'
      default:
        return '這一欄是記錄，不能改'
    }
  }
  if (column === 'detail')
    return row.base ? '連結建立後不能改備註；作廢再建一個' : null
  return row.kind === 'join' ? '邀請連結只能填備註' : '重設連結沒有可以改的地方'
}

export function userCellText(row: UserRow, column: UserColumn): string {
  switch (column) {
    case 'name':
      return row.kind === 'user' ? row.username : ''
    case 'detail':
      return row.kind === 'user' ? row.displayName : row.note
    case 'role':
      return row.kind === 'user' ? roleLabels[row.role] : ''
    default:
      return ''
  }
}

/** What a typed cell changes, or why it cannot. */
export function userPatch(
  row: UserRow,
  column: UserColumn,
  text: string,
): UserRow | string {
  const value = text.trim()
  switch (column) {
    case 'role': {
      const role = (Object.keys(roleLabels) as Array<InstanceRole>).find(
        (r) => roleLabels[r] === value || r === value,
      )
      if (!role) return '請從清單選：管理員或一般使用者'
      return { ...row, role }
    }
    case 'name':
      if (!value || [...value].length > 64 || /\s/.test(value))
        return '帳號是 1 到 64 個字，不能有空白'
      return { ...row, username: value }
    case 'detail':
      if (row.kind === 'user') {
        if (!value || [...value].length > 64) return '名稱是 1 到 64 個字'
        return { ...row, displayName: value }
      }
      if ([...value].length > 255) return '備註最多 255 個字'
      return { ...row, note: value }
    default:
      return '這一欄不能直接輸入'
  }
}

/** Why a line cannot be saved, or null. */
export function validateUserRow(
  row: UserRow,
  rows: Array<UserRow>,
): UserProblem | null {
  if (row.deleted || row.kind !== 'reset' || row.base) return null
  const user = rows.find((r) => r.kind === 'user' && r.id === row.userId)
  if (!user) return { field: null, message: '找不到要重設密碼的使用者' }
  return null
}

/** Why `dd` cannot take a line away, or null. */
export function deleteBlocked(row: UserRow): string | null {
  return row.kind === 'user'
    ? '使用者不能刪除；要讓他不能登入就按 x 停用'
    : null
}

/** Where a link leads: /join/<token> or /reset/<token> on this site. */
export function linkUrl(origin: string, row: UserRow, token: string): string {
  return `${origin}/${row.kind === 'reset' ? 'reset' : 'join'}/${token}`
}

/** A line's 期限 or last login, as the cell says it. */
export function whenText(row: UserRow): string {
  const user = userOf(row)
  if (user) return user.lastLoginAt ? dateText(user.lastLoginAt) : '還沒登入過'
  const link = linkOf(row)
  return link ? `${dateText(link.expiresAt)} 前有效` : ':w 儲存後產生'
}

/** How a user logs in, or what a link is. */
export function loginText(row: UserRow): string {
  const user = userOf(row)
  if (row.kind === 'join') return '邀請連結'
  if (row.kind === 'reset') return '重設密碼連結'
  if (!user) return ''
  const ways = [
    ...(user.hasPassword ? ['密碼'] : []),
    ...(user.identities > 0 ? [`第三方 ${user.identities}`] : []),
  ]
  return ways.join('、') || '—'
}

function dateText(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

// ---------- the caller's own line: password and sign-in accounts

export type LinkedIdentity = Schemas['LinkedIdentity']
export type LoginProvider = Schemas['LoginProvider']

export type PasswordField = 'current' | 'next' | 'again'

export interface Passwords {
  current: string
  next: string
  again: string
}

export const noPasswords: Passwords = { current: '', next: '', again: '' }

export const passwordLabels: Record<PasswordField, string> = {
  current: '目前的密碼',
  next: '新密碼',
  again: '再輸入一次',
}

export type OwnGroup = 'password' | 'accounts'

/** A sign-in account line: an enabled provider, and the identity linked there if any. */
export interface AccountLine {
  code: string
  name: string
  icon: string
  /** Not offered any more (disabled), but still linked. */
  disabled: boolean
  identity: LinkedIdentity | null
}

/** A line under the caller's own line. */
export type OwnLine =
  | { kind: 'group'; group: OwnGroup }
  | { kind: 'password'; field: PasswordField }
  | { kind: 'account'; account: AccountLine }

/** Every provider offered, then the identities whose provider is not. */
export function accountLines(
  providers: Array<LoginProvider>,
  identities: Array<LinkedIdentity>,
): Array<AccountLine> {
  return [
    ...providers.map((p) => ({
      code: p.code,
      name: p.name,
      icon: p.icon,
      disabled: false,
      identity: identities.find((i) => i.providerCode === p.code) ?? null,
    })),
    ...identities
      .filter((i) => !providers.some((p) => p.code === i.providerCode))
      .map((i) => ({
        code: i.providerCode,
        name: i.providerName,
        icon: i.providerIcon,
        disabled: true,
        identity: i,
      })),
  ]
}

/** The lines under the caller's own line, with the groups open as they are. */
export function ownLines(
  open: ReadonlySet<OwnGroup>,
  hasPassword: boolean,
  accounts: Array<AccountLine>,
): Array<OwnLine> {
  const out: Array<OwnLine> = [{ kind: 'group', group: 'password' }]
  if (open.has('password'))
    for (const field of ['current', 'next', 'again'] as const)
      if (field !== 'current' || hasPassword)
        out.push({ kind: 'password', field })
  out.push({ kind: 'group', group: 'accounts' })
  if (open.has('accounts'))
    for (const account of accounts) out.push({ kind: 'account', account })
  return out
}

/** Why the passwords typed cannot be sent, and which field; null when fine or none typed. */
export function passwordProblem(
  p: Passwords,
  hasPassword: boolean,
): { field: PasswordField; message: string } | null {
  if (!p.current && !p.next && !p.again) return null
  if (hasPassword && !p.current)
    return { field: 'current', message: '請輸入目前的密碼' }
  if (p.next.length < 8)
    return { field: 'next', message: '新密碼至少 8 個字元' }
  if (p.next.length > 256) return { field: 'next', message: '新密碼太長了' }
  if (p.next !== p.again)
    return { field: 'again', message: '兩次輸入的新密碼不一樣' }
  return null
}

/**
 * Why the accounts marked cannot be unlinked: the caller would have no way
 * left to log in (with no password, and none being set).
 */
export function unlinkProblem(
  accounts: Array<AccountLine>,
  unlink: ReadonlySet<string>,
  hasPassword: boolean,
  settingPassword: boolean,
): string | null {
  if (unlink.size === 0 || hasPassword || settingPassword) return null
  const left = accounts.filter(
    (a) => a.identity && !a.disabled && !unlink.has(a.identity.id),
  )
  return left.length === 0
    ? '這是你唯一的登入方式：先設定密碼，或留下一個第三方帳號'
    : null
}

// ---------- problems from the server

export function userProblemColumn(field: string): UserColumn | null {
  if (field === 'note') return 'detail'
  return (userColumns as Array<string>).includes(field)
    ? (field as UserColumn)
    : null
}

export const userProblemMessages: Record<string, string> = {
  not_found: '找不到，可能已在別處刪除',
  duplicate_id: '這一列重複出現',
}
