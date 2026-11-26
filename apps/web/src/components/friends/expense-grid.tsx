import { useEffect, useRef, useState } from 'react'
import { api } from '#/lib/api'
import { errorCodeMessage } from '#/lib/apiError'
import { currencies } from '#/lib/budget'
import { setEditorStatus } from '#/lib/editorStatus'
import {
  focusField,
  formKey,
  openForm,
  settleForm,
  takeTyped,
} from '#/lib/form'
import { formatAmount } from '#/lib/money'
import { movePane, windowDirection } from '#/lib/panes'
import {
  findCategory,
  formatDate,
  isoDate,
  parseDate,
  rankCell,
} from '#/lib/register'
import {
  applySplitForm,
  balanceText,
  currencyUnits,
  derivedSplitColumns,
  describeLine,
  effectOf,
  formColumns,
  needs,
  newSplitRow,
  rowFromExpense,
  runningBalances,
  sharesOf,
  splitCellText,
  splitColumns,
  splitFormFields,
  splitFormValues,
  splitLabels,
  splitPatch,
  splitProblemColumn,
  splitProblemMessages,
  splitStatus,
  splitText,
  toSplitInput,
  validateSplit,
} from '#/lib/split'
import { cn } from '#/lib/utils'
import { FormPopover } from '../form-popover'
import { CellEditor, eraseBeforeCaret, nextPick } from '../register/cell-editor'
import { KeyHelp, friendKeys } from '../register/key-help'
import { useKeyFeed } from '../register/use-key-feed'
import type { FormState } from '#/lib/form'
import type { Key, Keymap } from '#/lib/keymap'
import type { Context } from '#/lib/register'
import type {
  People,
  SharedExpense,
  SplitColumn,
  SplitProblem,
  SplitRow,
  SplitRowStatus,
} from '#/lib/split'
import type { Suggestion } from '../register/cell-editor'

// A friend's shared expenses (M12, ADR-106): a grid edited as the goals
// page is, saved with :w through the batch endpoint, which also writes the
// caller's side into their budget; drafts kept locally (ADR-043).

const ROW_HEIGHT = 32
const GUTTER = 28
const widths: Record<SplitColumn, number> = {
  date: 72,
  description: 140,
  amount: 120,
  paidBy: 96,
  split: 88,
  mine: 88,
  balance: 96,
  category: 120,
  account: 104,
  note: 120,
}
const stretch: Partial<Record<SplitColumn, number>> = {
  description: 0.35,
  category: 0.15,
  note: 0.5,
}
const amountColumns: ReadonlySet<SplitColumn> = new Set([
  'amount',
  'mine',
  'balance',
])

interface Layout {
  lefts: Record<SplitColumn, number>
  widths: Record<SplitColumn, number>
  template: string
  width: number
}

function layoutOf(room: number): Layout {
  const least = splitColumns.reduce((sum, c) => sum + widths[c], GUTTER)
  const extra = Math.max(0, room - least)
  const lefts = {} as Record<SplitColumn, number>
  const sized = {} as Record<SplitColumn, number>
  let x = GUTTER
  for (const c of splitColumns) {
    sized[c] = widths[c] + Math.floor(extra * (stretch[c] ?? 0))
    lefts[c] = x
    x += sized[c]
  }
  return {
    lefts,
    widths: sized,
    template: `${GUTTER}px ${splitColumns.map((c) => `${sized[c]}px`).join(' ')}`,
    width: x,
  }
}

type Mode = 'normal' | 'visual' | 'insert' | 'form' | 'command'

interface Message {
  text: string
  tone: 'info' | 'error'
}

interface Range {
  from: number
  to: number
}

interface Props {
  friendId: string
  people: People
  /** The budget's currency, which shared expenses are recorded in (ADR-041). */
  currency: string
  ctx: Context
  /** The expenses as last loaded, oldest first. */
  expenses: Array<SharedExpense>
  keymap: Keymap
  /** Fetches the expenses again. */
  reload: () => Promise<Array<SharedExpense>>
  onQuit: () => void
}

