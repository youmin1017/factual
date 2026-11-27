import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  LinkIcon,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '#/lib/api'
import { errorCodeMessage } from '#/lib/apiError'
import { oidcLinkUrl } from '#/lib/auth'
import { setEditorStatus } from '#/lib/editorStatus'
import { movePane, windowDirection } from '#/lib/panes'
import { rankCell } from '#/lib/register'
import {
  deleteBlocked,
  linkUrl,
  lockedReason,
  loginText,
  newJoinRow,
  newResetRow,
  noPasswords,
  ownLines,
  passwordLabels,
  passwordProblem,
  profileChange,
  roleLabels,
  toBatch,
  unlinkProblem,
  userCellText,
  userColumns,
  userLabels,
  userPatch,
  userProblemColumn,
  userProblemMessages,
  userRows,
  userStatus,
  usernameOf,
  validateUserRow,
  whenText,
} from '#/lib/users'
import { cn } from '#/lib/utils'
import { BrandIcon } from '../brand-icon'
import { CellEditor, eraseBeforeCaret, nextPick } from '../register/cell-editor'
import { KeyHelp, userKeys } from '../register/key-help'
import { useKeyFeed } from '../register/use-key-feed'
import type { Key, Keymap } from '#/lib/keymap'
import type {
  AccountLine,
  InstanceRole,
  OpenLink,
  OwnGroup,
  OwnLine,
  Passwords,
  UserColumn,
  UserProblem,
  UserRow,
  UserRowStatus,
  UserSummary,
} from '#/lib/users'
import type { Suggestion } from '../register/cell-editor'

// The users page (ADR-131, ADR-132, ADR-136): users and open links as one
// grid, edited as the 分帳 page is (ADR-116) and saved with :w. The caller's
// own line is their profile, with their password and sign-in accounts in
// groups folded under it. Drafts are kept locally (ADR-043), never passwords.

const ROW_HEIGHT = 32
const GUTTER = 28
const widths: Record<UserColumn, number> = {
  name: 160,
  detail: 180,
  role: 110,
  login: 190,
  when: 150,
  active: 56,
}
const stretch: Partial<Record<UserColumn, number>> = { detail: 1 }
/** Where an own line's label and value sit. */
const OWN_INDENT = GUTTER + 20
const OWN_LABEL = 120

interface Layout {
  lefts: Record<UserColumn, number>
  widths: Record<UserColumn, number>
  template: string
  width: number
}

function layoutOf(room: number): Layout {
  const least = userColumns.reduce((sum, c) => sum + widths[c], GUTTER)
  const extra = Math.max(0, room - least)
  const lefts = {} as Record<UserColumn, number>
  const sized = {} as Record<UserColumn, number>
  let x = GUTTER
  for (const c of userColumns) {
    sized[c] = widths[c] + Math.floor(extra * (stretch[c] ?? 0))
    lefts[c] = x
    x += sized[c]
  }
  return {
    lefts,
    widths: sized,
    template: `${GUTTER}px ${userColumns.map((c) => `${sized[c]}px`).join(' ')}`,
    width: x,
  }
}

type Mode = 'normal' | 'visual' | 'insert' | 'command'

export interface Message {
  text: string
  tone: 'info' | 'error'
}

interface Range {
  from: number
  to: number
}

const DRAFT_KEY = 'factual:users'
const DRAFT_VERSION = 2

interface Draft {
  version: number
  rows: Array<UserRow>
}

function readDraft(): Draft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<Draft>
    return parsed.version === DRAFT_VERSION && Array.isArray(parsed.rows)
      ? (parsed as Draft)
      : null
  } catch {
    return null
  }
}

function writeDraft(rows: Array<UserRow> | null): void {
  try {
    if (!rows) localStorage.removeItem(DRAFT_KEY)
    else
      localStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({ version: DRAFT_VERSION, rows } satisfies Draft),
      )
  } catch {
    // Drafts are a convenience (ADR-043).
  }
}

/** The saved lines with a draft's changes on top (lines gone since are dropped). */
function initialRows(
  saved: Array<UserRow>,
  draft: Draft | null,
): Array<UserRow> {
  if (!draft) return saved
  const fresh = new Map(saved.map((r) => [r.id, r]))
  const out: Array<UserRow> = []
  for (const d of draft.rows) {
    if (!d.base) out.push(d)
    else {
      const now = fresh.get(d.id)
      if (!now) continue
      out.push({ ...d, base: now.base })
      fresh.delete(d.id)
    }
  }
  const users = [...fresh.values()].filter((r) => r.kind === 'user')
  const links = [...fresh.values()].filter((r) => r.kind !== 'user')
  const firstLink = out.findIndex((r) => r.kind !== 'user')
  const at = firstLink < 0 ? out.length : firstLink
  return [...out.slice(0, at), ...users, ...out.slice(at), ...links]
}

/** What the page shows, as loaded. */
export interface UsersData {
  users: Array<UserSummary>
  links: Array<OpenLink>
  /** The caller's sign-in accounts: every provider, and identities. */
  accounts: Array<AccountLine>
  /** Whether the caller has a password. */
  hasPassword: boolean
}

interface Props {
  me: string
  /** Whether the caller may manage users (otherwise they see only themselves). */
  manage: boolean
  data: UsersData
  keymap: Keymap
  /** Said first, e.g. that an account was linked. */
  notice: Message | null
  /** Fetches everything again (after :w). */
  reload: () => Promise<UsersData>
}

