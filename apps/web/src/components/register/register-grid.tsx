import { useVirtualizer } from '@tanstack/react-virtual'
import {
  ArrowRightLeftIcon,
  CalendarClockIcon,
  CircleCheckIcon,
  CircleIcon,
  LockIcon,
  SplitIcon,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '#/lib/api'
import { errorCodeMessage } from '#/lib/apiError'
import { billingText, deferPlan } from '#/lib/card'
import { setEditorStatus } from '#/lib/editorStatus'
import { formatAmount } from '#/lib/money'
import { movePane, windowDirection } from '#/lib/panes'
import {
  amountCellText,
  bufferRows,
  categoryMode,
  evalAmount,
  findCategory,
  foreignAccount,
  formatDate,
  isoDate,
  multiColumns,
  newRow,
  parseDate,
  problemColumn,
  problemMessages,
  rank,
  rowKey,
  rowStatus,
  runningBalances,
  saveInput,
  columns as singleColumns,
  syncRows,
  validateRow,
  withSplits,
} from '#/lib/register'
import { installmentPlan, scheduleFromRow } from '#/lib/schedules'
import { cn } from '#/lib/utils'
import { CellEditor, eraseBeforeCaret, nextPick } from './cell-editor'
import { KeyHelp } from './key-help'
import { SplitEditor } from './split-editor'
import { useKeyFeed } from './use-key-feed'
import type { CardStatements } from '#/lib/card'
import type { Key, Keymap } from '#/lib/keymap'
import type {
  Column,
  Context,
  Occurrence,
  PayeeRef,
  Row,
  RowProblem,
  RowStatus,
  SplitLine,
  Transaction,
} from '#/lib/register'
import type { Suggestion } from './cell-editor'

// ---------- layout (ADR-045: fixed row height, one cursor overlay)

const ROW_HEIGHT = 32
const GUTTER = 28
const widths: Record<Column, number> = {
  date: 84,
  account: 132,
  payee: 196,
  note: 220,
  category: 196,
  outflow: 112,
  inflow: 112,
  cleared: 52,
}
const BALANCE = 124
const labels: Record<Column, string> = {
  date: '日期',
  account: '帳戶',
  payee: '收付款對象',
  note: '備註',
  category: '類別',
  outflow: '支出',
  inflow: '收入',
  cleared: '核對',
}

/** How the room wider than the columns need is shared out: the text columns. */
const stretch: Partial<Record<Column, number>> = {
  payee: 0.3,
  note: 0.4,
  category: 0.3,
}

interface Layout {
  columns: Array<Column>
  lefts: Record<Column, number>
  widths: Record<Column, number>
  template: string
  width: number
}

/** Column positions for a register `room` pixels wide (at least its minimum). */
function layoutOf(columns: Array<Column>, room: number): Layout {
  const least = columns.reduce((sum, c) => sum + widths[c], GUTTER + BALANCE)
  const extra = Math.max(0, room - least)
  const lefts = {} as Record<Column, number>
  const sized = {} as Record<Column, number>
  let x = GUTTER
  for (const c of columns) {
    sized[c] = widths[c] + Math.floor(extra * (stretch[c] ?? 0))
    lefts[c] = x
    x += sized[c]
  }
  return {
    columns,
    lefts,
    widths: sized,
    template: `${GUTTER}px ${columns.map((c) => `${sized[c]}px`).join(' ')} ${BALANCE}px`,
    width: x + BALANCE,
  }
}

const textColumns = new Set<Column>([
  'date',
  'account',
  'payee',
  'note',
  'category',
  'outflow',
  'inflow',
])
/** The cells a split's lines own: editing them opens the split editor. */
const splitColumns = new Set<Column>(['category', 'outflow', 'inflow'])
/** Normal-mode keys that change rows; held back while a split is open. */
const changingKeys = new Set<Key>([
  'i',
  'a',
  '<CR>',
  '<F2>',
  'c',
  's',
  'o',
  'O',
  'p',
  'P',
  'x',
  'u',
  '<C-r>',
  '.',
  ':',
  'd',
  'y',
  '<C-s>',
  '<D-s>',
])
/** The category completion that turns the row into a split. */
const SPLIT = '\u0000split'

/** `visual` is Vim's linewise visual mode (`V`): whole rows are selected. */
type Mode = 'normal' | 'visual' | 'insert' | 'command'

interface Message {
  text: string
  tone: 'info' | 'error'
}

/** One repeatable change, for `.`, and how many rows it covered. */
interface Change {
  op: 'd' | 'x' | 'p' | 'P'
  lines: number
}

/** Rows `from` to `to` (inclusive), as visual mode selects them. */
interface Range {
  from: number
  to: number
}

/** What the register shows: one account, or a group of them (ADR-071). */
export interface RegisterView {
  /** Names the view's draft: an account id, or `all`, `on-budget`, `off-budget`. */
  key: string
  /** The accounts shown, in the order their rows of one transaction appear. */
  accounts: Array<string>
  /** Whether rows say whose they are (the account column). */
  multi: boolean
}

/** What a register is built from. */
export interface RegisterData {
  transactions: Array<Transaction>
  upcoming: Array<Occurrence>
}

interface Props {
  budgetId: string
  view: RegisterView
  ctx: Context
  transactions: Array<Transaction>
  /** Occurrences of schedules not yet posted: the 預定 rows (ADR-085). */
  upcoming: Array<Occurrence>
  payees: Array<PayeeRef>
  keymap: Keymap
  /** Fetches the view's transactions and 預定 rows again after a change. */
  reload: () => Promise<RegisterData>
  /** Leaves the register (`:q`). */
  onQuit: () => void
  /** A credit card's register: the card and its statements (ADR-088). */
  card?: { id: string; statements: CardStatements }
}

// Version 3: rows carry their key and account (ADR-071). Older drafts are dropped.
const DRAFT_VERSION = 3

function draftKey(budgetId: string, view: string): string {
  return `factual:draft:${budgetId}:${view}`
}

function readDraft(key: string): Array<Row> {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw) as { version?: number; rows?: Array<Row> }
    return parsed.version === DRAFT_VERSION && Array.isArray(parsed.rows)
      ? parsed.rows
      : []
  } catch {
    return []
  }
}

function writeDraft(key: string, rows: Array<Row>): void {
  try {
    if (rows.length === 0) localStorage.removeItem(key)
    else
      localStorage.setItem(
        key,
        JSON.stringify({ version: DRAFT_VERSION, rows }),
      )
  } catch {
    // Storage may be full or blocked; drafts are a convenience (ADR-043).
  }
}

/**
 * 預定 rows and saved rows newest first, with unsaved drafts laid over them
 * (a draft of an edited 預定 row finds it by its id, ADR-085).
 */
function initialRows(
  data: RegisterData,
  accounts: Array<string>,
  drafts: Array<Row>,
): { rows: Array<Row>; conflicts: number } {
  const saved = bufferRows(data.transactions, data.upcoming, accounts)
  const byKey = new Map(saved.map((r, i) => [r.key, i]))
  const fresh: Array<Row> = []
  let conflicts = 0
  for (const draft of drafts) {
    if (!draft.base) {
      fresh.push(draft)
      continue
    }
    const at = byKey.get(draft.key)
    // Saved rows deleted elsewhere since the draft are dropped.
    if (at === undefined) continue
    const server = saved[at]
    if (JSON.stringify(server.base) !== JSON.stringify(draft.base)) conflicts++
    saved[at] = { ...draft, base: server.base }
  }
  return { rows: [...fresh, ...saved], conflicts }
}