const DRAFT_VERSION = 1

interface Draft {
  version: number
  rows: Array<SplitRow>
  order: Array<string>
}

function draftKey(friendId: string): string {
  return `factual:friend:${friendId}`
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

function writeDraft(
  key: string,
  rows: Array<SplitRow> | null,
  people: People,
): void {
  try {
    if (!rows) localStorage.removeItem(key)
    else
      localStorage.setItem(
        key,
        JSON.stringify({
          version: DRAFT_VERSION,
          rows: rows.filter((r) => splitStatus(r, people) !== 'clean'),
          order: rows.map((r) => r.id),
        } satisfies Draft),
      )
  } catch {
    // Drafts are a convenience (ADR-043).
  }
}

function initialRows(
  expenses: Array<SharedExpense>,
  draft: Draft | null,
  people: People,
): Array<SplitRow> {
  const saved = expenses.map((x) => rowFromExpense(x, people))
  if (!draft) return saved
  const at = new Map(saved.map((r, i) => [r.id, i]))
  const fresh: Array<SplitRow> = []
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
  return [...saved, ...fresh].toSorted(
    (a, b) =>
      (place.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
      (place.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  )
}

export function ExpenseGrid({
  friendId,
  people,
  currency,
  ctx,
  expenses,
  keymap,
  reload,
  onQuit,
}: Props) {
  const key = draftKey(friendId)
  const [room, setRoom] = useState(0)
  const layout = layoutOf(room)
  const columns = splitColumns
  const [rows, setRows] = useState<Array<SplitRow>>(() =>
    initialRows(expenses, readDraft(key), people),
  )
  const [cursor, setCursor] = useState(() => ({
    row: Math.max(0, rows.length - 1),
    col: 0,
  }))
  const [mode, setMode] = useState<Mode>('normal')
  const [edit, setEdit] = useState('')
  const [pick, setPick] = useState(0)
  const [navigated, setNavigated] = useState(false)
  const [command, setCommand] = useState('')
  const [message, setMessage] = useState<Message | null>(() =>
    readDraft(key) ? { text: '已還原上次未儲存的變更', tone: 'info' } : null,
  )
  const [problems, setProblems] = useState<Map<string, SplitProblem>>(new Map())
  const [saving, setSaving] = useState(false)
  const [anchor, setAnchor] = useState(0)
  const [bulk, setBulk] = useState(false)
  const [help, setHelp] = useState(false)
  /** The split form (ADR-107), while it is open under the cursor's cell. */
  const [form, setForm] = useState<FormState | null>(null)

  const gridRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const history = useRef<{
    undo: Array<Array<SplitRow>>
    redo: Array<Array<SplitRow>>
  }>({ undo: [], redo: [] })
  const pending = useRef({ count: '', op: '' })
  const yanked = useRef<Array<SplitRow>>([])
  const lastChange = useRef<{ op: 'd' | 'p' | 'P'; lines: number } | null>(null)
  const lastVisual = useRef<{ anchor: number; row: number } | null>(null)
  const opened = useRef<{ id: string; from: typeof cursor } | null>(null)

  const now = new Date()
  const today = isoDate(now)
  const states: Array<SplitRowStatus> = rows.map((r) => splitStatus(r, people))
  const dirty = states.filter((s) => s !== 'clean').length
  const balances = runningBalances(rows)
  const balance = rows.reduce((sum, r) => sum + (effectOf(r) ?? 0), 0)
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
    setEditorStatus({ mode: mode === 'form' ? 'insert' : mode, dirty })
  }, [mode, dirty])
  useEffect(() => () => setEditorStatus(null), [])
  useEffect(() => {
    const unsaved = rows.some((r) => splitStatus(r, people) !== 'clean')
    writeDraft(key, unsaved ? rows : null, people)
  }, [key, rows, people])
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

  function change(next: Array<SplitRow>) {
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
    patchOf: (row: SplitRow) => Partial<SplitRow> | null,
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

  /** The account a new line pays from: the cursor line's, or the first one on the budget. */
  function defaultAccount(): string | null {
    if (current?.accountId) return current.accountId
    return (
      [...ctx.accounts.values()].find((a) => a.onBudget && !a.closed)?.id ??
      null
    )
  }

  function insertRow(
    at: number,
    row: SplitRow,
    col: SplitColumn,
    hint: string,
  ) {
    const index = Math.max(0, Math.min(at, rows.length))
    change(rows.toSpliced(index, 0, row))
    opened.current = { id: row.id, from: cursor }
    setCursor({ row: index, col: columns.indexOf(col) })
    setEdit('')
    setPick(0)
    setNavigated(false)
    setBulk(false)
    setMode('insert')
    say(hint)
  }

  function openRow(at: number) {
    const row = newSplitRow(
      crypto.randomUUID(),
      today,
      defaultAccount(),
      current?.categoryId ?? null,
    )
    insertRow(
      at,
      row,
      'description',
      '輸入項目，例如：晚餐、計程車；Tab 到下一欄（金額、誰付、分法）',
    )
  }

  /** `:settle`: a settlement for what the balance is now. */
  function settle() {
    if (balance === 0) return say('目前兩清，不用還款')
    const row: SplitRow = {
      ...newSplitRow(crypto.randomUUID(), today, defaultAccount(), null),
      description: '還款',
      total: Math.abs(balance),
      settlement: true,
      method: 'exact',
      payer: balance > 0 ? 'friend' : 'me',
    }
    const index = rows.length
    change([...rows, row])
    setCursor({ row: index, col: columns.indexOf('account') })
    say(
      `${balance > 0 ? `${people.friendName} 還我` : `我還 ${people.friendName}`} ${formatAmount(
        Math.abs(balance),
        ctx.minorUnits,
      )}：確認帳戶和日期後 :w 儲存`,
    )
  }

  function dropOpened(): boolean {
    const o = opened.current
    opened.current = null
    if (!o || !current || current.id !== o.id || bulk) return false
    if (edit.trim() !== '' || current.base || current.description) return false
    if (current.total || current.note) return false
    history.current.undo.pop()
    const next = rows.filter((r) => r.id !== o.id)
    setRows(next)
    setCursor({ row: clamp(o.from.row, next.length), col: o.from.col })
    setMode('normal')
    say('已取消新增')
    return true
  }

  /**
   * `dd`: saved lines are marked deleted until :w and kept for `p`; unsaved
   * lines are removed. `dd` on lines already marked takes the mark off.
   */
  function deleteRange({ from, to }: Range) {
    const targets = rows.slice(from, to + 1)
    if (targets.length === 0) return
    const restore = targets.every((t) => t.deleted)
    const ids = new Set(targets.map((t) => t.id))
    lastChange.current = { op: 'd', lines: to - from + 1 }
    if (restore) {
      change(rows.map((r) => (ids.has(r.id) ? { ...r, deleted: false } : r)))
      return say(`已取消 ${ids.size} 筆分帳的刪除標記`)
    }
    yanked.current = targets.map((r) => ({ ...r, deleted: false, base: null }))
    const next = rows.flatMap((r) =>
      !ids.has(r.id) ? [r] : r.base ? [{ ...r, deleted: true }] : [],
    )
    change(next)
    setCursor((c) => ({ ...c, row: clamp(from, next.length) }))
    const marked = targets.filter((t) => t.base).length
    say(
      marked > 0
        ? `已標記刪除 ${marked} 筆分帳（:w 儲存後才會刪除，帳本裡的交易也會一起刪掉），u 可以復原`
        : `已移除 ${targets.length} 筆未儲存的分帳，u 可以復原，p 可以貼上`,
    )
  }

  function yank(range: Range) {
    const picked = rows.slice(range.from, range.to + 1)
    if (picked.length === 0) return
    yanked.current = picked.map((r) => ({ ...r, deleted: false, base: null }))
    setCursor((c) => ({ ...c, row: range.from }))
    say(`已複製 ${picked.length} 筆分帳（p 貼上）`)
  }

  function paste(after: boolean) {
    if (yanked.current.length === 0) {
      return say('還沒有複製任何分帳（yy，或 V 選取後按 y）')
    }
    const lines = yanked.current.map((r) => ({
      ...r,
      id: crypto.randomUUID(),
      base: null,
      deleted: false,
    }))
    const at = rows.length === 0 ? 0 : cursor.row + (after ? 1 : 0)
    const next = rows.toSpliced(at, 0, ...lines)
    change(next)
    setCursor((c) => ({ ...c, row: clamp(at, next.length) }))
    lastChange.current = { op: after ? 'p' : 'P', lines: 1 }
    if (lines.length > 1) say(`已貼上 ${lines.length} 筆分帳`)
  }

  function repeat() {
    const last = lastChange.current
    if (!last) return say('沒有可以重複的動作')
    if (last.op === 'd') {
      return deleteRange({ from: cursor.row, to: cursor.row + last.lines - 1 })
    }
    paste(last.op === 'p')
  }

  // ---------- visual mode

  function startVisual(from: number, to: number) {
    if (rows.length === 0) return say('還沒有分帳，按 o 新增一筆')
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
    if (derivedSplitColumns.has(column))
      return say('這一欄是算出來的，不能修改', 'error')
    const usable = rows
      .slice(range.from, range.to + 1)
      .filter((r) => !r.deleted)
    if (usable.length === 0) return say('選取的分帳都已標記刪除', 'error')
    if (formColumns.has(column)) {
      setBulk(true)
      openForm_(current ?? usable[0], column)
      return say(`表單的設定會套用到 ${usable.length} 筆分帳；Enter 套用`)
    }
    setEdit('')
    setPick(0)
    setNavigated(false)
    setBulk(true)
    setMode('insert')
    say(
      `輸入的${splitLabels[column]}會套用到 ${usable.length} 筆分帳；Enter 套用，沒輸入就按 Esc 取消`,
    )
  }

  function commitBulk(text: string, cancelIfEmpty: boolean): boolean {
    if (!selection) return true
    if (cancelIfEmpty && text.trim() === '') {
      endVisual()
      say('沒有輸入，未修改任何分帳')
      return true
    }
    let error = ''
    let skipped = 0
    const changed = patchRows(idsIn(selection), (row) => {
      if (row.deleted) {
        skipped++
        return null
      }
      const patch = splitPatch(column, text, ctx, now)
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
      `已修改 ${changed} 筆分帳的${splitLabels[column]}${
        skipped > 0 ? `，略過 ${skipped} 筆` : ''
      }${error ? `（${error}）` : ''}`,
      error ? 'error' : 'info',
    )
    return true
  }

  // ---------- cells

  function editable(row: SplitRow, col: SplitColumn): string | null {
    if (row.deleted) return '這筆分帳已標記刪除，按 u 復原或 dd 取消'
    if (col === 'mine') return '我的份是從金額和分法算出來的'
    if (col === 'balance')
      return `往來是到這一筆為止 ${people.friendName} 欠我（負的是我欠）多少`
    const need = needs(row)
    if (col === 'account' && !need.account)
      return `${people.friendName} 付的，我這邊不用填帳戶`
    if (col === 'category' && !need.category)
      return row.settlement ? '還款不用類別' : '我的份是 0，不用類別'
    return null
  }

  function startInsertAt(index: number, colIndex: number, clear = false) {
    const row = rows.at(index)
    const col = columns[colIndex]
    if (!row) return say('還沒有分帳，按 o 新增一筆')
    const reason = editable(row, col)
    if (reason) return say(reason, 'error')
    if (formColumns.has(col)) {
      setBulk(false)
      return openForm_(row, col)
    }
    setEdit(clear ? '' : splitCellText(row, col, ctx, people))
    setPick(0)
    setNavigated(false)
    setBulk(false)
    setMode('insert')
  }

  // ---------- the split form

  const currencyOptions = currencies
    .filter((c) => c.code !== currency)
    .map((c) => ({ value: c.code, label: c.label }))

  function formFieldsOf(values: Record<string, string>) {
    return splitFormFields(values, people, currencyOptions)
  }

  /** Opens the split form on a line, at the field of the column. */
  function openForm_(row: SplitRow, col: SplitColumn) {
    const values = splitFormValues(row, ctx.minorUnits)
    const at = col === 'paidBy' ? 'payer' : row.settlement ? 'kind' : 'method'
    setForm(openForm(values, formFieldsOf(values), at))
    setMode('form')
    setMessage(null)
  }

  function closeForm() {
    setForm(null)
    if (bulk) endVisual()
    else setMode('normal')
  }

  /** Writes the form's values into the cursor's line, or every selected one. */
  function commitForm(values: Record<string, string>): string | null {
    if (!current) return null
    const ids = bulk && selection ? idsIn(selection) : [current.id]
    const failed = { error: '', count: 0 }
    const changed = patchRows(ids, (row) => {
      if (row.deleted) return null
      const patch = applySplitForm(row, values, ctx.minorUnits)
      if (typeof patch === 'string') {
        failed.error ||= patch
        failed.count++
        return null
      }
      return patch
    })
    if (failed.error && changed === 0) return failed.error
    opened.current = null
    if (bulk && selection) {
      lastVisual.current = { anchor, row: cursor.row }
      setCursor((c) => ({ ...c, row: selection.from }))
      say(
        `已修改 ${changed} 筆分帳的分攤${
          failed.count > 0 ? `，略過 ${failed.count} 筆（${failed.error}）` : ''
        }`,
        failed.error ? 'error' : 'info',
      )
    }
    return null
  }

  function runForm(k: Key): boolean {
    if (!form) return false
    const fields = formFieldsOf(form.values)
    const result = formKey(form, fields, k, now)
    if (!('done' in result)) {
      setForm(settleForm(result.state, formFieldsOf(result.state.values)))
      return true
    }
    if (result.done === 'cancel') {
      closeForm()
      say('已取消編輯')
      return true
    }
    const error = commitForm(result.state.values)
    if (error) {
      setForm({ ...result.state, error })
      return true
    }
    closeForm()
    return true
  }

  /** What the form's values come to on the cursor's line. */
  function formPreview(): string | undefined {
    if (!form || !current) return undefined
    const patch = applySplitForm(current, form.values, ctx.minorUnits)
    if (typeof patch === 'string') return patch
    return (
      describeLine({ ...current, ...patch }, people, ctx.minorUnits) ??
      '先在金額欄輸入總額'
    )
  }

  function suggestions(): Array<Suggestion> {
    if (mode !== 'insert' || !current) return []
    // The cell's own text, while nothing has been typed over it: every
    // option is offered, that one first (rankCell).
    const own = bulk ? null : splitCellText(current, column, ctx, people)
    const pickFrom = (list: Array<Suggestion>) =>
      rankCell(list, edit, own, (o) => o.value)
    switch (column) {
      case 'category':
        return pickFrom(
          [...ctx.categories.values()]
            .filter((c) => !c.isSystem && !c.archived)
            .map((c) => ({
              value: c.path,
              label: c.path,
              hint: c.kind === 'income' ? '收入' : undefined,
            })),
        )
      case 'account':
        return pickFrom(
          [...ctx.accounts.values()]
            .filter((a) => a.onBudget && !a.closed)
            .map((a) => ({ value: a.name, label: a.name })),
        )
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
    if (column === 'account') {
      return [...ctx.accounts.values()].some((a) => a.name === edit.trim())
        ? edit
        : highlighted
    }
    return edit
  }

  function takenIndex(options: Array<Suggestion>): number {
    if (options.length === 0) return -1
    if (!navigated && edit === '') return -1
    const text = chosenText()
    const value =
      column === 'category'
        ? (findCategory(text, ctx.categories.values())?.path ?? text)
        : text
    return options.findIndex((o) => o.value === value)
  }

  function commitCell(text: string, cancelIfEmpty = false): SplitRow | null {
    if (!current) return null
    if (bulk) return commitBulk(text, cancelIfEmpty) ? current : null
    opened.current = null
    const patch = splitPatch(column, text, ctx, now)
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
    if (formColumns.has(columns[col])) return openForm_(row, columns[col])
    setEdit(splitCellText(row, columns[col], ctx, people))
    setPick(0)
    setNavigated(false)
  }

  // ---------- saving

  function messageFor(code: string, fallback: string): string {
    if (splitProblemMessages[code]) return splitProblemMessages[code]
    const known = errorCodeMessage(code)
    return known === '發生未知錯誤' ? fallback : known
  }

  async function save(): Promise<boolean> {
    const found = new Map<string, SplitProblem>()
    for (const [i, row] of rows.entries()) {
      if (states[i] === 'clean') continue
      const p = validateSplit(row, ctx)
      if (p) found.set(row.id, p)
    }
    if (found.size > 0) return reportProblems(found)
    const upserts = rows
      .filter((_, i) => states[i] === 'new' || states[i] === 'changed')
      .map((r) => toSplitInput(r, people))
    const deletes = rows.filter((r) => r.deleted && r.base).map((r) => r.id)
    if (upserts.length === 0 && deletes.length === 0) {
      say('沒有需要儲存的變更')
      return true
    }
    setSaving(true)
    try {
      const { data, error, response } = await api.POST(
        '/friends/{friendId}/expenses/batch',
        { params: { path: { friendId } }, body: { upserts, deletes } },
      )
      if (response.status === 422 && error && 'errors' in error) {
        const fromServer = new Map<string, SplitProblem>()
        for (const p of error.errors) {
          fromServer.set(p.id, {
            field: splitProblemColumn(p.field),
            message: messageFor(p.code, p.message),
          })
        }
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
      const next = fresh.map((x) => rowFromExpense(x, people))
      writeDraft(key, null, people)
      history.current = { undo: [], redo: [] }
      setRows(next)
      setProblems(new Map())
      setCursor((c) => ({ ...c, row: clamp(c.row, next.length) }))
      say(`已儲存：${data.upserted} 筆新增或修改，${data.deleted} 筆刪除`)
      return true
    } catch {
      say('無法連線至伺服器；變更仍保留在草稿裡', 'error')
      return false
    } finally {
      setSaving(false)
    }
  }

  function reportProblems(found: Map<string, SplitProblem>): false {
    setProblems(found)
    const first = rows.findIndex((r) => found.has(r.id))
    const p = found.get(rows[first]?.id ?? '')
    if (first >= 0) {
      const col = p?.field ? columns.indexOf(p.field) : -1
      setCursor({ row: first, col: col >= 0 ? col : cursor.col })
    }
    say(`${found.size} 筆分帳有問題，沒有儲存：${p?.message ?? ''}`, 'error')
    return false
  }

  function discard() {
    const fresh = expenses.map((x) => rowFromExpense(x, people))
    writeDraft(key, null, people)
    change(fresh)
    setProblems(new Map())
    setCursor((c) => ({ ...c, row: clamp(c.row, fresh.length) }))
    say('已放棄所有未儲存的變更（u 可以復原）')
  }

  async function runCommand(raw: string) {
    const cmd = raw.trim()
    setMode('normal')
    setCommand('')
    if (cmd === 'w') {
      await save()
    } else if (cmd === 'wq' || cmd === 'x') {
      if (await save()) onQuit()
    } else if (cmd === 'q') {
      if (dirty > 0)
        say(
          `還有 ${dirty} 筆分帳未儲存（:w 儲存，:q! 離開並保留草稿）`,
          'error',
        )
      else onQuit()
    } else if (cmd === 'q!') {
      onQuit()
    } else if (cmd === 'e!') {
      discard()
    } else if (cmd === 'settle') {
      settle()
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
          if (visual) endVisual()
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
    if (mode === 'form') return runForm(k)
    if (mode === 'insert') return runInsert(k)
    if (mode === 'command') return runCommandKey(k)
    return runNormal(k)
  })

  // ---------- render

  const options = suggestions()
  const problem = current ? problems.get(current.id) : undefined
  const cursorLine =
    current && !current.deleted
      ? describeLine(current, people, ctx.minorUnits)
      : null
  const line =
    mode === 'command'
      ? null
      : (message ??
        (problem ? { text: problem.message, tone: 'error' as const } : null))

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <p className="text-sm text-muted-foreground">
        {dirty > 0 ? '儲存後：' : '目前：'}
        <span
          className={cn(
            'amount',
            balance > 0
              ? 'text-positive'
              : balance < 0
                ? 'text-destructive'
                : 'text-foreground',
          )}
        >
          {balanceText(balance, people.friendName, ctx.minorUnits)}
        </span>
      </p>
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
                    amountColumns.has(c) && 'justify-end',
                  )}
                >
                  {splitLabels[c]}
                </span>
              ))}
            </div>

            {rows.length === 0 && (
              <p className="px-4 py-6 text-sm text-muted-foreground">
                還沒有和 {people.friendName} 的分帳。按{' '}
                <kbd className="font-mono text-foreground">o</kbd>{' '}
                新增一筆，例如：晚餐 2400，我付的，平分。
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
                <ExpenseLine
                  key={row.id}
                  row={row}
                  index={index}
                  layout={layout}
                  state={states[index]}
                  problem={problems.get(row.id)}
                  ctx={ctx}
                  people={people}
                  balance={balances[index]}
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

              {mode === 'form' && form && current && (
                <div
                  className="absolute z-30"
                  style={{
                    top: (cursor.row + 1) * ROW_HEIGHT,
                    left: layout.lefts[column],
                  }}
                >
                  <FormPopover
                    title={
                      bulk && selection
                        ? `分攤（選取的 ${selection.to - selection.from + 1} 筆）`
                        : '分攤'
                    }
                    fields={formFieldsOf(form.values)}
                    state={form}
                    preview={formPreview()}
                    width={layout.widths[column] + layout.widths.split}
                    onKeyDown={feed.onNormalKeyDown}
                    onField={(field) =>
                      setForm(
                        focusField(
                          takeTyped(form, formFieldsOf(form.values), now),
                          formFieldsOf(form.values),
                          field,
                        ),
                      )
                    }
                    onChoose={(field, value) => {
                      const next = {
                        ...form,
                        values: { ...form.values, [field]: value },
                        field,
                        typed: null,
                        error: null,
                      }
                      setForm(settleForm(next, formFieldsOf(next.values)))
                    }}
                  />
                </div>
              )}

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
                        ? `${splitLabels[column]}（選取的分帳）`
                        : splitLabels[column]
                    }
                    numeric={
                      column === 'date'
                        ? 'date'
                        : column === 'amount'
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
                    calendar={
                      column === 'date' && !bulk
                        ? {
                            value: parseDate(edit, now) ?? '',
                            onPick: (iso) => {
                              opened.current = null
                              if (commitCell(iso)) setMode('normal')
                            },
                          }
                        : undefined
                    }
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
        groups={friendKeys}
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
              ? `已選 ${selection.to - selection.from + 1} 筆 · d 刪除 · y 複製 · c 修改 · ? 快捷鍵`
              : mode === 'normal' && cursorLine
                ? cursorLine
                : 'hjkl 移動 · i 編輯 · o 新增 · :settle 結清 · :w 儲存 · ? 快捷鍵'}
          </span>
        )}
      </div>
    </div>
  )
}

