import { useQueries } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  accountCellText,
  accountColumns,
  accountLabels,
  accountStatus,
  applySetup,
  cardOf,
  cardText,
  formOf,
  kindLabel,
  lockedReason,
  newAccountRow,
  rowFromAccount,
  setupFields,
  setupPreview,
  setupValues,
  toAccountInput,
  validateAccount,
} from '#/lib/accounts'
import { api } from '#/lib/api'
import { errorCodeMessage } from '#/lib/apiError'
import { loanQuery } from '#/lib/budget'
import {
  cardCellNumeric,
  cardCellOptions,
  cardCellPatch,
  cardCellPlaceholder,
  cardCellText,
  cardLines,
  cardValuesOf,
} from '#/lib/card-lines'
import { setEditorStatus } from '#/lib/editorStatus'
import {
  focusField,
  formKey,
  openForm,
  settleForm,
  takeTyped,
} from '#/lib/form'
import { loanFieldValues } from '#/lib/loan'
import {
  addRate,
  loanCellLocked,
  loanCellNumeric,
  loanCellOptions,
  loanCellPatch,
  loanCellText,
  loanLines,
  removeRate,
} from '#/lib/loan-lines'
import { formatAmount } from '#/lib/money'
import { movePane, windowDirection } from '#/lib/panes'
import { categoryRefs, isoDate, parseDate, rankCell } from '#/lib/register'
import { cn } from '#/lib/utils'
import { FormPopover } from '../form-popover'
import { CellEditor, eraseBeforeCaret, nextPick } from '../register/cell-editor'
import { KeyHelp, accountKeys } from '../register/key-help'
import { useKeyFeed } from '../register/use-key-feed'
import { LoanPreviewLine, LoanTermsPlaceholder } from './loan-preview-line'
import type {
  Account,
  AccountColumn,
  AccountProblem,
  AccountRow,
  AccountRowStatus,
} from '#/lib/accounts'
import type { Category } from '#/lib/budget'
import type { CardCell, CardRefs } from '#/lib/card-lines'
import type { FormState, Option } from '#/lib/form'
import type { Key, Keymap } from '#/lib/keymap'
import type { LoanFieldValues } from '#/lib/loan'
import type { LoanCell, LoanRefs } from '#/lib/loan-lines'
import type { Suggestion } from '../register/cell-editor'

// The accounts page (ADR-108): a grid edited as the goals page is, whose
// line order is the accounts' order; saved with :w through the batch
// endpoint, drafts kept locally (ADR-043). What a new account is, is edited
// in a form under the cell (ADR-107); a loan's terms and a card's settings
// are lines under the account's line (ADR-110, ADR-117).

/** A cell of the lines under an account: a loan's term or a card's setting. */
type DetailCell = LoanCell | CardCell

/**
 * What the grid needs of the lines under an account, whichever they are:
 * the lines, how a cell shows and is edited, and the change a value makes.
 */
interface Details {
  lines: Array<{ cells: Array<DetailCell> }>
  text: (cell: DetailCell) => string
  /** What an empty cell says, muted. */
  placeholder: (cell: DetailCell) => string
  numeric: (cell: DetailCell) => boolean
  options: (cell: DetailCell) => Array<Option> | null
  locked: (cell: DetailCell) => string | null
  /** The change to the account for a value ({} when it is as it was), or why not. */
  patch: (cell: DetailCell, text: string) => Partial<AccountRow> | string
}

const ROW_HEIGHT = 32
const GUTTER = 28
const widths: Record<AccountColumn, number> = {
  name: 180,
  kind: 80,
  onBudget: 88,
  balance: 120,
  cleared: 120,
  card: 120,
  status: 80,
}
const stretch: Partial<Record<AccountColumn, number>> = { name: 1 }
const amountColumns: ReadonlySet<AccountColumn> = new Set([
  'balance',
  'cleared',
])

interface Layout {
  lefts: Record<AccountColumn, number>
  widths: Record<AccountColumn, number>
  template: string
  width: number
}

