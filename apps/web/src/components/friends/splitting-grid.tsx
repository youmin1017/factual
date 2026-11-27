import { Link, useNavigate } from '@tanstack/react-router'
import { ArrowUpRightIcon, CheckIcon, LockIcon, XIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '#/lib/api'
import { errorCodeMessage } from '#/lib/apiError'
import { setEditorStatus } from '#/lib/editorStatus'
import { movePane, windowDirection } from '#/lib/panes'
import { rankCell } from '#/lib/register'
import {
  applyMemberPick,
  deleteBlocked,
  dropMember,
  expenseCount,
  insertIndex,
  kindLabels,
  lockedReason,
  memberLocked,
  memberName,
  memberOptions,
  membersText,
  newPartyRow,
  partyBalanceText,
  partyCellText,
  partyColumns,
  partyLabels,
  partyPatch,
  partyProblemColumn,
  partyProblemMessages,
  partyRows,
  partyStatus,
  placeByKind,
  registered,
  takeMember,
  toBatch,
  validateParty,
} from '#/lib/splitting'
import { cn } from '#/lib/utils'
import { CellEditor, eraseBeforeCaret, nextPick } from '../register/cell-editor'
import { KeyHelp, splittingKeys } from '../register/key-help'
import { useKeyFeed } from '../register/use-key-feed'
import type { Key, Keymap } from '#/lib/keymap'
import type { Friend, Group } from '#/lib/split'
import type {
  MemberPick,
  PartyColumn,
  PartyKind,
  PartyProblem,
  PartyRow,
  PartyStatus,
} from '#/lib/splitting'
import type { Suggestion } from '../register/cell-editor'

// The 分帳 page (ADR-116): groups and friends as one grid, edited as the
// accounts page is (ADR-108) and saved with :w in one request; gx opens a
// friend's or group's expenses. Drafts kept locally (ADR-043).

const ROW_HEIGHT = 32
const GUTTER = 28
const widths: Record<PartyColumn, number> = {
  name: 160,
  kind: 64,
  members: 200,
  count: 64,
  balance: 160,
  archived: 56,
}
const stretch: Partial<Record<PartyColumn, number>> = {
  name: 0.4,
  members: 0.6,
}
const rightColumns: ReadonlySet<PartyColumn> = new Set(['count', 'balance'])

interface Layout {
  lefts: Record<PartyColumn, number>
  widths: Record<PartyColumn, number>
  template: string
  width: number
}

function layoutOf(room: number): Layout {
  const least = partyColumns.reduce((sum, c) => sum + widths[c], GUTTER)
  const extra = Math.max(0, room - least)
  const lefts = {} as Record<PartyColumn, number>
  const sized = {} as Record<PartyColumn, number>
  let x = GUTTER
  for (const c of partyColumns) {
    sized[c] = widths[c] + Math.floor(extra * (stretch[c] ?? 0))
    lefts[c] = x
    x += sized[c]
  }
  return {
    lefts,
    widths: sized,
    template: `${GUTTER}px ${partyColumns.map((c) => `${sized[c]}px`).join(' ')}`,
    width: x,
  }
}

type Mode = 'normal' | 'visual' | 'insert' | 'command'

interface Message {
  text: string
  tone: 'info' | 'error'
}

interface Range {
  from: number
  to: number
}

const DRAFT_KEY = 'factual:splitting'
const DRAFT_VERSION = 1

interface Draft {
  version: number
  rows: Array<PartyRow>
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

function writeDraft(rows: Array<PartyRow> | null): void {
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

/** The saved lines, with a draft's changes on top (saved lines it no longer has are kept). */
function initialRows(
  saved: Array<PartyRow>,
  draft: Draft | null,
): Array<PartyRow> {
  if (!draft) return saved
  const fresh = new Map(saved.map((r) => [r.id, r]))
  const out: Array<PartyRow> = []
  for (const d of draft.rows) {
    if (!d.base) out.push(d)
    else {
      const now = fresh.get(d.id)
      if (!now) continue
      out.push({ ...d, base: now.base })
      fresh.delete(d.id)
    }
  }
  let next = out
  for (const r of fresh.values())
    next = next.toSpliced(insertIndex(next, r.kind, next.length), 0, r)
  return next
}

interface Props {
  me: string
  groups: Array<Group>
  friends: Array<Friend>
  minorUnits: number
  keymap: Keymap
  /** Fetches the groups and friends again (after :w). */
  reload: () => Promise<{ groups: Array<Group>; friends: Array<Friend> }>
}

/**
 * The line and column the cursor was on, kept while the app runs so that
 * coming back (Ctrl-o after gx, ADR-124) finds it where it was.
 */
let lastSpot: { id: string; col: number } | null = null

export function SplittingGrid({
  me,
  groups,
  friends,
  minorUnits,
  keymap,
  reload,
}: Props) {
  const navigate = useNavigate()
  const [room, setRoom] = useState(0)
  const layout = layoutOf(room)
  const columns = partyColumns
  const [rows, setRows] = useState<Array<PartyRow>>(() =>
    initialRows(partyRows(groups, friends, me), readDraft()),
  )
  const [cursor, setCursor] = useState(() => {
    const row = rows.findIndex((r) => r.id === lastSpot?.id)
    return row < 0 ? { row: 0, col: 0 } : { row, col: lastSpot?.col ?? 0 }
  })
  const [mode, setMode] = useState<Mode>('normal')
  const [edit, setEdit] = useState('')
  const [pick, setPick] = useState(0)
  const [navigated, setNavigated] = useState(false)
  const [command, setCommand] = useState('')
  const [message, setMessage] = useState<Message | null>(() =>
    readDraft() ? { text: '已還原上次未儲存的變更', tone: 'info' } : null,
  )
  const [problems, setProblems] = useState<Map<string, PartyProblem>>(new Map())
  const [saving, setSaving] = useState(false)
  const [anchor, setAnchor] = useState(0)
  const [help, setHelp] = useState(false)
  /** The members picker (ADR-120), while a group's 成員 cell is edited. */
  const [picker, setPicker] = useState<MemberPick | null>(null)

  const gridRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLElement>(null)
  const history = useRef<{
    undo: Array<Array<PartyRow>>
    redo: Array<Array<PartyRow>>
  }>({ undo: [], redo: [] })
  const pending = useRef({ count: '', op: '' })
  const opened = useRef<{ id: string; from: typeof cursor } | null>(null)

  const states: Array<PartyStatus> = rows.map((r) => partyStatus(r, me))
  const dirty = states.filter((s) => s !== 'clean').length
  const current = rows.at(cursor.row)
  const column = columns[cursor.col]
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
  const spotId = current?.id
  useEffect(() => {
    lastSpot = spotId ? { id: spotId, col: cursor.col } : null
  }, [spotId, cursor.col])
  useEffect(() => {
    writeDraft(rows.some((r) => partyStatus(r, me) !== 'clean') ? rows : null)
  }, [rows, me])
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

  function change(next: Array<PartyRow>) {
    history.current.undo.push(rows)
    if (history.current.undo.length > 200) history.current.undo.shift()
    history.current.redo = []
    setRows(next)
  }

  function clearProblem(id: string) {
    if (!problems.has(id)) return
    const rest = new Map(problems)
    rest.delete(id)
    setProblems(rest)
  }

  function patchRow(id: string, patch: Partial<PartyRow>) {
    const i = rows.findIndex((r) => r.id === id)
    if (i < 0) return
    const row = { ...rows[i], ...patch }
    if (JSON.stringify(row) === JSON.stringify(rows[i])) return
    let next = rows.with(i, row)
    if (patch.kind && patch.kind !== rows[i].kind) {
      next = placeByKind(next, id)
      setCursor((c) => ({ ...c, row: next.findIndex((r) => r.id === id) }))
    }
    change(next)
    clearProblem(id)
  }

  function undo() {
    const prev = history.current.undo.pop()
    if (!prev) return say('已經是最早的狀態')
    history.current.redo.push(rows)
    setRows(prev)
    setCursor((c) => ({ ...c, row: clamp(c.row, prev.length) }))
  }

  function redo() {
    const next = history.current.redo.pop()
    if (!next) return say('已經是最新的狀態')
    history.current.undo.push(rows)
    setRows(next)
    setCursor((c) => ({ ...c, row: clamp(c.row, next.length) }))
  }

  function say(text: string, tone: Message['tone'] = 'info') {
    setMessage({ text, tone })
  }

  function clamp(row: number, length = rows.length) {
    return Math.max(0, Math.min(row, length - 1))
  }

  function moveTo(row: number, col: number) {
    setCursor({
      row: clamp(row),
      col: Math.max(0, Math.min(col, columns.length - 1)),
    })
  }

  // ---------- line commands

  function openRow(after: boolean) {
    const kind: PartyKind = current?.kind ?? 'friend'
    const row = newPartyRow(crypto.randomUUID(), kind)
    const at = insertIndex(
      rows,
      kind,
      rows.length === 0 ? 0 : cursor.row + (after ? 1 : 0),
    )
    change(rows.toSpliced(at, 0, row))
    opened.current = { id: row.id, from: cursor }
    setCursor({ row: at, col: columns.indexOf('name') })
    setEdit('')
    setPick(0)
    setNavigated(false)
    setMode('insert')
    say(
      kind === 'group'
        ? '輸入群組名稱；Tab 到類型（可改成朋友）、成員'
        : '輸入朋友的名字；Tab 到類型可改成群組',
    )
  }

  /** Esc on a new line left empty takes it away again. */
  function dropOpened(): boolean {
    const o = opened.current
    opened.current = null
    if (!o || !current || current.id !== o.id) return false
    if (edit.trim() !== '' || current.base || current.name) return false
    history.current.undo.pop()
    const next = rows.filter((r) => r.id !== o.id)
    setRows(next)
    setCursor({ row: clamp(o.from.row, next.length), col: o.from.col })
    setMode('normal')
    say('已取消新增')
    return true
  }

  /** `dd`: saved lines are marked deleted until :w; new ones go. Again on marked lines takes the mark off. */
  function deleteRange({ from, to }: Range) {
    const targets = rows.slice(from, to + 1)
    if (targets.length === 0) return
    if (targets.every((t) => t.deleted)) {
      const ids = new Set(targets.map((t) => t.id))
      change(rows.map((r) => (ids.has(r.id) ? { ...r, deleted: false } : r)))
      return say(`已取消 ${ids.size} 列的刪除標記`)
    }
    for (const t of targets) {
      const reason = deleteBlocked(t, rows)
      if (reason) return say(reason, 'error')
    }
    const ids = new Set(targets.map((t) => t.id))
    const next = rows.flatMap((r) =>
      !ids.has(r.id) ? [r] : r.base ? [{ ...r, deleted: true }] : [],
    )
    change(next)
    setCursor((c) => ({ ...c, row: clamp(from, next.length) }))
    say(
      `已標記刪除 ${targets.length} 列（:w 儲存後才會刪除，往來帳戶也會一起刪掉），u 可以復原`,
    )
  }

  /** `x`: archive a group or take it out of the archive. */
  function toggleArchived(row: PartyRow | undefined) {
    if (!row) return
    const reason = lockedReason(row, 'archived')
    if (reason) return say(reason, 'error')
    patchRow(row.id, { archived: !row.archived })
    say(
      row.archived
        ? `「${row.name}」會取消封存（:w 儲存）`
        : `「${row.name}」會封存：往來帳戶關閉、分帳不能再改（:w 儲存；要先結清）`,
    )
  }

  /** `gx` / :open: the friend's or group's expenses. */
  function openPage(row: PartyRow | undefined) {
    if (!row) return
    if (!row.base) return say('先 :w 儲存，才能打開它的分帳', 'error')
    if (row.kind === 'friend')
      void navigate({ to: '/friends/$friendId', params: { friendId: row.id } })
    else void navigate({ to: '/groups/$groupId', params: { groupId: row.id } })
  }

  // ---------- cells

  function startInsertAt(index: number, colIndex: number, clear = false) {
    const row = rows.at(index)
    const col = columns[colIndex]
    if (!row) return say('還沒有朋友或群組，按 o 新增')
    const reason = lockedReason(row, col)
    if (reason) return say(reason, 'error')
    if (col === 'archived') return toggleArchived(row)
    if (col === 'members') return openMembers(row)
    setEdit(clear ? '' : partyCellText(row, col, rows))
    setPick(0)
    setNavigated(false)
    setMode('insert')
  }

  /**
   * The members picker (ADR-120): the members as chips with a field after
   * them; typing finds friends not in the group (or offers a new one of
   * that name), Enter adds the highlighted one, Backspace on an empty field
   * takes the last member off, Tab or Esc applies, Ctrl-c leaves it as it
   * was.
   */
  function openMembers(row: PartyRow) {
    setPicker({ members: [...row.members], added: [] })
    setEdit('')
    setPick(0)
    setNavigated(false)
    setMode('insert')
    say(
      '輸入名字找朋友，Enter 加入；沒有這個人就會新增；Backspace 拿掉最後一位；Tab 或 Esc 完成',
    )
  }

  function memberChoicesNow(): ReturnType<typeof memberOptions> {
    if (!picker || !current) return []
    return memberOptions(rows, current, picker, edit)
  }

  function addMember(index: number) {
    const options = memberChoicesNow()
    const option = options.at(index)
    if (!picker || !option) return
    setPicker(takeMember(picker, option, () => crypto.randomUUID()))
    setEdit('')
    setPick(0)
    setNavigated(false)
  }

  function removeMember(id: string) {
    if (!picker || !current) return
    const next = dropMember(picker, current, id, rows)
    if (typeof next === 'string') return say(next, 'error')
    setPicker(next)
    setMessage(null)
  }

  /** Applies the picker to the group; false while it cannot be (no members). */
  function applyMembers(): boolean {
    if (!picker || !current) return true
    const next = applyMemberPick(rows, current.id, picker)
    if (typeof next === 'string') {
      say(next, 'error')
      return false
    }
    if (JSON.stringify(next) !== JSON.stringify(rows)) {
      change(next)
      clearProblem(current.id)
    }
    setPicker(null)
    setEdit('')
    const added = picker.added.filter((a) => picker.members.includes(a.id))
    say(
      added.length > 0
        ? `已加入新朋友 ${added.map((a) => a.name).join('、')}（:w 和群組一起儲存）`
        : '',
    )
    if (added.length === 0) setMessage(null)
    return true
  }

  function runMembers(k: Key): boolean {
    const options = memberChoicesNow()
    // Enter takes the highlighted option once something is typed or picked.
    const choosing = options.length > 0 && (edit.trim() !== '' || navigated)
    switch (k) {
      case '<C-n>':
      case '<Down>':
        setPick(nextPick(options.length, choosing ? pick : -1, 1))
        setNavigated(true)
        return true
      case '<C-p>':
      case '<Up>':
        setPick(nextPick(options.length, choosing ? pick : -1, -1))
        setNavigated(true)
        return true
      case '<CR>':
        if (choosing) addMember(Math.min(pick, options.length - 1))
        else if (edit.trim() !== '') say('沒有符合的朋友', 'error')
        else if (applyMembers()) setMode('normal')
        return true
      case '<Tab>':
      case '<S-Tab>':
      case '<Esc>':
        if (applyMembers()) setMode('normal')
        return true
      case '<C-c>':
        setPicker(null)
        setEdit('')
        setMode('normal')
        say('已取消編輯成員')
        return true
      case '<BS>':
        if (edit !== '' || !picker) return false
        if (picker.members.length > 0)
          removeMember(picker.members[picker.members.length - 1])
        return true
      case '<C-s>':
      case '<D-s>':
        if (applyMembers()) {
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

  function suggestions(): Array<Suggestion> {
    if (picker) return memberChoicesNow()
    if (mode !== 'insert' || !current || column !== 'kind') return []
    return rankCell(
      (Object.keys(kindLabels) as Array<PartyKind>).map((k) => ({
        value: kindLabels[k],
        label: kindLabels[k],
      })),
      edit,
      partyCellText(current, column, rows),
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
    const patch = partyPatch(column, text)
    if (typeof patch === 'string') {
      say(patch, 'error')
      return false
    }
    patchRow(current.id, patch)
    setMessage(null)
    return true
  }

  function finishCell(move: 'stay' | 'next' | 'prev') {
    if (!current || !commitCell(chosenText())) return
    if (move === 'stay') return setMode('normal')
    const patch = partyPatch(column, chosenText())
    const row: PartyRow =
      typeof patch === 'string' ? current : { ...current, ...patch }
    let col = cursor.col
    for (;;) {
      col += move === 'next' ? 1 : -1
      if (col < 0 || col >= columns.length) return setMode('normal')
      const c = columns[col]
      if (c !== 'archived' && !lockedReason(row, c)) break
    }
    setCursor((c) => ({ ...c, col }))
    if (columns[col] === 'members') return openMembers(row)
    setEdit(partyCellText(row, columns[col], rows))
    setPick(0)
    setNavigated(false)
  }

  // ---------- saving

  function messageFor(code: string, fallback: string): string {
    if (partyProblemMessages[code]) return partyProblemMessages[code]
    const known = errorCodeMessage(code)
    return known === '發生未知錯誤' ? fallback : known
  }

  function reportProblems(found: Map<string, PartyProblem>): false {
    setProblems(found)
    const first = rows.findIndex((r) => found.has(r.id))
    const p = found.get(rows[first]?.id ?? '')
    if (first >= 0) {
      const col = p?.field ? columns.indexOf(p.field) : -1
      setCursor({ row: first, col: col >= 0 ? col : cursor.col })
    }
    say(`${found.size} 列有問題，沒有儲存：${p?.message ?? ''}`, 'error')
    return false
  }

  async function save(): Promise<boolean> {
    const found = new Map<string, PartyProblem>()
    for (const [i, row] of rows.entries()) {
      if (states[i] === 'clean') continue
      const p = validateParty(row, rows)
      if (p) found.set(row.id, p)
    }
    if (found.size > 0) return reportProblems(found)
    const body = toBatch(rows, me)
    const count =
      body.friends.length +
      body.groups.length +
      body.deleteFriends.length +
      body.deleteGroups.length
    if (count === 0) {
      say('沒有需要儲存的變更')
      return true
    }
    setSaving(true)
    try {
      const { data, error, response } = await api.POST('/splitting/batch', {
        body,
      })
      if (response.status === 422 && error && 'errors' in error) {
        const fromServer = new Map<string, PartyProblem>()
        for (const p of error.errors)
          fromServer.set(p.id, {
            field: partyProblemColumn(p.field),
            message: messageFor(p.code, p.message),
          })
        return reportProblems(fromServer)
      }
      if (!data) {
        const code = 'code' in error ? String(error.code) : ''
        say(
          `${messageFor(code, '儲存失敗，請稍後再試')}；變更仍保留在草稿裡`,
          'error',
        )
        return false
      }
      const fresh = await reload()
      const next = partyRows(fresh.groups, fresh.friends, me)
      writeDraft(null)
      history.current = { undo: [], redo: [] }
      setRows(next)
      setProblems(new Map())
      setCursor((c) => ({ ...c, row: clamp(c.row, next.length) }))
      say(`已儲存：${data.upserted} 個新增或修改，${data.deleted} 個刪除`)
      return true
    } catch {
      say('無法連線至伺服器；變更仍保留在草稿裡', 'error')
      return false
    } finally {
      setSaving(false)
    }
  }

  function discard() {
    const fresh = partyRows(groups, friends, me)
    writeDraft(null)
    change(fresh)
    setProblems(new Map())
    setCursor((c) => ({ ...c, row: clamp(c.row, fresh.length) }))
    say('已放棄所有未儲存的變更（u 可以復原）')
  }

  async function runCommand(raw: string) {
    const cmd = raw.trim()
    setMode('normal')
    setCommand('')
    if (cmd === 'w') await save()
    else if (cmd === 'e!') discard()
    else if (cmd === 'open') openPage(current)
    else if (cmd === 'archive' || cmd === 'unarchive') {
      if (current && current.archived !== (cmd === 'archive'))
        toggleArchived(current)
    } else if (/^winc(md)? [hjkl]$/.test(cmd)) {
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

    if (p.op) {
      const op = p.op + k
      if (op === 'dd') return done(() => deleteRange(counted))
      if (op === 'gg')
        return done(() => moveTo(p.count ? count - 1 : 0, cursor.col))
      if (op === 'gx') return done(() => openPage(current))
      const dir = p.op === '<C-w>' ? windowDirection(k) : null
      if (dir) return done(() => movePane(dir, gridRef.current))
      pending.current = { count: '', op: '' }
      return true
    }

    switch (k) {
      case 'j':
      case '<Down>':
        return done(() => moveTo(cursor.row + count, cursor.col))
      case 'k':
      case '<Up>':
        return done(() => moveTo(cursor.row - count, cursor.col))
      case 'l':
      case '<Right>':
      case 'w':
      case '<Tab>':
        return done(() => moveTo(cursor.row, cursor.col + count))
      case 'h':
      case '<Left>':
      case 'b':
      case '<S-Tab>':
        return done(() => moveTo(cursor.row, cursor.col - count))
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
    }

    if (visual) {
      const range = selection ?? counted
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
          setAnchor(cursor.row)
          setMode('visual')
        })
      case 'd':
        pending.current = { count: p.count, op: k }
        return true
      case 'i':
      case 'a':
      case '<CR>':
      case '<F2>':
        return done(() => startInsertAt(cursor.row, cursor.col))
      case 'c':
      case 's':
        return done(() => startInsertAt(cursor.row, cursor.col, true))
      case 'o':
        return done(() => openRow(true))
      case 'O':
        return done(() => openRow(false))
      case 'x':
        return done(() => toggleArchived(current))
      case 'u':
        return done(undo)
      case '<C-r>':
        return done(redo)
      case 'y':
      case 'p':
      case 'P':
        return done(() => say('這一頁不複製；新增按 o'))
      case '<Esc>':
        return done(() => setMessage(null))
      default:
        pending.current = { count: '', op: '' }
        return false
    }
  }

  function runInsert(k: Key): boolean {
    if (picker) return runMembers(k)
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
        finishCell('next')
        return true
      case '<S-Tab>':
        finishCell('prev')
        return true
      case '<CR>':
        finishCell('stay')
        return true
      case '<Esc>':
        if (dropOpened()) return true
        if (edit.trim() === '' && column === 'name' && current?.name === '')
          return true
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

  const feed = useKeyFeed(keymap, 'friends', (k) => {
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

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div
        ref={gridRef}
        tabIndex={0}
        role="grid"
        aria-label="分帳"
        aria-rowcount={rows.length}
        data-pane="friends"
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
                    rightColumns.has(c) && 'justify-end',
                    c === 'archived' && 'justify-center',
                  )}
                >
                  {partyLabels[c]}
                </span>
              ))}
            </div>

            {rows.length === 0 && (
              <p className="px-4 py-6 text-sm text-muted-foreground">
                還沒有朋友或群組。按{' '}
                <kbd className="font-mono text-foreground">o</kbd>{' '}
                輸入朋友的名字；類型改成「群組」就是一起出遊或同住的群組。
              </p>
            )}

            <div
              style={{ height: rows.length * ROW_HEIGHT }}
              className="relative"
            >
              {selection && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 border-l-2 border-kraft bg-kraft/15"
                  style={{
                    top: selection.from * ROW_HEIGHT,
                    height: (selection.to - selection.from + 1) * ROW_HEIGHT,
                  }}
                />
              )}
              {current && (
                <>
                  <div
                    aria-hidden
                    className="pointer-events-none absolute inset-x-0 bg-accent/50"
                    style={{ top: cursor.row * ROW_HEIGHT, height: ROW_HEIGHT }}
                  />
                  {mode !== 'insert' && (
                    <div
                      aria-hidden
                      className="pointer-events-none absolute z-10 border-2 border-kraft/40 group-focus:border-kraft"
                      style={{
                        top: cursor.row * ROW_HEIGHT,
                        left: layout.lefts[column],
                        width: layout.widths[column],
                        height: ROW_HEIGHT,
                      }}
                    />
                  )}
                </>
              )}

              {rows.map((row, index) => (
                <PartyLine
                  key={row.id}
                  row={row}
                  rows={rows}
                  index={index}
                  layout={layout}
                  state={states[index]}
                  problem={problems.get(row.id)}
                  minorUnits={minorUnits}
                  first={index > 0 && rows[index - 1].kind !== row.kind}
                  onPick={(col, enter) => {
                    if (mode === 'insert') {
                      if (picker ? !applyMembers() : !commitCell(chosenText()))
                        return
                    }
                    setMode('normal')
                    setCursor({ row: index, col })
                    if (enter) startInsertAt(index, col)
                  }}
                />
              ))}

              {mode === 'insert' && current && (
                <div
                  className="absolute z-30"
                  style={{
                    top: cursor.row * ROW_HEIGHT,
                    left: layout.lefts[column],
                    width: layout.widths[column],
                  }}
                >
                  <CellEditor
                    inputRef={inputRef}
                    value={edit}
                    label={picker ? '找朋友或輸入新名字' : partyLabels[column]}
                    enterHint={picker ? 'Enter 完成' : undefined}
                    width={layout.widths[column]}
                    options={feed.waiting ? [] : options}
                    pick={
                      picker
                        ? options.length > 0 &&
                          (edit.trim() !== '' || navigated)
                          ? Math.min(pick, options.length - 1)
                          : -1
                        : takenIndex(options)
                    }
                    chips={
                      picker
                        ? picker.members.map((id) => (
                            <MemberChip
                              key={id}
                              name={memberName(rows, current, id, picker.added)}
                              locked={memberLocked(current, id, rows)}
                              onRemove={() => removeMember(id)}
                              // The text typed after them is the next one.
                              comma
                            />
                          ))
                        : undefined
                    }
                    onChange={(value) => {
                      setEdit(value)
                      setPick(0)
                      setNavigated(false)
                    }}
                    onKeyDown={(e) =>
                      feed.onInsertKeyDown(e, (n) =>
                        setEdit(eraseBeforeCaret(inputRef.current, edit, n)),
                      )
                    }
                    onChoose={(i) => {
                      if (picker) return addMember(i)
                      opened.current = null
                      setEdit(options[i].value)
                      setPick(i)
                      setNavigated(true)
                    }}
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <KeyHelp
        open={help}
        onClose={() => setHelp(false)}
        keymap={keymap}
        groups={splittingKeys}
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
              ? `已選 ${selection.to - selection.from + 1} 列 · d 刪除 · Esc 取消`
              : 'hjkl 移動 · gx 打開分帳 · i 編輯 · o 新增 · x 封存 · :w 儲存 · ? 快捷鍵'}
          </span>
        )}
      </div>
    </div>
  )
}

function balanceOfRow(row: PartyRow): number {
  return row.base?.balance ?? 0
}

function PartyLine({
  row,
  rows,
  index,
  layout,
  state,
  problem,
  minorUnits,
  first,
  onPick,
}: {
  row: PartyRow
  rows: Array<PartyRow>
  index: number
  layout: Layout
  state: PartyStatus
  problem: PartyProblem | undefined
  minorUnits: number
  /** The first line of its kind after the other kind's: a rule above it. */
  first: boolean
  onPick: (col: number, enter: boolean) => void
}) {
  const marker = problem
    ? '!'
    : { clean: '', new: '+', changed: '~', deleted: '-' }[state]
  const cell = 'flex items-center overflow-hidden px-2 whitespace-nowrap'
  const muted = 'text-muted-foreground'
  const balance = balanceOfRow(row)

  function content(c: PartyColumn, col: number): React.ReactNode {
    const bad = problem?.field === c && 'text-destructive'
    switch (c) {
      case 'name':
        return (
          <span key={c} data-col={col} className={cn(cell, bad)}>
            <span className="truncate">{row.name}</span>
            {registered(row) && (
              <span className="ml-2 shrink-0 text-xs text-muted-foreground">
                有帳號
              </span>
            )}
            {/* The mouse's way to the expenses, as gx is the keyboard's. */}
            {row.base && !row.deleted && (
              <Link
                {...(row.kind === 'friend'
                  ? { to: '/friends/$friendId', params: { friendId: row.id } }
                  : { to: '/groups/$groupId', params: { groupId: row.id } })}
                tabIndex={-1}
                aria-label={`打開「${row.name}」的分帳`}
                title="打開分帳（gx）"
                className="ml-auto flex shrink-0 items-center gap-0.5 pl-2 text-xs text-muted-foreground opacity-60 group-hover/row:opacity-100 hover:text-kraft"
                onMouseDown={(e) => {
                  // The cursor goes to the line, where Ctrl-o comes back to.
                  e.stopPropagation()
                  onPick(col, false)
                }}
              >
                分帳
                <ArrowUpRightIcon className="size-3.5" />
              </Link>
            )}
          </span>
        )
      case 'kind':
        return (
          <span key={c} data-col={col} className={cn(cell, muted, bad)}>
            {kindLabels[row.kind]}
          </span>
        )
      case 'members':
        return (
          <span
            key={c}
            data-col={col}
            className={cn(cell, 'gap-1.5', bad)}
            title={row.kind === 'group' ? membersText(row, rows) : undefined}
          >
            {row.kind === 'group' ? (
              row.members.map((id, i) => (
                <MemberChip
                  key={id}
                  name={memberName(rows, row, id)}
                  locked={memberLocked(row, id, rows)}
                  comma={i < row.members.length - 1}
                />
              ))
            ) : (
              <span className={muted}>—</span>
            )}
          </span>
        )
      case 'count':
        return (
          <span
            key={c}
            data-col={col}
            className={cn(
              cell,
              'justify-end font-mono text-xs tabular-nums',
              muted,
            )}
          >
            {row.base ? expenseCount(row) : ''}
          </span>
        )
      case 'balance':
        return (
          <span
            key={c}
            data-col={col}
            className={cn(
              cell,
              'amount justify-end',
              !row.base || row.deleted
                ? muted
                : balance > 0
                  ? 'text-positive'
                  : balance < 0
                    ? 'amount-negative'
                    : muted,
            )}
          >
            {row.base ? partyBalanceText(row, minorUnits) : ''}
          </span>
        )
      case 'archived':
        return (
          <span
            key={c}
            data-col={col}
            className={cn(cell, 'justify-center', muted, bad)}
          >
            {row.kind === 'friend' ? (
              '—'
            ) : row.archived ? (
              <CheckIcon
                className="size-4 text-foreground"
                aria-label="已封存"
              />
            ) : (
              ''
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
        'group/row absolute inset-x-0 grid border-b border-rule/60 text-sm leading-normal',
        first && 'border-t border-t-rule',
        row.deleted && 'text-muted-foreground line-through',
        row.archived && !row.deleted && 'text-muted-foreground',
      )}
      style={{
        top: index * ROW_HEIGHT,
        height: ROW_HEIGHT,
        gridTemplateColumns: layout.template,
      }}
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
      {partyColumns.map((c, col) => content(c, col))}
    </div>
  )
}

/**
 * A group's member as the 成員 cell shows them, in normal mode and in the
 * picker alike (ADR-120): their name as plain text, a lock when expenses
 * keep them in the group, in the picker a button to take them off, and a
 * comma before the next.
 */
function MemberChip({
  name,
  locked,
  onRemove,
  comma,
}: {
  name: string
  locked: string | null
  onRemove?: () => void
  comma?: boolean
}) {
  return (
    <span
      title={locked ?? undefined}
      className="flex h-6 shrink-0 items-center gap-1 text-sm text-foreground"
    >
      {name}
      {locked ? (
        <LockIcon
          aria-label="有分帳，不能移除"
          className="size-3 text-muted-foreground"
        />
      ) : (
        onRemove && (
          <button
            type="button"
            tabIndex={-1}
            aria-label={`移除${name}`}
            className="text-muted-foreground hover:text-destructive"
            onMouseDown={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onRemove()
            }}
          >
            <XIcon className="size-3" />
          </button>
        )
      )}
      {comma && <span className="-ml-0.5 text-muted-foreground">,</span>}
    </span>
  )
}
