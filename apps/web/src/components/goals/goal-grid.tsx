import { CheckIcon, LinkIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '#/lib/api'
import { errorCodeMessage } from '#/lib/apiError'
import { setEditorStatus } from '#/lib/editorStatus'
import {
  amountText,
  derivedColumns,
  etaText,
  goalCategories,
  goalCellText,
  goalColumns,
  goalFigures,
  goalLabels,
  goalPatch,
  goalProblemColumn,
  goalStatus,
  kindLabels,
  newGoalRow,
  parseKind,
  rowFromGoal,
  statusLabels,
  toGoalInput,
  usesColumn,
  validateGoal,
} from '#/lib/goals'
import { formatAmount } from '#/lib/money'
import { movePane, windowDirection } from '#/lib/panes'
import {
  findCategory,
  formatDate,
  isoDate,
  problemMessages,
  rank,
} from '#/lib/register'
import { cn } from '#/lib/utils'
import { CellEditor, eraseBeforeCaret, nextPick } from '../register/cell-editor'
import { KeyHelp, goalKeys } from '../register/key-help'
import { useKeyFeed } from '../register/use-key-feed'
import type {
  Goal,
  GoalColumn,
  GoalFigures,
  GoalList,
  GoalProblem,
  GoalRow,
  GoalRowStatus,
} from '#/lib/goals'
import type { Key, Keymap } from '#/lib/keymap'
import type { Context } from '#/lib/register'
import type { Suggestion } from '../register/cell-editor'

// The goals page (ADR-094): a grid edited as the schedules page is, whose
// line order is the goals' priority; saved with :w through the batch
// endpoint, drafts kept locally (ADR-043).

const ROW_HEIGHT = 32
const GUTTER = 28
const widths: Record<GoalColumn, number> = {
  name: 150,
  category: 128,
  kind: 96,
  target: 104,
  date: 92,
  monthly: 96,
  saved: 128,
  ask: 92,
  eta: 120,
  status: 72,
  wait: 84,
  url: 112,
  note: 140,
}
const stretch: Partial<Record<GoalColumn, number>> = {
  name: 0.3,
  category: 0.2,
  note: 0.4,
  url: 0.1,
}
const amountColumns: ReadonlySet<GoalColumn> = new Set([
  'target',
  'monthly',
  'saved',
  'ask',
])

interface Layout {
  lefts: Record<GoalColumn, number>
  widths: Record<GoalColumn, number>
  template: string
  width: number
}

function layoutOf(room: number): Layout {
  const least = goalColumns.reduce((sum, c) => sum + widths[c], GUTTER)
  const extra = Math.max(0, room - least)
  const lefts = {} as Record<GoalColumn, number>
  const sized = {} as Record<GoalColumn, number>
  let x = GUTTER
  for (const c of goalColumns) {
    sized[c] = widths[c] + Math.floor(extra * (stretch[c] ?? 0))
    lefts[c] = x
    x += sized[c]
  }
  return {
    lefts,
    widths: sized,
    template: `${GUTTER}px ${goalColumns.map((c) => `${sized[c]}px`).join(' ')}`,
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

/** A line's state: its content, or only its place in the priority. */
type LineState = GoalRowStatus | 'moved'

interface Props {
  budgetId: string
  ctx: Context
  /** Every expense category to the envelope it is budgeted in. */
  envelopes: Map<string, string>
  /** The goals and what the projection needs, as last loaded. */
  list: GoalList
  keymap: Keymap
  /** Fetches the goals again. */
  reload: () => Promise<GoalList>
  onQuit: () => void
}

const DRAFT_VERSION = 1

interface Draft {
  version: number
  rows: Array<GoalRow>
  /** Every line's id in the page's order (the priority). */
  order: Array<string>
}

function draftKey(budgetId: string): string {
  return `factual:goals:${budgetId}`
}

function readDraft(key: string): Draft | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<Draft>
    return parsed.version === DRAFT_VERSION &&
      Array.isArray(parsed.rows) &&
      Array.isArray(parsed.order)
      ? (parsed as Draft)
      : null
  } catch {
    return null
  }
}

function writeDraft(key: string, rows: Array<GoalRow> | null): void {
  try {
    if (!rows) localStorage.removeItem(key)
    else
      localStorage.setItem(
        key,
        JSON.stringify({
          version: DRAFT_VERSION,
          rows: rows.filter((r) => goalStatus(r) !== 'clean'),
          order: rows.map((r) => r.id),
        } satisfies Draft),
      )
  } catch {
    // Drafts are a convenience (ADR-043).
  }
}

function initialRows(goals: Array<Goal>, draft: Draft | null): Array<GoalRow> {
  const saved = goals.map(rowFromGoal)
  if (!draft) return saved
  const at = new Map(saved.map((r, i) => [r.id, i]))
  const fresh: Array<GoalRow> = []
  for (const d of draft.rows) {
    if (!d.base) {
      fresh.push(d)
      continue
    }
    const i = at.get(d.id)
    if (i === undefined) continue
    saved[i] = { ...d, base: saved[i].base }
  }
  const place = new Map(draft.order.map((id, i) => [id, i]))
  return [...fresh, ...saved].toSorted(
    (a, b) =>
      (place.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
      (place.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  )
}

/** Each line's place in the priority: its index among the lines kept. */
function priorities(rows: Array<GoalRow>): Map<string, number> {
  return new Map(rows.filter((r) => !r.deleted).map((r, i) => [r.id, i]))
}

export function GoalGrid({
  budgetId,
  ctx,
  envelopes,
  list,
  keymap,
  reload,
  onQuit,
}: Props) {
  const key = draftKey(budgetId)
  const [room, setRoom] = useState(0)
  const layout = layoutOf(room)
  const columns = goalColumns
  const [rows, setRows] = useState<Array<GoalRow>>(() =>
    initialRows(list.goals, readDraft(key)),
  )
  const [cursor, setCursor] = useState({ row: 0, col: 0 })
  const [mode, setMode] = useState<Mode>('normal')
  const [edit, setEdit] = useState('')
  const [pick, setPick] = useState(0)
  const [navigated, setNavigated] = useState(false)
  const [command, setCommand] = useState('')
  const [message, setMessage] = useState<Message | null>(() =>
    readDraft(key) ? { text: '已還原上次未儲存的變更', tone: 'info' } : null,
  )
  const [problems, setProblems] = useState<Map<string, GoalProblem>>(new Map())
  const [saving, setSaving] = useState(false)
  const [anchor, setAnchor] = useState(0)
  const [bulk, setBulk] = useState(false)
  const [help, setHelp] = useState(false)

  const gridRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const history = useRef<{
    undo: Array<Array<GoalRow>>
    redo: Array<Array<GoalRow>>
  }>({ undo: [], redo: [] })
  const pending = useRef({ count: '', op: '' })
  const yanked = useRef<Array<GoalRow>>([])
  const lastChange = useRef<{ op: 'd' | 'p' | 'P'; lines: number } | null>(null)
  const lastVisual = useRef<{ anchor: number; row: number } | null>(null)
  const commandRange = useRef<Range | null>(null)
  const opened = useRef<{ id: string; from: typeof cursor } | null>(null)

  const now = new Date()
  const today = isoDate(now)
  const places = priorities(rows)
  const states: Array<LineState> = rows.map((r) => {
    const s = goalStatus(r)
    return s === 'clean' && r.base && places.get(r.id) !== r.base.sortOrder
      ? 'moved'
      : s
  })
  const dirty = states.filter((s) => s !== 'clean').length
  const { figures, summary } = goalFigures(rows, list, envelopes, today)
  /** What the saved goals would show, to point out what a change moves. */
  const before = goalFigures(
    list.goals.map(rowFromGoal),
    list,
    envelopes,
    today,
  ).figures
  const current = rows.at(cursor.row)
  const column = columns[cursor.col]
  const selection: Range | null =
    mode === 'visual' || (mode === 'insert' && bulk)
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
    const unsaved = rows.some(
      (r) =>
        goalStatus(r) !== 'clean' ||
        (r.base && priorities(rows).get(r.id) !== r.base.sortOrder),
    )
    writeDraft(key, unsaved ? rows : null)
  }, [key, rows])
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
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const top = (cursor.row + 1) * ROW_HEIGHT
    if (top < el.scrollTop + ROW_HEIGHT) el.scrollTop = top - ROW_HEIGHT
    else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight)
      el.scrollTop = top + ROW_HEIGHT - el.clientHeight
  }, [cursor.row])

  // ---------- buffer changes

  function change(next: Array<GoalRow>) {
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

  /** Changes rows by id as one undo step; returns how many changed. */
  function patchRows(
    ids: Array<string>,
    patchOf: (row: GoalRow) => Partial<GoalRow> | null,
  ): number {
    let next = rows
    const changed: Array<string> = []
    for (const id of ids) {
      const i = next.findIndex((r) => r.id === id)
      if (i < 0) continue
      const patch = patchOf(next[i])
      if (!patch) continue
      const row = { ...next[i], ...patch }
      if (JSON.stringify(row) === JSON.stringify(next[i])) continue
      next = next.with(i, row)
      changed.push(id)
    }
    if (changed.length === 0) return 0
    change(next)
    clearProblems(changed)
    return changed.length
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

  function idsIn({ from, to }: Range): Array<string> {
    return rows.slice(from, to + 1).map((r) => r.id)
  }

  // ---------- line commands

  function openRow(at: number) {
    const row = newGoalRow(crypto.randomUUID(), null)
    const index = Math.max(0, Math.min(at, rows.length))
    change(rows.toSpliced(index, 0, row))
    opened.current = { id: row.id, from: cursor }
    setCursor({ row: index, col: columns.indexOf('name') })
    setEdit('')
    setPick(0)
    setNavigated(false)
    setBulk(false)
    setMode('insert')
    say('輸入名稱，例如：羽球拍、日本旅遊、備用金；Tab 到下一欄')
  }

  function dropOpened(): boolean {
    const o = opened.current
    opened.current = null
    if (!o || !current || current.id !== o.id || bulk) return false
    if (edit.trim() !== '' || current.base || current.name) return false
    if (current.targetAmount || current.monthlyAmount || current.note)
      return false
    history.current.undo.pop()
    const next = rows.filter((r) => r.id !== o.id)
    setRows(next)
    setCursor({ row: clamp(o.from.row, next.length), col: o.from.col })
    setMode('normal')
    say('已取消新增')
    return true
  }

  /**
   * `dd`: lines leave their place as in Vim. Saved goals go to the bottom,
   * marked deleted until :w, and stay in the register for `p`, which puts
   * the same goal back at the cursor: `ddp` moves a goal one down the
   * priority, `ddkP` one up. Unsaved lines are removed. `dd` on lines
   * already marked takes the mark off.
   */
  function deleteRange({ from, to }: Range) {
    const targets = rows.slice(from, to + 1)
    if (targets.length === 0) return
    const restore = targets.every((t) => t.deleted)
    const ids = new Set(targets.map((t) => t.id))
    lastChange.current = { op: 'd', lines: to - from + 1 }
    if (restore) {
      change(rows.map((r) => (ids.has(r.id) ? { ...r, deleted: false } : r)))
      return say(`已取消 ${ids.size} 個目標的刪除標記`)
    }
    yanked.current = targets.map((r) => ({ ...r, deleted: false }))
    const marked = targets
      .filter((t) => t.base)
      .map((t) => ({ ...t, deleted: true }))
    const next = [...rows.filter((r) => !ids.has(r.id)), ...marked]
    change(next)
    setCursor((c) => ({ ...c, row: clamp(from, next.length) }))
    say(
      marked.length > 0
        ? `已標記刪除 ${marked.length} 個目標，移到最下面（:w 儲存後才會刪除）；p 貼回別處就是調整優先序，u 可以復原`
        : `已移除 ${targets.length} 個未儲存的目標，u 可以復原，p 可以貼上`,
    )
  }

  function yank(range: Range) {
    const picked = rows.slice(range.from, range.to + 1)
    if (picked.length === 0) return
    // Copies are new goals; only a deleted goal is put back as itself.
    yanked.current = picked.map((r) => ({ ...r, deleted: false, base: null }))
    setCursor((c) => ({ ...c, row: range.from }))
    say(`已複製 ${picked.length} 個目標（p 貼上）`)
  }

  function paste(after: boolean) {
    if (yanked.current.length === 0) {
      return say('還沒有複製任何目標（yy，或 V 選取後按 y）')
    }
    // A goal marked deleted in this buffer moves to the cursor; anything
    // else becomes a new goal.
    const marked = new Set(rows.filter((r) => r.deleted).map((r) => r.id))
    const moving = new Set<string>()
    const lines = yanked.current.map((r) => {
      if (r.base && marked.has(r.id)) {
        moving.add(r.id)
        return { ...r, deleted: false }
      }
      return { ...r, id: crypto.randomUUID(), base: null, deleted: false }
    })
    const at = rows.length === 0 ? 0 : cursor.row + (after ? 1 : 0)
    const index = at - rows.slice(0, at).filter((r) => moving.has(r.id)).length
    const kept = rows.filter((r) => !moving.has(r.id))
    const next = kept.toSpliced(index, 0, ...lines)
    change(next)
    setCursor((c) => ({ ...c, row: clamp(index, next.length) }))
    lastChange.current = { op: after ? 'p' : 'P', lines: 1 }
    if (moving.size > 0) {
      // Put back once; pasting again makes copies.
      yanked.current = yanked.current.map((r) => ({ ...r, base: null }))
      say(`已調整 ${moving.size} 個目標的優先序（:w 儲存）`)
    } else if (lines.length > 1) say(`已貼上 ${lines.length} 個目標`)
  }

  function repeat() {
    const last = lastChange.current
    if (!last) return say('沒有可以重複的動作')
    if (last.op === 'd') {
      return deleteRange({ from: cursor.row, to: cursor.row + last.lines - 1 })
    }
    paste(last.op === 'p')
  }

  function setFlag(range: Range, flag: 'achieved' | 'archived', on: boolean) {
    const n = patchRows(idsIn(range), (r) =>
      r.deleted ? null : { [flag]: on },
    )
    const word = flag === 'achieved' ? '達成' : '封存'
    say(
      n === 0
        ? on
          ? `選取的目標都已${word}`
          : `選取的目標都沒有${word}`
        : on
          ? `已標記${word} ${n} 個目標：不再分到預算的錢（:w 儲存）`
          : `已取消 ${n} 個目標的${word}（:w 儲存）`,
    )
  }

  function setWait(range: Range, arg: string) {
    const days = arg === '' ? 30 : Number(arg)
    if (!Number.isInteger(days) || days < 0 || days > 3650)
      return say('冷靜期是 0 到 3650 天，例如 :wait 30', 'error')
    const until = new Date(now)
    until.setDate(until.getDate() + days)
    const date = days === 0 ? null : isoDate(until)
    const n = patchRows(idsIn(range), (r) =>
      r.deleted ? null : { waitUntil: date },
    )
    say(
      n === 0
        ? '沒有改變'
        : date
          ? `${n} 個目標考慮到 ${formatDate(date, now)}：存滿了也先顯示冷靜中（:w 儲存）`
          : `已取消 ${n} 個目標的冷靜期（:w 儲存）`,
    )
  }

  function openLink() {
    if (!current?.url) return say('這個目標沒有連結', 'error')
    window.open(current.url, '_blank', 'noopener,noreferrer')
  }

  // ---------- visual mode

  function startVisual(from: number, to: number) {
    if (rows.length === 0) return say('沒有目標，按 o 新增一個')
    setAnchor(clamp(from))
    setCursor((c) => ({ ...c, row: clamp(to) }))
    setMessage(null)
    setMode('visual')
  }

  function endVisual() {
    lastVisual.current = { anchor, row: cursor.row }
    setBulk(false)
    setMode('normal')
  }

  function changeSelection(range: Range) {
    if (column === 'name') return say('名稱要一個一個改', 'error')
    if (derivedColumns.has(column))
      return say('這一欄是算出來的，不能修改', 'error')
    const usable = rows
      .slice(range.from, range.to + 1)
      .filter((r) => !r.deleted)
    if (usable.length === 0) return say('選取的目標都已標記刪除', 'error')
    setEdit('')
    setPick(0)
    setNavigated(false)
    setBulk(true)
    setMode('insert')
    say(
      `輸入的${goalLabels[column]}會套用到 ${usable.length} 個目標；Enter 套用，沒輸入就按 Esc 取消`,
    )
  }

  function commitBulk(text: string, cancelIfEmpty: boolean): boolean {
    if (!selection) return true
    if (cancelIfEmpty && text.trim() === '') {
      endVisual()
      say('沒有輸入，未修改任何目標')
      return true
    }
    let error = ''
    let skipped = 0
    const changed = patchRows(idsIn(selection), (row) => {
      if (row.deleted || !usesColumn(row.kind, column)) {
        skipped++
        return null
      }
      const patch = goalPatch(row, column, text, ctx, envelopes, today)
      if (typeof patch === 'string') {
        error ||= patch
        skipped++
        return null
      }
      return patch
    })
    if (error && changed === 0) {
      say(error, 'error')
      return false
    }
    lastVisual.current = { anchor, row: cursor.row }
    setBulk(false)
    setCursor((c) => ({ ...c, row: selection.from }))
    say(
      `已修改 ${changed} 個目標的${goalLabels[column]}${
        skipped > 0 ? `，略過 ${skipped} 個` : ''
      }${error ? `（${error}）` : ''}`,
      error ? 'error' : 'info',
    )
    return true
  }

  // ---------- cells

  function editable(row: GoalRow, col: GoalColumn): string | null {
    if (row.deleted) return '這個目標已標記刪除，按 u 復原或 dd 取消'
    if (derivedColumns.has(col)) {
      return {
        saved: '已存是從預算的餘額依優先序分來的：到預算頁分配',
        ask: '本月是這個目標這個月要的金額，:fill 會分配到它的預算',
        eta: '預計完成是用每月可自由分配的錢推算的',
        status: '狀態是算出來的：:done 標記達成，:archive 封存',
      }[col as 'saved' | 'ask' | 'eta' | 'status']
    }
    if (!usesColumn(row.kind, col)) {
      if (col === 'date') return '只有「期限前存到」有期限'
      if (col === 'target') return '每月固定沒有目標金額'
      return '期限前存到每月要存多少是算出來的（看「本月」）'
    }
    return null
  }

  function startInsertAt(index: number, colIndex: number, clear = false) {
    const row = rows.at(index)
    const col = columns[colIndex]
    if (!row) return say('沒有目標，按 o 新增一個')
    const reason = editable(row, col)
    if (reason) return say(reason, 'error')
    setEdit(clear ? '' : goalCellText(row, col, ctx))
    setPick(0)
    setNavigated(false)
    setBulk(false)
    setMode('insert')
  }

  function suggestions(): Array<Suggestion> {
    if (mode !== 'insert' || !current) return []
    switch (column) {
      case 'category':
        return rank(goalCategories(ctx, envelopes), edit, (c) => c.path).map(
          (c) => ({ value: c.path, label: c.path }),
        )
      case 'kind': {
        const labels = Object.values(kindLabels)
        // The cell's own label (i on the cell) still lists every kind.
        const typed =
          edit.trim() === kindLabels[current.kind] ? null : parseKind(edit)
        // Typing narrows the list to the kind it names (維 → 維持水位).
        return (typed ? [kindLabels[typed]] : labels).map((label) => ({
          value: label,
          label,
        }))
      }
      default:
        return []
    }
  }

  function chosenText(): string {
    const options = suggestions()
    if (options.length === 0) return edit
    const highlighted = options[Math.min(pick, options.length - 1)].value
    if (navigated) return highlighted
    if (edit === '') return edit
    if (column === 'category') {
      return findCategory(edit, ctx.categories.values()) ? edit : highlighted
    }
    if (column === 'kind') return parseKind(edit) ? edit : highlighted
    return edit
  }

  function takenIndex(options: Array<Suggestion>): number {
    if (options.length === 0) return -1
    const text = chosenText()
    const value =
      column === 'category'
        ? (findCategory(text, ctx.categories.values())?.path ?? text)
        : text
    return options.findIndex((o) => o.value === value)
  }

  function commitCell(text: string, cancelIfEmpty = false): GoalRow | null {
    if (!current) return null
    if (bulk) return commitBulk(text, cancelIfEmpty) ? current : null
    opened.current = null
    const patch = goalPatch(current, column, text, ctx, envelopes, today)
    if (typeof patch === 'string') {
      say(patch, 'error')
      return null
    }
    const next = { ...current, ...patch }
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      change(rows.with(cursor.row, next))
      clearProblems([current.id])
    }
    setMessage(null)
    return next
  }

  function finishCell(move: 'stay' | 'next' | 'prev'): void {
    const row = commitCell(chosenText())
    if (!row) return
    if (move === 'stay' || bulk) {
      setMode('normal')
      return
    }
    let col = cursor.col
    for (;;) {
      col += move === 'next' ? 1 : -1
      if (col < 0 || col >= columns.length) {
        setMode('normal')
        return
      }
      if (!editable(row, columns[col])) break
    }
    setCursor((c) => ({ ...c, col }))
    setEdit(goalCellText(row, columns[col], ctx))
    setPick(0)
    setNavigated(false)
  }

  // ---------- saving

  function messageFor(code: string, fallback: string): string {
    if (problemMessages[code]) return problemMessages[code]
    const known = errorCodeMessage(code)
    return known === '發生未知錯誤' ? fallback : known
  }

  async function save(): Promise<boolean> {
    const found = new Map<string, GoalProblem>()
    for (const [i, row] of rows.entries()) {
      if (states[i] === 'clean' || states[i] === 'moved') continue
      const p = validateGoal(row, envelopes)
      if (p) found.set(row.id, p)
    }
    if (found.size > 0) return reportProblems(found)
    const upserts = rows
      .filter((_, i) => states[i] !== 'clean' && states[i] !== 'deleted')
      .map((r) => toGoalInput(r, places.get(r.id) ?? 0))
    const deletes = rows.filter((r) => r.deleted && r.base).map((r) => r.id)
    if (upserts.length === 0 && deletes.length === 0) {
      say('沒有需要儲存的變更')
      return true
    }
    setSaving(true)
    try {
      const { data, error, response } = await api.POST(
        '/budgets/{budgetId}/goals/batch',
        { params: { path: { budgetId } }, body: { upserts, deletes } },
      )
      if (response.status === 422 && error && 'errors' in error) {
        const fromServer = new Map<string, GoalProblem>()
        for (const p of error.errors) {
          fromServer.set(p.id, {
            field: goalProblemColumn(p.field),
            message: messageFor(p.code, p.message),
          })
        }
        return reportProblems(fromServer)
      }
      if (!data) {
        say('儲存失敗，請稍後再試；變更仍保留在草稿裡', 'error')
        return false
      }
      const fresh = await reload()
      const next = fresh.goals.map(rowFromGoal)
      writeDraft(key, null)
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

  function reportProblems(found: Map<string, GoalProblem>): false {
    setProblems(found)
    const first = rows.findIndex((r) => found.has(r.id))
    const p = found.get(rows[first]?.id ?? '')
    if (first >= 0) {
      const col = p?.field ? columns.indexOf(p.field) : -1
      setCursor({ row: first, col: col >= 0 ? col : cursor.col })
    }
    say(`${found.size} 個目標有問題，沒有儲存：${p?.message ?? ''}`, 'error')
    return false
  }

  function discard() {
    const fresh = list.goals.map(rowFromGoal)
    writeDraft(key, null)
    change(fresh)
    setProblems(new Map())
    setCursor((c) => ({ ...c, row: clamp(c.row, fresh.length) }))
    say('已放棄所有未儲存的變更（u 可以復原）')
  }

  async function runCommand(raw: string) {
    const cmd = raw.trim()
    const range = commandRange.current ?? { from: cursor.row, to: cursor.row }
    commandRange.current = null
    setMode('normal')
    setCommand('')
    const [name, ...rest] = cmd.split(/\s+/)
    const arg = rest.join(' ')
    if (cmd === 'w') {
      await save()
    } else if (cmd === 'wq' || cmd === 'x') {
      if (await save()) onQuit()
    } else if (cmd === 'q') {
      if (dirty > 0)
        say(
          `還有 ${dirty} 個目標未儲存（:w 儲存，:q! 離開並保留草稿）`,
          'error',
        )
      else onQuit()
    } else if (cmd === 'q!') {
      onQuit()
    } else if (cmd === 'e!') {
      discard()
    } else if (name === 'done' || name === 'undone') {
      setFlag(range, 'achieved', name === 'done')
    } else if (name === 'archive' || name === 'unarchive') {
      setFlag(range, 'archived', name === 'archive')
    } else if (name === 'wait') {
      setWait(range, arg)
    } else if (name === 'open') {
      openLink()
    } else if (/^winc(md)? [hjkl]$/.test(cmd)) {
      const dir = windowDirection(cmd.slice(-1))
      if (dir) movePane(dir, gridRef.current)
    } else if (/^\d+$/.test(cmd)) {
      moveTo(Number(cmd) - 1, cursor.col)
    } else if (cmd) {
      say(`不認得的指令：${cmd}`, 'error')
    }
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
    const half = Math.max(
      1,
      Math.floor((scrollRef.current?.clientHeight ?? 320) / ROW_HEIGHT / 2),
    )
    const counted = { from: cursor.row, to: cursor.row + count - 1 }

    if (p.op) {
      const op = p.op + k
      if (op === 'dd') return done(() => deleteRange(counted))
      if (op === 'yy') return done(() => yank(counted))
      if (op === 'gg')
        return done(() => moveTo(p.count ? count - 1 : 0, cursor.col))
      if (op === 'gx') return done(openLink)
      if (op === 'gv') {
        return done(() => {
          const last = lastVisual.current
          if (!last) return say('還沒有選取過（V 開始選取）')
          startVisual(last.anchor, last.row)
        })
      }
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
      case '<C-d>':
        return done(() => moveTo(cursor.row + half, cursor.col))
      case '<C-u>':
        return done(() => moveTo(cursor.row - half, cursor.col))
      case 'g':
      case '<C-w>':
        pending.current = { count: p.count, op: k }
        return true
      case ':':
        return done(() => {
          if (visual && selection) {
            commandRange.current = selection
            endVisual()
          }
          setCommand('')
          setMode('command')
        })
      case '?':
        return done(() => setHelp(true))
      case '<C-s>':
      case '<D-s>':
        return done(() => {
          if (visual) endVisual()
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
          return done(endVisual)
        case 'o':
        case 'O':
          return done(() => {
            setAnchor(cursor.row)
            setCursor((c) => ({ ...c, row: anchor }))
          })
        case 'd':
        case 'D':
        case 'X':
          return done(() => {
            endVisual()
            deleteRange(range)
          })
        case 'y':
        case 'Y':
          return done(() => {
            endVisual()
            yank(range)
          })
        case 'c':
        case 's':
          return done(() => changeSelection(range))
        default:
          pending.current = { count: '', op: '' }
          return false
      }
    }

    switch (k) {
      case 'v':
      case 'V':
        return done(() => startVisual(cursor.row, cursor.row + count - 1))
      case 'd':
      case 'y':
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
        return done(() => openRow(rows.length === 0 ? 0 : cursor.row + 1))
      case 'O':
        return done(() => openRow(cursor.row))
      case 'p':
        return done(() => paste(true))
      case 'P':
        return done(() => paste(false))
      case 'u':
        return done(undo)
      case '<C-r>':
        return done(redo)
      case '.':
        return done(repeat)
      case '<Esc>':
        return done(() => setMessage(null))
      default:
        pending.current = { count: '', op: '' }
        return false
    }
  }

  function runInsert(k: Key): boolean {
    const options = suggestions()
    switch (k) {
      case '<C-n>':
      case '<Down>':
        opened.current = null
        setPick(nextPick(options.length, takenIndex(options), 1))
        setNavigated(true)
        return true
      case '<C-p>':
      case '<Up>':
        opened.current = null
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
      case '<Esc>': {
        if (dropOpened()) return true
        if (commitCell(navigated ? chosenText() : edit, true)) setMode('normal')
        return true
      }
      case '<C-c>':
        if (dropOpened()) return true
        if (bulk) endVisual()
        setMode('normal')
        say('已取消編輯')
        return true
      case '<C-s>':
      case '<D-s>':
        if (commitCell(edit)) {
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
        commandRange.current = null
        setMode('normal')
        setCommand('')
        return true
      case '<BS>':
        if (command !== '') return false
        commandRange.current = null
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

  const feed = useKeyFeed(keymap, 'goals', (k) => {
    if (mode === 'insert') return runInsert(k)
    if (mode === 'command') return runCommandKey(k)
    return runNormal(k)
  })

  // ---------- render

  const options = suggestions()
  const problem = current ? problems.get(current.id) : undefined
  const money = (n: number) => formatAmount(n, ctx.minorUnits)
  /** The cursor's goal in a sentence, when nothing else is shown. */
  const cursorLine = (() => {
    if (!current || current.deleted) return null
    const f = figures.get(current.id)
    if (!f) return null
    if (!f.envelope) return null
    const parts = [
      f.total === null
        ? `累積 ${money(f.saved)}`
        : f.total <= 0
          ? current.kind === 'maintain'
            ? '近六個月沒有支出紀錄，還算不出水位'
            : '還沒有目標金額'
          : f.saved >= f.total
            ? `已存滿 ${money(f.total)}`
            : `已存 ${money(f.saved)}，目標 ${money(f.total)}，還差 ${money(f.total - f.saved)}`,
    ]
    if (f.ask > 0) parts.push(`本月要 ${money(f.ask)}（:fill 分配）`)
    if (f.eta && f.eta !== 'now') {
      const was = before.get(current.id)?.eta
      parts.push(
        f.eta === 'never'
          ? '照目前的收入，十年內存不到'
          : `預計 ${etaText(f.eta)} 存到${
              was !== undefined && was !== f.eta
                ? `（原本 ${etaText(was)}）`
                : ''
            }`,
      )
    }
    if (f.status === 'waiting' && current.waitUntil)
      parts.push(`冷靜到 ${formatDate(current.waitUntil, now)} 再決定要不要買`)
    return parts.join(' · ')
  })()
  const line =
    mode === 'command'
      ? null
      : (message ??
        (problem ? { text: problem.message, tone: 'error' as const } : null))

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <p className="text-sm text-muted-foreground">
        每月可自由分配{' '}
        <span
          className={cn(
            'amount',
            summary.free < 0 ? 'text-destructive' : 'text-foreground',
          )}
        >
          {money(summary.free)}
        </span>
        （收入中位數 <span className="amount">{money(list.typicalIncome)}</span>{' '}
        − 基本額與排程 <span className="amount">{money(list.baseTargets)}</span>
        ）· 目標本月共要 <span className="amount">{money(summary.asks)}</span>
      </p>
      <div
        ref={gridRef}
        tabIndex={0}
        role="grid"
        aria-label="目標"
        aria-rowcount={rows.length}
        data-pane="goals"
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
                    amountColumns.has(c) && 'justify-end',
                  )}
                >
                  {goalLabels[c]}
                </span>
              ))}
            </div>

            {rows.length === 0 && (
              <p className="px-4 py-6 text-sm text-muted-foreground">
                還沒有目標。按{' '}
                <kbd className="font-mono text-foreground">o</kbd>{' '}
                新增一個，例如想買的羽球拍、明年一月的旅行、六個月的備用金。上面的優先。
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
                <GoalLine
                  key={row.id}
                  row={row}
                  index={index}
                  layout={layout}
                  state={states[index]}
                  problem={problems.get(row.id)}
                  ctx={ctx}
                  figures={figures.get(row.id)}
                  was={before.get(row.id)?.eta}
                  now={now}
                  onPick={(col, enter, extend) => {
                    if (mode === 'insert' && !commitCell(edit)) return
                    if (extend) {
                      if (mode !== 'visual') setAnchor(cursor.row)
                      setMode('visual')
                      setCursor({ row: index, col })
                      gridRef.current?.focus({ preventScroll: true })
                      return
                    }
                    if (mode === 'visual') endVisual()
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
                    label={
                      bulk && selection
                        ? `${goalLabels[column]}（選取的目標）`
                        : goalLabels[column]
                    }
                    numeric={
                      column === 'date' || column === 'wait'
                        ? 'date'
                        : amountColumns.has(column) &&
                            !(
                              column === 'target' && current.kind === 'maintain'
                            )
                          ? 'amount'
                          : undefined
                    }
                    width={layout.widths[column]}
                    options={options}
                    pick={takenIndex(options)}
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
        groups={goalKeys}
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
              ? `已選 ${selection.to - selection.from + 1} 個 · d 刪除 · y 複製 · c 修改 · :done 達成 · ? 快捷鍵`
              : mode === 'normal' && cursorLine
                ? cursorLine
                : 'hjkl 移動 · i 編輯 · o 新增 · ddp 往下調優先序 · :done 達成 · :w 儲存 · ? 快捷鍵'}
          </span>
        )}
      </div>
    </div>
  )
}

function GoalLine({
  row,
  index,
  layout,
  state,
  problem,
  ctx,
  figures,
  was,
  now,
  onPick,
}: {
  row: GoalRow
  index: number
  layout: Layout
  state: LineState
  problem: GoalProblem | undefined
  ctx: Context
  figures: GoalFigures | undefined
  /** The saved goals' projected completion, to show what a change moved. */
  was: string | null | undefined
  now: Date
  onPick: (col: number, enter: boolean, extend: boolean) => void
}) {
  const marker = problem
    ? '!'
    : { clean: '', new: '+', changed: '~', deleted: '-', moved: '↕' }[state]
  const cell = 'flex items-center overflow-hidden px-2 whitespace-nowrap'
  const muted = 'text-muted-foreground'
  const unused = (c: GoalColumn) => !usesColumn(row.kind, c)
  const money = (n: number | null) => amountText(n, ctx.minorUnits)
  const closed = row.achieved || row.archived

  function content(c: GoalColumn, col: number): React.ReactNode {
    const bad = problem?.field === c && 'text-destructive'
    switch (c) {
      case 'name':
        return (
          <span key={c} data-col={col} className={cn(cell, 'gap-1.5', bad)}>
            {row.achieved && (
              <CheckIcon className="size-3.5 shrink-0 text-positive" />
            )}
            <span className="truncate">{row.name}</span>
          </span>
        )
      case 'category':
        return (
          <span key={c} data-col={col} className={cn(cell, muted, bad)}>
            <span className="truncate">
              {row.categoryId ? ctx.categories.get(row.categoryId)?.path : ''}
            </span>
          </span>
        )
      case 'kind':
        return (
          <span key={c} data-col={col} className={cn(cell, 'text-xs', bad)}>
            {kindLabels[row.kind]}
          </span>
        )
      case 'target':
        return (
          <span
            key={c}
            data-col={col}
            className={cn(cell, 'amount justify-end', unused(c) && muted, bad)}
          >
            {unused(c)
              ? '—'
              : row.kind === 'maintain'
                ? row.maintainMonths
                  ? `${row.maintainMonths} 個月`
                  : ''
                : money(row.targetAmount)}
          </span>
        )
      case 'date':
        return (
          <span
            key={c}
            data-col={col}
            className={cn(cell, 'font-mono', unused(c) && muted, bad)}
          >
            {unused(c)
              ? '—'
              : row.targetDate
                ? formatDate(row.targetDate, now)
                : ''}
          </span>
        )
      case 'monthly':
        return (
          <span
            key={c}
            data-col={col}
            className={cn(cell, 'amount justify-end', unused(c) && muted, bad)}
            title={
              row.kind === 'target' || row.kind === 'maintain'
                ? '每月最多存多少（選填）'
                : undefined
            }
          >
            {unused(c) ? '—' : money(row.monthlyAmount)}
          </span>
        )
      case 'saved': {
        const total = figures?.total ?? null
        const share =
          figures && total && total > 0 ? Math.min(1, figures.saved / total) : 0
        return (
          <span
            key={c}
            data-col={col}
            className={cn(cell, 'relative amount justify-end')}
            title={
              figures && total !== null
                ? `已存 ${money(figures.saved) || '0'} / ${money(total) || '0'}`
                : undefined
            }
          >
            {figures && !closed && (
              <span
                aria-hidden
                className={cn(
                  'absolute inset-y-1.5 left-1 rounded-sm',
                  share >= 1 ? 'bg-positive/20' : 'bg-kraft/20',
                )}
                style={{ width: `calc(${share * 100}% - 0.5rem)` }}
              />
            )}
            <span className="relative">
              {figures && !closed ? money(figures.saved) || '0' : ''}
            </span>
          </span>
        )
      }
      case 'ask':
        return (
          <span
            key={c}
            data-col={col}
            className={cn(cell, 'amount justify-end')}
          >
            {figures ? money(figures.ask) : ''}
          </span>
        )
      case 'eta': {
        const eta = figures?.eta ?? null
        const moved = was !== undefined && was !== eta && eta !== null
        return (
          <span
            key={c}
            data-col={col}
            className={cn(
              cell,
              'gap-1.5 font-mono',
              eta === 'never' && 'text-destructive',
              (eta === null || eta === 'now') && muted,
            )}
            title={moved ? `原本 ${etaText(was ?? null)}` : undefined}
          >
            {etaText(eta)}
            {moved && (
              <span className="text-xs text-muted-foreground">
                ← {etaText(was ?? null)}
              </span>
            )}
          </span>
        )
      }
      case 'status': {
        const status = figures?.status ?? 'saving'
        return (
          <span
            key={c}
            data-col={col}
            className={cn(
              cell,
              'text-xs',
              status === 'full' && 'text-positive',
              status === 'waiting' && 'text-kraft',
              (status === 'saving' || closed) && muted,
            )}
          >
            {statusLabels[status]}
          </span>
        )
      }
      case 'wait':
        return (
          <span
            key={c}
            data-col={col}
            className={cn(cell, 'font-mono', muted, bad)}
          >
            {row.waitUntil ? formatDate(row.waitUntil, now) : ''}
          </span>
        )
      case 'url':
        return (
          <span
            key={c}
            data-col={col}
            className={cn(cell, 'gap-1.5', muted, bad)}
            title={row.url || undefined}
          >
            {row.url && (
              <>
                <LinkIcon className="size-3.5 shrink-0" />
                <span className="truncate">{hostOf(row.url)}</span>
              </>
            )}
          </span>
        )
      case 'note':
        return (
          <span key={c} data-col={col} className={cn(cell, muted)}>
            <span className="truncate">{row.note}</span>
          </span>
        )
    }
  }

  return (
    <div
      role="row"
      aria-rowindex={index + 1}
      className={cn(
        'absolute inset-x-0 grid border-b border-rule/60 text-sm',
        row.deleted && 'text-muted-foreground line-through',
        closed && !row.deleted && 'text-muted-foreground',
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
        onPick(Number(target.dataset.col), e.detail === 2, e.shiftKey)
      }}
    >
      <span
        className={cn(
          'flex items-center justify-center font-mono text-xs',
          problem || state === 'deleted' ? 'text-destructive' : 'text-kraft',
        )}
        title={
          problem?.message ??
          (state === 'moved' ? '優先序變了（:w 儲存）' : undefined)
        }
      >
        {marker}
      </span>
      {goalColumns.map((c, col) => content(c, col))}
    </div>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
