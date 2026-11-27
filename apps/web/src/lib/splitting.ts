import { formatAmount } from './money.ts'
import type { Schemas } from './api'
import type { Friend, Group } from './split.ts'

// The 分帳 page (ADR-116): the user's groups and friends as one grid, saved
// with :w through POST /splitting/batch. Groups come first, then friends,
// each by name; a group's members are picked as chips, typing to find a
// friend or to add a new one (ADR-120), from the friend
// lines (new ones included). Pure, tested with node.

export type SplittingBatch = Schemas['SplittingBatch']

export type PartyKind = 'group' | 'friend'

export type PartyColumn =
  | 'name'
  | 'kind'
  | 'members'
  | 'count'
  | 'balance'
  | 'archived'

export const partyColumns: Array<PartyColumn> = [
  'name',
  'kind',
  'members',
  'count',
  'balance',
  'archived',
]

export const partyLabels: Record<PartyColumn, string> = {
  name: '名稱',
  kind: '類型',
  members: '成員',
  count: '筆數',
  balance: '往來',
  archived: '封存',
}

export const kindLabels: Record<PartyKind, string> = {
  group: '群組',
  friend: '朋友',
}

export interface PartyRow {
  /** The friend's user id or the group's id; chosen here for new lines. */
  id: string
  kind: PartyKind
  /** The saved friend or group; null for a line never saved. */
  base: Friend | Group | null
  deleted: boolean
  name: string
  /** A group's members besides the caller, by friend id. */
  members: Array<string>
  archived: boolean
}

export type PartyStatus = 'clean' | 'new' | 'changed' | 'deleted'

export interface PartyProblem {
  field: PartyColumn | null
  message: string
}

export function rowFromFriend(f: Friend): PartyRow {
  return {
    id: f.id,
    kind: 'friend',
    base: f,
    deleted: false,
    name: f.displayName,
    members: [],
    archived: false,
  }
}

export function rowFromGroup(g: Group, me: string): PartyRow {
  return {
    id: g.id,
    kind: 'group',
    base: g,
    deleted: false,
    name: g.name,
    members: g.members.filter((m) => m.userId !== me).map((m) => m.userId),
    archived: g.archived,
  }
}

/** The page's lines: groups (active first), then friends. */
export function partyRows(
  groups: Array<Group>,
  friends: Array<Friend>,
  me: string,
): Array<PartyRow> {
  return [
    ...groups.map((g) => rowFromGroup(g, me)),
    ...friends.map(rowFromFriend),
  ]
}

export function newPartyRow(id: string, kind: PartyKind): PartyRow {
  return {
    id,
    kind,
    base: null,
    deleted: false,
    name: '',
    members: [],
    archived: false,
  }
}

/** Where a new line of a kind goes: after the last line of that kind. */
export function insertIndex(
  rows: Array<PartyRow>,
  kind: PartyKind,
  at: number,
): number {
  const first = rows.findIndex((r) => r.kind === kind)
  const last = rows.findLastIndex((r) => r.kind === kind)
  if (first < 0) return kind === 'group' ? 0 : rows.length
  return Math.max(first, Math.min(at, last + 1))
}

/** Moves a line to the end of its kind's lines (after its kind changed). */
export function placeByKind(
  rows: Array<PartyRow>,
  id: string,
): Array<PartyRow> {
  const row = rows.find((r) => r.id === id)
  if (!row) return rows
  const rest = rows.filter((r) => r.id !== id)
  return rest.toSpliced(insertIndex(rest, row.kind, rest.length), 0, row)
}

function friendOf(row: PartyRow): Friend | null {
  return row.base && row.kind === 'friend' ? (row.base as Friend) : null
}

function groupOf(row: PartyRow): Group | null {
  return row.base && row.kind === 'group' ? (row.base as Group) : null
}

/** A saved friend with an account of their own (not renamed here). */
export function registered(row: PartyRow): boolean {
  return friendOf(row)?.placeholder === false
}

export function expenseCount(row: PartyRow): number {
  return (friendOf(row) ?? groupOf(row))?.expenseCount ?? 0
}

export function balanceOf(row: PartyRow): number {
  return (friendOf(row) ?? groupOf(row))?.balance ?? 0
}

