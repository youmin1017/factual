import { ArrowRightLeftIcon, PauseIcon, RedoIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '#/lib/api'
import { errorCodeMessage } from '#/lib/apiError'
import { setEditorStatus } from '#/lib/editorStatus'
import { movePane, windowDirection } from '#/lib/panes'
import {
  findCategory,
  formatDate,
  isoDate,
  lineCategoryMode,
  parseDate,
  problemMessages,
  rank,
} from '#/lib/register'
import { nextOccurrences, parseRule, ruleTemplates } from '#/lib/schedule-rule'
import {
  modeLabels,
  newScheduleRow,
  nextOf,
  rowFromSchedule,
  scheduleAmountText,
  scheduleCellText,
  scheduleColumns,
  scheduleLabels,
  schedulePatch,
  scheduleProblemColumn,
  scheduleStatus,
  toScheduleInput,
  validateSchedule,
} from '#/lib/schedules'
import { cn } from '#/lib/utils'
import { CellEditor, eraseBeforeCaret, nextPick } from '../register/cell-editor'
import { KeyHelp, scheduleKeys } from '../register/key-help'
import { useKeyFeed } from '../register/use-key-feed'
import type { Key, Keymap } from '#/lib/keymap'
import type { Context, PayeeRef } from '#/lib/register'
import type {
  Schedule,
  ScheduleColumn,
  ScheduleProblem,
  ScheduleRow,
  ScheduleStatus,
} from '#/lib/schedules'
import type { Suggestion } from '../register/cell-editor'

// The schedules page (ADR-084): a grid edited as the register is, saved
// with :w through the batch endpoint, drafts kept locally (ADR-043).

const ROW_HEIGHT = 32
const GUTTER = 28
const widths: Record<ScheduleColumn, number> = {
  rule: 168,
  next: 96,
  payee: 160,
  note: 160,
  category: 168,
  account: 112,
  outflow: 104,
  inflow: 104,
  mode: 104,
}
const stretch: Partial<Record<ScheduleColumn, number>> = {
  rule: 0.2,
  payee: 0.25,
  note: 0.3,
  category: 0.25,
}

interface Layout {
  lefts: Record<ScheduleColumn, number>
  widths: Record<ScheduleColumn, number>
  template: string
  width: number
}

function layoutOf(room: number): Layout {
  const least = scheduleColumns.reduce((sum, c) => sum + widths[c], GUTTER)
  const extra = Math.max(0, room - least)
  const lefts = {} as Record<ScheduleColumn, number>
  const sized = {} as Record<ScheduleColumn, number>
  let x = GUTTER
  for (const c of scheduleColumns) {
    sized[c] = widths[c] + Math.floor(extra * (stretch[c] ?? 0))
    lefts[c] = x
    x += sized[c]
  }
  return {
    lefts,
    widths: sized,
    template: `${GUTTER}px ${scheduleColumns.map((c) => `${sized[c]}px`).join(' ')}`,
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

interface Props {
  budgetId: string
  ctx: Context
  schedules: Array<Schedule>
  payees: Array<PayeeRef>
  keymap: Keymap
  /** Days off, for when occurrences are posted (ADR-087). */
  off: (iso: string) => boolean
  /** Fetches the schedules again (and what posting changed). */
  reload: () => Promise<Array<Schedule>>
  onQuit: () => void
}

const DRAFT_VERSION = 1

function draftKey(budgetId: string): string {
  return `factual:schedules:${budgetId}`
}

function readDraft(key: string): Array<ScheduleRow> {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw) as {
      version?: number
      rows?: Array<ScheduleRow>
    }
    return parsed.version === DRAFT_VERSION && Array.isArray(parsed.rows)
      ? parsed.rows
      : []
  } catch {
    return []
  }
}

function writeDraft(key: string, rows: Array<ScheduleRow>): void {
  try {
    if (rows.length === 0) localStorage.removeItem(key)
    else
      localStorage.setItem(
        key,
        JSON.stringify({ version: DRAFT_VERSION, rows }),
      )
  } catch {
    // Drafts are a convenience (ADR-043).
  }
}

/** Saved schedules by next date (ended ones last). */
function savedRows(schedules: Array<Schedule>): Array<ScheduleRow> {
  return [...schedules]
    .sort((a, b) =>
      (a.nextDate ?? '9999') < (b.nextDate ?? '9999')
        ? -1
        : (a.nextDate ?? '9999') > (b.nextDate ?? '9999')
          ? 1
          : 0,
    )
    .map(rowFromSchedule)
}

function initialRows(
  schedules: Array<Schedule>,
  drafts: Array<ScheduleRow>,
): Array<ScheduleRow> {
  const saved = savedRows(schedules)
  const at = new Map(saved.map((r, i) => [r.id, i]))
  const fresh: Array<ScheduleRow> = []
  for (const d of drafts) {
    if (!d.base) {
      fresh.push(d)
      continue
    }
    const i = at.get(d.id)
    if (i === undefined) continue
    saved[i] = { ...d, base: saved[i].base }
  }
  return [...fresh, ...saved]
}

export function ScheduleGrid({
  budgetId,
  ctx,
  schedules,
  payees,
  keymap,
  off,
  reload,
  onQuit,
}: Props) {
  const key = draftKey(budgetId)
  const [room, setRoom] = useState(0)
  const layout = layoutOf(room)
  const columns = scheduleColumns
  const [rows, setRows] = useState<Array<ScheduleRow>>(() =>
    initialRows(schedules, readDraft(key)),
  )
  const [cursor, setCursor] = useState({ row: 0, col: 0 })
  const [mode, setMode] = useState<Mode>('normal')
  const [edit, setEdit] = useState('')
  const [pick, setPick] = useState(0)
  const [navigated, setNavigated] = useState(false)
  const [command, setCommand] = useState('')
  const [message, setMessage] = useState<Message | null>(() =>
    rows.some((r) => scheduleStatus(r) !== 'clean')
      ? { text: '已還原上次未儲存的變更', tone: 'info' }
      : null,
  )
  const [problems, setProblems] = useState<Map<string, ScheduleProblem>>(
    new Map(),
  )
  const [saving, setSaving] = useState(false)
  const [anchor, setAnchor] = useState(0)
  const [bulk, setBulk] = useState(false)
  const [help, setHelp] = useState(false)

  const gridRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const history = useRef<{
    undo: Array<Array<ScheduleRow>>
    redo: Array<Array<ScheduleRow>>
  }>({ undo: [], redo: [] })
  const pending = useRef({ count: '', op: '' })
  const yanked = useRef<Array<ScheduleRow>>([])
  const lastChange = useRef<{ op: 'd' | 'p' | 'P'; lines: number } | null>(null)
  const lastVisual = useRef<{ anchor: number; row: number } | null>(null)
  /** The selection a command typed from visual mode acts on. */
  const commandRange = useRef<Range | null>(null)
  const opened = useRef<{ id: string; from: typeof cursor } | null>(null)

  const now = new Date()
  const today = isoDate(now)
  const statuses: Array<ScheduleStatus> = rows.map(scheduleStatus)
  const dirty = statuses.filter((s) => s !== 'clean').length
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
    writeDraft(
      key,
      rows.filter((r) => scheduleStatus(r) !== 'clean'),
    )
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

  function change(next: Array<ScheduleRow>) {
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
    patchOf: (row: ScheduleRow) => Partial<ScheduleRow> | null,
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
    const near = rows.at(cursor.row)
    const accountId =
      near?.accountId ??
      [...ctx.accounts.values()].find((a) => !a.closed && a.onBudget)?.id ??
      [...ctx.accounts.values()].find((a) => !a.closed)?.id
    if (!accountId) return say('還沒有帳戶：先到「帳戶」新增一個', 'error')
    const row = newScheduleRow(crypto.randomUUID(), accountId)
    const index = Math.max(0, Math.min(at, rows.length))
    change(rows.toSpliced(index, 0, row))
    opened.current = { id: row.id, from: cursor }
    setCursor({ row: index, col: columns.indexOf('rule') })
    setEdit('')
    setPick(0)
    setNavigated(false)
    setBulk(false)
    setMode('insert')
    say('輸入週期，例如：每月 5 日、每週一三五、每年 3/15；Tab 到下一欄')
  }

  function dropOpened(): boolean {
    const o = opened.current
    opened.current = null
    if (!o || !current || current.id !== o.id || bulk) return false
    if (edit.trim() !== '' || current.base) return false
    if (current.source || current.payee || current.transferTo || current.note)
      return false
    if (current.categoryId || current.amount !== 0) return false
    history.current.undo.pop()
    const next = rows.filter((r) => r.id !== o.id)
    setRows(next)
    setCursor({ row: clamp(o.from.row, next.length), col: o.from.col })
    setMode('normal')
    say('已取消新增')
    return true
  }

  function deleteRange({ from, to }: Range) {
    const targets = rows.slice(from, to + 1)
    if (targets.length === 0) return
    const restore = targets.every((t) => t.deleted)
    const ids = new Set(targets.map((t) => t.id))
    if (!restore)
      yanked.current = targets.map((r) => ({ ...r, deleted: false }))
    const next = rows.flatMap((r) => {
      if (!ids.has(r.id)) return [r]
      return r.base ? [{ ...r, deleted: !restore }] : []
    })
    change(next)
    setCursor((c) => ({ ...c, row: clamp(from, next.length) }))
    lastChange.current = { op: 'd', lines: to - from + 1 }
    if (restore) return say(`已取消 ${ids.size} 個排程的刪除標記`)
    const saved = targets.filter((t) => t.base).length
    say(
      saved > 0
        ? `已標記刪除 ${saved} 個排程（:w 儲存後才會刪除；已入帳的交易會保留），u 可以復原，p 可以貼上`
        : `已移除 ${targets.length} 個未儲存的排程，u 可以復原`,
    )
  }

  function yank(range: Range) {
    const picked = rows.slice(range.from, range.to + 1)
    if (picked.length === 0) return
    yanked.current = picked
    setCursor((c) => ({ ...c, row: range.from }))
    say(`已複製 ${picked.length} 個排程（p 貼上）`)
  }

  function paste(after: boolean) {
    if (yanked.current.length === 0) {
      return say('還沒有複製任何排程（yy，或 V 選取後按 y）')
    }
    const copies = yanked.current.map((r) => ({
      ...r,
      id: crypto.randomUUID(),
      base: null,
      deleted: false,
    }))
    const index = rows.length === 0 ? 0 : cursor.row + (after ? 1 : 0)
    change(rows.toSpliced(index, 0, ...copies))
    setCursor((c) => ({ ...c, row: index }))
    lastChange.current = { op: after ? 'p' : 'P', lines: 1 }
    if (copies.length > 1) say(`已貼上 ${copies.length} 個排程`)
  }

  function repeat() {
    const last = lastChange.current
    if (!last) return say('沒有可以重複的動作')
    if (last.op === 'd') {
      return deleteRange({ from: cursor.row, to: cursor.row + last.lines - 1 })
    }
    paste(last.op === 'p')
  }

  function setPaused(range: Range, paused: boolean) {
    const n = patchRows(idsIn(range), (r) => (r.deleted ? null : { paused }))
    say(
      n === 0
        ? paused
          ? '選取的排程都已暫停'
          : '選取的排程都沒有暫停'
        : `已${paused ? '暫停' : '恢復'} ${n} 個排程（:w 儲存）`,
    )
  }

  // ---------- visual mode

  function startVisual(from: number, to: number) {
    if (rows.length === 0) return say('沒有排程，按 o 新增一個')
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
    if (column === 'rule' || column === 'next') {
      return say('週期和下次要一個一個改', 'error')
    }
    const usable = rows
      .slice(range.from, range.to + 1)
      .filter((r) => !r.deleted)
    if (usable.length === 0) return say('選取的排程都已標記刪除', 'error')
    setEdit('')
    setPick(0)
    setNavigated(false)
    setBulk(true)
    setMode('insert')
    say(
      `輸入的${scheduleLabels[column]}會套用到 ${usable.length} 個排程；Enter 套用，沒輸入就按 Esc 取消`,
    )
  }

  function commitBulk(text: string, cancelIfEmpty: boolean): boolean {
    if (!selection) return true
    if (cancelIfEmpty && text.trim() === '') {
      endVisual()
      say('沒有輸入，未修改任何排程')
      return true
    }
    let error = ''
    let skipped = 0
    const changed = patchRows(idsIn(selection), (row) => {
      if (row.deleted) {
        skipped++
        return null
      }
      const patch = schedulePatch(row, column, text, ctx, today)
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
      `已修改 ${changed} 個排程的${scheduleLabels[column]}${
        skipped > 0 ? `，略過 ${skipped} 個` : ''
      }${error ? `（${error}）` : ''}`,
      error ? 'error' : 'info',
    )
    return true
  }

  // ---------- cells

  function editable(row: ScheduleRow, col: ScheduleColumn): string | null {
    if (row.deleted) return '這個排程已標記刪除，按 u 復原或 dd 取消'
    if (
      col === 'category' &&
      lineCategoryMode(row.accountId, row.transferTo, ctx) === 'none'
    ) {
      return '這個排程不需要類別'
    }
    return null
  }

  function startInsertAt(index: number, colIndex: number, clear = false) {
    const row = rows.at(index)
    const col = columns[colIndex]
    if (!row) return say('沒有排程，按 o 新增一個')
    const reason = editable(row, col)
    if (reason) return say(reason, 'error')
    setEdit(
      clear ? '' : scheduleCellText(row, col, ctx, nextOf(row, today, off)),
    )
    setPick(0)
    setNavigated(false)
    setBulk(false)
    setMode('insert')
  }

  function openAccounts(except: string | null) {
    return [...ctx.accounts.values()].filter(
      (a) => a.id !== except && !a.closed,
    )
  }

  function suggestions(): Array<Suggestion> {
    if (mode !== 'insert' || !current) return []
    switch (column) {
      case 'account':
        return rank(
          openAccounts(current.transferTo).map((a) => ({
            value: a.name,
            label: a.name,
            hint: a.onBudget ? '預算內' : '追蹤',
          })),
          edit,
          (a) => a.value,
        )
      case 'payee': {
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
      case 'category':
        return rank(
          [...ctx.categories.values()].filter(
            (c) => !c.isSystem && !c.archived,
          ),
          edit,
          (c) => c.path,
        ).map((c) => ({
          value: c.path,
          label: c.path,
          hint: c.kind === 'income' ? '收入' : undefined,
        }))
      case 'mode':
        return Object.values(modeLabels).map((label) => ({
          value: label,
          label,
        }))
      case 'rule':
        // `/monthly`, `/每月`, `/every`: a rule to start from.
        if (!edit.startsWith('/')) return []
        return rank(
          ruleTemplates(today),
          edit.slice(1),
          (t) => `${t.command} ${t.text}`,
        ).map((t) => ({ value: t.text, label: `/${t.command}`, hint: t.text }))
      default:
        return []
    }
  }

  /** In the rule cell, `/…` with a template highlighted. */
  function templating(options: Array<Suggestion>): boolean {
    return column === 'rule' && edit.startsWith('/') && options.length > 0
  }

  /** Puts the highlighted template in the cell and keeps editing it. */
  function applyTemplate(options: Array<Suggestion>) {
    const text = options[Math.min(pick, options.length - 1)].value
    opened.current = null
    setEdit(text)
    setPick(0)
    setNavigated(false)
  }

  function chosenText(): string {
    const options = suggestions()
    if (options.length === 0) return edit
    const highlighted = options[Math.min(pick, options.length - 1)].value
    if (navigated) return highlighted
    if (column === 'rule') return edit.startsWith('/') ? highlighted : edit
    if (edit === '') return column === 'account' ? highlighted : edit
    if (column === 'category') {
      return findCategory(edit, ctx.categories.values()) ? edit : highlighted
    }
    if (column === 'account' || column === 'mode') {
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

  function takenIndex(options: Array<Suggestion>): number {
    if (options.length === 0) return -1
    const text = chosenText()
    const value =
      column === 'category'
        ? (findCategory(text, ctx.categories.values())?.path ?? text)
        : text
    return options.findIndex((o) => o.value === value)
  }

  function commitCell(text: string, cancelIfEmpty = false): ScheduleRow | null {
    if (!current) return null
    if (bulk) return commitBulk(text, cancelIfEmpty) ? current : null
    opened.current = null
    const patch = schedulePatch(current, column, text, ctx, today)
    if (typeof patch === 'string') {
      say(patch, 'error')
      return null
    }
    const next = { ...current, ...patch }
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      change(rows.with(cursor.row, next))
      clearProblems([current.id])
    }
    // A known payee brings the category it was last used with.
    if (column === 'payee' && !next.transferTo && !next.categoryId) {
      const known = payees.find((p) => p.name === next.payee)
      if (
        known?.lastCategoryId &&
        lineCategoryMode(next.accountId, null, ctx) === 'required'
      ) {
        const withCategory = { ...next, categoryId: known.lastCategoryId }
        setRows((rs) => rs.with(cursor.row, withCategory))
        setMessage(null)
        return withCategory
      }
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
    setEdit(scheduleCellText(row, columns[col], ctx, nextOf(row, today, off)))
    setPick(0)
    setNavigated(false)
  }

  // ---------- saving and the server's own actions

  function messageFor(code: string, fallback: string): string {
    if (problemMessages[code]) return problemMessages[code]
    const known = errorCodeMessage(code)
    return known === '發生未知錯誤' ? fallback : known
  }

  async function save(): Promise<boolean> {
    const found = new Map<string, ScheduleProblem>()
    for (const row of rows) {
      if (scheduleStatus(row) === 'clean') continue
      const p = validateSchedule(row, ctx)
      if (p) found.set(row.id, p)
    }
    if (found.size > 0) return reportProblems(found)
    const upserts = rows
      .filter((r) => !r.deleted && scheduleStatus(r) !== 'clean')
      .map(toScheduleInput)
    const deletes = rows.filter((r) => r.deleted && r.base).map((r) => r.id)
    if (upserts.length === 0 && deletes.length === 0) {
      say('沒有需要儲存的變更')
      return true
    }
    setSaving(true)
    try {
      const { data, error, response } = await api.POST(
        '/budgets/{budgetId}/schedules/batch',
        { params: { path: { budgetId } }, body: { upserts, deletes } },
      )
      if (response.status === 422 && error && 'errors' in error) {
        const fromServer = new Map<string, ScheduleProblem>()
        for (const p of error.errors) {
          fromServer.set(p.id, {
            field: scheduleProblemColumn(p.field),
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
      const next = savedRows(fresh)
      writeDraft(key, [])
      history.current = { undo: [], redo: [] }
      setRows(next)
      setProblems(new Map())
      setCursor((c) => ({ ...c, row: clamp(c.row, next.length) }))
      say(
        `已儲存：${data.upserted} 個新增或修改，${data.deleted} 個刪除${
          data.posted > 0 ? `；已入帳 ${data.posted} 筆到期的交易` : ''
        }`,
      )
      return true
    } catch {
      say('無法連線至伺服器；變更仍保留在草稿裡', 'error')
      return false
    } finally {
      setSaving(false)
    }
  }

  function reportProblems(found: Map<string, ScheduleProblem>): false {
    setProblems(found)
    const first = rows.findIndex((r) => found.has(r.id))
    const p = found.get(rows[first]?.id ?? '')
    if (first >= 0) {
      const col = p?.field ? columns.indexOf(p.field) : -1
      setCursor({ row: first, col: col >= 0 ? col : cursor.col })
    }
    say(`${found.size} 個排程有問題，沒有儲存：${p?.message ?? ''}`, 'error')
    return false
  }

  /** After a change made on the server: saved lines take the fresh copy, drafts stay. */
  async function refresh() {
    const fresh = await reload()
    const byId = new Map(fresh.map((s) => [s.id, s]))
    setRows((rs) => {
      const kept = rs.flatMap((r) => {
        const s = byId.get(r.id)
        if (!r.base) return [r]
        if (!s) return []
        return scheduleStatus(r) === 'clean'
          ? [rowFromSchedule(s)]
          : [{ ...r, base: s }]
      })
      const known = new Set(kept.map((r) => r.id))
      return [...kept, ...savedRows(fresh.filter((s) => !known.has(s.id)))]
    })
  }

  /** The line a skip or unskip acts on: saved and unchanged. */
  function savedLine(): ScheduleRow | null {
    if (!current) {
      say('沒有排程', 'error')
      return null
    }
    if (!current.base || scheduleStatus(current) !== 'clean') {
      say('先 :w 儲存這個排程', 'error')
      return null
    }
    return current
  }

  async function skipNext() {
    const row = savedLine()
    if (!row?.base) return
    const occurrence = row.base.nextOccurrence
    if (!occurrence) return say('這個排程已經沒有下一期', 'error')
    const { error } = await api.POST(
      '/budgets/{budgetId}/schedules/{scheduleId}/skips',
      {
        params: { path: { budgetId, scheduleId: row.id } },
        body: { occurrence },
      },
    )
    if (error) return say(messageFor(error.code, error.message), 'error')
    await refresh()
    say(`已略過 ${formatDate(occurrence, now)} 這一期（:unskip 取消）`)
  }

  async function unskip(arg: string) {
    const row = savedLine()
    if (!row?.base) return
    const skips = row.base.skips
    if (skips.length === 0) return say('這個排程沒有略過的期數', 'error')
    let occurrence = skips.at(-1) ?? ''
    if (arg) {
      const date = parseDate(arg, now)
      if (!date || !skips.includes(date)) {
        return say(
          `沒有略過「${arg}」這一期；略過的有 ${skips.map((s) => formatDate(s, now)).join('、')}`,
          'error',
        )
      }
      occurrence = date
    }
    const { error } = await api.DELETE(
      '/budgets/{budgetId}/schedules/{scheduleId}/skips/{occurrence}',
      { params: { path: { budgetId, scheduleId: row.id, occurrence } } },
    )
    if (error) return say(messageFor(error.code, error.message), 'error')
    await refresh()
    say(`已恢復 ${formatDate(occurrence, now)} 這一期`)
  }

  function discard() {
    const fresh = savedRows(schedules)
    writeDraft(key, [])
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
      if (await save()) onQuit()
    } else if (cmd === 'q') {
      if (dirty > 0)
        say(
          `還有 ${dirty} 個排程未儲存（:w 儲存，:q! 離開並保留草稿）`,
          'error',
        )
      else onQuit()
    } else if (cmd === 'q!') {
      onQuit()
    } else if (cmd === 'e!') {
      discard()
    } else if (cmd === 'pause') {
      setPaused(range, true)
    } else if (cmd === 'resume') {
      setPaused(range, false)
    } else if (cmd === 'skip') {
      await skipNext()
    } else if (cmd === 'unskip' || cmd.startsWith('unskip ')) {
      await unskip(cmd.slice('unskip'.length).trim())
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
        if (templating(options)) applyTemplate(options)
        else finishCell('next')
        return true
      case '<S-Tab>':
        finishCell('prev')
        return true
      case '<CR>':
        // A template goes into the cell first, to be adjusted.
        if (templating(options)) applyTemplate(options)
        else finishCell('stay')
        return true
      case '<Esc>': {
        if (dropOpened()) return true
        const text = navigated || templating(options) ? chosenText() : edit
        if (commitCell(text, true)) setMode('normal')
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

  const feed = useKeyFeed(keymap, 'schedules', (k) => {
    if (mode === 'insert') return runInsert(k)
    if (mode === 'command') return runCommandKey(k)
    return runNormal(k)
  })

  // ---------- render

  const options = suggestions()
  const problem = current ? problems.get(current.id) : undefined
  /** While a rule is typed: the dates it would give. */
  const preview = (() => {
    if (mode !== 'insert' || column !== 'rule' || bulk || !edit.trim())
      return null
    if (edit.startsWith('/')) {
      return options.length > 0
        ? {
            text: '選一個範本：Ctrl-n/Ctrl-p 移動，Enter 放進格子再改日期',
            tone: 'info' as const,
          }
        : {
            text: '沒有這個範本：/每月、/每週、/monthly、/weekly、/every…',
            tone: 'error' as const,
          }
    }
    const parsed = parseRule(edit)
    if ('error' in parsed) return { text: parsed.error, tone: 'error' as const }
    const dates = nextOccurrences(
      parsed.rule,
      today,
      parsed.shift,
      today,
      4,
      off,
    )
    if (dates.length === 0)
      return { text: '今天之後沒有任何一期', tone: 'error' as const }
    return {
      text: `接下來：${dates
        .map((d) =>
          d.date === d.nominal
            ? formatDate(d.date, now)
            : `${formatDate(d.date, now)}（${formatDate(d.nominal, now)} 遇假日）`,
        )
        .join('、')}`,
      tone: 'info' as const,
    }
  })()
  const line =
    mode === 'command'
      ? null
      : (preview ??
        message ??
        (problem ? { text: problem.message, tone: 'error' as const } : null))

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={gridRef}
        tabIndex={0}
        role="grid"
        aria-label="排程"
        aria-rowcount={rows.length}
        data-pane="schedules"
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
                    (c === 'outflow' || c === 'inflow') && 'justify-end',
                  )}
                >
                  {scheduleLabels[c]}
                </span>
              ))}
            </div>

            {rows.length === 0 && (
              <p className="px-4 py-6 text-sm text-muted-foreground">
                還沒有排程。按{' '}
                <kbd className="font-mono text-foreground">o</kbd>{' '}
                新增一個，例如每月 5 日的房租、每年 3/15 的保費。
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
                <ScheduleLine
                  key={row.id}
                  row={row}
                  index={index}
                  layout={layout}
                  status={statuses[index]}
                  problem={problems.get(row.id)}
                  ctx={ctx}
                  next={nextOf(row, today, off)}
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
                        ? `${scheduleLabels[column]}（選取的排程）`
                        : scheduleLabels[column]
                    }
                    numeric={
                      column === 'next'
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
        groups={scheduleKeys}
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
              ? `已選 ${selection.to - selection.from + 1} 個 · d 刪除 · y 複製 · c 修改 · :pause 暫停 · ? 快捷鍵`
              : 'hjkl 移動 · i 編輯 · o 新增 · :skip 略過下一期 · :w 儲存 · ? 快捷鍵'}
          </span>
        )}
      </div>
    </div>
  )
}

function ScheduleLine({
  row,
  index,
  layout,
  status,
  problem,
  ctx,
  next,
  now,
  onPick,
}: {
  row: ScheduleRow
  index: number
  layout: Layout
  status: ScheduleStatus
  problem: ScheduleProblem | undefined
  ctx: Context
  next: ReturnType<typeof nextOf>
  now: Date
  onPick: (col: number, enter: boolean, extend: boolean) => void
}) {
  const marker = problem
    ? '!'
    : { clean: '', new: '+', changed: '~', deleted: '-' }[status]
  const transfer = row.transferTo ? ctx.accounts.get(row.transferTo) : undefined
  const needsCategory =
    lineCategoryMode(row.accountId, row.transferTo, ctx) === 'required'
  const cell = 'flex items-center overflow-hidden px-2 whitespace-nowrap'

  function content(c: ScheduleColumn, col: number): React.ReactNode {
    const bad = problem?.field === c && 'text-destructive'
    switch (c) {
      case 'rule':
        return (
          <span key={c} data-col={col} className={cn(cell, bad)}>
            <span className="truncate">{row.source}</span>
          </span>
        )
      case 'next':
        return (
          <span
            key={c}
            data-col={col}
            className={cn(cell, 'font-mono', bad)}
            title={
              next && next.date !== next.nominal
                ? `${formatDate(next.nominal, now)} 遇假日，${formatDate(next.date, now)} 入帳`
                : undefined
            }
          >
            {row.paused ? (
              <span className="flex items-center gap-1 font-sans text-muted-foreground">
                <PauseIcon className="size-3.5" />
                暫停
              </span>
            ) : next ? (
              <span className="flex items-center gap-1">
                {formatDate(next.date, now)}
                {next.date !== next.nominal && (
                  <RedoIcon className="size-3 text-muted-foreground" />
                )}
              </span>
            ) : row.rule ? (
              <span className="font-sans text-muted-foreground">已結束</span>
            ) : null}
          </span>
        )
      case 'payee':
        return (
          <span key={c} data-col={col} className={cn(cell, bad)}>
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
            className={cn(cell, !needsCategory && 'text-muted-foreground', bad)}
          >
            <span className="truncate">
              {row.categoryId
                ? ctx.categories.get(row.categoryId)?.path
                : needsCategory
                  ? ''
                  : '—'}
            </span>
          </span>
        )
      case 'account':
        return (
          <span
            key={c}
            data-col={col}
            className={cn(cell, 'text-muted-foreground', bad)}
          >
            <span className="truncate">
              {ctx.accounts.get(row.accountId)?.name ?? ''}
            </span>
          </span>
        )
      case 'outflow':
      case 'inflow':
        return (
          <span
            key={c}
            data-col={col}
            className={cn(cell, 'amount justify-end', bad)}
            title={row.estimate ? '預估金額：入帳後要確認' : undefined}
          >
            {scheduleAmountText(row, c, ctx.minorUnits)}
          </span>
        )
      case 'mode':
        return (
          <span
            key={c}
            data-col={col}
            className={cn(
              cell,
              'text-xs',
              row.budgetMode === 'notBudgeted' || !needsCategory
                ? 'text-muted-foreground'
                : 'text-kraft',
            )}
          >
            {needsCategory ? modeLabels[row.budgetMode] : '—'}
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
        row.paused && !row.deleted && 'text-muted-foreground',
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
        title={problem?.message}
      >
        {marker}
      </span>
      {scheduleColumns.map((c, col) => content(c, col))}
    </div>
  )
}