export function RegisterGrid({
  budgetId,
  view,
  ctx,
  transactions,
  upcoming,
  payees,
  keymap,
  reload,
  onQuit,
  card,
}: Props) {
  const key = draftKey(budgetId, view.key)
  /** The register's inner width: the text columns grow to fill it. */
  const [room, setRoom] = useState(0)
  const layout = layoutOf(view.multi ? multiColumns : singleColumns, room)
  const { columns } = layout
  const shown = new Set(view.accounts)
  const [init] = useState(() =>
    initialRows({ transactions, upcoming }, view.accounts, readDraft(key)),
  )
  const [rows, setRows] = useState<Array<Row>>(init.rows)
  // The register opens at its top left, as a buffer does.
  const [cursor, setCursor] = useState({
    row: 0,
    col: 0,
  })
  const [mode, setMode] = useState<Mode>('normal')
  const [edit, setEdit] = useState('')
  const [pick, setPick] = useState(0)
  /** Whether a suggestion was chosen with the keys or the mouse. */
  const [navigated, setNavigated] = useState(false)
  const [command, setCommand] = useState('')
  const [message, setMessage] = useState<Message | null>(
    init.conflicts > 0
      ? {
          text: `已還原未儲存的草稿；其中 ${init.conflicts} 筆交易在別處被修改過，儲存會以草稿為準`,
          tone: 'error',
        }
      : init.rows.some((r) => rowStatus(r, ctx) !== 'clean')
        ? { text: '已還原上次未儲存的變更', tone: 'info' }
        : null,
  )
  /** Problems by transaction id: every row of the transaction shows them. */
  const [problems, setProblems] = useState<Map<string, RowProblem>>(new Map())
  const [saving, setSaving] = useState(false)
  /** The key of the row whose split editor is open. */
  const [splitting, setSplitting] = useState<string | null>(null)
  const [splitMode, setSplitMode] = useState<'normal' | 'insert'>('normal')
  /** Where visual mode started; the selection runs from it to the cursor. */
  const [anchor, setAnchor] = useState(0)
  /** Whether the cell editor changes every selected transaction (visual `c`). */
  const [bulk, setBulk] = useState(false)
  /** The key reference (`?`). */
  const [help, setHelp] = useState(false)

  const gridRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const history = useRef<{ undo: Array<Array<Row>>; redo: Array<Array<Row>> }>({
    undo: [],
    redo: [],
  })
  const pending = useRef({ count: '', op: '' })
  /** The yanked transactions, one row each. */
  const yanked = useRef<Array<Row>>([])
  const lastChange = useRef<Change | null>(null)
  /** The last selection, for `gv`. */
  const lastVisual = useRef<{ anchor: number; row: number } | null>(null)
  /**
   * The row `o` just opened, and where the cursor was, until anything is
   * typed, picked or committed in it: Esc then takes the row back out.
   */
  const opened = useRef<{ key: string; from: typeof cursor } | null>(null)
  /** The selection a command typed from visual mode acts on. */
  const commandRange = useRef<Range | null>(null)

  const today = new Date()
  const statuses: Array<RowStatus> = rows.map((r) => rowStatus(r, ctx))
  // Unsaved transactions, not rows: a transfer is on two rows of one view.
  const dirty = new Set(
    rows.filter((_, i) => statuses[i] !== 'clean').map((r) => r.id),
  ).size
  const balances = runningBalances(rows)
  const current = rows.at(cursor.row)
  const column = columns[cursor.col]
  const splitRow = splitting ? rows.find((r) => r.key === splitting) : undefined
  const selection: Range | null =
    mode === 'visual' || (mode === 'insert' && bulk)
      ? {
          from: clamp(Math.min(anchor, cursor.row)),
          to: clamp(Math.max(anchor, cursor.row)),
        }
      : null

  // Status line and drafts follow the buffer.
  const shownMode = splitRow ? splitMode : mode
  useEffect(() => {
    setEditorStatus({ mode: shownMode, dirty })
  }, [shownMode, dirty])
  useEffect(() => () => setEditorStatus(null), [])
  useEffect(() => {
    writeDraft(
      key,
      rows.filter((_, i) => statuses[i] !== 'clean'),
    )
  }, [key, rows, statuses])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  })

  useEffect(() => {
    if (rows.length > 0)
      virtualizer.scrollToIndex(cursor.row, { align: 'auto' })
  }, [cursor.row, rows.length, virtualizer])

  useEffect(() => {
    if (mode === 'normal' && !splitting && !help)
      gridRef.current?.focus({ preventScroll: true })
  }, [mode, splitting, help])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const observer = new ResizeObserver(() => setRoom(el.clientWidth))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // ---------- buffer changes

  function change(next: Array<Row>) {
    history.current.undo.push(rows)
    if (history.current.undo.length > 200) history.current.undo.shift()
    history.current.redo = []
    setRows(next)
  }

  /** Changes one row, and the transaction's other rows with it (ADR-071). */
  function updateRow(index: number, patch: Partial<Row>) {
    const row = rows[index]
    const next = { ...row, ...patch }
    if (JSON.stringify(next) === JSON.stringify(row)) return
    change(syncRows(rows.with(index, next), index, ctx, shown))
    if (problems.has(row.id)) {
      const rest = new Map(problems)
      rest.delete(row.id)
      setProblems(rest)
    }
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

  function accountName(id: string | null): string {
    return id ? (ctx.accounts.get(id)?.name ?? '') : ''
  }

  // ---------- row commands

  function openRow(at: number) {
    const near = rows.at(cursor.row)
    const accountId =
      near?.accountId ?? view.accounts.find((a) => !ctx.accounts.get(a)?.closed)
    if (!accountId) return say('還沒有帳戶：先到「帳戶」新增一個', 'error')
    const row = newRow(
      crypto.randomUUID(),
      near?.date ?? isoDate(today),
      accountId,
    )
    const index = Math.max(0, Math.min(at, rows.length))
    change(rows.toSpliced(index, 0, row))
    opened.current = { key: row.key, from: cursor }
    setEdit('')
    setBulk(false)
    setMode('insert')
    if (!view.multi) {
      setCursor({ row: index, col: columns.indexOf('payee') })
      setPick(0)
      setNavigated(false)
      return
    }
    // A register of several accounts asks whose the transaction is first,
    // offering the account of the row it was opened from.
    setCursor({ row: index, col: columns.indexOf('account') })
    const offered = rank(
      openAccounts(null, shown),
      '',
      (a) => a.name,
    ).findIndex((a) => a.id === accountId)
    setPick(Math.max(0, offered))
    setNavigated(offered >= 0)
    say('先選帳戶：Ctrl-n/Ctrl-p 或打字篩選，Tab 到收付款對象')
  }

  /**
   * Esc right after `o`, with nothing typed or picked and the row still
   * blank: the row goes, as if `o` had not been pressed (no undo step left).
   */
  function dropOpened(): boolean {
    const o = opened.current
    opened.current = null
    if (!o || !current || current.key !== o.key || bulk) return false
    if (edit.trim() !== '' || current.base) return false
    if (
      current.payee ||
      current.transferTo ||
      current.note ||
      current.categoryId ||
      current.amount !== 0 ||
      current.splits
    ) {
      return false
    }
    history.current.undo.pop()
    const next = rows.filter((r) => r.key !== o.key)
    setRows(next)
    setCursor({ row: clamp(o.from.row, next.length), col: o.from.col })
    setMode('normal')
    say('已取消新增')
    return true
  }

  /**
   * The keys of the transactions on rows `from` to `to`: the first row of
   * each (a transfer may be on two rows of one view).
   */
  function transactionKeys({ from, to }: Range): Array<string> {
    const seen = new Set<string>()
    return rows
      .slice(from, to + 1)
      .filter((r) => !seen.has(r.id) && Boolean(seen.add(r.id)))
      .map((r) => r.key)
  }

  /**
   * Changes rows by key as one undo step, each through `syncRows`, and
   * returns how many changed; `patchOf` returns null to leave a row alone.
   */
  function patchRows(
    keys: Array<string>,
    patchOf: (row: Row) => Partial<Row> | null,
  ): number {
    let next = rows
    const changed = new Set<string>()
    for (const k of keys) {
      const i = next.findIndex((r) => r.key === k)
      if (i < 0) continue
      const patch = patchOf(next[i])
      if (!patch) continue
      const row = { ...next[i], ...patch }
      if (JSON.stringify(row) === JSON.stringify(next[i])) continue
      next = syncRows(next.with(i, row), i, ctx, shown)
      changed.add(row.id)
    }
    if (changed.size === 0) return 0
    change(next)
    if ([...changed].some((id) => problems.has(id))) {
      const rest = new Map(problems)
      for (const id of changed) rest.delete(id)
      setProblems(rest)
    }
    return changed.size
  }

  /**
   * dd, or d on a selection: marks saved transactions deleted and drops
   * unsaved ones; every row of a transaction goes with it. As in Vim, what
   * is deleted is also yanked, so p puts it back elsewhere. When all of them
   * are marked already, the marks come off instead (and nothing is yanked).
   */
  function deleteRange({ from, to }: Range) {
    const targets = rows.slice(from, to + 1)
    if (targets.length === 0) return
    if (targets.some((t) => t.planned)) {
      return say('預定列不能刪除：用 :skip 略過這一期', 'error')
    }
    const restore = targets.every((t) => t.deleted)
    const ids = new Set(targets.map((t) => t.id))
    if (!restore) {
      const keys = new Set(transactionKeys({ from, to }))
      yanked.current = rows
        .filter((r) => keys.has(r.key))
        .map((r) => ({ ...r, deleted: false }))
    }
    const next = rows.flatMap((r) => {
      if (!ids.has(r.id)) return [r]
      return r.base ? [{ ...r, deleted: !restore }] : []
    })
    change(next)
    setCursor((c) => ({ ...c, row: clamp(from, next.length) }))
    lastChange.current = { op: 'd', lines: to - from + 1 }
    if (ids.size === 1) return
    if (restore) return say(`已取消 ${ids.size} 筆交易的刪除標記`)
    const saved = new Set(targets.filter((t) => t.base).map((t) => t.id)).size
    const parts = [
      saved > 0 && `標記刪除 ${saved} 筆（:w 儲存後才會刪除）`,
      ids.size > saved && `移除 ${ids.size - saved} 筆未儲存的`,
    ].filter(Boolean)
    say(`已${parts.join('、')}，u 可以復原，p 可以貼上`)
  }

  /** yy, or y on a selection: copies the transactions for p. */
  function yank(range: Range) {
    const keys = new Set(transactionKeys(range))
    if (keys.size === 0) return
    yanked.current = rows.filter((r) => keys.has(r.key))
    setCursor((c) => ({ ...c, row: range.from }))
    say(`已複製 ${keys.size} 筆交易（p 貼上）`)
  }

  /** A new, unsaved transaction like `source`. */
  function copyOf(source: Row): Row {
    const id = crypto.randomUUID()
    return {
      ...source,
      key: rowKey(id, source.accountId),
      id,
      base: null,
      deleted: false,
      planned: null,
      cleared: 'uncleared',
      splits:
        source.splits?.map((l) => ({
          ...l,
          id: crypto.randomUUID(),
          counterCleared: 'uncleared',
        })) ?? null,
    }
  }

  function paste(after: boolean) {
    const sources = yanked.current
    if (sources.length === 0) {
      return say('還沒有複製任何交易（yy，或 V 選取後按 y）')
    }
    const usable = sources.filter((s) => !s.locked)
    if (usable.length === 0) {
      return say(
        sources[0].locked === 'opening'
          ? '期初餘額不能貼上'
          : '這筆拆分交易要在另一個帳戶複製',
        'error',
      )
    }
    const copies = usable.map(copyOf)
    const index = rows.length === 0 ? 0 : cursor.row + (after ? 1 : 0)
    let next = rows.toSpliced(index, 0, ...copies)
    for (const copy of copies) {
      const i = next.findIndex((r) => r.key === copy.key)
      next = syncRows(next, i, ctx, shown)
    }
    change(next)
    setCursor((c) => ({ ...c, row: index }))
    lastChange.current = { op: after ? 'p' : 'P', lines: 1 }
    const skipped = sources.length - usable.length
    if (skipped > 0) {
      say(
        `已貼上 ${copies.length} 筆；略過 ${skipped} 筆期初餘額或在別的帳戶拆分的交易`,
      )
    } else if (copies.length > 1) {
      say(`已貼上 ${copies.length} 筆交易`)
    }
  }

  /**
   * x, or x on a selection: marks the rows cleared, or uncleared when all of
   * them are. Reconciled and deleted rows are left alone.
   */
  function toggleCleared({ from, to }: Range) {
    const targets = rows.slice(from, to + 1)
    if (targets.length === 0) return
    const open = targets.filter((r) => !r.deleted && r.cleared !== 'reconciled')
    if (open.length === 0) {
      return say(
        targets.every((r) => r.deleted)
          ? '這一列已標記刪除，按 u 復原或 dd 取消'
          : '已對帳的交易不能取消核對',
        'error',
      )
    }
    const cleared = open.every((r) => r.cleared === 'cleared')
      ? 'uncleared'
      : 'cleared'
    patchRows(
      open.map((r) => r.key),
      () => ({ cleared }),
    )
    // As after any change to a selection, the cursor goes to its top.
    setCursor((c) => ({ ...c, row: from }))
    lastChange.current = { op: 'x', lines: to - from + 1 }
    const skipped = targets.length - open.length
    if (skipped > 0) say(`已略過 ${skipped} 列已對帳或已標記刪除的交易`)
  }

  function repeat() {
    const last = lastChange.current
    if (!last) return say('沒有可以重複的動作')
    const range = { from: cursor.row, to: cursor.row + last.lines - 1 }
    switch (last.op) {
      case 'd':
        return deleteRange(range)
      case 'x':
        return toggleCleared(range)
      case 'p':
        return paste(true)
      case 'P':
        return paste(false)
    }
  }

  // ---------- visual mode (linewise, like Vim's V)

  function startVisual(from: number, to: number) {
    if (rows.length === 0) return say('沒有交易，按 o 新增一筆')
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

  /**
   * c on a selection: one cell editor whose text goes into this column of
   * every selected transaction (on the cleared column it toggles them).
   */
  function changeSelection(range: Range) {
    if (column === 'cleared') {
      endVisual()
      return toggleCleared(range)
    }
    const keys = transactionKeys(range)
    const usable = keys.filter((k) => {
      const row = rows.find((r) => r.key === k)
      return row && bulkEditable(row, column)
    })
    if (usable.length === 0) {
      return say(`選取的交易都不能修改${labels[column]}`, 'error')
    }
    const skipped = keys.length - usable.length
    setEdit('')
    setPick(0)
    setNavigated(false)
    setBulk(true)
    setMode('insert')
    say(
      `輸入的${labels[column]}會套用到 ${usable.length} 筆交易${
        skipped > 0 ? `（略過 ${skipped} 筆不能改的）` : ''
      }；Enter 套用，沒輸入就按 Esc 取消`,
    )
  }

  function bulkEditable(row: Row, col: Column): boolean {
    return !editable(row, col) && !(row.splits && splitColumns.has(col))
  }

  /** Puts `text` into the selected transactions; false keeps editing. */
  function commitBulk(text: string, cancelIfEmpty: boolean): boolean {
    if (!selection) return true
    if (cancelIfEmpty && text.trim() === '') {
      endVisual()
      say('沒有輸入，未修改任何交易')
      return true
    }
    let error = ''
    let skipped = 0
    const changed = patchRows(transactionKeys(selection), (row) => {
      if (!bulkEditable(row, column)) {
        skipped++
        return null
      }
      const patch = patchFor(row, column, text)
      if (typeof patch === 'string') {
        error ||= patch
        skipped++
        return null
      }
      return patch
    })
    // The same mistake on every row (a date it cannot read): keep editing.
    if (error && changed === 0) {
      say(error, 'error')
      return false
    }
    lastVisual.current = { anchor, row: cursor.row }
    setBulk(false)
    setCursor((c) => ({ ...c, row: selection.from }))
    say(
      `已修改 ${changed} 筆交易的${labels[column]}${
        skipped > 0 ? `，略過 ${skipped} 筆` : ''
      }${error ? `（${error}）` : ''}${changed > 0 ? '（u 可以復原）' : ''}`,
      error ? 'error' : 'info',
    )
    return true
  }

  // ---------- splits (ADR-068)

  function openSplit(index: number) {
    const row = rows.at(index)
    if (!row) return say('沒有交易，按 o 新增一筆')
    if (row.deleted)
      return say('這一列已標記刪除，按 u 復原或 dd 取消', 'error')
    if (row.locked === 'opening') return say('期初餘額不能拆分', 'error')
    if (row.locked === 'foreign') return say(foreignMessage(row), 'error')
    setMode('normal')
    setMessage(null)
    setSplitMode('normal')
    setSplitting(row.key)
  }

  function closeSplit(lines: Array<SplitLine>, then: Array<Key>) {
    const index = rows.findIndex((r) => r.key === splitting)
    setSplitting(null)
    if (index >= 0) {
      const before = rows[index]
      const next = withSplits(before, lines)
      updateRow(index, next)
      if (JSON.stringify(next) !== JSON.stringify(before)) {
        say(
          next.splits
            ? `已拆分成 ${next.splits.length} 行（u 可以復原）`
            : '已改回單一類別（u 可以復原）',
        )
      }
    }
    feed.push(then)
  }

  function foreignMessage(row: Row): string {
    const name = accountName(foreignAccount(row))
    return `這筆拆分交易是從「${name}」記的，類別和金額要在那個帳戶的明細修改`
  }

  // ---------- cell editing

  function editable(row: Row, col: Column): string | null {
    if (row.deleted) return '這一列已標記刪除，按 u 復原或 dd 取消'
    if (
      row.locked === 'foreign' &&
      (splitColumns.has(col) || col === 'account')
    ) {
      return foreignMessage(row)
    }
    if (col === 'account' && row.locked === 'opening') {
      return '期初餘額不能換帳戶'
    }
    if (col === 'category') {
      const m = categoryMode(row, ctx)
      if (m === 'locked') return '期初餘額的類別不能修改'
      if (m === 'none') return '這筆交易不需要類別'
    }
    return null
  }

  function cellText(row: Row, col: Column): string {
    switch (col) {
      case 'date':
        return formatDate(row.date, today)
      case 'account':
        return accountName(row.accountId)
      case 'payee':
        return row.transferTo ? `@${accountName(row.transferTo)}` : row.payee
      case 'note':
        return row.note
      case 'category':
        return row.categoryId
          ? (ctx.categories.get(row.categoryId)?.path ?? '')
          : ''
      case 'outflow':
      case 'inflow':
        return amountCellText(row.amount, col, ctx.minorUnits)
      case 'cleared':
        return ''
    }
  }

  function startInsertAt(index: number, colIndex: number, clear = false) {
    const row = rows.at(index)
    const col = columns[colIndex]
    if (!row) return say('沒有交易，按 o 新增一筆')
    if (col === 'cleared') return toggleCleared({ from: index, to: index })
    if (row.splits && splitColumns.has(col) && !row.deleted) {
      return openSplit(index)
    }
    const reason = editable(row, col)
    if (reason) return say(reason, 'error')
    setEdit(clear ? '' : cellText(row, col))
    setPick(0)
    setNavigated(false)
    setBulk(false)
    setMode('insert')
  }

  /** Open accounts a row can be on, or transfer to. */
  function openAccounts(except: string | null, among?: Set<string>) {
    return [...ctx.accounts.values()].filter(
      (a) => a.id !== except && !a.closed && (!among || among.has(a.id)),
    )
  }

  function suggestions(): Array<Suggestion> {
    if (mode !== 'insert' || !current) return []
    if (column === 'account') {
      const accounts = openAccounts(null, shown).map((a) => ({
        value: a.name,
        label: a.name,
        hint: a.onBudget ? '預算內' : '追蹤',
      }))
      return rank(accounts, edit, (a) => a.value)
    }
    if (column === 'payee') {
      const transfers = openAccounts(current.accountId).map((a) => ({
        value: `@${a.name}`,
        label: `@${a.name}`,
        hint: '轉帳',
      }))
      if (edit.startsWith('@')) return rank(transfers, edit, (s) => s.value)
      const named = payees.map((p) => ({
        value: p.name,
        label: p.name,
        hint: p.lastCategoryId
          ? ctx.categories.get(p.lastCategoryId)?.path
          : undefined,
      }))
      return edit ? rank([...named, ...transfers], edit, (s) => s.value) : []
    }
    if (column === 'category') {
      const usable = [...ctx.categories.values()].filter(
        (c) => !c.isSystem && !c.archived,
      )
      const found: Array<Suggestion> = rank(usable, edit, (c) => c.path).map(
        (c) => ({
          value: c.path,
          label: c.path,
          hint: c.kind === 'income' ? '收入' : undefined,
        }),
      )
      // Splitting is offered last, and first when asked for by name.
      const split: Suggestion = {
        value: SPLIT,
        label: '拆分成多個類別…',
        hint: ':sp',
      }
      // Several transactions are not split at once.
      if (bulk) return found
      const q = edit.trim().toLowerCase()
      const asked =
        (q.length >= 2 || q === '拆') &&
        ['拆分', 'split'].some((word) => word.startsWith(q))
      if (!edit) return [...found, split]
      return asked ? [split, ...found] : found
    }
    return []
  }

  /**
   * What typing `text` into a cell changes on a row, or why it cannot
   * (a message to show).
   */
  function patchFor(
    row: Row,
    col: Column,
    text: string,
  ): Partial<Row> | string {
    const value = text.trim()
    const patch: Partial<Row> = {}
    switch (col) {
      case 'date': {
        const date = parseDate(value, today)
        if (!date)
          return '看不懂這個日期：可以輸入 t、-1、5、11/5 或 2026-11-05'
        patch.date = date
        break
      }
      case 'account': {
        const account = openAccounts(null, shown).find((a) => a.name === value)
        if (!account) return `找不到帳戶「${value}」`
        if (
          account.id === row.transferTo ||
          row.splits?.some((l) => l.transferTo === account.id)
        ) {
          return '不能轉帳給同一個帳戶'
        }
        patch.accountId = account.id
        const next = { ...row, ...patch }
        if (categoryMode(next, ctx) === 'none') patch.categoryId = null
        break
      }
      case 'payee': {
        if (value.startsWith('@')) {
          if (row.splits) return '拆分交易的轉帳要寫在拆分行裡（:sp）'
          const name = value.slice(1).trim()
          const account = [...ctx.accounts.values()].find(
            (a) => a.name === name,
          )
          if (!account) return `找不到帳戶「${name}」`
          if (account.id === row.accountId) return '不能轉帳給同一個帳戶'
          patch.transferTo = account.id
          patch.payee = ''
        } else {
          patch.transferTo = null
          patch.payee = value
          // A known payee fills in the category it was last used with.
          const known = payees.find((p) => p.name === value)
          if (known?.lastCategoryId && !row.categoryId && !row.splits) {
            patch.categoryId = known.lastCategoryId
          }
        }
        // A category that no longer applies is dropped.
        const next = { ...row, ...patch }
        if (categoryMode(next, ctx) === 'none') patch.categoryId = null
        break
      }
      case 'note':
        patch.note = value
        break
      case 'category': {
        if (!value) {
          patch.categoryId = null
          break
        }
        const found = findCategory(value, ctx.categories.values())
        if (!found) return `找不到類別「${value}」：請從清單選，或輸入完整路徑`
        patch.categoryId = found.id
        break
      }
      case 'outflow':
      case 'inflow': {
        const amount = evalAmount(value, ctx.minorUnits)
        if (amount === null)
          return '金額格式不對：可以輸入 1280、1,280 或 120*3'
        if (amount !== 0) {
          patch.amount = col === 'outflow' ? -amount : amount
        } else if (
          (col === 'outflow' && row.amount < 0) ||
          (col === 'inflow' && row.amount > 0)
        ) {
          patch.amount = 0
        }
        break
      }
      case 'cleared':
        break
    }
    return patch
  }

  /**
   * Applies the cell editor's text and returns the row as it now is, or null
   * (with a message) when the text is not valid. Under visual `c` the text
   * goes into every selected transaction.
   */
  function commitCell(text: string, cancelIfEmpty = false): Row | null {
    if (!current) return null
    if (bulk) return commitBulk(text, cancelIfEmpty) ? current : null
    opened.current = null
    const patch = patchFor(current, column, text)
    if (typeof patch === 'string') {
      say(patch, 'error')
      return null
    }
    updateRow(cursor.row, patch)
    setMessage(null)
    return { ...current, ...patch }
  }

  /**
   * The text a cell is left with: what was typed, unless a suggestion was
   * chosen or what was typed does not name anything while a suggestion does.
   * A new payee name is never replaced by an existing one unasked.
   */
  function chosenText(): string {
    const options = suggestions()
    if (options.length === 0) return edit
    const highlighted = options[Math.min(pick, options.length - 1)].value
    // Picked with Ctrl-n/Ctrl-p or the arrows, even before anything is typed.
    if (navigated) return highlighted
    // A row needs an account; for the other cells nothing typed clears them.
    if (edit === '') return column === 'account' ? highlighted : edit
    if (column === 'category') {
      return findCategory(edit, ctx.categories.values()) ? edit : highlighted
    }
    if (column === 'account') {
      return options.some((o) => o.value === edit.trim()) ? edit : highlighted
    }
    if (column === 'payee' && edit.startsWith('@')) {
      const name = edit.slice(1).trim()
      return [...ctx.accounts.values()].some((a) => a.name === name)
        ? edit
        : highlighted
    }
    return edit
  }

  /** The suggestion Enter would take, or -1 when it keeps the typed text. */
  function takenIndex(options: Array<Suggestion>): number {
    if (options.length === 0) return -1
    const text = chosenText()
    // A category named by part of its path (外食) is the option of its path.
    const value =
      column === 'category'
        ? (findCategory(text, ctx.categories.values())?.path ?? text)
        : text
    return options.findIndex((o) => o.value === value)
  }

  /** Leaves the cell: stays on it, or (Tab) moves to the next text cell. */
  function finishCell(move: 'stay' | 'next' | 'prev'): void {
    const text = chosenText()
    if (text === SPLIT) return openSplit(cursor.row)
    const row = commitCell(text)
    if (!row) return
    // A change to several transactions ends where it started.
    if (move === 'stay' || bulk) {
      setMode('normal')
      return
    }
    // Tab walks the editable text cells of the row; past the last it stops.
    let col = cursor.col
    for (;;) {
      col += move === 'next' ? 1 : -1
      if (col < 0 || col >= columns.length) {
        setMode('normal')
        return
      }
      const c = columns[col]
      if (textColumns.has(c) && !editable(row, c)) break
    }
    // A split's amount and category are its lines: Tab opens them.
    if (row.splits && splitColumns.has(columns[col])) {
      return openSplit(cursor.row)
    }
    setCursor((cur) => ({ ...cur, col }))
    setEdit(cellText(row, columns[col]))
    setPick(0)
    setNavigated(false)
  }

  // ---------- saving (:w)

  async function save(): Promise<boolean> {
    const found = new Map<string, RowProblem>()
    rows.forEach((row) => {
      if (rowStatus(row, ctx) === 'clean') return
      const p = validateRow(row, ctx)
      if (p && !found.has(row.id)) found.set(row.id, p)
    })
    if (found.size > 0) return reportProblems(found)

    // One upsert per transaction, though it may be on several rows.
    const sent = new Set<string>()
    const upserts = rows
      .filter((r) => !r.deleted && rowStatus(r, ctx) !== 'clean')
      .filter((r) => !sent.has(r.id) && Boolean(sent.add(r.id)))
      .map((r) => saveInput(r, ctx))
    const deletes = [
      ...new Set(rows.filter((r) => r.deleted && r.base).map((r) => r.id)),
    ]
    if (upserts.length === 0 && deletes.length === 0) {
      say('沒有需要儲存的變更')
      return true
    }

    setSaving(true)
    try {
      const { data, error, response } = await api.POST(
        '/budgets/{budgetId}/transactions/batch',
        { params: { path: { budgetId } }, body: { upserts, deletes } },
      )
      if (response.status === 422 && error && 'errors' in error) {
        const fromServer = new Map<string, RowProblem>()
        for (const p of error.errors) {
          fromServer.set(p.id, {
            field: problemColumn(p.field),
            message: problemMessages[p.code] ?? p.message,
          })
        }
        return reportProblems(fromServer)
      }
      if (!data) {
        say('儲存失敗，請稍後再試；變更仍保留在草稿裡', 'error')
        return false
      }
      const fresh = await reload()
      const next = bufferRows(fresh.transactions, fresh.upcoming, view.accounts)
      writeDraft(key, [])
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

  function reportProblems(found: Map<string, RowProblem>): false {
    setProblems(found)
    const first = rows.findIndex((r) => found.has(r.id))
    const p = found.get(rows[first]?.id ?? '')
    if (first >= 0) {
      const col = p?.field ? columns.indexOf(p.field) : -1
      setCursor({ row: first, col: col >= 0 ? col : cursor.col })
    }
    say(`${found.size} 筆交易有問題，沒有儲存：${p?.message ?? ''}`, 'error')
    return false
  }

  function discard() {
    const fresh = bufferRows(transactions, upcoming, view.accounts)
    writeDraft(key, [])
    change(fresh)
    setProblems(new Map())
    setCursor((c) => ({ ...c, row: clamp(c.row, fresh.length) }))
    say('已放棄所有未儲存的變更（u 可以復原）')
  }

  // ---------- 預定 rows and review (ADR-085)

  function messageFor(code: string, fallback: string): string {
    if (problemMessages[code]) return problemMessages[code]
    const known = errorCodeMessage(code)
    return known === '發生未知錯誤' ? fallback : known
  }

  /** The rows a command acts on: the selection it was typed from, or the cursor's. */
  function commandRows(): Array<Row> {
    const range = commandRange.current ?? {
      from: cursor.row,
      to: cursor.row,
    }
    commandRange.current = null
    return rows.slice(range.from, range.to + 1)
  }

  /**
   * Reads the register again after the server changed it, keeping every
   * unsaved change (they are laid over it as drafts are).
   */
  async function refresh() {
    const fresh = await reload()
    const kept = rows.filter((r) => rowStatus(r, ctx) !== 'clean')
    const next = initialRows(fresh, view.accounts, kept).rows
    history.current = { undo: [], redo: [] }
    setRows(next)
    setCursor((c) => ({ ...c, row: clamp(c.row, next.length) }))
  }

  /** :post and :skip: each 預定 transaction of the rows, once. */
  async function onOccurrences(targets: Array<Row>, action: 'post' | 'skip') {
    const planned = targets.filter((r) => r.planned)
    if (planned.length === 0) {
      return say('這裡沒有預定列（淡色、標著時鐘的那些）', 'error')
    }
    const edited = planned.filter((r) => rowStatus(r, ctx) !== 'clean')
    if (action === 'post' && edited.length > 0) {
      return say('改過的預定列用 :w 入帳（會照改過的內容）', 'error')
    }
    const seen = new Set<string>()
    const occurrences = planned
      .filter((r) => !seen.has(r.id) && Boolean(seen.add(r.id)))
      .flatMap((r) => (r.planned ? [r.planned] : []))
    setSaving(true)
    try {
      let done = 0
      for (const o of occurrences) {
        const path = {
          params: { path: { budgetId, scheduleId: o.scheduleId } },
          body: { occurrence: o.occurrence },
        }
        const { error } =
          action === 'post'
            ? await api.POST(
                '/budgets/{budgetId}/schedules/{scheduleId}/post',
                path,
              )
            : await api.POST(
                '/budgets/{budgetId}/schedules/{scheduleId}/skips',
                path,
              )
        if (error) {
          await refresh()
          return say(
            `${done > 0 ? `已處理 ${done} 期；` : ''}${messageFor(error.code, error.message)}`,
            'error',
          )
        }
        done++
      }
      await refresh()
      say(
        action === 'post'
          ? `已入帳 ${done} 期`
          : `已略過 ${done} 期（到排程頁用 :unskip 可以取消）`,
      )
    } catch {
      say('無法連線至伺服器', 'error')
    } finally {
      setSaving(false)
    }
  }

  /** :review: confirms transactions a schedule posted with an estimate. */
  async function review(targets: Array<Row>) {
    const ids = [
      ...new Set(targets.filter((r) => r.base?.needsReview).map((r) => r.id)),
    ]
    if (ids.length === 0) return say('這裡沒有待確認的交易（標著 ? 的那些）')
    setSaving(true)
    try {
      const { data, error } = await api.POST(
        '/budgets/{budgetId}/transactions/reviewed',
        { params: { path: { budgetId } }, body: { ids } },
      )
      if (error) return say(messageFor(error.code, error.message), 'error')
      await refresh()
      say(`已確認 ${data.reviewed} 筆交易的金額`)
    } catch {
      say('無法連線至伺服器', 'error')
    } finally {
      setSaving(false)
    }
  }

  /** :schedule: a monthly schedule like the cursor's row, from its next month. */
  async function makeSchedule() {
    commandRange.current = null
    const row = current
    if (!row) return say('沒有交易，按 o 新增一筆')
    if (row.planned) return say('這一列已經是排程的預定列', 'error')
    const made = scheduleFromRow(row, crypto.randomUUID(), isoDate(today))
    if (typeof made === 'string') return say(made, 'error')
    setSaving(true)
    try {
      const { error } = await api.POST('/budgets/{budgetId}/schedules/batch', {
        params: { path: { budgetId } },
        body: { upserts: [made.input], deletes: [] },
      })
      if (error) {
        const problem = 'errors' in error ? error.errors.at(0) : error
        return say(
          problem ? messageFor(problem.code, problem.message) : '無法建立排程',
          'error',
        )
      }
      await refresh()
      say(
        `已建立排程「${made.input.source}」，第一期 ${formatDate(made.first, today)}；到「排程」頁可以修改週期和預算方式`,
      )
    } catch {
      say('無法連線至伺服器', 'error')
    } finally {
      setSaving(false)
    }
  }

  /** :defer: rows out of the card's latest statement, or back in (ADR-088). */
  async function defer(targets: Array<Row>) {
    if (!card) return say('只有信用卡的明細可以調整帳單', 'error')
    const plan = deferPlan(targets, card.id, card.statements)
    if (typeof plan === 'string') return say(plan, 'error')
    setSaving(true)
    try {
      const { data, error } = await api.PUT(
        '/budgets/{budgetId}/accounts/{accountId}/billing',
        {
          params: { path: { budgetId, accountId: card.id } },
          body: { transactionIds: plan.ids, billed: plan.billed },
        },
      )
      if (error) return say(messageFor(error.code, error.message), 'error')
      await refresh()
      const closing = card.statements.statements.at(0)?.periodEnd ?? ''
      say(
        plan.billed
          ? `已把 ${data.changed} 筆放回 ${formatDate(closing, today)} 結帳的帳單`
          : `已把 ${data.changed} 筆移到下一期帳單（再 :defer 一次可以放回）`,
      )
    } catch {
      say('無法連線至伺服器', 'error')
    } finally {
      setSaving(false)
    }
  }

  /**
   * :installment N: the cursor's purchase becomes its first instalment (an
   * unsaved change, :w) and a schedule holds the rest (ADR-091).
   */
  async function installment(n: number) {
    commandRange.current = null
    const row = current
    if (!row) return say('沒有交易，按 o 新增一筆')
    if (row.planned) return say('預定列不能分期', 'error')
    const plan = installmentPlan(row, n, crypto.randomUUID(), isoDate(today))
    if (typeof plan === 'string') return say(plan, 'error')
    setSaving(true)
    try {
      const { error } = await api.POST('/budgets/{budgetId}/schedules/batch', {
        params: { path: { budgetId } },
        body: { upserts: [plan.input], deletes: [] },
      })
      if (error) {
        const problem = 'errors' in error ? error.errors.at(0) : error
        return say(
          problem ? messageFor(problem.code, problem.message) : '無法建立分期',
          'error',
        )
      }
      updateRow(cursor.row, { amount: plan.first })
      const money = (v: number) => formatAmount(-v, ctx.minorUnits)
      say(
        `分成 ${n} 期：這筆改成第一期 ${money(plan.first)}（:w 儲存），其餘 ${plan.left} 期每期 ${money(plan.each)} 建成排程「${plan.input.source}」${plan.past > 0 ? `；已經過的 ${plan.past} 期當作繳過，不補記` : ''}`,
      )
    } catch {
      say('無法連線至伺服器', 'error')
    } finally {
      setSaving(false)
    }
  }

  async function runCommand(raw: string) {
    const cmd = raw.trim()
    setMode('normal')
    setCommand('')
    if (cmd === 'post') {
      await onOccurrences(commandRows(), 'post')
    } else if (cmd === 'skip') {
      await onOccurrences(commandRows(), 'skip')
    } else if (cmd === 'review') {
      await review(commandRows())
    } else if (cmd === 'defer') {
      await defer(commandRows())
    } else if (/^inst(allments?)?(\s|$)/.test(cmd)) {
      const n = Number(cmd.split(/\s+/)[1])
      if (!n) return say('要分幾期？例如 :installment 12', 'error')
      await installment(n)
    } else if (cmd === 'schedule' || cmd === 'sched') {
      await makeSchedule()
    } else if (cmd === 'w') {
      await save()
    } else if (cmd === 'wq' || cmd === 'x') {
      if (await save()) onQuit()
    } else if (cmd === 'q') {
      if (dirty > 0) {
        say(`還有 ${dirty} 筆未儲存（:w 儲存，:q! 離開並保留草稿）`, 'error')
      } else {
        onQuit()
      }
    } else if (cmd === 'q!') {
      onQuit()
    } else if (cmd === 'e!') {
      discard()
    } else if (/^winc(md)? [hjkl]$/.test(cmd)) {
      const dir = windowDirection(cmd.slice(-1))
      if (dir) movePane(dir, gridRef.current)
    } else if (cmd === 'sp' || cmd === 'split') {
      openSplit(cursor.row)
    } else if (/^\d+$/.test(cmd)) {
      moveTo(Number(cmd) - 1, cursor.col)
    } else if (cmd) {
      say(`不認得的指令：${cmd}`, 'error')
    }
  }

  // ---------- keys (named as Vim writes them; mappings come first, ADR-070)

  function runNormal(k: Key): boolean {
    if (saving) return false
    const p = pending.current
    const visual = mode === 'visual'
    // While the split window is open the register above it only moves.
    if (
      splitting &&
      !p.op &&
      changingKeys.has(k) &&
      !(visual && (k === 'o' || k === 'O'))
    ) {
      say('拆分視窗還開著：回到下面的拆分視窗按 q 完成，才能修改明細')
      return true
    }
    // A count before a motion or command: 5j, 3dd.
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

    // dd, 3yy: this row and the ones under it.
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
      // Vim's window commands (ADR-072), reached through mappings.
      const dir = p.op === '<C-w>' ? windowDirection(k) : null
      if (dir) return done(() => movePane(dir, gridRef.current))
      pending.current = { count: '', op: '' }
      return true
    }

    // Motions, in normal and visual mode alike.
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
        return done(() => moveTo(cursor.row, cursor.col + count))
      case 'h':
      case '<Left>':
      case 'b':
        return done(() => moveTo(cursor.row, cursor.col - count))
      case '<Tab>':
        return done(() => moveTo(cursor.row, cursor.col + 1))
      case '<S-Tab>':
        return done(() => moveTo(cursor.row, cursor.col - 1))
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
      case '<PageDown>':
      case '<C-f>':
        return done(() => moveTo(cursor.row + half * 2, cursor.col))
      case '<PageUp>':
      case '<C-b>':
        return done(() => moveTo(cursor.row - half * 2, cursor.col))
      case 'g':
      case '<C-w>':
        pending.current = { count: p.count, op: k }
        return true
      case ':':
        return done(() => {
          commandRange.current = null
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
        // The other end of the selection.
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
        case 'x':
          return done(() => {
            endVisual()
            toggleCleared(range)
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
      case 'x':
        return done(() => toggleCleared(counted))
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
      // Enter takes the suggestion; Esc leaves the typed text as it is.
      case '<CR>':
        finishCell('stay')
        return true
      case '<Esc>': {
        if (dropOpened()) return true
        // Esc keeps what was typed, or the suggestion picked with the keys.
        const text = navigated ? chosenText() : edit
        if (text === SPLIT) openSplit(cursor.row)
        else if (commitCell(text, true)) setMode('normal')
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
        // Characters from a mapping are typed into the cell.
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

  const feed = useKeyFeed(keymap, 'register', (k) => {
    if (mode === 'insert') return runInsert(k)
    if (mode === 'command') return runCommandKey(k)
    return runNormal(k)
  })

  // ---------- render

  const options = suggestions()
  const problem = current ? problems.get(current.id) : undefined
  /** On a card's row: which statement it is billed in. */
  const billing =
    card && current && mode === 'normal'
      ? billingText(current, card.statements, today)
      : null
  const line =
    mode === 'command'
      ? null
      : (message ??
        (problem ? { text: problem.message, tone: 'error' as const } : null) ??
        (billing ? { text: billing, tone: 'info' as const } : null))

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={gridRef}
        tabIndex={0}
        role="grid"
        aria-label="帳戶明細"
        aria-rowcount={rows.length}
        data-pane="register"
        data-editor
        onKeyDown={
          mode === 'normal'
            ? feed.onNormalKeyDown
            : mode === 'visual'
              ? feed.onVisualKeyDown
              : undefined
        }
        // No focus ring: the cursor shows focus, bright only while the grid has it.
        className="group flex min-h-0 flex-1 flex-col rounded-md border border-rule outline-none"
      >
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
          <div style={{ width: layout.width }} className="relative">
            {/* Header */}
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
                    (c === 'outflow' || c === 'inflow') && 'justify-end',
                    c === 'cleared' && 'justify-center',
                  )}
                >
                  {labels[c]}
                </span>
              ))}
              <span
                role="columnheader"
                className="flex items-center justify-end px-2"
              >
                餘額
              </span>
            </div>

            {rows.length === 0 && (
              <p className="px-4 py-6 text-sm text-muted-foreground">
                還沒有交易。按{' '}
                <kbd className="font-mono text-foreground">o</kbd> 新增一筆。
              </p>
            )}

            <div
              style={{ height: virtualizer.getTotalSize() }}
              className="relative"
            >
              {/* The selection, the current row and the cursor: overlays, not per-cell state. */}
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

              {virtualizer.getVirtualItems().map((v) => {
                const row = rows[v.index]
                return (
                  <RowView
                    key={row.key}
                    row={row}
                    index={v.index}
                    layout={layout}
                    status={statuses[v.index]}
                    problem={problems.get(row.id)}
                    balance={balances[v.index]}
                    selected={
                      selection !== null &&
                      v.index >= selection.from &&
                      v.index <= selection.to
                    }
                    ctx={ctx}
                    today={today}
                    onPick={(col, enter, extend) => {
                      if (mode === 'insert' && !commitCell(edit)) return
                      // Shift-click selects from the cursor to the row.
                      if (extend) {
                        if (mode !== 'visual') setAnchor(cursor.row)
                        setMode('visual')
                        setCursor({ row: v.index, col })
                        gridRef.current?.focus({ preventScroll: true })
                        return
                      }
                      if (mode === 'visual') endVisual()
                      setMode('normal')
                      setCursor({ row: v.index, col })
                      if (splitting) {
                        gridRef.current?.focus({ preventScroll: true })
                        return
                      }
                      if (enter) startInsertAt(v.index, col)
                    }}
                  />
                )
              })}

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
                        ? `${labels[column]}（選取的交易）`
                        : labels[column]
                    }
                    numeric={
                      column === 'date'
                        ? 'date'
                        : column === 'outflow' || column === 'inflow'
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
                      if (options[i].value === SPLIT) {
                        openSplit(cursor.row)
                        return
                      }
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

      {splitRow && (
        <SplitEditor
          key={splitRow.key}
          row={splitRow}
          ctx={ctx}
          keymap={keymap}
          onClose={closeSplit}
          onMode={setSplitMode}
          onHelp={() => setHelp(true)}
        />
      )}

      <KeyHelp open={help} onClose={() => setHelp(false)} keymap={keymap} />

      {/* The command line, under the buffer like Vim's. */}
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
          // Only the basics; `?` lists every key.
          <span className="truncate text-muted-foreground">
            {selection
              ? `已選 ${selection.to - selection.from + 1} 列 · d 刪除 · y 複製 · c 修改 · ? 快捷鍵`
              : 'hjkl 移動 · i 編輯 · o 新增 · x 核對 · :w 儲存 · ? 快捷鍵'}
          </span>
        )}
      </div>
    </div>
  )
}