function inputOf(row: PartyRow): string {
  return JSON.stringify(
    row.kind === 'friend'
      ? { name: row.name.trim() }
      : {
          name: row.name.trim(),
          members: row.members.toSorted(),
          archived: row.archived,
        },
  )
}

export function partyStatus(row: PartyRow, me: string): PartyStatus {
  if (row.deleted) return 'deleted'
  if (!row.base) return 'new'
  const saved =
    row.kind === 'friend'
      ? rowFromFriend(row.base as Friend)
      : rowFromGroup(row.base as Group, me)
  return inputOf(row) === inputOf(saved) ? 'clean' : 'changed'
}

/** What :w sends: the lines that changed, deleted ones by id. */
export function toBatch(rows: Array<PartyRow>, me: string): SplittingBatch {
  const changed = rows.filter((r) => {
    const s = partyStatus(r, me)
    return s === 'new' || s === 'changed'
  })
  return {
    friends: changed
      .filter((r) => r.kind === 'friend')
      .map((r) => ({ id: r.id, displayName: r.name.trim() })),
    groups: changed
      .filter((r) => r.kind === 'group')
      .map((r) => ({
        id: r.id,
        name: r.name.trim(),
        members: r.members,
        archived: r.archived,
      })),
    deleteFriends: rows
      .filter((r) => r.deleted && r.base && r.kind === 'friend')
      .map((r) => r.id),
    deleteGroups: rows
      .filter((r) => r.deleted && r.base && r.kind === 'group')
      .map((r) => r.id),
  }
}

/** The friend lines a group can have as members (not deleted, without an account of their own unless already in it). */
export function memberChoices(
  rows: Array<PartyRow>,
  group: PartyRow,
): Array<PartyRow> {
  return rows.filter(
    (r) =>
      r.kind === 'friend' &&
      !r.deleted &&
      (!registered(r) || group.members.includes(r.id)),
  )
}

export function validateParty(
  row: PartyRow,
  rows: Array<PartyRow>,
): PartyProblem | null {
  if (row.deleted) return null
  const name = row.name.trim()
  if (!name) return { field: 'name', message: '請輸入名稱' }
  if ([...name].length > 64)
    return { field: 'name', message: '名稱最多 64 個字' }
  // Every friend and group has an account in the budget, and account
  // names are unique there.
  if (rows.some((r) => r.id !== row.id && !r.deleted && r.name.trim() === name))
    return { field: 'name', message: `已經有叫「${name}」的朋友或群組` }
  if (row.kind === 'group') {
    if (row.members.length === 0)
      return { field: 'members', message: '群組至少要有一位朋友' }
    const friends = new Map(rows.map((r) => [r.id, r]))
    for (const id of row.members) {
      const f = friends.get(id)
      if (!f || f.deleted)
        return { field: 'members', message: '有成員已經不在朋友名單' }
    }
    // A member who paid or shared stays (the server also refuses one any
    // expense names, member_in_use).
    for (const m of groupOf(row)?.members ?? []) {
      if (m.role === 'admin' || row.members.includes(m.userId)) continue
      if (m.paid !== 0 || m.share !== 0)
        return {
          field: 'members',
          message: `${m.displayName} 還有群組裡的分帳，不能移除`,
        }
    }
    if (row.archived && !groupOf(row)?.archived) {
      const unsettled = groupOf(row)?.members.some((m) => m.balance !== 0)
      if (unsettled)
        return { field: 'archived', message: '群組還沒結清，結清後才能封存' }
    }
  }
  return null
}

/** Why a line cannot be deleted, or null. */
export function deleteBlocked(
  row: PartyRow,
  rows: Array<PartyRow>,
): string | null {
  if (!row.base) return null
  if (expenseCount(row) > 0)
    return row.kind === 'friend'
      ? `還有和 ${row.name} 的分帳，刪掉那些分帳後才能刪除`
      : '群組還有分帳，不能刪除；可以改成封存（x）'
  if (row.kind === 'friend') {
    const inGroup = rows.find(
      (r) => r.kind === 'group' && !r.deleted && r.members.includes(row.id),
    )
    if (inGroup) return `${row.name} 還在「${inGroup.name}」裡，先從群組移除`
  }
  return null
}