function ExpenseLine({
  row,
  index,
  layout,
  state,
  problem,
  ctx,
  people,
  balance,
  now,
  onPick,
}: {
  row: SplitRow
  index: number
  layout: Layout
  state: SplitRowStatus
  problem: SplitProblem | undefined
  ctx: Context
  people: People
  /** The friend account's balance after this line. */
  balance: number
  now: Date
  onPick: (col: number, enter: boolean, extend: boolean) => void
}) {
  const marker = problem
    ? '!'
    : { clean: '', new: '+', changed: '~', deleted: '-' }[state]
  const cell = 'flex items-center overflow-hidden px-2 whitespace-nowrap'
  const muted = 'text-muted-foreground'
  const money = (n: number | null) =>
    n === null ? '' : formatAmount(n, ctx.minorUnits)
  const shares = sharesOf(row)
  const need = needs(row)

  function content(c: SplitColumn, col: number): React.ReactNode {
    const bad = problem?.field === c && 'text-destructive'
    switch (c) {
      case 'date':
        return (
          <span key={c} data-col={col} className={cn(cell, 'font-mono', bad)}>
            {formatDate(row.date, now)}
          </span>
        )
      case 'description':
        return (
          <span key={c} data-col={col} className={cn(cell, bad)}>
            <span className="truncate">{row.description}</span>
          </span>
        )
      case 'amount':
        return (
          <span
            key={c}
            data-col={col}
            className={cn(cell, 'amount justify-end gap-1.5', bad)}
            title={
              row.foreign
                ? `${row.foreign.currency} ${formatAmount(row.foreign.amount, currencyUnits(row.foreign.currency))}`
                : undefined
            }
          >
            {row.foreign && (
              <span className="text-xs text-muted-foreground">
                {row.foreign.currency}
              </span>
            )}
            {money(row.total)}
          </span>
        )
      case 'paidBy':
        return (
          <span key={c} data-col={col} className={cn(cell, bad)}>
            <span className="truncate">
              {row.payer === 'me'
                ? '我'
                : row.payer === 'friend'
                  ? people.friendName
                  : `我 ${money(row.myPaid)}`}
            </span>
          </span>
        )
      case 'split':
        return (
          <span
            key={c}
            data-col={col}
            className={cn(cell, 'text-xs', row.settlement && 'text-kraft', bad)}
          >
            {splitText(row, ctx.minorUnits)}
          </span>
        )
      case 'mine':
        return (
          <span
            key={c}
            data-col={col}
            className={cn(cell, 'amount justify-end', muted)}
          >
            {row.settlement || !shares ? '' : money(shares[0])}
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
              row.deleted
                ? muted
                : balance > 0
                  ? 'text-positive'
                  : balance < 0
                    ? 'amount-negative'
                    : muted,
            )}
          >
            {row.deleted ? '' : money(balance)}
          </span>
        )
      case 'category':
        return (
          <span key={c} data-col={col} className={cn(cell, muted, bad)}>
            <span className="truncate">
              {!need.category
                ? '—'
                : row.categoryId
                  ? ctx.categories.get(row.categoryId)?.path
                  : ''}
            </span>
          </span>
        )
      case 'account':
        return (
          <span key={c} data-col={col} className={cn(cell, muted, bad)}>
            <span className="truncate">
              {!need.account
                ? '—'
                : row.accountId
                  ? ctx.accounts.get(row.accountId)?.name
                  : ''}
            </span>
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
        title={problem?.message}
      >
        {marker}
      </span>
      {splitColumns.map((c, col) => content(c, col))}
    </div>
  )
}