export function UserGrid({ me, manage, data, keymap, notice, reload }: Props) {
  const [room, setRoom] = useState(0)
  const layout = layoutOf(room)
  const columns = userColumns
  const [loaded, setLoaded] = useState(data)
  const [rows, setRows] = useState<Array<UserRow>>(() =>
    initialRows(userRows(data.users, data.links), readDraft()),
  )
  const [cursor, setCursor] = useState(() => ({
    row: Math.max(
      0,
      rows.findIndex((r) => r.id === me),
    ),
    col: 0,
  }))
  /** The cursor on a line under the caller's own line (its index), or null. */
  const [sub, setSub] = useState<number | null>(null)
  /** Whether insert mode edits a password line. */
  const [subEdit, setSubEdit] = useState(false)
  const [open, setOpen] = useState<ReadonlySet<OwnGroup>>(new Set())
  const [passwords, setPasswords] = useState<Passwords>(noPasswords)
  /** Identities marked to be unlinked at :w. */
  const [unlink, setUnlink] = useState<ReadonlySet<string>>(new Set())
  const [mode, setMode] = useState<Mode>('normal')
  const [edit, setEdit] = useState('')
  const [pick, setPick] = useState(0)
  const [navigated, setNavigated] = useState(false)
  const [command, setCommand] = useState('')
  const [message, setMessage] = useState<Message | null>(
    () =>
      notice ??
      (readDraft() ? { text: '已還原上次未儲存的變更', tone: 'info' } : null),
  )
  const [problems, setProblems] = useState<Map<string, UserProblem>>(new Map())
  const [saving, setSaving] = useState(false)
  const [anchor, setAnchor] = useState(0)
  const [help, setHelp] = useState(false)
  /** Tokens of links made on this page, for a server without an encryption key. */
  const [tokens, setTokens] = useState<ReadonlyMap<string, string>>(new Map())

  const gridRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLElement>(null)
  const history = useRef<{
    undo: Array<Array<UserRow>>
    redo: Array<Array<UserRow>>
  }>({ undo: [], redo: [] })
  const pending = useRef({ count: '', op: '' })
  const opened = useRef<{ id: string; from: typeof cursor } | null>(null)

  const states: Array<UserRowStatus> = rows.map(userStatus)
  const typed = passwords.current || passwords.next || passwords.again
  const dirty =
    states.filter((s) => s !== 'clean').length + (typed ? 1 : 0) + unlink.size
  const current = rows.at(cursor.row)
  const column = columns[cursor.col]
  const own = ownLines(open, loaded.hasPassword, loaded.accounts)
  const ownLine: OwnLine | null =
    sub !== null && current?.id === me ? (own.at(sub) ?? null) : null
  const selection: Range | null =
    mode === 'visual'
      ? {
          from: clamp(Math.min(anchor, cursor.row)),
          to: clamp(Math.max(anchor, cursor.row)),
        }
      : null

  useEffect(() => {
    setEditorStatus({ mode, dirty })
  }, [mode, dirty])
  useEffect(() => () => setEditorStatus(null), [])
  useEffect(() => {
    writeDraft(rows.some((r) => userStatus(r) !== 'clean') ? rows : null)
  }, [rows])
  useEffect(() => {
    if (mode === 'normal' && !help)
      gridRef.current?.focus({ preventScroll: true })
  }, [mode, help])
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const observer = new ResizeObserver(() => setRoom(el.clientWidth))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // ---------- buffer changes

  function change(next: Array<UserRow>) {
    history.current.undo.push(rows)
    if (history.current.undo.length > 200) history.current.undo.shift()
    history.current.redo = []
    setRows(next)
  }

  function clearProblems(ids: Iterable<string>) {
    const rest = new Map(problems)
    let any = false
    for (const id of ids) any = rest.delete(id) || any
    if (any) setProblems(rest)
  }

  function putRow(row: UserRow) {
    const i = rows.findIndex((r) => r.id === row.id)
    if (i < 0 || JSON.stringify(rows[i]) === JSON.stringify(row)) return
    change(rows.with(i, row))
    clearProblems([row.id])
  }

  function undo() {
    const prev = history.current.undo.pop()
    if (!prev) return say('已經是最早的狀態')
    history.current.redo.push(rows)
    setRows(prev)
    setSub(null)
    setCursor((c) => ({ ...c, row: clamp(c.row, prev.length) }))
  }

  function redo() {
    const next = history.current.redo.pop()
    if (!next) return say('已經是最新的狀態')
    history.current.undo.push(rows)
    setRows(next)
    setSub(null)
    setCursor((c) => ({ ...c, row: clamp(c.row, next.length) }))
  }

  function say(text: string, tone: Message['tone'] = 'info') {
    setMessage({ text, tone })
  }

  function clamp(row: number, length = rows.length) {
    return Math.max(0, Math.min(row, length - 1))
  }

  function moveTo(row: number, col: number) {
    setSub(null)
    setCursor({
      row: clamp(row),
      col: Math.max(0, Math.min(col, columns.length - 1)),
    })
  }

  function linesUnder(index: number): number {
    return rows[index]?.id === me ? own.length : 0
  }

  /** Moves down `n` lines, through the lines under the caller's own line. */
  function down(n: number) {
    let r = cursor.row
    let at = sub
    for (let i = 0; i < n; i++) {
      const under = linesUnder(r)
      if (at === null) {
        if (under > 0) at = 0
        else if (r < rows.length - 1) r++
      } else if (at < under - 1) at++
      else if (r < rows.length - 1) {
        r++
        at = null
      }
    }
    setCursor((c) => ({ ...c, row: r }))
    setSub(at)
  }

  /** Moves up `n` lines, through the lines under the caller's own line. */
  function up(n: number) {
    let r = cursor.row
    let at = sub
    for (let i = 0; i < n; i++) {
      if (at === null) {
        if (r === 0) break
        r--
        const under = linesUnder(r)
        at = under > 0 ? under - 1 : null
      } else if (at > 0) at--
      else at = null
    }
    setCursor((c) => ({ ...c, row: r }))
    setSub(at)
  }

  /** Opens or closes a group under the caller's line. */
  function toggleGroup(group: OwnGroup, show?: boolean) {
    const next = new Set(open)
    if (show ?? !next.has(group)) next.add(group)
    else next.delete(group)
    setOpen(next)
  }

  /** `za`/`zo`/`zc`: on a group, that group; on the caller's line, both. */
  function fold(op: 'za' | 'zo' | 'zc') {
    if (!current || current.id !== me)
      return say('只有自己那一列底下有密碼和第三方帳號', 'error')
    const show = op === 'za' ? undefined : op === 'zo'
    if (ownLine?.kind === 'group') return toggleGroup(ownLine.group, show)
    if (ownLine) {
      // Inside a group: close it, back on its header.
      const group = ownLine.kind === 'password' ? 'password' : 'accounts'
      if (op === 'zo') return
      toggleGroup(group, false)
      setSub(own.findIndex((l) => l.kind === 'group' && l.group === group))
      return
    }
    const both = op === 'za' ? open.size < 2 : op === 'zo'
    setOpen(both ? new Set(['password', 'accounts']) : new Set())
    if (both && op === 'zo') setSub(0)
  }

  // ---------- line commands

  /** `o`, `:invite`: a join link at the end, its note open. */
  function openInvite(note?: string) {
    if (!manage) return say('只有管理員能邀請新的使用者', 'error')
    const row = newJoinRow(crypto.randomUUID(), note ?? '')
    const next = [...rows, row]
    change(next)
    setSub(null)
    setCursor({ row: next.length - 1, col: columns.indexOf('detail') })
    if (note !== undefined)
      return say('已加一條邀請連結：:w 儲存後會複製連結，傳給對方')
    opened.current = { id: row.id, from: cursor }
    setEdit('')
    setPick(0)
    setNavigated(false)
    setMode('insert')
    say('邀請連結的備註：寫這是給誰的（可以不填）；:w 儲存後會複製連結')
  }

  /** Esc on a new link left as it was takes it away again. */
  function dropOpened(): boolean {
    const o = opened.current
    opened.current = null
    if (!o || !current || current.id !== o.id || edit.trim() !== '')
      return false
    history.current.undo.pop()
    const next = rows.filter((r) => r.id !== o.id)
    setRows(next)
    setCursor({ row: clamp(o.from.row, next.length), col: o.from.col })
    setMode('normal')
    say('已取消新增')
    return true
  }

  /** `:reset`: a link that sets the cursor's user's password. */
  function addReset() {
    if (!manage) return say('只有管理員能產生重設密碼的連結', 'error')
    const target = current?.kind === 'user' ? current : undefined
    if (!target) return say('游標移到要重設密碼的使用者再 :reset', 'error')
    if (target.id === me)
      return say('自己的密碼在自己這一列底下的「密碼」改（za 展開）', 'error')
    const row = newResetRow(crypto.randomUUID(), target.id)
    const next = [...rows, row]
    change(next)
    setSub(null)
    setCursor((c) => ({ ...c, row: next.length - 1 }))
    say(
      `已加一條重設 ${usernameOf(row, next)} 密碼的連結：:w 儲存後會複製，傳給他自己設新密碼`,
    )
  }

  /** `dd`: links are revoked at :w (new ones go); again takes the mark off. */
  function deleteRange({ from, to }: Range) {
    const targets = rows.slice(from, to + 1)
    if (targets.length === 0) return
    for (const t of targets) {
      const reason = deleteBlocked(t)
      if (reason) return say(reason, 'error')
    }
    const ids = new Set(targets.map((t) => t.id))
    if (targets.every((t) => t.deleted)) {
      change(rows.map((r) => (ids.has(r.id) ? { ...r, deleted: false } : r)))
      return say(`已取消 ${ids.size} 條連結的作廢標記`)
    }
    const next = rows.flatMap((r) =>
      !ids.has(r.id) ? [r] : r.base ? [{ ...r, deleted: true }] : [],
    )
    change(next)
    setCursor((c) => ({ ...c, row: clamp(from, next.length) }))
    say(
      `已標記作廢 ${targets.length} 條連結（:w 儲存後就不能再用），u 可以復原`,
    )
  }

  /** `dd` under the caller's line: unlink an account, or clear a password typed. */
  function deleteOwn(line: OwnLine) {
    if (line.kind === 'password') {
      setPasswords((p) => ({ ...p, [line.field]: '' }))
      return say(`已清掉${passwordLabels[line.field]}`)
    }
    if (line.kind === 'group') return say('這一條不能刪；za 收起', 'error')
    const identity = line.account.identity
    if (!identity)
      return say(`還沒連結 ${line.account.name}；i 去連結`, 'error')
    const next = new Set(unlink)
    if (next.has(identity.id)) {
      next.delete(identity.id)
      setUnlink(next)
      return say(`已取消解除 ${line.account.name}`)
    }
    next.add(identity.id)
    setUnlink(next)
    say(
      `${line.account.name} 會在 :w 時解除連結，之後就不能用它登入；再 dd 取消`,
    )
  }

  /** `x`: disable or enable users. */
  function toggleActive(range: Range) {
    const targets = rows
      .slice(range.from, range.to + 1)
      .filter((r) => r.kind === 'user')
    if (targets.length === 0) return say('連結沒有啟用與否；不要了就 dd 作廢')
    for (const t of targets) {
      const reason = lockedReason(t, 'active', me, manage)
      if (reason) return say(reason, 'error')
    }
    const active = !targets.every((t) => t.active)
    const ids = new Set(targets.map((t) => t.id))
    change(rows.map((r) => (ids.has(r.id) ? { ...r, active } : r)))
    clearProblems(ids)
    say(
      active
        ? `已啟用 ${targets.length} 位（:w 儲存）`
        : `已停用 ${targets.length} 位：:w 儲存後他們會被登出，也不能再登入`,
    )
  }

  /** A link's token: as the server keeps it (ADR-135), or as made here. */
  function tokenOf(row: UserRow): string | null {
    if (row.kind === 'user') return null
    return tokens.get(row.id) ?? (row.base as OpenLink | null)?.token ?? null
  }

  /** `yy` and the copy button: copies a link while it can be used. */
  async function copyLink(row: UserRow | undefined) {
    if (!row || row.kind === 'user') return say('游標移到連結上再 yy', 'error')
    const token = tokenOf(row)
    if (!token)
      return say(
        row.base
          ? '伺服器沒有設定 FACTUAL_ENCRYPTION_KEY，連結只能在建立時複製；要再給就作廢它、建一條新的'
          : '先 :w 儲存，連結才會產生',
        'error',
      )
    await copy(linkUrl(window.location.origin, row, token))
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url)
      say(`已複製：${url}`)
    } catch {
      say(`複製不了，請自己選取：${url}`)
    }
  }

  // ---------- cells

  function startInsertAt(index: number, colIndex: number, clear = false) {
    const row = rows.at(index)
    const col = columns[colIndex]
    if (!row) return say('還沒有使用者')
    if (col === 'active') return toggleActive({ from: index, to: index })
    const reason = lockedReason(row, col, me, manage)
    if (reason) return say(reason, 'error')
    setSub(null)
    setSubEdit(false)
    setEdit(clear ? '' : userCellText(row, col))
    setPick(0)
    setNavigated(false)
    setMode('insert')
  }

  /** `i` under the caller's line: a group opens, a password is typed, an account is linked. */
  function startOwn(line: OwnLine, clear: boolean) {
    if (line.kind === 'group') return toggleGroup(line.group)
    if (line.kind === 'account') {
      if (line.account.identity)
        return say(
          `已連結 ${line.account.name}（${line.account.identity.email || '沒有 email'}）；dd 解除`,
        )
      if (line.account.disabled)
        return say('這個登入方式已停用，不能再連結', 'error')
      if (dirty > 0)
        return say(
          '連結會離開這一頁：先 :w 儲存，或 :e! 放棄變更，再去連結',
          'error',
        )
      window.location.href = oidcLinkUrl(line.account.code)
      return
    }
    setSubEdit(true)
    setEdit(clear ? '' : passwords[line.field])
    setMode('insert')
  }

  function suggestions(): Array<Suggestion> {
    if (mode !== 'insert' || !current || subEdit || column !== 'role') return []
    return rankCell(
      (Object.keys(roleLabels) as Array<InstanceRole>).map((r) => ({
        value: roleLabels[r],
        label: roleLabels[r],
        hint: r === 'admin' ? '管理使用者、登入方式、國定假日' : undefined,
      })),
      edit,
      userCellText(current, column),
      (o) => o.value,
    )
  }

  function chosenText(): string {
    const options = suggestions()
    if (options.length === 0) return edit
    const highlighted = options[Math.min(pick, options.length - 1)].value
    if (navigated) return highlighted
    return options.some((o) => o.value === edit.trim()) ? edit : highlighted
  }

  function takenIndex(options: Array<Suggestion>): number {
    if (options.length === 0) return -1
    return options.findIndex((o) => o.value === chosenText())
  }

  function commitCell(text: string): boolean {
    if (!current) return false
    opened.current = null
    const next = userPatch(current, column, text)
    if (typeof next === 'string') {
      say(next, 'error')
      return false
    }
    putRow(next)
    setMessage(null)
    return true
  }

  /** Takes the password typed (and returns them all); Tab goes on to the next one. */
  function commitPassword(move: 'stay' | 'next' | 'prev'): Passwords {
    if (ownLine?.kind !== 'password') return passwords
    const next = { ...passwords, [ownLine.field]: edit }
    setPasswords(next)
    setEdit('')
    if (move === 'stay') {
      setSubEdit(false)
      setMode('normal')
      return next
    }
    const to = (sub ?? 0) + (move === 'next' ? 1 : -1)
    const line = own.at(to)
    if (to < 0 || line?.kind !== 'password') {
      setSubEdit(false)
      setMode('normal')
      return next
    }
    setSub(to)
    setEdit(next[line.field])
    return next
  }

  /** A click elsewhere while editing takes what was typed. */
  function finishEditing(): boolean {
    if (mode !== 'insert') return true
    if (subEdit) {
      commitPassword('stay')
      return true
    }
    if (!commitCell(chosenText())) return false
    setMode('normal')
    return true
  }

  // ---------- saving

  function messageFor(code: string, fallback: string): string {
    if (userProblemMessages[code]) return userProblemMessages[code]
    const known = errorCodeMessage(code)
    return known === '發生未知錯誤' ? fallback : known
  }

  function codeOf(error: unknown): string {
    return error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : ''
  }

  function reportProblems(found: Map<string, UserProblem>): false {
    setProblems(found)
    const first = rows.findIndex((r) => found.has(r.id))
    const p = found.get(rows[first]?.id ?? '')
    if (first >= 0) {
      const col = p?.field ? columns.indexOf(p.field) : -1
      setSub(null)
      setCursor({ row: first, col: col >= 0 ? col : cursor.col })
    }
    say(`${found.size} 列有問題，沒有儲存：${p?.message ?? ''}`, 'error')
    return false
  }

  /** Puts the cursor on one of the caller's own lines with a problem, its group open. */
  function reportOwn(
    group: OwnGroup,
    where: (l: OwnLine) => boolean,
    text: string,
  ): false {
    const shown = new Set(open).add(group)
    setOpen(shown)
    const lines = ownLines(shown, loaded.hasPassword, loaded.accounts)
    const at = lines.findIndex(where)
    setCursor((c) => ({
      ...c,
      row: Math.max(
        0,
        rows.findIndex((r) => r.id === me),
      ),
    }))
    setSub(at >= 0 ? at : null)
    say(text, 'error')
    return false
  }

  /** :w; `pw` are the passwords as just typed (Ctrl-s in a password line). */
  async function save(pw: Passwords = passwords): Promise<boolean> {
    const typedNow = pw.current || pw.next || pw.again
    // Everything is checked before anything is sent.
    const found = new Map<string, UserProblem>()
    for (const [i, row] of rows.entries()) {
      if (states[i] === 'clean') continue
      const p = validateUserRow(row, rows)
      if (p) found.set(row.id, p)
    }
    if (found.size > 0) return reportProblems(found)
    const bad = passwordProblem(pw, loaded.hasPassword)
    if (bad)
      return reportOwn(
        'password',
        (l) => l.kind === 'password' && l.field === bad.field,
        bad.message,
      )
    const lost = unlinkProblem(
      loaded.accounts,
      unlink,
      loaded.hasPassword,
      typedNow !== '',
    )
    if (lost)
      return reportOwn(
        'accounts',
        (l) => l.kind === 'group' && l.group === 'accounts',
        lost,
      )

    const profile = profileChange(rows, me)
    const body = toBatch(rows)
    const batch =
      manage &&
      (body.users.length > 0 || body.links.length > 0 || body.revoke.length > 0)
    if (!profile && !typedNow && unlink.size === 0 && !batch) {
      say('沒有需要儲存的變更')
      return true
    }
    setSaving(true)
    const done: Array<string> = []
    try {
      // Each part is its own request; what was saved before a failure stays.
      if (profile) {
        const { error } = await api.PATCH('/me', { body: profile })
        if (error) {
          const meRow = rows.find((r) => r.id === me)
          return reportProblems(
            new Map([
              [
                meRow?.id ?? me,
                {
                  field:
                    codeOf(error) === 'invalid_display_name'
                      ? 'detail'
                      : 'name',
                  message: messageFor(codeOf(error), '儲存失敗'),
                },
              ],
            ]),
          )
        }
        done.push('帳號名稱')
      }
      if (typedNow) {
        const { error } = await api.PUT('/me/password', {
          body: { currentPassword: pw.current, newPassword: pw.next },
        })
        if (error)
          return reportOwn(
            'password',
            (l) =>
              l.kind === 'password' &&
              l.field ===
                (codeOf(error) === 'wrong_password' ? 'current' : 'next'),
            `${done.length ? `已儲存${done.join('、')}；` : ''}${messageFor(codeOf(error), '密碼沒有變更')}`,
          )
        setPasswords(noPasswords)
        done.push('密碼（其他裝置已登出）')
      }
      for (const id of unlink) {
        const { error } = await api.DELETE('/me/identities/{id}', {
          params: { path: { id } },
        })
        if (error)
          return reportOwn(
            'accounts',
            (l) => l.kind === 'account' && l.account.identity?.id === id,
            `${done.length ? `已儲存${done.join('、')}；` : ''}${messageFor(codeOf(error), '解除連結失敗')}`,
          )
      }
      if (unlink.size > 0) done.push(`解除 ${unlink.size} 個第三方帳號`)

      let created: Array<{ id: string; token: string }> = []
      if (batch) {
        const {
          data: saved,
          error,
          response,
        } = await api.POST('/users/batch', {
          body,
        })
        if (response.status === 422 && error && 'errors' in error) {
          const fromServer = new Map<string, UserProblem>()
          for (const p of error.errors)
            fromServer.set(p.id, {
              field: userProblemColumn(p.field),
              message: messageFor(p.code, p.message),
            })
          return reportProblems(fromServer)
        }
        if (!saved) {
          say(
            `${done.length ? `已儲存${done.join('、')}；` : ''}${messageFor(codeOf(error), '儲存失敗，請稍後再試')}；其餘變更仍保留在草稿裡`,
            'error',
          )
          return false
        }
        created = saved.created
        done.push(
          `${saved.updated} 位使用者、${saved.created.length} 條新連結、作廢 ${saved.revoked} 條`,
        )
      }

      const fresh = await reload()
      const next = userRows(fresh.users, fresh.links)
      const made = new Map(tokens)
      for (const c of created) made.set(c.id, c.token)
      writeDraft(null)
      history.current = { undo: [], redo: [] }
      setTokens(made)
      setLoaded(fresh)
      setRows(next)
      setUnlink(new Set())
      setProblems(new Map())
      setSub(null)
      setCursor((c) => ({ ...c, row: clamp(c.row, next.length) }))
      const summary = `已儲存：${done.join('、')}`
      // The first new link goes to the clipboard at once.
      const first = created.at(0)
      const row = first && next.find((r) => r.id === first.id)
      if (row) {
        await copy(linkUrl(window.location.origin, row, first.token))
        if (created.length > 1)
          say(`${summary}；第一條連結已複製，其他的按「複製連結」`)
      } else say(summary)
      return true
    } catch {
      say('無法連線至伺服器；變更仍保留在草稿裡（密碼除外）', 'error')
      return false
    } finally {
      setSaving(false)
    }
  }

  function discard() {
    const fresh = userRows(loaded.users, loaded.links)
    writeDraft(null)
    change(fresh)
    setPasswords(noPasswords)
    setUnlink(new Set())
    setProblems(new Map())
    setSub(null)
    setCursor((c) => ({ ...c, row: clamp(c.row, fresh.length) }))
    say('已放棄所有未儲存的變更（u 可以復原列上的變更）')
  }

  async function runCommand(raw: string) {
    const cmd = raw.trim()
    setMode('normal')
    setCommand('')
    if (cmd === 'w') await save()
    else if (cmd === 'e!') discard()
    else if (cmd === 'invite' || cmd.startsWith('invite '))
      openInvite(cmd.slice('invite'.length).trim())
    else if (cmd === 'reset') addReset()
    else if (/^winc(md)? [hjkl]$/.test(cmd)) {
      const dir = windowDirection(cmd.slice(-1))
      if (dir) movePane(dir, gridRef.current)
    } else if (/^\d+$/.test(cmd)) moveTo(Number(cmd) - 1, cursor.col)
    else if (cmd) say(`不認得的指令：${cmd}`, 'error')
  }

  // ---------- keys

  function runNormal(k: Key): boolean {
    if (saving) return false
    const p = pending.current
    const visual = mode === 'visual'
    if (/^[0-9]$/.test(k) && !(k === '0' && p.count === '')) {
      p.count += k
      return true
    }
    const count = Math.max(1, Number(p.count || '1'))
    const done = (fn: () => void): true => {
      setMessage((m) => (m?.tone === 'error' ? m : null))
      fn()
      pending.current = { count: '', op: '' }
      return true
    }
    const counted = { from: cursor.row, to: cursor.row + count - 1 }
    const range = visual && selection ? selection : counted

    if (p.op) {
      const op = p.op + k
      if (op === 'dd')
        return done(() => (ownLine ? deleteOwn(ownLine) : deleteRange(counted)))
      if (op === 'yy') return done(() => void copyLink(current))
      if (op === 'gg')
        return done(() => moveTo(p.count ? count - 1 : 0, cursor.col))
      if (op === 'za' || op === 'zo' || op === 'zc') return done(() => fold(op))
      const dir = p.op === '<C-w>' ? windowDirection(k) : null
      if (dir) return done(() => movePane(dir, gridRef.current))
      pending.current = { count: '', op: '' }
      return true
    }

    switch (k) {
      case 'j':
      case '<Down>':
        return done(() =>
          visual ? moveTo(cursor.row + count, cursor.col) : down(count),
        )
      case 'k':
      case '<Up>':
        return done(() =>
          visual ? moveTo(cursor.row - count, cursor.col) : up(count),
        )
      case 'l':
      case '<Right>':
      case 'w':
      case '<Tab>':
        return done(() => {
          if (sub === null) moveTo(cursor.row, cursor.col + count)
        })
      case 'h':
      case '<Left>':
      case 'b':
      case '<S-Tab>':
        return done(() => {
          if (sub === null) moveTo(cursor.row, cursor.col - count)
        })
      case '0':
      case '^':
      case '<Home>':
        return done(() => moveTo(cursor.row, 0))
      case '$':
      case '<End>':
        return done(() => moveTo(cursor.row, columns.length - 1))
      case 'G':
        return done(() =>
          moveTo(p.count ? count - 1 : rows.length - 1, cursor.col),
        )
      case 'g':
      case 'z':
      case '<C-w>':
        pending.current = { count: p.count, op: k }
        return true
      case ':':
        return done(() => {
          if (visual) setMode('normal')
          setCommand('')
          setMode('command')
        })
      case '?':
        return done(() => setHelp(true))
      case '<C-s>':
      case '<D-s>':
        return done(() => {
          if (visual) setMode('normal')
          void save()
        })
      case 'x':
        return done(() => {
          if (visual) setMode('normal')
          toggleActive(range)
        })
    }

    if (visual) {
      switch (k) {
        case '<Esc>':
        case '<C-c>':
        case 'v':
        case 'V':
          return done(() => setMode('normal'))
        case 'd':
        case 'D':
        case 'X':
          return done(() => {
            setMode('normal')
            deleteRange(range)
          })
        default:
          pending.current = { count: '', op: '' }
          return false
      }
    }

    switch (k) {
      case 'v':
      case 'V':
        return done(() => {
          if (rows.length === 0) return
          setSub(null)
          setAnchor(cursor.row)
          setMode('visual')
        })
      case 'd':
      case 'y':
        pending.current = { count: p.count, op: k }
        return true
      case 'i':
      case 'a':
      case '<CR>':
      case '<F2>':
        return done(() =>
          ownLine
            ? startOwn(ownLine, false)
            : startInsertAt(cursor.row, cursor.col),
        )
      case 'c':
      case 's':
        return done(() =>
          ownLine
            ? startOwn(ownLine, true)
            : startInsertAt(cursor.row, cursor.col, true),
        )
      case 'o':
      case 'O':
        return done(() => openInvite())
      case 'u':
        return done(undo)
      case '<C-r>':
        return done(redo)
      case '<Esc>':
        return done(() => setMessage(null))
      default:
        pending.current = { count: '', op: '' }
        return false
    }
  }

  function runPassword(k: Key): boolean {
    switch (k) {
      case '<Tab>':
        commitPassword('next')
        return true
      case '<S-Tab>':
        commitPassword('prev')
        return true
      case '<CR>':
      case '<Esc>':
        commitPassword('stay')
        return true
      case '<C-c>':
        setEdit('')
        setSubEdit(false)
        setMode('normal')
        say('已取消編輯')
        return true
      case '<C-s>':
      case '<D-s>':
        void save(commitPassword('stay'))
        return true
      default:
        if ([...k].length === 1) {
          setEdit((e) => e + k)
          return true
        }
        return false
    }
  }

  function runInsert(k: Key): boolean {
    if (subEdit) return runPassword(k)
    const options = suggestions()
    switch (k) {
      case '<C-n>':
      case '<Down>':
        setPick(nextPick(options.length, takenIndex(options), 1))
        setNavigated(true)
        return true
      case '<C-p>':
      case '<Up>':
        setPick(nextPick(options.length, takenIndex(options), -1))
        setNavigated(true)
        return true
      case '<Tab>':
      case '<S-Tab>':
      case '<CR>':
        if (commitCell(chosenText())) setMode('normal')
        return true
      case '<Esc>':
        if (dropOpened()) return true
        if (commitCell(chosenText())) setMode('normal')
        return true
      case '<C-c>':
        if (dropOpened()) return true
        setMode('normal')
        say('已取消編輯')
        return true
      case '<C-s>':
      case '<D-s>':
        if (commitCell(chosenText())) {
          setMode('normal')
          void save()
        }
        return true
      default:
        if ([...k].length === 1) {
          setEdit((e) => e + k)
          setPick(0)
          setNavigated(false)
          return true
        }
        return false
    }
  }

  function runCommandKey(k: Key): boolean {
    switch (k) {
      case '<CR>':
        void runCommand(command)
        return true
      case '<Esc>':
      case '<C-c>':
        setMode('normal')
        setCommand('')
        return true
      case '<BS>':
        if (command !== '') return false
        setMode('normal')
        return true
      default:
        if ([...k].length === 1) {
          setCommand((c) => c + k)
          return true
        }
        return false
    }
  }

  const feed = useKeyFeed(keymap, 'users', (k) => {
    if (mode === 'insert') return runInsert(k)
    if (mode === 'command') return runCommandKey(k)
    return runNormal(k)
  })

  // ---------- render

  const options = suggestions()
  const problem = current ? problems.get(current.id) : undefined
  const line =
    mode === 'command'
      ? null
      : (message ??
        (problem ? { text: problem.message, tone: 'error' as const } : null))
  const valueLeft = OWN_INDENT + OWN_LABEL
  const valueWidth = Math.max(
    240,
    Math.min(520, Math.max(room, layout.width) - valueLeft - 16),
  )

  function ownLineView(l: OwnLine, li: number, on: boolean) {
    const typing = on && mode === 'insert' && subEdit
    let label: React.ReactNode
    let value: React.ReactNode
    if (l.kind === 'group') {
      const isOpen = open.has(l.group)
      const Chevron = isOpen ? ChevronDownIcon : ChevronRightIcon
      const linked = loaded.accounts.filter((a) => a.identity).length
      label = (
        <span className="flex items-center gap-1 text-foreground">
          <Chevron className="size-3.5 text-muted-foreground" />
          {l.group === 'password' ? '密碼' : `第三方帳號（${linked}）`}
        </span>
      )
      value =
        l.group === 'password' ? (
          <span className="text-muted-foreground">
            {typed
              ? '已填新密碼（:w 儲存）'
              : loaded.hasPassword
                ? '已設定'
                : '還沒設定；設了之後就能用帳號密碼登入'}
          </span>
        ) : (
          <span className="text-muted-foreground">
            {unlink.size > 0 ? `${unlink.size} 個將解除（:w 儲存）` : ''}
          </span>
        )
    } else if (l.kind === 'password') {
      label = passwordLabels[l.field]
      value = passwords[l.field] ? (
        <span className="font-mono">
          {'•'.repeat(Math.min(passwords[l.field].length, 16))}
        </span>
      ) : (
        <span className="text-muted-foreground/60">
          {l.field === 'next' ? '至少 8 個字元' : ''}
        </span>
      )
    } else {
      const a = l.account
      const marked = a.identity && unlink.has(a.identity.id)
      label = (
        <span className="flex items-center gap-1.5 text-foreground">
          <BrandIcon slug={a.icon} className="size-3.5" />
          <span className="truncate">{a.name}</span>
        </span>
      )
      value = a.identity ? (
        <span
          className={cn(
            'truncate',
            marked && 'text-muted-foreground line-through',
          )}
        >
          {a.identity.email || '已連結'}
          <span className="ml-2 text-xs text-muted-foreground">
            {a.disabled
              ? '登入方式已停用'
              : a.identity.lastLoginAt
                ? `上次登入 ${new Date(a.identity.lastLoginAt).toLocaleDateString()}`
                : '還沒用來登入過'}
          </span>
          {marked && (
            <span className="ml-2 text-xs text-destructive no-underline">
              將解除
            </span>
          )}
        </span>
      ) : (
        <span className="text-muted-foreground">
          尚未連結 · i 或點這裡去連結
        </span>
      )
    }
    return (
      <div
        key={
          l.kind === 'group'
            ? `g-${l.group}`
            : l.kind === 'password'
              ? `p-${l.field}`
              : `a-${l.account.code}`
        }
        className="relative border-b border-rule/40 bg-card/40 text-sm leading-normal"
        style={{ height: ROW_HEIGHT }}
        onMouseDown={(e) => {
          e.preventDefault()
          if (!finishEditing()) return
          setMode('normal')
          setCursor((c) => ({ ...c, row: rows.findIndex((r) => r.id === me) }))
          setSub(li)
          gridRef.current?.focus({ preventScroll: true })
          // A click opens a group or goes to link an account; a double click edits.
          if (
            l.kind === 'group' ||
            (l.kind === 'account' && !l.account.identity) ||
            e.detail === 2
          )
            startOwn(l, false)
        }}
      >
        {on && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-accent/50"
          />
        )}
        <span
          aria-hidden
          className="absolute inset-y-0 border-l-2 border-kraft/60"
          style={{ left: GUTTER + (l.kind === 'group' ? 0 : 12) }}
        />
        <span
          className="absolute inset-y-0 flex items-center truncate pr-2 text-xs text-muted-foreground"
          style={{
            left: OWN_INDENT + (l.kind === 'group' ? 0 : 12),
            width: OWN_LABEL,
          }}
        >
          {label}
        </span>
        <span
          className="absolute inset-y-0 flex min-w-0 items-center overflow-hidden px-2 whitespace-nowrap"
          style={{ left: valueLeft, width: valueWidth }}
        >
          {value}
        </span>
        {on && !typing && (
          <div
            aria-hidden
            className="pointer-events-none absolute top-0 z-10 border-2 border-kraft/40 group-focus:border-kraft"
            style={{ left: valueLeft, width: valueWidth, height: ROW_HEIGHT }}
          />
        )}
        {typing && (
          <div
            className="absolute top-0 z-30"
            style={{ left: valueLeft, width: valueWidth }}
          >
            <CellEditor
              inputRef={inputRef}
              value={edit}
              label={l.kind === 'password' ? passwordLabels[l.field] : ''}
              width={valueWidth}
              options={[]}
              pick={-1}
              secret
              onChange={setEdit}
              onKeyDown={(e) =>
                feed.onInsertKeyDown(e, (n) =>
                  setEdit(eraseBeforeCaret(inputRef.current, edit, n)),
                )
              }
              onChoose={() => {}}
            />
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div
        ref={gridRef}
        tabIndex={0}
        role="grid"
        aria-label="使用者"
        aria-rowcount={rows.length}
        data-pane="users"
        data-editor
        onKeyDown={
          mode === 'normal'
            ? feed.onNormalKeyDown
            : mode === 'visual'
              ? feed.onVisualKeyDown
              : undefined
        }
        className="group flex min-h-0 flex-1 flex-col rounded-md border border-rule outline-none"
      >
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
          <div style={{ width: layout.width }} className="relative">
            <div
              role="row"
              className="sticky top-0 z-20 grid border-b border-rule bg-card text-xs text-muted-foreground"
              style={{
                gridTemplateColumns: layout.template,
                height: ROW_HEIGHT,
              }}
            >
              <span />
              {columns.map((c) => (
                <span
                  key={c}
                  role="columnheader"
                  className={cn(
                    'flex items-center px-2',
                    c === 'active' && 'justify-center',
                  )}
                >
                  {userLabels[c]}
                </span>
              ))}
            </div>

            {rows.map((row, index) => {
              const at = index === cursor.row
              const selected =
                selection !== null &&
                index >= selection.from &&
                index <= selection.to
              return (
                <div key={row.id} className="relative">
                  {((at && sub === null) || selected) && (
                    <div
                      aria-hidden
                      className={cn(
                        'pointer-events-none absolute inset-x-0 top-0',
                        selected
                          ? 'border-l-2 border-kraft bg-kraft/15'
                          : 'bg-accent/50',
                      )}
                      style={{ height: ROW_HEIGHT }}
                    />
                  )}
                  {at && sub === null && mode !== 'insert' && (
                    <div
                      aria-hidden
                      className="pointer-events-none absolute top-0 z-10 border-2 border-kraft/40 group-focus:border-kraft"
                      style={{
                        left: layout.lefts[column],
                        width: layout.widths[column],
                        height: ROW_HEIGHT,
                      }}
                    />
                  )}
                  <UserLine
                    row={row}
                    rows={rows}
                    index={index}
                    layout={layout}
                    state={states[index]}
                    problem={problems.get(row.id)}
                    me={me}
                    canCopy={tokenOf(row) !== null}
                    onCopy={() => void copyLink(row)}
                    first={
                      index > 0 &&
                      rows[index - 1].kind === 'user' &&
                      row.kind !== 'user'
                    }
                    onPick={(col, enter) => {
                      if (!finishEditing()) return
                      setMode('normal')
                      setSub(null)
                      setCursor({ row: index, col })
                      if (enter) startInsertAt(index, col)
                    }}
                  />
                  {at && mode === 'insert' && !subEdit && (
                    <div
                      className="absolute top-0 z-30"
                      style={{
                        left: layout.lefts[column],
                        width: layout.widths[column],
                      }}
                    >
                      <CellEditor
                        inputRef={inputRef}
                        value={edit}
                        label={
                          column === 'detail'
                            ? row.kind === 'user'
                              ? '顯示名稱'
                              : '備註'
                            : userLabels[column]
                        }
                        width={layout.widths[column]}
                        options={feed.waiting ? [] : options}
                        pick={takenIndex(options)}
                        onChange={(value) => {
                          setEdit(value)
                          setPick(0)
                          setNavigated(false)
                        }}
                        onKeyDown={(e) =>
                          feed.onInsertKeyDown(e, (n) =>
                            setEdit(
                              eraseBeforeCaret(inputRef.current, edit, n),
                            ),
                          )
                        }
                        onChoose={(i) => {
                          opened.current = null
                          setEdit(options[i].value)
                          setPick(i)
                          setNavigated(true)
                        }}
                      />
                    </div>
                  )}
                  {row.id === me &&
                    own.map((l, li) => ownLineView(l, li, at && sub === li))}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      <KeyHelp
        open={help}
        onClose={() => setHelp(false)}
        keymap={keymap}
        groups={userKeys}
      />

      <div className="flex h-8 shrink-0 items-center font-mono text-sm">
        {mode === 'command' ? (
          <label className="flex w-full items-center">
            <span className="text-kraft">:</span>
            <input
              autoFocus
              value={command}
              aria-label="指令"
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={feed.onTextKeyDown}
              className="flex-1 bg-transparent px-1 outline-none"
            />
          </label>
        ) : saving ? (
          <span className="text-muted-foreground">儲存中…</span>
        ) : line ? (
          <span
            role={line.tone === 'error' ? 'alert' : 'status'}
            title={line.text}
            className={cn(
              'truncate',
              line.tone === 'error'
                ? 'text-destructive'
                : 'text-muted-foreground',
            )}
          >
            {line.text}
          </span>
        ) : (
          <span className="truncate text-muted-foreground">
            {selection
              ? `已選 ${selection.to - selection.from + 1} 列 · x 停用/啟用 · d 作廢連結 · Esc 取消`
              : manage
                ? 'hjkl 移動 · i 編輯 · za 展開密碼和第三方帳號 · x 停用 · o 邀請 · :reset 重設密碼 · :w 儲存 · ? 快捷鍵'
                : 'i 改帳號和名稱 · za 展開密碼和第三方帳號 · :w 儲存 · ? 快捷鍵'}
          </span>
        )}
      </div>
    </div>
  )
}

function UserLine({
  row,
  rows,
  index,
  layout,
  state,
  problem,
  me,
  canCopy,
  onCopy,
  first,
  onPick,
}: {
  row: UserRow
  rows: Array<UserRow>
  index: number
  layout: Layout
  state: UserRowStatus
  problem: UserProblem | undefined
  me: string
  /** Whether the link's token is known (it can be copied). */
  canCopy: boolean
  onCopy: () => void
  /** The first link after the users: a rule above it. */
  first: boolean
  onPick: (col: number, enter: boolean) => void
}) {
  const marker = problem
    ? '!'
    : { clean: '', new: '+', changed: '~', deleted: '-' }[state]
  const cell = 'flex items-center overflow-hidden px-2 whitespace-nowrap'
  const muted = 'text-muted-foreground'

  function content(c: UserColumn, col: number): React.ReactNode {
    const bad = problem?.field === c && 'text-destructive'
    switch (c) {
      case 'name':
        return (
          <span key={c} data-col={col} className={cn(cell, 'gap-1.5', bad)}>
            {row.kind === 'user' ? (
              <>
                <span className="truncate">{row.username}</span>
                {row.id === me && (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    （你）
                  </span>
                )}
              </>
            ) : (
              <>
                <LinkIcon className={cn('size-3.5 shrink-0', muted)} />
                <span className={cn('truncate', muted)}>
                  {row.kind === 'reset'
                    ? `重設 ${usernameOf(row, rows) || '?'}`
                    : '邀請'}
                </span>
              </>
            )}
          </span>
        )
      case 'detail':
        return (
          <span key={c} data-col={col} className={cn(cell, bad)}>
            <span className="truncate">
              {row.kind === 'user'
                ? row.displayName
                : row.note || (
                    <span className="text-muted-foreground/60">
                      {row.kind === 'join' && !row.base
                        ? '給誰的（可不填）'
                        : ''}
                    </span>
                  )}
            </span>
          </span>
        )
      case 'role':
        return (
          <span key={c} data-col={col} className={cn(cell, bad)}>
            {row.kind === 'user' ? roleLabels[row.role] : ''}
          </span>
        )
      case 'login':
        return (
          <span key={c} data-col={col} className={cn(cell, 'gap-2', muted)}>
            <span className="truncate">{loginText(row)}</span>
            {/* The mouse's way to copy, as yy is the keyboard's. */}
            {canCopy && !row.deleted && (
              <button
                type="button"
                tabIndex={-1}
                title="複製連結（yy）"
                className="ml-auto flex shrink-0 items-center gap-1 text-xs text-kraft hover:text-foreground"
                onMouseDown={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  onCopy()
                }}
              >
                <CopyIcon className="size-3.5" />
                複製連結
              </button>
            )}
          </span>
        )
      case 'when':
        return (
          <span key={c} data-col={col} className={cn(cell, muted)}>
            {whenText(row)}
          </span>
        )
      case 'active':
        return (
          <span
            key={c}
            data-col={col}
            className={cn(cell, 'justify-center', muted, bad)}
          >
            {row.kind === 'user' && row.active && (
              <CheckIcon className="size-4 text-foreground" aria-label="啟用" />
            )}
          </span>
        )
    }
  }

  return (
    <div
      role="row"
      aria-rowindex={index + 1}
      className={cn(
        'relative grid border-b border-rule/60 text-sm leading-normal',
        first && 'border-t border-t-rule',
        row.deleted && 'text-muted-foreground line-through',
        row.kind === 'user' && !row.active && 'text-muted-foreground',
      )}
      style={{ height: ROW_HEIGHT, gridTemplateColumns: layout.template }}
      onMouseDown={(e) => {
        const target = (e.target as HTMLElement).closest<HTMLElement>(
          '[data-col]',
        )
        if (!target) return
        e.preventDefault()
        onPick(Number(target.dataset.col), e.detail === 2)
      }}
    >
      <span
        className={cn(
          'flex items-center justify-center font-mono text-xs',
          problem || state === 'deleted' ? 'text-destructive' : 'text-kraft',
        )}
        title={problem?.message}
      >
        {marker}
      </span>
      {userColumns.map((c, col) => content(c, col))}
    </div>
  )
}