/** Why a cell cannot be edited, or null. */
export function lockedReason(
  row: PartyRow,
  column: PartyColumn,
): string | null {
  if (row.deleted) return '這一列已標記刪除，按 u 復原或 dd 取消'
  switch (column) {
    case 'name':
      return registered(row) ? '朋友已經有自己的帳號，名字由他自己改' : null
    case 'kind':
      return row.base ? '建立後不能改成朋友或群組' : null
    case 'members':
    case 'archived':
      return row.kind === 'friend' ? '朋友沒有成員和封存，這是群組的設定' : null
    case 'count':
      return '筆數是分帳的數目，到朋友或群組的頁面（gx）新增'
    case 'balance':
      return '往來是分帳算出來的'
  }
}

/** A balance in words: 小明欠我 300、群組欠我 300、我欠… 、已結清. */
export function partyBalanceText(row: PartyRow, minorUnits: number): string {
  const balance = balanceOf(row)
  const money = formatAmount(Math.abs(balance), minorUnits)
  const who = row.kind === 'group' ? '群組' : row.name
  if (balance > 0) return `${who} 欠我 ${money}`
  if (balance < 0) return `我欠 ${who} ${money}`
  return '已結清'
}

/** The members as the cell says them. */
export function membersText(row: PartyRow, rows: Array<PartyRow>): string {
  if (row.kind !== 'group') return ''
  const names = new Map(rows.map((r) => [r.id, r.name]))
  const saved = new Map(
    groupOf(row)?.members.map((m) => [m.userId, m.displayName]) ?? [],
  )
  return row.members
    .map((id) => names.get(id) || saved.get(id) || '?')
    .join('、')
}

export function partyCellText(
  row: PartyRow,
  column: PartyColumn,
  rows: Array<PartyRow>,
): string {
  switch (column) {
    case 'name':
      return row.name
    case 'kind':
      return kindLabels[row.kind]
    case 'members':
      return membersText(row, rows)
    default:
      return ''
  }
}

/** What a typed cell changes, or why it cannot. */
export function partyPatch(
  column: PartyColumn,
  text: string,
): Partial<PartyRow> | string {
  const value = text.trim()
  switch (column) {
    case 'name':
      if (!value) return '請輸入名稱'
      if ([...value].length > 64) return '名稱最多 64 個字'
      return { name: value }
    case 'kind': {
      const kind = (Object.keys(kindLabels) as Array<PartyKind>).find(
        (k) => kindLabels[k] === value,
      )
      if (!kind) return '請從清單選：朋友或群組'
      return { kind }
    }
    default:
      return '這一欄不能直接輸入'
  }
}

// ---------- the members picker (ADR-120)

/** A friend added from the picker by name, saved with the group as a new friend line. */
export interface AddedFriend {
  id: string
  name: string
}

/** What the picker holds while it is open: the members, in order, and friends it added. */
export interface MemberPick {
  members: Array<string>
  added: Array<AddedFriend>
}

/** The value of the option that adds a new friend by the name typed. */
export const NEW_FRIEND = 'new:'

export interface MemberOption {
  /** A friend's id, or NEW_FRIEND and the name. */
  value: string
  label: string
  hint?: string
}

/** How a member is called: their line's name, or the saved member's. */
export function memberName(
  rows: Array<PartyRow>,
  group: PartyRow,
  id: string,
  added: Array<AddedFriend> = [],
): string {
  return (
    added.find((a) => a.id === id)?.name ||
    rows.find((r) => r.id === id)?.name ||
    groupOf(group)?.members.find((m) => m.userId === id)?.displayName ||
    '?'
  )
}

/**
 * The friends the picker offers for what is typed: friends not in the group
 * yet whose name has it (those starting with it first, then by name), and
 * a new friend of that name when no friend has exactly it.
 */