function layoutOf(room: number): Layout {
  const least = accountColumns.reduce((sum, c) => sum + widths[c], GUTTER)
  const extra = Math.max(0, room - least)
  const lefts = {} as Record<AccountColumn, number>
  const sized = {} as Record<AccountColumn, number>
  let x = GUTTER
  for (const c of accountColumns) {
    sized[c] = widths[c] + Math.floor(extra * (stretch[c] ?? 0))
    lefts[c] = x
    x += sized[c]
  }
  return {
    lefts,
    widths: sized,
    template: `${GUTTER}px ${accountColumns.map((c) => `${sized[c]}px`).join(' ')}`,
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

/** A line's state: its content, or only its place in the order. */
type LineState = AccountRowStatus | 'moved'

interface Props {
  budgetId: string
  minorUnits: number
  /** The accounts as last loaded, in their order (friend accounts left out). */
  accounts: Array<Account>
  keymap: Keymap
  /** Fetches the accounts again. */
  reload: () => Promise<Array<Account>>
  /** The budget's categories, for where a loan's payments are recorded. */
  categories: Array<Category>
  /** After :w saved loans' terms: the page checks them against the accounts. */
  onLoansSaved: (ids: Array<string>) => void
}

const DRAFT_VERSION = 1

interface Draft {
  version: number
  rows: Array<AccountRow>
  order: Array<string>
}

function draftKey(budgetId: string): string {
  return `factual:accounts:${budgetId}`
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
  rows: Array<AccountRow> | null,
  minorUnits: number,
): void {
  try {
    if (!rows) localStorage.removeItem(key)
    else
      localStorage.setItem(
        key,
        JSON.stringify({
          version: DRAFT_VERSION,
          rows: rows.filter((r) => accountStatus(r, minorUnits) !== 'clean'),
          order: rows.map((r) => r.id),
        } satisfies Draft),
      )
  } catch {
    // Drafts are a convenience (ADR-043).
  }
}

function initialRows(
  accounts: Array<Account>,
  draft: Draft | null,
): Array<AccountRow> {
  const saved = accounts.map(rowFromAccount)
  if (!draft) return saved
  const at = new Map(saved.map((r, i) => [r.id, i]))
  const fresh: Array<AccountRow> = []
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

/** Each line's place in the order: its index among the lines kept. */
function places(rows: Array<AccountRow>): Map<string, number> {
  return new Map(rows.filter((r) => !r.deleted).map((r, i) => [r.id, i]))
}

/** Where each saved account was in the order when loaded. */
function savedPlaces(accounts: Array<Account>): Map<string, number> {
  return new Map(accounts.map((a, i) => [a.id, i]))
}

export function AccountGrid({
  budgetId,
  minorUnits,
  accounts,
  keymap,
  reload,
  categories,
  onLoansSaved,
}: Props) {
  const navigate = useNavigate()
  const key = draftKey(budgetId)
  const [room, setRoom] = useState(0)
  const layout = layoutOf(room)
  const columns = accountColumns
  const [loaded, setLoaded] = useState(accounts)
  const [rows, setRows] = useState<Array<AccountRow>>(() =>
    initialRows(accounts, readDraft(key)),
  )
  const [cursor, setCursor] = useState({ row: 0, col: 0 })
  const [mode, setMode] = useState<Mode>('normal')
  const [edit, setEdit] = useState('')
  const [command, setCommand] = useState('')
  const [message, setMessage] = useState<Message | null>(() =>
    readDraft(key) ? { text: '已還原上次未儲存的變更', tone: 'info' } : null,
  )
  const [problems, setProblems] = useState<Map<string, AccountProblem>>(
    new Map(),
  )
  const [saving, setSaving] = useState(false)
  const [anchor, setAnchor] = useState(0)
  const [help, setHelp] = useState(false)
  /** Lines whose details are shown under them (ADR-110). */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  /** The cursor on a line of a loan's terms, under the cursor's account. */
  const [sub, setSub] = useState<{ line: number; cell: number } | null>(null)
  /** Whether insert mode edits a line of the terms (not the name). */
  const [subEdit, setSubEdit] = useState(false)
  const [pick, setPick] = useState(0)
  const [navigated, setNavigated] = useState(false)
  const [form, setForm] = useState<{
    kind: 'setup'
    state: FormState
  } | null>(null)

  const gridRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const history = useRef<{
    undo: Array<Array<AccountRow>>
    redo: Array<Array<AccountRow>>
  }>({ undo: [], redo: [] })
  const pending = useRef({ count: '', op: '' })
  const yanked = useRef<Array<AccountRow>>([])
  const lastChange = useRef<{ op: 'd' | 'p' | 'P'; lines: number } | null>(null)
  const lastVisual = useRef<{ anchor: number; row: number } | null>(null)
  const commandRange = useRef<Range | null>(null)
  const opened = useRef<{ id: string; from: typeof cursor } | null>(null)

  const now = new Date()
  const today = isoDate(now)
  const order = places(rows)
  const was = savedPlaces(loaded)
  const states: Array<LineState> = rows.map((r) => {
    const s = accountStatus(r, minorUnits)
    return s === 'clean' && r.base && order.get(r.id) !== was.get(r.id)
      ? 'moved'
      : s
  })
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

  // The saved terms of the loans whose lines are open.
  const shownLoans = rows
    .filter((r) => r.base && r.kind === 'loan' && expanded.has(r.id))
    .map((r) => r.id)
  const savedLoans = useQueries({
    queries: shownLoans.map((id) => loanQuery(budgetId, id)),
  })
  const savedTerms = new Map(shownLoans.map((id, i) => [id, savedLoans[i]]))
  const refs: LoanRefs = {
    payers: new Map(
      rows
        .filter(
          (r) =>
            r.base &&
            !r.deleted &&
            !r.closed &&
            r.onBudget &&
            (r.kind === 'bank' || r.kind === 'cash'),
        )
        .map((r) => [r.id, r.name]),
    ),
    categories: new Map(
      [...categoryRefs(categories).values()]
        .filter((c) => c.kind === 'expense' && !c.isSystem && !c.archived)
        .toSorted((a, b) => a.path.localeCompare(b.path))
        .map((c) => [c.id, c.path]),
    ),
    minorUnits,
  }

  /** A loan's terms as the page has them: edited, saved, or none yet. */
  function loanOf(row: AccountRow): LoanFieldValues | null {
    if (row.loan) return row.loan
    if (!row.base) return loanFieldValues(null, minorUnits, today)
    const q = savedTerms.get(row.id)
    if (!q?.isSuccess) return null
    return loanFieldValues(q.data?.terms ?? null, minorUnits, today)
  }

  const cardRefs: CardRefs = { payers: refs.payers, minorUnits }

  /** The lines under an account and how they are edited; null for accounts without any (or terms not read yet). */
  function detailsFor(row: AccountRow): Details | null {
    if (row.kind === 'loan') {
      const v = loanOf(row)
      if (!v) return null
      const cell = (c: DetailCell) => c as LoanCell
      return {
        lines: loanLines(v),
        text: (c) => loanCellText(v, cell(c), refs),
        placeholder: () => '',
        numeric: (c) => loanCellNumeric(cell(c)),
        options: (c) => loanCellOptions(cell(c), refs),
        locked: (c) => loanCellLocked(cell(c)),
        patch: (c, text) => {
          const next = loanCellPatch(v, cell(c), text, refs, now)
          if (typeof next === 'string') return next
          // Taking a value unchanged leaves the terms as they were (saved).
          return JSON.stringify(next) === JSON.stringify(v)
            ? {}
            : { loan: next }
        },
      }
    }
    if (row.kind === 'credit_card') {
      const v = row.cardEdit ?? cardValuesOf(row.card, minorUnits)
      const cell = (c: DetailCell) => c as CardCell
      return {
        lines: cardLines,
        text: (c) => cardCellText(v, cell(c), cardRefs),
        placeholder: (c) => cardCellPlaceholder(cell(c)),
        numeric: (c) => cardCellNumeric(cell(c)),
        options: (c) => cardCellOptions(cell(c), cardRefs),
        locked: () => null,
        patch: (c, text) => {
          const next = cardCellPatch(v, cell(c), text, cardRefs)
          if (typeof next === 'string') return next
          return JSON.stringify(next) === JSON.stringify(v)
            ? {}
            : { cardEdit: next }
        },
      }
    }
    return null
  }

  /** The lines shown under an account: its details when they are open. */
  function linesOf(row: AccountRow | undefined): Details['lines'] {
    if (!row || !expanded.has(row.id)) return []
    return detailsFor(row)?.lines ?? []
  }

  useEffect(() => {
    setEditorStatus({
      mode: mode === 'form' ? 'insert' : mode,
      dirty,
    })
  }, [mode, dirty])
  useEffect(() => () => setEditorStatus(null), [])
  useEffect(() => {
    writeDraft(key, dirty > 0 ? rows : null, minorUnits)
  }, [key, rows, dirty, minorUnits])
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

  function change(next: Array<AccountRow>) {
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

  function patchRows(
    ids: Array<string>,
    patchOf: (row: AccountRow) => Partial<AccountRow> | null,
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
    setSub(null)
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
    const row = newAccountRow(crypto.randomUUID(), today)
    const index = Math.max(0, Math.min(at, rows.length))
    change(rows.toSpliced(index, 0, row))
    opened.current = { id: row.id, from: cursor }
    setCursor({ row: index, col: columns.indexOf('name') })
    setEdit('')
    setMode('insert')
    say('輸入帳戶名稱，例如：台新活存；Tab 到類型和期初餘額')
  }

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

  /**
   * `dd`: saved accounts go to the bottom marked deleted until :w and stay
   * in the register for `p`, which puts the same account back at the
   * cursor: `ddp` moves it one down, `ddkP` one up. Unsaved lines are
   * removed. `dd` on lines already marked takes the mark off.
   */
  function deleteRange({ from, to }: Range) {
    const targets = rows.slice(from, to + 1)
    if (targets.length === 0) return
    const restore = targets.every((t) => t.deleted)
    const ids = new Set(targets.map((t) => t.id))
    lastChange.current = { op: 'd', lines: to - from + 1 }
    if (restore) {
      change(rows.map((r) => (ids.has(r.id) ? { ...r, deleted: false } : r)))
      return say(`已取消 ${ids.size} 個帳戶的刪除標記`)
    }
    yanked.current = targets.map((r) => ({ ...r, deleted: false }))
    const marked = targets
      .filter((t) => t.base)
      .map((t) => ({ ...t, deleted: true }))
    const next = [...rows.filter((r) => !ids.has(r.id)), ...marked]
    change(next)
    setCursor((c) => ({ ...c, row: clamp(from, next.length) }))
    const used = marked.filter((t) => t.base?.hasActivity).length
    say(
      marked.length > 0
        ? `已標記刪除 ${marked.length} 個帳戶，移到最下面（:w 才刪除）；p 貼回別處就是調整順序${
            used > 0 ? `。其中 ${used} 個有交易不能刪，請改用 :close` : ''
          }`
        : `已移除 ${targets.length} 個未儲存的帳戶，u 可以復原`,
      used > 0 ? 'error' : 'info',
    )
  }

  function yank(range: Range) {
    const picked = rows.slice(range.from, range.to + 1)
    if (picked.length === 0) return
    yanked.current = picked.map((r) => ({ ...r, deleted: false, base: null }))
    setCursor((c) => ({ ...c, row: range.from }))
    say(`已複製 ${picked.length} 個帳戶的設定（p 貼成新帳戶）`)
  }

  function paste(after: boolean) {
    if (yanked.current.length === 0) {
      return say('還沒有複製任何帳戶（yy，或 V 選取後按 y）')
    }
    const marked = new Set(rows.filter((r) => r.deleted).map((r) => r.id))
    const moving = new Set<string>()
    const lines = yanked.current.map((r) => {
      if (r.base && marked.has(r.id)) {
        moving.add(r.id)
        return { ...r, deleted: false }
      }
      return {
        ...r,
        id: crypto.randomUUID(),
        base: null,
        deleted: false,
        name: `${r.name}（複製）`,
        openingBalance: 0,
        openingDate: today,
      }
    })
    const at = rows.length === 0 ? 0 : cursor.row + (after ? 1 : 0)
    const index = at - rows.slice(0, at).filter((r) => moving.has(r.id)).length
    const kept = rows.filter((r) => !moving.has(r.id))
    const next = kept.toSpliced(index, 0, ...lines)
    change(next)
    setCursor((c) => ({ ...c, row: clamp(index, next.length) }))
    lastChange.current = { op: after ? 'p' : 'P', lines: 1 }
    if (moving.size > 0) {
      yanked.current = yanked.current.map((r) => ({ ...r, base: null }))
      say(`已調整 ${moving.size} 個帳戶的順序（:w 儲存）`)
    }
  }

  function repeat() {
    const last = lastChange.current
    if (!last) return say('沒有可以重複的動作')
    if (last.op === 'd') {
      return deleteRange({ from: cursor.row, to: cursor.row + last.lines - 1 })
    }
    paste(last.op === 'p')
  }

  function setClosed(range: Range, closed: boolean) {
    const n = patchRows(idsIn(range), (r) => (r.deleted ? null : { closed }))
    say(
      n === 0
        ? closed
          ? '選取的帳戶都已關閉'
          : '選取的帳戶都沒有關閉'
        : closed
          ? `已關閉 ${n} 個帳戶：不再出現在側欄和選單（:w 儲存）`
          : `已重新開啟 ${n} 個帳戶（:w 儲存）`,
    )
  }

  function openRegister() {
    if (!current?.base) return say('先 :w 儲存這個帳戶，才有明細', 'error')
    void navigate({
      to: '/b/$budgetId/accounts/$accountId',
      params: { budgetId, accountId: current.id },
    })
  }

  /**
   * `za` (and the arrow by the name): shows or hides a loan's terms or a
   * card's settings as lines under its line (ADR-110, ADR-117); `zo` opens
   * them with the cursor on the first, `zc` closes them. j/k move through
   * them like any line.
   */
  function toggleDetails(id: string, enter: boolean, open?: boolean) {
    const row = rows.find((r) => r.id === id)
    if (row?.kind !== 'loan' && row?.kind !== 'credit_card')
      return say('只有貸款和信用卡有展開的設定', 'error')
    const next = new Set(expanded)
    const show = open ?? !next.has(id)
    if (show) next.add(id)
    else next.delete(id)
    setExpanded(next)
    setSub(show && enter ? { line: 0, cell: 0 } : null)
    if (show)
      say(
        `${row.kind === 'loan' ? '貸款條件' : '帳單設定'}在這一列底下：j k 移動、i 修改，:w 和帳戶一起儲存`,
      )
  }

  /** Moves down `n` lines, through the terms of open loans. */
  function down(n: number) {
    let r = cursor.row
    let at = sub
    for (let i = 0; i < n; i++) {
      const lines = linesOf(rows[r])
      if (at === null) {
        if (lines.length > 0) at = { line: 0, cell: 0 }
        else if (r < rows.length - 1) r++
      } else if (at.line < lines.length - 1) {
        at = {
          line: at.line + 1,
          cell: Math.min(at.cell, lines[at.line + 1].cells.length - 1),
        }
      } else if (r < rows.length - 1) {
        r++
        at = null
      }
    }
    setCursor((c) => ({ ...c, row: r }))
    setSub(at)
  }

  /** Moves up `n` lines, through the terms of open loans. */
  function up(n: number) {
    let r = cursor.row
    let at = sub
    for (let i = 0; i < n; i++) {
      if (at === null) {
        if (r === 0) break
        r--
        const lines = linesOf(rows[r])
        at = lines.length > 0 ? { line: lines.length - 1, cell: 0 } : null
      } else if (at.line > 0) {
        at = { line: at.line - 1, cell: 0 }
      } else {
        at = null
      }
    }
    setCursor((c) => ({ ...c, row: r }))
    setSub(at)
  }

  /** The cell of the terms the cursor is on, with the terms and its line. */
  function subLine(): {
    d: Details
    line: Details['lines'][number]
    cell: DetailCell
  } | null {
    if (!current || !sub) return null
    const d = detailsFor(current)
    const line = linesOf(current).at(sub.line)
    const cell = line?.cells.at(sub.cell) ?? line?.cells.at(0)
    return d && line && cell ? { d, line, cell } : null
  }

  /**
   * Edits the cell of the terms the cursor is on, or `target` (a double
   * click), which the cursor then moves to.
   */
  function startSubEdit(
    clear: boolean,
    target?: { row: number; line: number; cell: number },
  ) {
    let at = subLine()
    if (target) {
      const row = rows.at(target.row)
      const d = row ? detailsFor(row) : null
      const line = linesOf(row).at(target.line)
      const cell = line?.cells.at(target.cell)
      at = d && line && cell ? { d, line, cell } : null
    }
    if (!at) return
    const locked = at.d.locked(at.cell)
    if (locked) return say(locked, 'error')
    if (target) {
      setCursor((c) => ({ ...c, row: target.row }))
      setSub({ line: target.line, cell: target.cell })
    }
    setEdit(clear ? '' : at.d.text(at.cell))
    setPick(0)
    setNavigated(false)
    setSubEdit(true)
    setMode('insert')
  }

  function subOptions(): Array<Suggestion> {
    const at = subLine()
    if (!at || !subEdit || mode !== 'insert') return []
    const options = at.d.options(at.cell)
    if (!options) return []
    return rankCell(
      options.map((o) => ({ value: o.label, label: o.label })),
      edit,
      at.d.text(at.cell),
      (o) => o.value,
    )
  }

  function subChosen(): string {
    const options = subOptions()
    if (options.length === 0) return edit
    const highlighted = options[Math.min(pick, options.length - 1)].value
    if (navigated) return highlighted
    if (edit === '' || options.some((o) => o.value === edit)) return edit
    return highlighted
  }

  /** Writes a value into the lines; the account as it then is, or null when refused. */
  function commitSub(text: string): AccountRow | null {
    const at = subLine()
    if (!at || !sub || !current) return null
    const patch = at.d.patch(at.cell, text)
    if (typeof patch === 'string') {
      say(patch, 'error')
      return null
    }
    if (Object.keys(patch).length > 0) patchRows([current.id], () => patch)
    setMessage(null)
    return { ...current, ...patch }
  }

  /**
   * A click elsewhere while a cell is edited takes what was typed, as Enter
   * would (a form under a cell is left as it was); false when it cannot.
   */
  function finishEditing(): boolean {
    if (mode === 'form') {
      setForm(null)
      setMode('normal')
      return true
    }
    if (mode !== 'insert') return true
    if (subEdit) {
      if (
        !commitSub(navigated ? subChosen() : edit === '' ? edit : subChosen())
      )
        return false
      endSubEdit()
      return true
    }
    if (!commitName(edit)) return false
    setMode('normal')
    return true
  }

  function endSubEdit() {
    setSubEdit(false)
    setMode('normal')
  }

  function runSubInsert(k: Key): boolean {
    const options = subOptions()
    switch (k) {
      case '<C-n>':
      case '<Down>':
        setPick(nextPick(options.length, subTaken(options), 1))
        setNavigated(true)
        return true
      case '<C-p>':
      case '<Up>':
        setPick(nextPick(options.length, subTaken(options), -1))
        setNavigated(true)
        return true
      case '<Tab>': {
        const next = commitSub(subChosen())
        const d = next ? detailsFor(next) : null
        if (!d || !sub) return true
        // On to the next cell: across the line, then down the lines.
        const lines = d.lines
        const cells = (line: number) => lines[line]?.cells ?? []
        let to = { line: sub.line, cell: sub.cell + 1 }
        for (;;) {
          if (to.cell >= cells(to.line).length)
            to = { line: to.line + 1, cell: 0 }
          if (to.line >= lines.length) {
            endSubEdit()
            return true
          }
          if (!d.locked(cells(to.line)[to.cell])) break
          to = { ...to, cell: to.cell + 1 }
        }
        setSub(to)
        setEdit(d.text(cells(to.line)[to.cell]))
        setPick(0)
        setNavigated(false)
        return true
      }
      case '<CR>':
      case '<Esc>':
        if (
          commitSub(navigated ? subChosen() : edit === '' ? edit : subChosen())
        )
          endSubEdit()
        return true
      case '<C-c>':
        endSubEdit()
        say('已取消編輯')
        return true
      case '<C-s>':
      case '<D-s>':
        if (commitSub(subChosen())) {
          endSubEdit()
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

  function subTaken(options: Array<Suggestion>): number {
    if (options.length === 0) return -1
    if (!navigated && edit === '') return -1
    return options.findIndex((o) => o.value === subChosen())
  }

  /** `o` and `dd` on the terms: rate changes come and go. */
  function addRateLine() {
    const at = subLine()
    const v = current?.kind === 'loan' ? loanOf(current) : null
    if (!at || !current || !sub || !v)
      return say('帳單設定沒有可以新增的列：i 修改它的值', 'error')
    const rate = (at.cell as LoanCell).rate ?? rateOf(at.line)
    const after = rate ?? v.rates.length - 1
    const next = addRate(v, after, today)
    patchRows([current.id], () => ({ loan: next }))
    const line = loanLines(next).findIndex((l) => l.cells[0].rate === after + 1)
    setSub({ line, cell: 0 })
    say('已加一段利率調整：輸入生效日和利率（:w 儲存）')
  }

  function removeRateLine() {
    const at = subLine()
    const v = current?.kind === 'loan' ? loanOf(current) : null
    if (!at || !current) return
    const rate = v ? rateOf(at.line) : undefined
    if (!v || rate === undefined)
      return say(
        `${v ? '貸款條件' : '帳單設定'}不能刪：zc 收起，或改它的值`,
        'error',
      )
    const next = removeRate(v, rate)
    if (typeof next === 'string') return say(next, 'error')
    patchRows([current.id], () => ({ loan: next }))
    setSub((s) => (s ? { line: s.line - 1, cell: 0 } : s))
  }

  /** Which rate period a line of a loan's terms is, if it is one. */
  function rateOf(line: Details['lines'][number]): number | undefined {
    for (const c of line.cells) {
      const rate = (c as LoanCell).rate
      if (rate !== undefined) return rate
    }
    return undefined
  }

  // ---------- visual mode

  function startVisual(from: number, to: number) {
    if (rows.length === 0) return say('還沒有帳戶，按 o 新增一個')
    setAnchor(clamp(from))
    setCursor((c) => ({ ...c, row: clamp(to) }))
    setMessage(null)
    setMode('visual')
  }

  function endVisual() {
    lastVisual.current = { anchor, row: cursor.row }
    setMode('normal')
  }

  // ---------- cells and forms

  function formFields(values: Record<string, string>) {
    return setupFields(values)
  }

  function startEdit(index: number, colIndex: number, clear = false) {
    const row = rows.at(index)
    const col = columns[colIndex]
    if (!row) return say('還沒有帳戶，按 o 新增一個')
    const reason = lockedReason(row, col)
    if (reason) return say(reason, 'error')
    if (col === 'status') {
      setCursor({ row: index, col: colIndex })
      return setClosed({ from: index, to: index }, !row.closed)
    }
    // A card's settings are the lines under it (ADR-117).
    if (col === 'card') {
      setCursor({ row: index, col: colIndex })
      return toggleDetails(row.id, true, true)
    }
    const which = formOf(row, col)
    if (which) {
      const values = setupValues(row, minorUnits)
      const at =
        col === 'balance'
          ? 'balance'
          : col === 'onBudget'
            ? 'onBudget'
            : undefined
      setForm({
        kind: which,
        state: openForm(values, formFields(values), at),
      })
      setMode('form')
      setMessage(null)
      return
    }
    if (col !== 'name') return say('這一欄是算出來的', 'error')
    setEdit(clear ? '' : accountCellText(row, col))
    setMode('insert')
  }

  function commitName(text: string): AccountRow | null {
    if (!current) return null
    opened.current = null
    const name = text.trim()
    if (!name) {
      say('請輸入帳戶名稱', 'error')
      return null
    }
    const next = { ...current, name }
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      change(rows.with(cursor.row, next))
      clearProblems([current.id])
    }
    setMessage(null)
    return next
  }

  function runForm(k: Key): boolean {
    if (!form || !current) return false
    const fields = formFields(form.state.values)
    const result = formKey(form.state, fields, k, now)
    if (!('done' in result)) {
      setForm({
        ...form,
        state: settleForm(result.state, formFields(result.state.values)),
      })
      return true
    }
    if (result.done === 'cancel') {
      setForm(null)
      if (!dropOpened()) setMode('normal')
      say('已取消編輯')
      return true
    }
    const patch = applySetup(result.state.values, minorUnits)
    if (typeof patch === 'string') {
      setForm({ ...form, state: { ...result.state, error: patch } })
      return true
    }
    opened.current = null
    patchRows([current.id], () => patch)
    setForm(null)
    setMode('normal')
    // A new loan goes on to its terms, under its line.
    if (patch.kind === 'loan' && !current.base) {
      setRows((list) =>
        list.map((r) =>
          r.id === current.id
            ? { ...r, loan: r.loan ?? loanFieldValues(null, minorUnits, today) }
            : r,
        ),
      )
      setExpanded(new Set(expanded).add(current.id))
      setSub({ line: 0, cell: 0 })
      say('填貸款條件：j k 移動、i 修改；不填就只記目前欠款')
    }
    return true
  }

  function formPreview(): string | undefined {
    if (!form) return undefined
    return setupPreview(form.state.values, minorUnits)
  }

  // ---------- saving

  function messageFor(code: string, fallback: string): string {
    const known = errorCodeMessage(code)
    return known === '發生未知錯誤' ? fallback : known
  }

  async function save(): Promise<boolean> {
    const found = new Map<string, AccountProblem>()
    for (const [i, row] of rows.entries()) {
      if (states[i] === 'clean' || states[i] === 'moved') continue
      const p = validateAccount(row, rows, minorUnits)
      if (p) found.set(row.id, p)
    }
    if (found.size > 0) return reportProblems(found)
    const upserts = rows
      .filter((_, i) => states[i] !== 'clean' && states[i] !== 'deleted')
      .map((r) => toAccountInput(r, order.get(r.id) ?? 0, minorUnits))
    const deletes = rows.filter((r) => r.deleted && r.base).map((r) => r.id)
    if (upserts.length === 0 && deletes.length === 0) {
      say('沒有需要儲存的變更')
      return true
    }
    setSaving(true)
    try {
      const { data, error, response } = await api.POST(
        '/budgets/{budgetId}/accounts/batch',
        { params: { path: { budgetId } }, body: { upserts, deletes } },
      )
      if (response.status === 422 && error && 'errors' in error) {
        const fromServer = new Map<string, AccountProblem>()
        for (const p of error.errors) {
          fromServer.set(p.id, {
            field: (columns as Array<string>).includes(p.field)
              ? (p.field as AccountColumn)
              : null,
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
      const next = fresh.map(rowFromAccount)
      const loans = upserts.filter((u) => u.loan).map((u) => u.id)
      if (loans.length > 0) onLoansSaved(loans)
      writeDraft(key, null, minorUnits)
      history.current = { undo: [], redo: [] }
      setLoaded(fresh)
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

  function reportProblems(found: Map<string, AccountProblem>): false {
    setProblems(found)
    const first = rows.findIndex((r) => found.has(r.id))
    const p = found.get(rows[first]?.id ?? '')
    if (first >= 0) {
      const col = p?.field ? columns.indexOf(p.field) : -1
      setCursor({ row: first, col: col >= 0 ? col : cursor.col })
    }
    say(`${found.size} 個帳戶有問題，沒有儲存：${p?.message ?? ''}`, 'error')
    return false
  }

  function discard() {
    const fresh = loaded.map(rowFromAccount)
    writeDraft(key, null, minorUnits)
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
    if (cmd === 'w') {
      await save()
    } else if (cmd === 'wq' || cmd === 'x') {
      if (await save()) openRegister()
    } else if (cmd === 'q' || cmd === 'q!') {
      if (dirty > 0 && cmd === 'q')
        say(
          `還有 ${dirty} 個帳戶未儲存（:w 儲存，:q! 離開並保留草稿）`,
          'error',
        )
      else void navigate({ to: '/b/$budgetId', params: { budgetId } })
    } else if (cmd === 'e!') {
      discard()
    } else if (cmd === 'close' || cmd === 'reopen') {
      setClosed(range, cmd === 'close')
    } else if (cmd === 'loan') {
      if (current) toggleDetails(current.id, true, true)
    } else if (cmd === 'open') {
      openRegister()
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
      if (op === 'dd')
        return done(() => (sub ? removeRateLine() : deleteRange(counted)))
      if (op === 'yy') return done(() => yank(counted))
      if (op === 'gg')
        return done(() => moveTo(p.count ? count - 1 : 0, cursor.col))
      if (op === 'gx') return done(openRegister)
      if (current && (op === 'za' || op === 'zo' || op === 'zc'))
        return done(() =>
          toggleDetails(
            current.id,
            op === 'zo',
            op === 'za' ? undefined : op === 'zo',
          ),
        )
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
          if (!sub) return moveTo(cursor.row, cursor.col + count)
          const cells = linesOf(current).at(sub.line)?.cells.length ?? 1
          setSub({ ...sub, cell: Math.min(cells - 1, sub.cell + count) })
        })
      case 'h':
      case '<Left>':
      case 'b':
      case '<S-Tab>':
        return done(() =>
          sub
            ? setSub({ ...sub, cell: Math.max(0, sub.cell - count) })
            : moveTo(cursor.row, cursor.col - count),
        )
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
      case 'z':
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
        case 'x':
          return done(() => {
            endVisual()
            const all = rows.slice(range.from, range.to + 1)
            setClosed(range, !all.every((r) => r.closed))
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
          setSub(null)
          startVisual(cursor.row, cursor.row + count - 1)
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
          sub ? startSubEdit(false) : startEdit(cursor.row, cursor.col),
        )
      case 'c':
      case 's':
        return done(() =>
          sub ? startSubEdit(true) : startEdit(cursor.row, cursor.col, true),
        )
      case 'x':
        return done(() => {
          if (current) setClosed(counted, !current.closed)
        })
      case 'o':
        return done(() =>
          sub ? addRateLine() : openRow(rows.length === 0 ? 0 : cursor.row + 1),
        )
      case 'O':
        return done(() => (sub ? addRateLine() : openRow(cursor.row)))
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
    if (subEdit) return runSubInsert(k)
    switch (k) {
      case '<Tab>': {
        const row = commitName(edit)
        if (!row) return true
        // A new account goes on to what it is; a saved one is done.
        if (!row.base) {
          const col = columns.indexOf('kind')
          setCursor((c) => ({ ...c, col }))
          startEditRow(row, col)
        } else setMode('normal')
        return true
      }
      case '<CR>':
      case '<Esc>':
        if (k === '<Esc>' && dropOpened()) return true
        if (commitName(edit)) setMode('normal')
        return true
      case '<C-c>':
        if (dropOpened()) return true
        setMode('normal')
        say('已取消編輯')
        return true
      case '<C-s>':
      case '<D-s>':
        if (commitName(edit)) {
          setMode('normal')
          void save()
        }
        return true
      default:
        if ([...k].length === 1) {
          setEdit((e) => e + k)
          return true
        }
        return false
    }
  }

  /** Opens the setup form of a line just named (it is not in `rows` yet). */
  function startEditRow(row: AccountRow, colIndex: number) {
    const values = setupValues(row, minorUnits)
    setForm({
      kind: 'setup',
      state: openForm(values, setupFields(values)),
    })
    setCursor((c) => ({ ...c, col: colIndex }))
    setMode('form')
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

  const feed = useKeyFeed(keymap, 'accounts', (k) => {
    if (mode === 'form') return runForm(k)
    if (mode === 'insert') return runInsert(k)
    if (mode === 'command') return runCommandKey(k)
    return runNormal(k)
  })

  // ---------- render

  const problem = current ? problems.get(current.id) : undefined
  const line =
    mode === 'command'
      ? null
      : (message ??
        (problem ? { text: problem.message, tone: 'error' as const } : null))
  const formList = form ? formFields(form.state.values) : []

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div
        ref={gridRef}
        tabIndex={0}
        role="grid"
        aria-label="帳戶"
        aria-rowcount={rows.length}
        data-pane="accounts"
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
                  {accountLabels[c]}
                </span>
              ))}
            </div>

            {rows.length === 0 && (
              <p className="px-4 py-6 text-sm text-muted-foreground">
                還沒有帳戶。按{' '}
                <kbd className="font-mono text-foreground">o</kbd>{' '}
                新增你的銀行帳戶、信用卡和現金，填入今天的餘額，預算就從這些錢開始。
              </p>
            )}

            <div>
              {rows.map((row, index) => {
                const at = index === cursor.row
                const selected =
                  selection !== null &&
                  index >= selection.from &&
                  index <= selection.to
                return (
                  <div key={row.id} className="relative" data-line={index}>
                    {((at && !sub) || selected) && (
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
                    {at && !sub && mode !== 'insert' && (
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
                    <AccountLine
                      row={row}
                      index={index}
                      layout={layout}
                      state={states[index]}
                      problem={problems.get(row.id)}
                      minorUnits={minorUnits}
                      open={expanded.has(row.id)}
                      onToggle={() => toggleDetails(row.id, false)}
                      onPick={(col, enter, extend) => {
                        if (!finishEditing()) return
                        if (extend) {
                          if (mode !== 'visual') setAnchor(cursor.row)
                          setMode('visual')
                          setCursor({ row: index, col })
                          gridRef.current?.focus({ preventScroll: true })
                          return
                        }
                        if (mode === 'visual') endVisual()
                        setMode('normal')
                        setSub(null)
                        setCursor({ row: index, col })
                        if (enter) startEdit(index, col)
                      }}
                    />

                    {at && mode === 'form' && form && (
                      <div
                        className="absolute z-30"
                        style={{ top: ROW_HEIGHT, left: layout.lefts[column] }}
                      >
                        <FormPopover
                          title="帳戶設定"
                          fields={formList}
                          state={form.state}
                          preview={formPreview()}
                          width={layout.widths[column] * 2}
                          onKeyDown={feed.onNormalKeyDown}
                          onField={(field) =>
                            setForm({
                              ...form,
                              state: focusField(
                                takeTyped(form.state, formList, now),
                                formList,
                                field,
                              ),
                            })
                          }
                          onChoose={(field, value) => {
                            const state = {
                              ...form.state,
                              values: { ...form.state.values, [field]: value },
                              field,
                              typed: null,
                              error: null,
                            }
                            setForm({
                              ...form,
                              state: settleForm(
                                state,
                                formFields(state.values),
                              ),
                            })
                          }}
                        />
                      </div>
                    )}

                    {at && mode === 'insert' && !subEdit && (
                      <div
                        className="absolute top-0 z-30"
                        style={{
                          left: layout.lefts.name,
                          width: layout.widths.name,
                        }}
                      >
                        <CellEditor
                          inputRef={inputRef}
                          value={edit}
                          label={accountLabels.name}
                          width={layout.widths.name}
                          options={[]}
                          pick={-1}
                          onChange={setEdit}
                          onKeyDown={(e) =>
                            feed.onInsertKeyDown(e, (n) =>
                              setEdit(
                                eraseBeforeCaret(inputRef.current, edit, n),
                              ),
                            )
                          }
                          onChoose={() => {}}
                        />
                      </div>
                    )}

                    {row.kind === 'loan' &&
                      expanded.has(row.id) &&
                      !loanOf(row) && (
                        <LoanTermsPlaceholder
                          failed={savedTerms.get(row.id)?.isError ?? false}
                          onRetry={() => void savedTerms.get(row.id)?.refetch()}
                        />
                      )}
                    {linesOf(row).map((term, li) => {
                      const d = detailsFor(row)
                      if (!d) return null
                      const on = at && sub?.line === li
                      const typing = on && mode === 'insert' && subEdit
                      // Two columns across the grid, each a label and its value.
                      const indent = GUTTER + 24
                      const half = Math.max(
                        280,
                        Math.floor((Math.max(room, layout.width) - indent) / 2),
                      )
                      const label = 104
                      const valueLeft = (c: number) => indent + c * half + label
                      const valueWidth = Math.min(320, half - label - 8)
                      const active = on ? term.cells.at(sub.cell) : undefined
                      return (
                        <div
                          key={term.cells
                            .map((c) => `${c.key}${(c as LoanCell).rate ?? ''}`)
                            .join('-')}
                          className="relative border-b border-rule/40 bg-card/40 text-sm"
                          style={{ height: ROW_HEIGHT }}
                          onMouseDown={(e) => {
                            const cell = (
                              e.target as HTMLElement
                            ).closest<HTMLElement>('[data-cell]')
                            e.preventDefault()
                            if (!finishEditing()) return
                            const target = {
                              row: index,
                              line: li,
                              cell: Number(cell?.dataset.cell ?? 0),
                            }
                            // A double click edits the cell, as on any line.
                            if (e.detail === 2 && cell) {
                              startSubEdit(false, target)
                              return
                            }
                            setCursor((c) => ({ ...c, row: index }))
                            setSub({ line: target.line, cell: target.cell })
                            gridRef.current?.focus({ preventScroll: true })
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
                            style={{ left: GUTTER }}
                          />
                          {term.cells.map((cell, c) => (
                            <span
                              key={c}
                              data-cell={c}
                              className="absolute inset-y-0 flex items-center"
                              style={{ left: indent + c * half, width: half }}
                            >
                              <span
                                className="shrink-0 truncate pr-2 text-xs text-muted-foreground"
                                style={{ width: label }}
                              >
                                {cell.label}
                              </span>
                              <span
                                className={cn(
                                  'flex min-w-0 items-center gap-1 px-2 whitespace-nowrap',
                                  d.numeric(cell) && 'font-mono',
                                  d.locked(cell) && 'text-muted-foreground',
                                )}
                              >
                                <span className="truncate">
                                  {d.text(cell) || (
                                    <span className="text-muted-foreground/60">
                                      {d.placeholder(cell)}
                                    </span>
                                  )}
                                </span>
                              </span>
                            </span>
                          ))}
                          {on && !typing && (
                            <div
                              aria-hidden
                              className="pointer-events-none absolute top-0 z-10 border-2 border-kraft/40 group-focus:border-kraft"
                              style={{
                                left: valueLeft(sub.cell),
                                width: valueWidth,
                                height: ROW_HEIGHT,
                              }}
                            />
                          )}
                          {typing && active && (
                            <div
                              className="absolute top-0 z-30"
                              style={{
                                left: valueLeft(sub.cell),
                                width: valueWidth,
                              }}
                            >
                              <div>
                                <CellEditor
                                  inputRef={inputRef}
                                  value={edit}
                                  label={active.label}
                                  numeric={
                                    d.numeric(active) ? 'date' : undefined
                                  }
                                  width={valueWidth}
                                  options={subOptions()}
                                  pick={subTaken(subOptions())}
                                  onChange={(value) => {
                                    setEdit(value)
                                    setPick(0)
                                    setNavigated(false)
                                  }}
                                  calendar={
                                    [
                                      'start',
                                      'firstPayment',
                                      'rateFrom',
                                    ].includes(active.key)
                                      ? {
                                          value: parseDate(edit, now) ?? '',
                                          onPick: (iso) => {
                                            if (commitSub(iso)) endSubEdit()
                                          },
                                        }
                                      : undefined
                                  }
                                  onKeyDown={(e) =>
                                    feed.onInsertKeyDown(e, (n) =>
                                      setEdit(
                                        eraseBeforeCaret(
                                          inputRef.current,
                                          edit,
                                          n,
                                        ),
                                      ),
                                    )
                                  }
                                  onChoose={(i) => {
                                    setEdit(subOptions()[i].value)
                                    setPick(i)
                                    setNavigated(true)
                                  }}
                                />
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })}
                    {row.kind === 'loan' &&
                      linesOf(row).length > 0 &&
                      loanOf(row) && (
                        <LoanPreviewLine
                          budgetId={budgetId}
                          minorUnits={minorUnits}
                          values={loanOf(row) as LoanFieldValues}
                        />
                      )}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>

      <KeyHelp
        open={help}
        onClose={() => setHelp(false)}
        keymap={keymap}
        groups={accountKeys}
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
              ? `已選 ${selection.to - selection.from + 1} 個 · d 刪除 · x 關閉/開啟 · ? 快捷鍵`
              : 'hjkl 移動 · i 編輯 · o 新增 · ddp 調整順序 · x 關閉 · gx 明細 · :w 儲存 · ? 快捷鍵'}
          </span>
        )}
      </div>
    </div>
  )
}

function AccountLine({
  row,
  index,
  layout,
  state,
  problem,
  minorUnits,
  open,
  onToggle,
  onPick,
}: {
  row: AccountRow
  index: number
  layout: Layout
  state: LineState
  problem: AccountProblem | undefined
  minorUnits: number
  /** Whether the line's details are shown under it. */
  open: boolean
  onToggle: () => void
  onPick: (col: number, enter: boolean, extend: boolean) => void
}) {
  const marker = problem
    ? '!'
    : { clean: '', new: '+', changed: '~', deleted: '-', moved: '↕' }[state]
  const cell = 'flex items-center overflow-hidden px-2 whitespace-nowrap'
  const muted = 'text-muted-foreground'
  const balance = row.base ? row.base.balance : row.openingBalance
  const money = (n: number) => formatAmount(n, minorUnits)

  function content(c: AccountColumn, col: number): React.ReactNode {
    const bad = problem?.field === c && 'text-destructive'
    switch (c) {
      case 'name':
        return (
          <span key={c} data-col={col} className={cn(cell, 'gap-1', bad)}>
            {(row.kind === 'loan' || row.kind === 'credit_card') && (
              <button
                type="button"
                tabIndex={-1}
                aria-label={
                  row.kind === 'loan'
                    ? open
                      ? '收起貸款條件'
                      : '展開貸款條件'
                    : open
                      ? '收起帳單設定'
                      : '展開帳單設定'
                }
                aria-expanded={open}
                onMouseDown={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  onToggle()
                }}
                className="-ml-1 shrink-0 text-muted-foreground hover:text-foreground"
              >
                {open ? (
                  <ChevronDownIcon className="size-3.5" />
                ) : (
                  <ChevronRightIcon className="size-3.5" />
                )}
              </button>
            )}
            <span className="truncate">{row.name}</span>
            {row.loan && (
              <span className="shrink-0 text-xs text-kraft">條件已改</span>
            )}
            {row.cardEdit && (
              <span className="shrink-0 text-xs text-kraft">設定已改</span>
            )}
          </span>
        )
      case 'kind':
        return (
          <span key={c} data-col={col} className={cn(cell, 'text-xs', bad)}>
            {kindLabel(row.kind)}
          </span>
        )
      case 'onBudget':
        return (
          <span key={c} data-col={col} className={cn(cell, 'text-xs', muted)}>
            {row.onBudget ? '預算內' : '預算外'}
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
              balance < 0 && 'amount-negative',
              bad,
            )}
            title={row.base ? undefined : `期初 ${row.openingDate}`}
          >
            {money(balance)}
          </span>
        )
      case 'cleared':
        return (
          <span
            key={c}
            data-col={col}
            className={cn(cell, 'amount justify-end', muted)}
          >
            {row.base ? money(row.base.clearedBalance) : ''}
          </span>
        )
      case 'card':
        return (
          <span
            key={c}
            data-col={col}
            className={cn(cell, 'text-xs', muted, bad)}
          >
            {row.kind === 'credit_card'
              ? cardText(cardOf(row, minorUnits)) || '未設定'
              : '—'}
          </span>
        )
      case 'status':
        return (
          <span
            key={c}
            data-col={col}
            className={cn(
              cell,
              'text-xs',
              row.closed ? muted : 'text-positive',
              bad,
            )}
          >
            {row.closed ? '已關閉' : '使用中'}
          </span>
        )
    }
  }

  return (
    <div
      role="row"
      aria-rowindex={index + 1}
      className={cn(
        'relative grid border-b border-rule/60 text-sm',
        row.deleted && 'text-muted-foreground line-through',
        row.closed && !row.deleted && 'text-muted-foreground',
      )}
      style={{ height: ROW_HEIGHT, gridTemplateColumns: layout.template }}
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
          (state === 'moved' ? '順序變了（:w 儲存）' : undefined)
        }
      >
        {marker}
      </span>
      {accountColumns.map((c, col) => content(c, col))}
    </div>
  )
}