function RowView({
  row,
  index,
  layout,
  status,
  problem,
  balance,
  selected,
  ctx,
  today,
  onPick,
}: {
  row: Row
  index: number
  layout: Layout
  status: RowStatus
  problem: RowProblem | undefined
  balance: number
  selected: boolean
  ctx: Context
  today: Date
  /** `enter` on a double click, `extend` with Shift held. */
  onPick: (col: number, enter: boolean, extend: boolean) => void
}) {
  const marker = problem
    ? '!'
    : status === 'clean' && row.base?.needsReview
      ? '?'
      : { clean: '', new: '+', changed: '~', deleted: '-' }[status]
  /** An untouched 預定 row (ADR-085): dimmed, not in the balance yet. */
  const planned = row.planned && status === 'clean'
  /** An estimated amount: a 預定 one, or one posted that waits for :review. */
  const estimate =
    (planned && row.planned?.estimate) ||
    (status === 'clean' && row.base?.needsReview)
  const money = (value: number) =>
    `${estimate ? '~' : ''}${formatAmount(value, ctx.minorUnits)}`
  const transfer = row.transferTo ? ctx.accounts.get(row.transferTo) : undefined
  const mode = categoryMode(row, ctx)
  const category = row.splits
    ? row.splits
        .map((l) =>
          l.transferTo
            ? `@${ctx.accounts.get(l.transferTo)?.name ?? ''}`
            : l.categoryId
              ? (ctx.categories.get(l.categoryId)?.name ?? '')
              : '未分類',
        )
        .join('、')
    : row.locked === 'foreign'
      ? `在「${ctx.accounts.get(foreignAccount(row) ?? '')?.name ?? ''}」拆分`
      : row.categoryId
        ? ctx.categories.get(row.categoryId)?.path
        : undefined
  const cell = 'flex items-center overflow-hidden px-2 whitespace-nowrap'

  function content(c: Column, col: number): React.ReactNode {
    switch (c) {
      case 'date':
        return (
          <span key={c} data-col={col} className={cn(cell, 'font-mono')}>
            {formatDate(row.date, today)}
          </span>
        )
      case 'account':
        return (
          <span
            key={c}
            data-col={col}
            className={cn(cell, 'text-muted-foreground')}
          >
            <span className="truncate">
              {ctx.accounts.get(row.accountId)?.name ?? ''}
            </span>
          </span>
        )
      case 'payee':
        return (
          <span key={c} data-col={col} className={cell}>
            {transfer ? (
              <span className="flex min-w-0 items-center gap-1.5">
                <ArrowRightLeftIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{transfer.name}</span>
              </span>
            ) : (
              <span className="truncate">{row.payee}</span>
            )}
          </span>
        )
      case 'note':
        return (
          <span
            key={c}
            data-col={col}
            className={cn(cell, 'text-muted-foreground')}
          >
            <span className="truncate">{row.note}</span>
          </span>
        )
      case 'category':
        return (
          <span
            key={c}
            data-col={col}
            className={cn(
              cell,
              (row.locked || mode === 'none') && 'text-muted-foreground',
              problem?.field === 'category' && 'text-destructive',
            )}
            title={row.splits ? category : undefined}
          >
            {(row.splits || row.locked === 'foreign') && (
              <SplitIcon className="mr-1.5 size-3.5 shrink-0 text-kraft" />
            )}
            <span className="truncate">
              {category ??
                (row.locked === 'opening'
                  ? '期初餘額'
                  : mode === 'none'
                    ? '—'
                    : '')}
            </span>
          </span>
        )
      case 'outflow':
        return (
          <span
            key={c}
            data-col={col}
            className={cn(cell, 'amount justify-end')}
          >
            {row.amount < 0 ? money(-row.amount) : ''}
          </span>
        )
      case 'inflow':
        return (
          <span
            key={c}
            data-col={col}
            className={cn(cell, 'amount justify-end')}
          >
            {row.amount > 0 ? money(row.amount) : ''}
          </span>
        )
      case 'cleared':
        return (
          <span
            key={c}
            data-col={col}
            className="flex items-center justify-center"
            title={
              { uncleared: '未核對', cleared: '已核對', reconciled: '已對帳' }[
                row.cleared
              ]
            }
          >
            {row.cleared === 'reconciled' ? (
              <LockIcon className="size-3.5 text-muted-foreground" />
            ) : row.cleared === 'cleared' ? (
              <CircleCheckIcon className="size-3.5 text-positive" />
            ) : (
              <CircleIcon className="size-3.5 text-muted-foreground/50" />
            )}
          </span>
        )
    }
  }

  return (
    <div
      role="row"
      aria-rowindex={index + 1}
      aria-selected={selected || undefined}
      data-row-id={row.key}
      className={cn(
        'absolute inset-x-0 grid border-b border-rule/60 text-sm',
        row.deleted && 'text-muted-foreground line-through',
        planned && 'text-muted-foreground italic',
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
          problem || status === 'deleted' ? 'text-destructive' : 'text-kraft',
        )}
        title={
          problem?.message ??
          (planned
            ? `預定：${row.planned?.occurrence} 這一期，還沒入帳（:post 入帳、:skip 略過，或直接改）`
            : marker === '?'
              ? '排程用估計金額記的，確認後 :review（或直接改金額）'
              : undefined)
        }
      >
        {planned && !problem ? (
          <CalendarClockIcon className="size-3.5 text-muted-foreground" />
        ) : (
          marker
        )}
      </span>
      {layout.columns.map((c, col) => content(c, col))}
      <span
        className={cn(
          cell,
          'amount justify-end text-muted-foreground',
          balance < 0 && 'amount-negative',
        )}
      >
        {row.planned ? '' : formatAmount(balance, ctx.minorUnits)}
      </span>
    </div>
  )
}