export function memberOptions(
  rows: Array<PartyRow>,
  group: PartyRow,
  pick: MemberPick,
  query: string,
): Array<MemberOption> {
  const q = query.trim().toLowerCase()
  const candidates = memberChoices(rows, { ...group, members: pick.members })
    .filter((f) => !pick.members.includes(f.id))
    .filter((f) => !q || f.name.toLowerCase().includes(q))
    .toSorted(
      (x, y) =>
        Number(!x.name.toLowerCase().startsWith(q)) -
          Number(!y.name.toLowerCase().startsWith(q)) ||
        x.name.localeCompare(y.name, 'zh-Hant'),
    )
  const options: Array<MemberOption> = candidates.map((f) => ({
    value: f.id,
    label: f.name || '（未命名）',
    hint: f.base ? undefined : '未儲存',
  }))
  const typed = query.trim()
  const taken = [
    ...rows.filter((r) => !r.deleted).map((r) => r.name.trim()),
    ...pick.added.map((x) => x.name),
  ]
  if (typed && !taken.includes(typed))
    options.push({
      value: NEW_FRIEND + typed,
      label: `新增朋友「${typed}」`,
      hint: '還沒有帳號也可以',
    })
  return options
}

/** The pick with an option taken: a friend joins, or a new one is added and joins. */
export function takeMember(
  pick: MemberPick,
  option: MemberOption,
  newId: () => string,
): MemberPick {
  if (option.value.startsWith(NEW_FRIEND)) {
    const added = { id: newId(), name: option.value.slice(NEW_FRIEND.length) }
    return {
      members: [...pick.members, added.id],
      added: [...pick.added, added],
    }
  }
  if (pick.members.includes(option.value)) return pick
  return { ...pick, members: [...pick.members, option.value] }
}

/** Why a member cannot leave the group: they paid or shared in it. */
export function memberLocked(
  group: PartyRow,
  id: string,
  rows: Array<PartyRow>,
): string | null {
  const m = groupOf(group)?.members.find((x) => x.userId === id)
  if (!m || (m.paid === 0 && m.share === 0)) return null
  return `${memberName(rows, group, id)} 有群組裡的分帳，不能移除`
}

/** The pick without a member, or why they stay. */
export function dropMember(
  pick: MemberPick,
  group: PartyRow,
  id: string,
  rows: Array<PartyRow>,
): MemberPick | string {
  const locked = memberLocked(group, id, rows)
  if (locked) return locked
  return {
    members: pick.members.filter((m) => m !== id),
    added: pick.added.filter((a) => a.id !== id),
  }
}

/**
 * The lines with the pick applied: the group's members set, and the friends
 * it added (and kept) as new friend lines after the others; or why not.
 */
export function applyMemberPick(
  rows: Array<PartyRow>,
  groupId: string,
  pick: MemberPick,
): Array<PartyRow> | string {
  if (pick.members.length === 0) return '群組至少要有一位朋友'
  let next = rows.map((r) =>
    r.id === groupId ? { ...r, members: pick.members } : r,
  )
  for (const a of pick.added) {
    if (!pick.members.includes(a.id)) continue
    const row = { ...newPartyRow(a.id, 'friend'), name: a.name }
    next = next.toSpliced(insertIndex(next, 'friend', next.length), 0, row)
  }
  return next
}

// ---------- problems from the server

export function partyProblemColumn(field: string): PartyColumn | null {
  return (partyColumns as Array<string>).includes(field)
    ? (field as PartyColumn)
    : null
}

export const partyProblemMessages: Record<string, string> = {
  invalid_name: '名稱是 1 到 64 個字',
  not_placeholder: '朋友已經有自己的帳號，名字由他自己改',
  not_found: '找不到，可能已在別處刪除',
  forbidden: '只有群組的管理者能修改',
  duplicate_member: '成員重複了',
  not_friend: '成員要是你的朋友',
  registered_member: '有帳號的朋友之後才能加入群組',
  member_in_use: '有成員還有群組裡的分帳，不能移除',
  group_not_settled: '群組還沒結清，結清後才能封存',
  group_in_use: '群組還有分帳，不能刪除；可以改成封存',
  friend_in_use: '還有和這位朋友的分帳，刪掉那些分帳後才能刪除',
  friend_in_group: '這位朋友還在群組裡，先從群組移除',
  duplicate_id: '這一列重複出現',
}
