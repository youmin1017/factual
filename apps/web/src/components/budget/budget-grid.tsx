import { EllipsisIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Amount } from '#/components/amount'
import { CellEditor, eraseBeforeCaret } from '#/components/register/cell-editor'
import { KeyHelp, budgetKeys } from '#/components/register/key-help'
import { useKeyFeed } from '#/components/register/use-key-feed'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '#/components/ui/dropdown-menu'
import {
  afterSubtree,
  categoryNodes,
  copyLastMonth,
  fillTargets,
  monthLabel,
  newPlace,
  offTarget,
  pasteTargets,
  siblingsOf,
  topDown,
} from '#/lib/budget-month'
import { setEditorStatus } from '#/lib/editorStatus'
import { amountInputValue, formatAmount } from '#/lib/money'
import { movePane, windowDirection } from '#/lib/panes'
import { evalAmount } from '#/lib/register'
import { cn } from '#/lib/utils'
import {
  deleteNodes,
  pasteCopy,
  pasteCut,
  restoreNodes,
  unpaste,
} from './category-tree'
import type { Category } from '#/lib/budget'
import type {
  BudgetLine,
  CategoryNode,
  MonthLines,
  NewPlace,
} from '#/lib/budget-month'
import type { Key, Keymap } from '#/lib/keymap'
import type { CategoryApi } from './category-api'
import type { Pasted } from './category-tree'

const ROW_HEIGHT = 32
/** The name column, then allocation, spending and balance for each month. */
function template(months: number): string {
  return `minmax(8rem, 1fr) repeat(${months * 3}, minmax(4.5rem, 7rem))`
}

export interface Allocation {
  categoryId: string
  amount: number
}

/**
 * One undoable change, done again or taken back by saving. `month` marks an
 * allocation, so undoing it from another month says which.
 */
interface Step {
  month?: string
  label?: string
  undo: () => Promise<string | null>
  redo: () => Promise<string | null>
}

interface Message {
  text: string
  tone: 'info' | 'error'
}

/** `visual` is Vim's linewise visual mode (`V`), as in the register. */
type Mode = 'normal' | 'visual' | 'insert' | 'command'
/** -1 for the name column, else the month (0, 1, 2) whose allocation it is. */
type Column = number
const NAME = -1
/** What insert mode is typing: an allocation, a new name, a new category. */
type Target = 'allocate' | 'rename' | 'new'

/**
 * What `y` and `d` keep for `p`. `y` keeps both the envelopes' allocations
 * (in line order, for `p` on an allocation column) and the categories with
 * what is under them and their allocations (for `p` on the name column).
 * `d` keeps what it took from its column: cleared allocations, or deleted
 * categories (`cut`: pasting moves them back in).
 */
interface Yank {
  amounts: Array<number>
  nodes: Array<CategoryNode>
  /** Allocations of the yanked categories, by the id they were yanked from. */
  allocations: Map<string, number>
  cut: boolean
}

/** A category being added: where it goes, and the line it is placed by. */
interface Draft {
  place: NewPlace
  anchorId: string
  /** Before the anchor, right after it, or after everything under it. */
  where: 'before' | 'next' | 'after'
}

interface Move {
  id: string
  to: { parentId: string | null; index: number }
  from: { parentId: string | null; index: number }
}

export type LineAction =
  | 'below'
  | 'above'
  | 'child'
  | 'rename'
  | 'down'
  | 'up'
  | 'indent'
  | 'outdent'
  | 'share'
  | 'archive'
  | 'delete'
  | 'base'

/**
 * The budget page's grid (M6, ADR-078..081): one line per category, expense
 * then income, with one to three months side by side, moved through and
 * selected as the register is (j/k, counts, gg/G, V; h/l across columns).
 * Each month's allocation column takes its budget; the name column renames
 * and edits the tree. `y` keeps lines (categories and allocations), `d` and
 * `p` act on the cursor's column. Every change is saved at once; `u` and
 * Ctrl-r undo and redo by saving again.
 */
export function BudgetGrid({
  months,
  categories,
  minorUnits,
  keymap,
  canManage,
  onToggleArchived,
  onMonth,
  onMonthCount,
  allocate,
  lastMonth,
  categoryApi,
  scheduleNames,
  setBase,
}: {
  /** The months shown, each with the same lines (`pageMonths`). */
  months: Array<MonthLines>
  categories: Array<Category>
  minorUnits: number
  keymap: Keymap
  /** Whether the caller may change categories (the budget's owner). */
  canManage: boolean
  onToggleArchived: () => void
  /** Moves the months shown, `delta` months away. */
  onMonth: (delta: number) => void
  /** `:months N`: how many months to show; a message when fewer fit. */
  onMonthCount: (count: number) => string | null
  /** Saves allocations of a month; resolves to an error message, or null. */
  allocate: (month: string, set: Array<Allocation>) => Promise<string | null>
  /** The lines of the month before `month`, for `:copylast`. */
  lastMonth: (month: string) => Promise<Array<BudgetLine>>
  categoryApi: CategoryApi
  /** How a schedule is named in a target's parts: `健身房（每月 5 日）`. */
  scheduleNames: Map<string, string>
  /** Sets an envelope's base amount (0 removes it); an error message, or null. */
  setBase: (categoryId: string, amount: number) => Promise<string | null>
}) {
  const gridRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // The cursor follows a category, so it stays put across months.
  const [cursorId, setCursorId] = useState<string | null>(
    () => months[0]?.lines.find((l) => l.kind === 'envelope')?.id ?? null,
  )
  const [col, setCol] = useState<Column>(0)
  // The month the cursor is in (the first one on the name column): its lines
  // carry that month's numbers, and allocations go to it.
  const at = Math.min(Math.max(col, 0), months.length - 1)
  const { month, lines } = months[at]
  const onName = col < 0
  const columns = template(months.length)
  /** How messages name the cursor's month. */
  const monthName = months.length > 1 ? monthLabel(month) : '本月'
  /** Room the sticky column heads take, so a line scrolled to stays visible. */
  const headHeight = ROW_HEIGHT * (months.length > 1 ? 2 : 1)
  const [mode, setMode] = useState<Mode>('normal')
  const [target, setTarget] = useState<Target>('allocate')
  /** Where visual mode started (a line id); the selection runs to the cursor. */
  const [anchorId, setAnchorId] = useState<string | null>(null)
  /** Whether the allocation typed goes into every selected envelope. */
  const [bulk, setBulk] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [edit, setEdit] = useState('')
  const [command, setCommand] = useState('')
  const [message, setMessage] = useState<Message | null>(null)
  const [help, setHelp] = useState(false)
  const [saving, setSaving] = useState(false)
  const pending = useRef({ count: '', op: '' })
  const history = useRef<{ undo: Array<Step>; redo: Array<Step> }>({
    undo: [],
    redo: [],
  })
  const yank = useRef<Yank | null>(null)
  const lastVisual = useRef<{ anchorId: string; cursorId: string } | null>(null)
  /** The lines a command typed from visual mode acts on (`:'<,'>`). */
  const commandLines = useRef<Array<BudgetLine> | null>(null)
  // Undo runs later; it needs the categories as they are then.
  const latest = useRef(categories)
  useEffect(() => {
    latest.current = categories
  }, [categories])

  const found = lines.findIndex((l) => l.id === cursorId)
  const row = found < 0 ? 0 : found
  const current = lines.at(row)

  const anchorFound = lines.findIndex((l) => l.id === anchorId)
  const anchor = anchorFound < 0 ? row : anchorFound
  const range =
    mode === 'visual' || (mode === 'insert' && bulk)
      ? { from: Math.min(anchor, row), to: Math.max(anchor, row) }
      : null

  const anchorAt = draft ? lines.findIndex((l) => l.id === draft.anchorId) : -1
  const draftAt = !draft
    ? -1
    : anchorAt < 0
      ? lines.length
      : draft.where === 'before'
        ? anchorAt
        : draft.where === 'next'
          ? anchorAt + 1
          : afterSubtree(lines, anchorAt)

  useEffect(() => {
    setEditorStatus({ mode, dirty: 0 })
  }, [mode])
  useEffect(() => () => setEditorStatus(null), [])
  useEffect(() => {
    if ((mode === 'normal' || mode === 'visual') && !help)
      gridRef.current?.focus({ preventScroll: true })
  }, [mode, help])
  useEffect(() => {
    const el = scrollRef.current?.querySelector(`[data-line="${row}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [row])

  function say(text: string, tone: Message['tone'] = 'info') {
    setMessage({ text, tone })
  }

  function moveTo(index: number) {
    const to = lines.at(Math.max(0, Math.min(index, lines.length - 1)))
    if (to) setCursorId(to.id)
  }

  /** The envelope `step` lines away that takes an allocation, if any. */
  function nextEnvelope(from: number, step: 1 | -1): number | null {
    for (let i = from + step; i >= 0 && i < lines.length; i += step) {
      if (lines[i].kind === 'envelope') return i
    }
    return null
  }

  /** Why a line takes no allocation, or null when it does. */
  function notEditable(line: BudgetLine): string | null {
    switch (line.kind) {
      case 'section':
        return line.section === 'expense'
          ? '這一行是支出的合計：到底下的預算分配'
          : '收入進入資金池，不用分配預算'
      case 'income':
        return '收入進入資金池，不用分配預算'
      case 'group':
        return `「${line.name}」的子類別各自有預算：到子類別分配`
      case 'member': {
        const parent = line.path.split('/').slice(0, -1).join('/')
        return `「${line.name}」和上層共用預算：到「${parent}」分配`
      }
      default:
        return null
    }
  }

  // ---------- saving and undo

  async function run(fn: () => Promise<string | null>): Promise<boolean> {
    setSaving(true)
    const error = await fn()
    setSaving(false)
    if (error) {
      say(error, 'error')
      return false
    }
    return true
  }

  function remember(step: Step) {
    history.current.undo.push(step)
    if (history.current.undo.length > 200) history.current.undo.shift()
    history.current.redo = []
  }

  /** Does `step`, and remembers it when it worked. */
  async function record(step: Step, done?: string): Promise<boolean> {
    if (!(await run(step.redo))) return false
    remember(step)
    if (done) say(done)
    return true
  }

  function stepName(step: Step): string {
    if (step.month && (step.month !== month || months.length > 1))
      return ` ${monthLabel(step.month)}的分配`
    return step.label ? `：${step.label}` : ''
  }

  async function undo() {
    const step = history.current.undo.pop()
    if (!step) return say('已經是最早的狀態')
    if (!(await run(step.undo))) {
      history.current.undo.push(step)
      return
    }
    history.current.redo.push(step)
    say(`已復原${stepName(step)}`)
  }

  async function redo() {
    const step = history.current.redo.pop()
    if (!step) return say('已經是最新的狀態')
    if (!(await run(step.redo))) {
      history.current.redo.push(step)
      return
    }
    history.current.undo.push(step)
    say(`已重做${stepName(step)}`)
  }

  // ---------- allocations

  function allocationStep(
    m: string,
    changes: Array<{ categoryId: string; from: number; to: number }>,
  ): Step {
    const set = (pick: 'from' | 'to') => () =>
      allocate(
        m,
        changes.map((c) => ({ categoryId: c.categoryId, amount: c[pick] })),
      )
    return { month: m, undo: set('from'), redo: set('to') }
  }

  /** Sets envelopes to amounts, as one undo step. */
  function setAllocations(
    set: Array<{ line: BudgetLine; amount: number }>,
    done: string,
  ) {
    const changes = set
      .filter((s) => s.amount !== s.line.allocated)
      .map((s) => ({
        categoryId: s.line.id,
        from: s.line.allocated,
        to: s.amount,
      }))
    if (changes.length === 0) return say('分配沒有改變')
    void record(allocationStep(month, changes), done)
  }

  function setAllocation(line: BudgetLine, amount: number) {
    if (amount === line.allocated) return
    setAllocations(
      [{ line, amount }],
      `「${line.path}」${monthName}分配 ${formatAmount(amount, minorUnits)}`,
    )
  }

  async function copyLast() {
    let last: Array<BudgetLine>
    try {
      last = await lastMonth(month)
    } catch {
      return say('讀不到上個月的預算', 'error')
    }
    const set = copyLastMonth(lines, last)
    if (set.length === 0)
      return say('沒有要複製的：本月還沒分配的預算，上個月也沒分配')
    await record(
      allocationStep(
        month,
        set.map((s) => ({ categoryId: s.categoryId, from: 0, to: s.amount })),
      ),
      `照上個月分配了 ${set.length} 個預算（u 可以復原）`,
    )
  }

  function envelopesOf(sel: Array<BudgetLine>): Array<BudgetLine> {
    return sel.filter((l) => l.kind === 'envelope')
  }

  /**
   * `y`: the lines, categories and allocations both (of the cursor's month),
   * so `p` on the name column brings the budget along with the categories.
   */
  function yankLines(sel: Array<BudgetLine>) {
    const env = envelopesOf(sel)
    const nodes = nodesOf(sel)
    if (env.length === 0 && nodes.length === 0)
      return say('選取的範圍裡沒有類別')
    const byId = new Map(lines.map((l) => [l.id, l]))
    const allocations = new Map<string, number>()
    for (const n of topDown(nodes)) {
      const l = byId.get(n.sourceId)
      if (l?.kind === 'envelope' && l.allocated !== 0)
        allocations.set(n.sourceId, l.allocated)
    }
    yank.current = {
      amounts: env.map((l) => l.allocated),
      nodes,
      allocations,
      cut: false,
    }
    say(
      onName
        ? `已複製 ${nodes.length} 個類別和它們的分配（p 貼上新類別）`
        : `已複製 ${env.length} 個預算的分配（p 從游標往下貼上）`,
    )
  }

  /** `d` on an allocation column: cleared, and kept for `p`. */
  function cutAmounts(sel: Array<BudgetLine>) {
    const env = envelopesOf(sel)
    if (env.length === 0) return say('選取的範圍裡沒有預算')
    yank.current = {
      amounts: env.map((l) => l.allocated),
      nodes: [],
      allocations: new Map(),
      cut: false,
    }
    setAllocations(
      env.map((line) => ({ line, amount: 0 })),
      `已清除 ${env.length} 個預算的分配（p 可以貼上）`,
    )
  }

  function pasteAmounts(amounts: Array<number>, from: number) {
    const targets = pasteTargets(lines, from, amounts.length)
    if (targets.length === 0) return say('游標下面沒有預算可以貼上')
    setAllocations(
      targets.map((line, i) => ({ line, amount: amounts[i] })),
      targets.length < amounts.length
        ? `已貼上 ${targets.length} 個預算的分配（下面只剩 ${targets.length} 個預算）`
        : `已貼上 ${targets.length} 個預算的分配`,
    )
  }

  // ---------- targets (ADR-086)

  /** `:fill`: the envelopes of `sel` with a target get it, as one undo step. */
  function fill(sel: Array<BudgetLine>, selected: boolean) {
    const set = fillTargets(sel)
    if (set.length === 0) {
      return say(
        selected
          ? '選取的預算都已經照目標分配了（或沒有目標）'
          : `${monthName}有目標的預算都已經照目標分配了`,
      )
    }
    setAllocations(
      set,
      `${monthName}照目標分配了 ${set.length} 個預算（u 可以復原）`,
    )
  }

  /** `:base N`: the cursor's envelope's base amount; `:base` alone says it. */
  function base(arg: string) {
    const line = current
    if (!line) return
    if (line.kind !== 'envelope' || !line.category) {
      return say(notEditable(line) ?? '只有預算有基本額', 'error')
    }
    const from = line.category.budgetBase ?? 0
    if (!arg) {
      return say(
        from > 0
          ? `「${line.path}」的基本額是 ${formatAmount(from, minorUnits)}（:base 0 移除）`
          : `「${line.path}」還沒有基本額：:base 1000 設定每個月的基本額`,
      )
    }
    const to = evalAmount(arg, minorUnits)
    if (to === null) return say(`「${arg}」不是金額`, 'error')
    if (to < 0) return say('基本額不能是負的', 'error')
    if (to === from) return say('基本額沒有改變')
    const id = line.id
    void record(
      {
        label: `「${line.path}」的基本額`,
        undo: () => setBase(id, from),
        redo: () => setBase(id, to),
      },
      to === 0
        ? `已移除「${line.path}」的基本額`
        : `「${line.path}」每個月的基本額是 ${formatAmount(to, minorUnits)}；:fill 照目標分配`,
    )
  }

  /** The cursor's target and its parts, for the status line. */
  function targetText(line: BudgetLine): string | null {
    const goal = line.target
    if (line.kind !== 'envelope' || !goal) return null
    const money = (n: number) => formatAmount(n, minorUnits)
    const parts = [
      ...(goal.base ? [`基本 ${money(goal.base)}`] : []),
      ...goal.schedules.map(
        (s) =>
          `${scheduleNames.get(s.scheduleId) ?? '排程'} ${money(s.amount)}`,
      ),
    ]
    const diff = goal.total - line.allocated
    const off =
      diff === 0
        ? '已照目標分配'
        : diff > 0
          ? `還差 ${money(diff)}，:fill 補上`
          : `多分配了 ${money(-diff)}`
    return `${monthName}目標 ${money(goal.total)} ＝ ${parts.join(' ＋ ')}（${off}）`
  }

  // ---------- the category tree (ADR-079, ADR-080)

  /** The category as it is now, for undo; an error when it is gone. */
  function fresh(id: string): Category | string {
    return latest.current.find((c) => c.id === id) ?? '找不到這個類別了'
  }

  /** Changes several categories, reloading once. */
  function updateAll(
    changes: Array<{
      id: string
      set: Partial<Pick<Category, 'name' | 'pooled' | 'archived'>>
    }>,
  ) {
    return async () => {
      let error: string | null = null
      for (const ch of changes) {
        const c = fresh(ch.id)
        const e =
          typeof c === 'string' ? c : await categoryApi.update(c, ch.set, true)
        error ??= e
      }
      await categoryApi.reload()
      return error
    }
  }

  /** Moves several categories, reloading once; back to front positions first. */
  function moveAll(moves: Array<Move>, way: 'to' | 'from') {
    return async () => {
      const order =
        way === 'to'
          ? moves
          : moves.toSorted((a, b) => a.from.index - b.from.index)
      let error: string | null = null
      for (const m of order) {
        const p = m[way]
        error ??= await categoryApi.move(m.id, p.parentId, p.index, true)
      }
      await categoryApi.reload()
      return error
    }
  }

  function mayManage(): boolean {
    if (!canManage) say('只有帳本的擁有者能修改類別', 'error')
    return canManage
  }

  /** The categories of `sel` that may be changed (no headings, no system ones). */
  function categoriesOf(sel: Array<BudgetLine>): Array<Category> {
    return sel
      .map((l) => l.category)
      .filter((c): c is Category => !!c && !c.isSystem)
  }

  /** The top-most categories of `sel`, each with what is under it. */
  function nodesOf(sel: Array<BudgetLine>): Array<CategoryNode> {
    return categoryNodes(
      categories,
      categoriesOf(sel).map((c) => c.id),
    )
  }

  function openDraft(
    how: 'below' | 'above' | 'child',
    line: BudgetLine | undefined = current,
  ) {
    if (!mayManage() || !line) return
    const place = newPlace(categories, line, how)
    if (!place) return say('類別最多三層')
    setDraft({
      place,
      anchorId: line.id,
      where: !line.category
        ? how === 'child'
          ? 'after'
          : 'next'
        : // System categories are listed last; new ones go above them.
          how === 'above' || line.category.isSystem
          ? 'before'
          : 'after',
    })
    setEdit('')
    setTarget('new')
    setMessage(null)
    setMode('insert')
  }

  async function commitNew(more: boolean) {
    if (!draft) return
    const name = edit.trim()
    if (!name) {
      setDraft(null)
      setMode('normal')
      return
    }
    const place = draft.place
    setSaving(true)
    const made = await categoryApi.create({ ...place, name })
    setSaving(false)
    if ('error' in made) return say(made.error, 'error')
    let id = made.id
    remember({
      label: `新增「${name}」`,
      undo: () => categoryApi.remove(id),
      redo: async () => {
        const again = await categoryApi.create({ ...place, name })
        if ('error' in again) return again.error
        id = again.id
        return null
      },
    })
    setCursorId(made.id)
    setCol(NAME)
    say(`已新增「${name}」`)
    if (more) {
      // Enter goes on to the next one, as `o` does in Vim.
      setDraft({
        place: { ...place, index: place.index + 1 },
        anchorId: made.id,
        where: 'after',
      })
      setEdit('')
    } else {
      setDraft(null)
      setMode('normal')
    }
  }

  function startRename(index: number, clear = false) {
    const line = lines.at(index)
    if (!mayManage() || !line) return
    const c = categoriesOf([line]).at(0)
    if (!c) return say(line.category ? '這是系統類別，不能改名' : '這是標題列')
    setCursorId(line.id)
    setEdit(clear ? '' : c.name)
    setTarget('rename')
    setMessage(null)
    setMode('insert')
  }

  function commitRename() {
    setMode('normal')
    const c = current?.category
    const name = edit.trim()
    if (!c || !name || name === c.name) return
    void record(
      {
        label: `「${c.name}」改名`,
        undo: updateAll([{ id: c.id, set: { name: c.name } }]),
        redo: updateAll([{ id: c.id, set: { name } }]),
      },
      `「${c.name}」改名為「${name}」`,
    )
  }

  /**
   * `d` on the name column: deletes the categories with what is under them,
   * and keeps them for `p`, which puts them back where the cursor is. Those
   * with money stay where they are (ADR-060), and `p` moves them.
   */
  async function cutCategories(sel: Array<BudgetLine>) {
    if (!mayManage()) return
    const nodes = nodesOf(sel)
    if (nodes.length === 0) return say('選取的範圍裡沒有類別')
    const gone = new Set(topDown(nodes).map((n) => n.id))
    const last = sel.length ? lines.indexOf(sel[sel.length - 1]) : row
    const next =
      lines.slice(last + 1).find((l) => !gone.has(l.id)) ??
      lines.slice(0, lines.indexOf(sel[0])).findLast((l) => !gone.has(l.id))

    setSaving(true)
    const first = await deleteNodes(categoryApi, nodes)
    setSaving(false)
    yank.current = { amounts: [], nodes, allocations: new Map(), cut: true }
    let deleted = first.deleted
    if (deleted.length > 0) {
      remember({
        label: `刪除 ${deleted.length} 個類別`,
        redo: async () => {
          const again = await deleteNodes(categoryApi, nodes)
          deleted = again.deleted
          return deleted.length > 0 ? null : again.error
        },
        undo: () => restoreNodes(categoryApi, deleted),
      })
    }
    const kept = nodes.filter((n) => n.id).map((n) => `「${n.name}」`)
    if (kept.length === 0) {
      say(`已刪除 ${deleted.length} 個類別（p 貼上，u 復原）`)
      if (next) setCursorId(next.id)
    } else {
      say(
        `${deleted.length > 0 ? `已刪除 ${deleted.length} 個類別；` : ''}${kept.join('')}有交易或預算，留在原處：p 可以搬到游標下面，:archive 可以封存`,
        deleted.length > 0 ? 'info' : 'error',
      )
    }
  }

  /**
   * `p` on the name column: copies (with the allocations they were yanked
   * with, into the cursor's month) or, after `d`, the cut categories moved
   * back in.
   */
  async function pasteCategories(y: Yank, above: boolean) {
    if (!mayManage() || !current) return
    const place = newPlace(categories, current, above ? 'above' : 'below')
    if (!place) return
    if (y.nodes.some((n) => n.kind !== place.kind))
      return say('支出類別和收入類別不能互相貼上', 'error')
    const into = month
    let pasted: Pasted = { created: [], moved: [] }
    let allocated: Array<Allocation> = []
    const doPaste = async () => {
      const r = y.cut
        ? await pasteCut(categoryApi, latest.current, y.nodes, place)
        : await pasteCopy(categoryApi, latest.current, y.nodes, place)
      pasted = r.pasted
      if (r.error) return r.error
      allocated = y.cut
        ? []
        : pasted.created.flatMap((n) => {
            const amount = y.allocations.get(n.sourceId)
            return n.id && amount ? [{ categoryId: n.id, amount }] : []
          })
      if (allocated.length === 0) return null
      const e = await allocate(into, allocated)
      if (!e) return null
      allocated = []
      return `類別貼上了，但分配沒有帶過去：${e}`
    }
    setSaving(true)
    const error = await doPaste()
    setSaving(false)
    const changed = pasted.created.length + pasted.moved.length
    if (changed > 0)
      remember({
        label: `貼上 ${y.nodes.length} 個類別`,
        redo: doPaste,
        undo: async () => {
          // Categories with money cannot be deleted: clear it first.
          if (allocated.length > 0) {
            const e = await allocate(
              into,
              allocated.map((a) => ({ ...a, amount: 0 })),
            )
            if (e) return e
          }
          return unpaste(categoryApi, pasted)
        },
      })
    if (error) return say(error, 'error')
    const firstId = y.cut ? y.nodes[0]?.id : pasted.created[0]?.id
    if (firstId) setCursorId(firstId)
    setCol(NAME)
    say(
      y.cut
        ? `已把 ${y.nodes.length} 個類別搬到這裡`
        : allocated.length > 0
          ? `已貼上 ${y.nodes.length} 個類別，${monthLabel(into)}的分配也帶過來了`
          : `已貼上 ${y.nodes.length} 個類別`,
    )
  }

  // ---------- d p, by the cursor's column

  function deleteLines(sel: Array<BudgetLine>) {
    if (onName) void cutCategories(sel)
    else cutAmounts(sel)
  }

  function put(above: boolean, from = row) {
    const y = yank.current
    if (!y) return say('還沒有複製任何東西：先用 yy 或 dd')
    if (onName) {
      if (y.nodes.length === 0)
        return say('暫存裡沒有類別：在類別欄用 yy 或 dd，或到分配欄貼上金額')
      void pasteCategories(y, above)
    } else {
      if (y.amounts.length === 0)
        return say(
          '暫存裡沒有分配金額：在分配欄用 yy 或 dd，或到類別欄貼上類別',
        )
      pasteAmounts(y.amounts, from)
    }
  }

  /** `J` / `K`: trade places with the next or previous shown sibling. */
  function swap(line: BudgetLine | undefined, step: 1 | -1) {
    if (!mayManage() || !line) return
    const c = categoriesOf([line]).at(0)
    if (!c) return say('這一行不能移動')
    const parentId = c.parentId ?? null
    const siblings = siblingsOf(categories, parentId, c.kind)
    const shown = new Set(lines.map((l) => l.id))
    const from = siblings.findIndex((s) => s.id === c.id)
    let to = from + step
    while (to >= 0 && to < siblings.length && !shown.has(siblings[to].id))
      to += step
    if (to < 0 || to >= siblings.length)
      return say(step > 0 ? '已經是這一層的最後一個' : '已經是這一層的第一個')
    const move = {
      id: c.id,
      to: { parentId, index: to },
      from: { parentId, index: from },
    }
    void record({
      label: `移動「${c.name}」`,
      redo: moveAll([move], 'to'),
      undo: moveAll([move], 'from'),
    })
  }

  /** Top-most categories of `sel` under one parent, or null (with a message). */
  function siblingNodes(sel: Array<BudgetLine>): Array<CategoryNode> | null {
    if (!mayManage()) return null
    const nodes = nodesOf(sel)
    if (nodes.length === 0) {
      say('選取的範圍裡沒有類別')
      return null
    }
    if (nodes.some((n) => n.parentId !== nodes[0].parentId)) {
      say('選取的類別不在同一層：一層一層搬')
      return null
    }
    return nodes
  }

  /** `>>`: into the shown sibling above, as its last subcategories. */
  function indent(sel: Array<BudgetLine>) {
    const nodes = siblingNodes(sel)
    if (!nodes) return
    const { parentId, kind } = nodes[0]
    const ids = new Set(nodes.map((n) => n.id))
    const shown = new Set(lines.map((l) => l.id))
    const into = siblingsOf(categories, parentId, kind)
      .slice(0, Math.max(0, nodes[0].index))
      .findLast((s) => shown.has(s.id) && !ids.has(s.id))
    if (!into) return say('上面沒有同一層的類別可以放進去')
    const end = siblingsOf(categories, into.id, kind).length
    const moves = nodes.map((n, k) => ({
      id: n.id ?? '',
      to: { parentId: into.id, index: end + k },
      from: { parentId, index: n.index },
    }))
    const names = nodes.map((n) => `「${n.name}」`).join('')
    void record(
      {
        label: `${names}放進「${into.name}」`,
        redo: moveAll(moves, 'to'),
        undo: moveAll(moves, 'from'),
      },
      `${names}放進「${into.name}」底下`,
    )
  }

  /** `<<`: out of their parent, right after it. */
  function outdent(sel: Array<BudgetLine>) {
    const nodes = siblingNodes(sel)
    if (!nodes) return
    const { parentId, kind } = nodes[0]
    const parent = categories.find((p) => p.id === parentId)
    if (!parent) return say('已經在最上層')
    const grand = parent.parentId ?? null
    const after =
      siblingsOf(categories, grand, kind).findIndex((s) => s.id === parent.id) +
      1
    const moves = nodes.map((n, k) => ({
      id: n.id ?? '',
      to: { parentId: grand, index: after + k },
      from: { parentId, index: n.index },
    }))
    const names = nodes.map((n) => `「${n.name}」`).join('')
    void record(
      {
        label: `${names}移出「${parent.name}」`,
        redo: moveAll(moves, 'to'),
        undo: moveAll(moves, 'from'),
      },
      `${names}移出「${parent.name}」`,
    )
  }

  /** Shared or separate budgets for the subcategories (ADR-061). */
  function toggleShare(sel: Array<BudgetLine>) {
    if (!mayManage()) return
    const parents = sel
      .filter((l) => l.hasChildren && l.section === 'expense')
      .flatMap((l) => categoriesOf([l]))
    if (parents.length === 0)
      return say('沒有子類別的類別不用選：有子類別才能選擇共用或各自預算')
    // All shared become separate; otherwise all share.
    const pooled = !parents.every((c) => c.pooled)
    const names = parents.map((c) => `「${c.name}」`).join('')
    void record(
      {
        label: `${names}${pooled ? '共用' : '各自'}預算`,
        redo: updateAll(parents.map((c) => ({ id: c.id, set: { pooled } }))),
        undo: updateAll(
          parents.map((c) => ({ id: c.id, set: { pooled: c.pooled } })),
        ),
      },
      pooled ? `${names}的子類別共用它的預算` : `${names}的子類別各自有預算`,
    )
  }

  function toggleArchive(sel: Array<BudgetLine>) {
    if (!mayManage()) return
    const cats = categoriesOf(sel)
    if (cats.length === 0) return say('選取的範圍裡沒有類別')
    const archived = !cats.every((c) => c.archived)
    const names =
      cats.length === 1 ? `「${cats[0].name}」` : `${cats.length} 個類別`
    void record(
      {
        label: `${archived ? '封存' : '取消封存'}${names}`,
        redo: updateAll(cats.map((c) => ({ id: c.id, set: { archived } }))),
        undo: updateAll(
          cats.map((c) => ({ id: c.id, set: { archived: c.archived } })),
        ),
      },
      archived
        ? `已封存${names}（:archived 顯示已封存的類別）`
        : `已取消封存${names}`,
    )
  }

  /** The menu's actions and their keys share this. */
  function act(action: LineAction, index: number) {
    const line = lines.at(index)
    if (!line) return
    setCursorId(line.id)
    switch (action) {
      case 'below':
      case 'above':
      case 'child':
        return openDraft(action, line)
      case 'rename':
        setCol(NAME)
        return startRename(index)
      case 'down':
        return swap(line, 1)
      case 'up':
        return swap(line, -1)
      case 'indent':
        return indent([line])
      case 'outdent':
        return outdent([line])
      case 'share':
        return toggleShare([line])
      case 'archive':
        return toggleArchive([line])
      case 'delete':
        setCol(NAME)
        return void cutCategories([line])
      case 'base': {
        const amount = line.category?.budgetBase
        setCommand(
          amount ? `base ${amountInputValue(amount, minorUnits)}` : 'base ',
        )
        setMode('command')
        return
      }
    }
  }

  // ---------- visual mode (linewise, like the register's V)

  function selection(): Array<BudgetLine> {
    return range
      ? lines.slice(range.from, range.to + 1)
      : current
        ? [current]
        : []
  }

  function startVisual(fromId: string, toId: string) {
    setAnchorId(fromId)
    setCursorId(toId)
    setMode('visual')
  }

  function endVisual() {
    if (anchorId && cursorId)
      lastVisual.current = { anchorId, cursorId: cursorId }
    if (range) moveTo(range.from)
    setMode('normal')
  }

  /** Runs `fn` on the selection, and leaves visual mode at its top. */
  function onSelection(fn: (sel: Array<BudgetLine>) => unknown) {
    const sel = selection()
    endVisual()
    fn(sel)
  }

  // ---------- insert mode

  /** Edits an allocation in the month at column `m` (clicked there). */
  function startInsertAt(m: number, index: number) {
    startInsert(index, false, months[m]?.lines ?? lines)
  }

  function startInsert(index: number, clear = false, from = lines) {
    const line = from.at(index)
    if (!line) return
    const why = notEditable(line)
    if (why) return say(why)
    setCursorId(line.id)
    setEdit(
      clear || line.allocated === 0
        ? ''
        : amountInputValue(line.allocated, minorUnits),
    )
    setTarget('allocate')
    setBulk(false)
    setMessage(null)
    setMode('insert')
  }

  function startEdit(index: number, clear = false) {
    if (onName) startRename(index, clear)
    else startInsert(index, clear)
  }

  /** Visual `c` on the allocation column: one amount for every envelope. */
  function startBulk() {
    if (onName) {
      endVisual()
      return say('選取多行時只能一起改分配金額：先按 l 到分配欄')
    }
    const env = envelopesOf(selection())
    if (env.length === 0) {
      endVisual()
      return say('選取的範圍裡沒有預算')
    }
    setEdit('')
    setTarget('allocate')
    setBulk(true)
    setMessage(null)
    setMode('insert')
  }

  /** Saves what is typed; false (and a message) when it is not an amount. */
  function commit(): boolean {
    if (!current) return true
    const amount = evalAmount(edit, minorUnits)
    if (amount === null) {
      say(`「${edit}」不是金額`, 'error')
      return false
    }
    if (bulk) {
      const env = envelopesOf(selection())
      setBulk(false)
      if (range) moveTo(range.from)
      setAllocations(
        env.map((line) => ({ line, amount })),
        `${env.length} 個預算的${monthName}分配都改成 ${formatAmount(amount, minorUnits)}`,
      )
      return true
    }
    setAllocation(current, amount)
    return true
  }

  function cancelInsert() {
    setDraft(null)
    setBulk(false)
    setMode('normal')
  }

  function runInsert(k: Key): boolean {
    if (k === '<C-c>') {
      cancelInsert()
      return true
    }
    if (target === 'new' || target === 'rename') {
      switch (k) {
        case '<CR>':
        case '<Tab>':
        case '<Esc>':
          if (saving) return true
          if (target === 'rename') commitRename()
          else void commitNew(k !== '<Esc>')
          return true
      }
    } else {
      switch (k) {
        case '<CR>':
        case '<Esc>':
          if (commit()) setMode('normal')
          return true
        case '<Tab>':
        case '<S-Tab>': {
          if (bulk) {
            if (commit()) setMode('normal')
            return true
          }
          if (!commit()) return true
          const next = nextEnvelope(row, k === '<Tab>' ? 1 : -1)
          if (next === null) setMode('normal')
          else startInsert(next)
          return true
        }
      }
    }
    // Characters from a mapping are typed into the cell.
    if ([...k].length === 1) {
      setEdit((e) => e + k)
      return true
    }
    return false
  }

  // ---------- commands

  function runCommand(raw: string) {
    const cmd = raw.trim()
    const selected = commandLines.current
    const sel = selected ?? (current ? [current] : [])
    commandLines.current = null
    setMode('normal')
    setCommand('')
    const fund = /^fund\s+(.+)$/.exec(cmd)
    if (fund) {
      if (!current) return
      const why = notEditable(current)
      if (why) return say(why, 'error')
      const amount = evalAmount(fund[1], minorUnits)
      if (amount === null) return say(`「${fund[1]}」不是金額`, 'error')
      setAllocation(current, current.allocated + amount)
    } else if (cmd === 'copylast') {
      void copyLast()
    } else if (cmd === 'fill') {
      fill(selected ?? lines, selected !== null)
    } else if (/^base(\s|$)/.test(cmd)) {
      base(cmd.slice(4).trim())
    } else if (cmd === 'share') {
      toggleShare(sel)
    } else if (cmd === 'archive') {
      toggleArchive(sel)
    } else if (cmd === 'archived') {
      onToggleArchived()
    } else if (/^months?\s+[1-3]$/.test(cmd)) {
      const n = Number(cmd.slice(-1))
      say(onMonthCount(n) ?? `一次顯示 ${n} 個月`)
    } else if (/^months?\b/.test(cmd)) {
      say('一次可以顯示 1 到 3 個月，例如 :months 3', 'error')
    } else if (['w', 'wa', 'wq', 'x', 'up', 'update'].includes(cmd)) {
      say('預算改完就儲存了，不用 :w')
    } else if (/^winc(md)? [hjkl]$/.test(cmd)) {
      const dir = windowDirection(cmd.slice(-1))
      if (dir) movePane(dir, gridRef.current)
    } else if (/^\d+$/.test(cmd)) {
      moveTo(Number(cmd) - 1)
    } else if (cmd) {
      say(`不認得的指令：${cmd}`, 'error')
    }
  }

  function runCommandKey(k: Key): boolean {
    switch (k) {
      case '<CR>':
        runCommand(command)
        return true
      case '<Esc>':
      case '<C-c>':
        commandLines.current = null
        setMode('normal')
        setCommand('')
        return true
      case '<BS>':
        if (command !== '') return false
        commandLines.current = null
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

  // ---------- normal and visual mode

  const busyKeys = new Set([
    'i',
    'a',
    'c',
    's',
    'u',
    ':',
    'o',
    'O',
    'A',
    'p',
    'P',
    'J',
    'K',
    'y',
    'd',
    '>',
    '<',
  ])

  function runNormal(k: Key): boolean {
    const visual = mode === 'visual'
    const p = pending.current
    if (/^[0-9]$/.test(k) && !(k === '0' && p.count === '')) {
      p.count += k
      return true
    }
    const count = Math.max(1, Number(p.count || '1'))
    const done = (fn: () => unknown): true => {
      setMessage((m) => (m?.tone === 'error' ? m : null))
      void fn()
      pending.current = { count: '', op: '' }
      return true
    }
    if (saving && (busyKeys.has(k) || busyKeys.has(p.op))) {
      pending.current = { count: '', op: '' }
      say('儲存中…')
      return true
    }
    const half = Math.max(
      1,
      Math.floor((scrollRef.current?.clientHeight ?? 320) / ROW_HEIGHT / 2),
    )
    /** `count` lines from the cursor down, as `3dd` and `3yy` take. */
    const counted = () => lines.slice(row, row + count)

    if (p.op) {
      const op = p.op + k
      if (op === 'gg') return done(() => moveTo(p.count ? count - 1 : 0))
      if (op === 'gt') return done(() => onMonth(count))
      if (op === 'gT') return done(() => onMonth(-count))
      if (op === 'gv' && !visual) {
        const last = lastVisual.current
        return done(() =>
          last
            ? startVisual(last.anchorId, last.cursorId)
            : say('還沒有選取過'),
        )
      }
      if (!visual) {
        if (op === 'dd') return done(() => deleteLines(counted()))
        if (op === 'yy') return done(() => yankLines(counted()))
        if (op === '>>') return done(() => indent(counted()))
        if (op === '<<') return done(() => outdent(counted()))
      }
      const dir = p.op === '<C-w>' ? windowDirection(k) : null
      if (dir) return done(() => movePane(dir, gridRef.current))
      pending.current = { count: '', op: '' }
      return true
    }

    // Motions, in normal and visual mode alike.
    switch (k) {
      case 'j':
      case '<Down>':
        return done(() => moveTo(row + count))
      case 'k':
      case '<Up>':
        return done(() => moveTo(row - count))
      // Across the name and each month's allocation, as the register's columns.
      case 'h':
      case '<Left>':
        return done(() => setCol(onName ? NAME : at - 1))
      case 'l':
      case '<Right>':
        return done(() =>
          setCol(onName ? 0 : Math.min(at + 1, months.length - 1)),
        )
      case '0':
      case '^':
        return done(() => setCol(NAME))
      case '$':
        return done(() => setCol(months.length - 1))
      case 'G':
        return done(() => moveTo(p.count ? count - 1 : lines.length - 1))
      case '<C-d>':
        return done(() => moveTo(row + half))
      case '<C-u>':
        return done(() => moveTo(row - half))
      case '<PageDown>':
      case '<C-f>':
        return done(() => moveTo(row + half * 2))
      case '<PageUp>':
      case '<C-b>':
        return done(() => moveTo(row - half * 2))
      case 'g':
      case '<C-w>':
        pending.current = { count: p.count, op: k }
        return true
      case '?':
        return done(() => setHelp(true))
    }

    if (visual) {
      switch (k) {
        case '<Esc>':
        case 'V':
        case 'v':
          return done(endVisual)
        case 'o':
        case 'O':
          // To the other end of the selection.
          return done(() => {
            const other = lines.at(anchor)
            if (!other || !current) return
            setAnchorId(current.id)
            setCursorId(other.id)
          })
        case 'y':
          return done(() => onSelection(yankLines))
        case 'd':
        case 'x':
          return done(() => onSelection(deleteLines))
        case 'c':
        case 's':
          return done(startBulk)
        case 'p':
        case 'P':
          return done(() =>
            onSelection((sel) => put(k === 'P', lines.indexOf(sel[0]))),
          )
        case '>':
          return done(() => onSelection(indent))
        case '<':
          return done(() => onSelection(outdent))
        case ':':
          return done(() => {
            commandLines.current = selection()
            endVisual()
            setCommand('')
            setMode('command')
          })
        case 'J':
        case 'K':
          return done(() => say('選取多行時用 > < 或 d 再 p 搬移'))
        default:
          return false
      }
    }

    switch (k) {
      case 'd':
      case 'y':
      case '>':
      case '<':
        pending.current = { count: p.count, op: k }
        return true
      case 'V':
        return done(() => current && startVisual(current.id, current.id))
      case 'i':
      case 'a':
      case '<CR>':
      case '<F2>':
        return done(() => startEdit(row))
      case 'c':
      case 's':
        return done(() => startEdit(row, true))
      case 'o':
        return done(() => openDraft('below'))
      case 'O':
        return done(() => openDraft('above'))
      case 'A':
        return done(() => openDraft('child'))
      case 'p':
        return done(() => put(false))
      case 'P':
        return done(() => put(true))
      case 'J':
        return done(() => swap(current, 1))
      case 'K':
        return done(() => swap(current, -1))
      case 'u':
        return done(undo)
      case '<C-r>':
        return done(redo)
      case ':':
        return done(() => {
          setCommand('')
          setMode('command')
        })
      case '<C-s>':
      case '<D-s>':
        return done(() => say('預算改完就儲存了'))
      case '<Esc>':
        return done(() => setMessage(null))
      default:
        pending.current = { count: '', op: '' }
        return false
    }
  }

  const feed = useKeyFeed(keymap, 'budget', (k) => {
    if (mode === 'insert') return runInsert(k)
    if (mode === 'command') return runCommandKey(k)
    return runNormal(k)
  })

  // ---------- render

  const editor = (label: string, numeric?: 'amount') => (
    <CellEditor
      inputRef={inputRef}
      value={edit}
      label={label}
      numeric={numeric}
      width={0}
      options={[]}
      pick={-1}
      onChange={setEdit}
      onKeyDown={(e) =>
        feed.onInsertKeyDown(e, (n) =>
          setEdit(eraseBeforeCaret(inputRef.current, edit, n)),
        )
      }
      onChoose={() => {}}
    />
  )

  const draftRow = draft && (
    <div
      key="draft"
      role="row"
      className="relative grid border-b border-rule/50 bg-accent/50 text-sm"
      style={{ gridTemplateColumns: columns, height: ROW_HEIGHT }}
    >
      <span
        role="gridcell"
        className="relative"
        style={{ paddingLeft: `${(draft.place.depth - 1) * 1.25}rem` }}
      >
        {editor(
          draft.place.kind === 'expense'
            ? '新的支出類別名稱'
            : '新的收入類別名稱',
        )}
      </span>
      <span
        className="flex items-center px-3 text-xs text-muted-foreground"
        style={{ gridColumn: '2 / -1' }}
      >
        Enter 儲存並新增下一個 · Esc 儲存 · Ctrl-c 放棄
      </span>
    </div>
  )

  const closeMenu = () =>
    requestAnimationFrame(() => {
      const active = document.activeElement
      if (!active || active === document.body)
        gridRef.current?.focus({ preventScroll: true })
    })

  const several = months.length > 1

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={gridRef}
        tabIndex={0}
        role="grid"
        aria-label={`${months.map((m) => monthLabel(m.month)).join('、')}預算`}
        aria-rowcount={lines.length}
        aria-multiselectable
        data-pane="budget"
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
        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-auto"
          style={{ scrollPaddingTop: headHeight }}
        >
          <div className="sticky top-0 z-20 border-b border-rule bg-card text-xs text-muted-foreground">
            {several && (
              <div
                role="row"
                className="grid border-b border-rule/50"
                style={{ gridTemplateColumns: columns, height: ROW_HEIGHT }}
              >
                <span />
                {months.map((m, i) => (
                  <span
                    key={m.month}
                    role="columnheader"
                    className={cn(
                      'flex items-center justify-center border-l border-rule px-2 text-sm',
                      i === at && !onName && 'text-foreground',
                    )}
                    style={{ gridColumn: `span 3` }}
                  >
                    {monthLabel(m.month)}
                  </span>
                ))}
              </div>
            )}
            <div
              role="row"
              className="grid"
              style={{ gridTemplateColumns: columns, height: ROW_HEIGHT }}
            >
              <span role="columnheader" className="flex items-center px-3">
                類別
              </span>
              {months.map((m) => (
                <MonthHeads key={m.month} short={several} />
              ))}
            </div>
          </div>

          {lines.map((line, i) => {
            const editing = i === row && mode === 'insert' && !draft
            const empty =
              line.kind === 'section' &&
              lines.at(i + 1)?.section !== line.section &&
              draftAt !== i + 1
            return (
              <div key={line.id} className="contents">
                {i === draftAt && draftRow}
                <LineView
                  cells={months.map((m) => m.lines[i] ?? line)}
                  index={i}
                  columns={columns}
                  active={i === row && !draft}
                  selected={!!range && i >= range.from && i <= range.to}
                  col={col}
                  editing={editing ? target : null}
                  minorUnits={minorUnits}
                  onPick={(column, enter, extend) => {
                    if (mode === 'insert') {
                      // Clicking away saves what was typed, as Esc does.
                      if (target === 'new') return void commitNew(false)
                      if (target === 'allocate' && !commit()) return
                      if (target === 'rename') commitRename()
                    }
                    setCol(column)
                    if (extend && current) {
                      // Shift-click selects from the cursor, as in the register.
                      if (mode !== 'visual') setAnchorId(current.id)
                      setCursorId(line.id)
                      setMode('visual')
                      return
                    }
                    setMode('normal')
                    setCursorId(line.id)
                    if (enter) {
                      if (column < 0) startRename(i)
                      // The lines of the month clicked, not the cursor's.
                      else startInsertAt(column, i)
                    } else gridRef.current?.focus({ preventScroll: true })
                  }}
                  menu={
                    canManage && !line.category?.isSystem ? (
                      <LineMenu
                        line={line}
                        onAction={(a) => act(a, i)}
                        onClose={closeMenu}
                      />
                    ) : null
                  }
                  editor={editor(
                    editing && target === 'rename'
                      ? `${line.path} 名稱`
                      : bulk
                        ? `選取的預算${monthLabel(month)}分配`
                        : `${line.path} ${monthLabel(month)}分配`,
                    editing && target === 'rename' ? undefined : 'amount',
                  )}
                />
                {empty && (
                  <p
                    className="flex items-center border-b border-rule/50 px-3 text-sm text-muted-foreground"
                    style={{ height: ROW_HEIGHT }}
                  >
                    還沒有{line.name}類別：按 o 新增
                  </p>
                )}
              </div>
            )
          })}
          {draftAt === lines.length && draftRow}
        </div>
      </div>

      <KeyHelp
        open={help}
        onClose={() => setHelp(false)}
        keymap={keymap}
        groups={budgetKeys}
      />

      {/* The command line, under the buffer like Vim's. */}
      <div className="flex h-8 shrink-0 items-center font-mono text-sm">
        {mode === 'command' ? (
          <label className="flex w-full items-center">
            <span className="text-kraft">
              :{commandLines.current ? "'<,'>" : ''}
            </span>
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
        ) : message ? (
          <span
            role={message.tone === 'error' ? 'alert' : 'status'}
            className={cn(
              'truncate',
              message.tone === 'error'
                ? 'text-destructive'
                : 'text-muted-foreground',
            )}
          >
            {message.text}
          </span>
        ) : range ? (
          <span className="truncate text-muted-foreground">
            -- 選取 {range.to - range.from + 1} 行 --（
            {onName
              ? 'y d > < 作用在類別'
              : `y d c 作用在${monthLabel(month)}的分配`}
            ）
          </span>
        ) : current && targetText(current) ? (
          <span className="truncate text-muted-foreground">
            {targetText(current)}
          </span>
        ) : (
          <span className="truncate text-muted-foreground">
            jk 移動 · hl 換欄 · i 分配或改名 · V 選取 · yy dd p · ? 快捷鍵
          </span>
        )}
      </div>
    </div>
  )
}

/** The three column heads of one month. */
function MonthHeads({ short }: { short: boolean }) {
  return (
    <>
      <span
        role="columnheader"
        className="flex items-center justify-end border-l border-rule px-2"
      >
        {short ? '分配' : '本月分配'}
      </span>
      <span role="columnheader" className="flex items-center justify-end px-2">
        {short ? '花費' : '本月花費'}
      </span>
      <span role="columnheader" className="flex items-center justify-end px-3">
        餘額
      </span>
    </>
  )
}

function LineView({
  cells,
  index,
  columns,
  active,
  selected,
  col,
  editing,
  minorUnits,
  onPick,
  menu,
  editor,
}: {
  /** The line in each month shown (same category, that month's numbers). */
  cells: Array<BudgetLine>
  index: number
  columns: string
  active: boolean
  selected: boolean
  col: Column
  /** What is being typed in this line, if anything (in the cursor's column). */
  editing: Target | null
  minorUnits: number
  /** Clicked in a column: `enter` to edit it, `extend` (Shift) to select. */
  onPick: (col: Column, enter: boolean, extend: boolean) => void
  menu: React.ReactNode
  editor: React.ReactNode
}) {
  const line = cells[0]
  const section = line.kind === 'section'
  const group = line.kind === 'group'
  const member = line.kind === 'member'
  const income = line.kind === 'income'
  const envelope = line.kind === 'envelope'
  const c = line.category
  const shareable = !!c && line.hasChildren && line.section === 'expense'
  const incomeHead = section && line.section === 'income'
  const cursor = (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-0 border-2 border-kraft/40 group-focus:border-kraft"
    />
  )
  // Shown on the cursor's line and under the mouse only.
  const onHover = cn(
    'relative z-10 shrink-0 opacity-0 group-hover/line:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100',
    active && 'opacity-100',
  )
  return (
    <div
      role="row"
      data-line={index}
      aria-selected={selected || active}
      onMouseDown={(e) => {
        e.preventDefault()
        onPick(col, false, e.shiftKey)
      }}
      className={cn(
        'group/line relative grid border-b border-rule/50 text-sm',
        active && 'bg-accent/50',
        (group || section) && 'font-medium',
        section && !active && 'bg-muted/40',
      )}
      style={{ gridTemplateColumns: columns, height: ROW_HEIGHT }}
    >
      {selected && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 border-l-2 border-kraft bg-kraft/15"
        />
      )}
      <span
        role="gridcell"
        className={cn(
          'relative flex min-w-0 items-center gap-2 px-3',
          (member || c?.isSystem) && 'text-muted-foreground',
        )}
        style={{
          paddingLeft: `${0.75 + Math.max(0, line.depth - 1) * 1.25}rem`,
        }}
        onMouseDown={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onPick(NAME, false, e.shiftKey)
        }}
        onDoubleClick={() => onPick(NAME, true, false)}
      >
        {active && col < 0 && editing === null && cursor}
        {editing === 'rename' ? (
          <span className="absolute inset-x-0 top-0 z-30">{editor}</span>
        ) : (
          <>
            <span className="truncate">{line.name}</span>
            {line.archived && (
              <span className="shrink-0 text-xs text-muted-foreground">
                已封存
              </span>
            )}
            {/* Only the shared case is marked; a parent budgeting separately
                reads as a group line with its subcategories' sums. */}
            {shareable && c.pooled && (
              <span className="shrink-0 text-xs font-normal text-muted-foreground">
                共用預算
              </span>
            )}
            {menu && <span className={cn('ml-auto', onHover)}>{menu}</span>}
          </>
        )}
      </span>
      {cells.map((cell, m) => (
        <MonthCells
          key={m}
          cell={cell}
          minorUnits={minorUnits}
          cursor={active && col === m && editing === null && envelope}
          cursorMark={cursor}
          editor={editing === 'allocate' && col === m ? editor : null}
          kind={{ section, member, income, envelope, incomeHead }}
          onPick={(enter, extend) => onPick(m, enter, extend)}
        />
      ))}
    </div>
  )
}

/** One month's allocation, spending and balance of a line. */
function MonthCells({
  cell,
  minorUnits,
  cursor,
  cursorMark,
  editor,
  kind,
  onPick,
}: {
  cell: BudgetLine
  minorUnits: number
  cursor: boolean
  cursorMark: React.ReactNode
  editor: React.ReactNode
  kind: {
    section: boolean
    member: boolean
    income: boolean
    envelope: boolean
    incomeHead: boolean
  }
  onPick: (enter: boolean, extend: boolean) => void
}) {
  const { member, income, envelope, incomeHead } = kind
  return (
    <>
      <span
        role="gridcell"
        className="relative flex items-center justify-end border-l border-rule/60 px-2"
        onMouseDown={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onPick(envelope && !e.shiftKey, e.shiftKey)
        }}
      >
        {cursor && cursorMark}
        {editor ? (
          <span className="absolute inset-x-0 top-0 z-30">{editor}</span>
        ) : member || income || incomeHead ? null : (
          <span
            className="flex items-center gap-1.5"
            title={
              cell.target
                ? `目標 ${formatAmount(cell.target.total, minorUnits)}`
                : undefined
            }
          >
            {offTarget(cell) && (
              <span
                aria-label="和目標不同"
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  cell.allocated < (cell.target?.total ?? 0)
                    ? 'bg-kraft'
                    : 'bg-muted-foreground',
                )}
              />
            )}
            <Amount
              value={cell.allocated}
              minorUnits={minorUnits}
              className={cn(cell.allocated === 0 && 'text-muted-foreground')}
            />
          </span>
        )}
      </span>
      <span
        role="gridcell"
        className={cn(
          'flex items-center justify-end px-2',
          member && 'text-muted-foreground',
        )}
      >
        {incomeHead ? (
          <span className="text-xs font-normal text-muted-foreground">
            收入
          </span>
        ) : (
          // A subcategory with nothing spent stays quiet.
          !((member || income) && cell.activity === 0) && (
            <Amount
              value={cell.activity}
              minorUnits={minorUnits}
              className={cn(
                cell.activity === 0 && 'text-muted-foreground',
                income && cell.activity > 0 && 'text-positive',
              )}
            />
          )
        )}
      </span>
      <span role="gridcell" className="flex items-center justify-end px-3">
        {incomeHead ? (
          <Amount
            value={cell.activity}
            minorUnits={minorUnits}
            className="font-normal text-positive"
          />
        ) : (
          !member &&
          !income && (
            <Amount
              value={cell.balance}
              minorUnits={minorUnits}
              className={cn(
                cell.balance > 0 && 'text-positive',
                cell.balance === 0 && 'text-muted-foreground',
              )}
            />
          )
        )}
      </span>
    </>
  )
}

/** The mouse's way to the same changes the keys make. */
function LineMenu({
  line,
  onAction,
  onClose,
}: {
  line: BudgetLine
  onAction: (action: LineAction) => void
  onClose: () => void
}) {
  const c = line.category
  const item = (action: LineAction, label: string, keys?: string) => (
    <DropdownMenuItem onSelect={() => onAction(action)}>
      {label}
      {keys && <DropdownMenuShortcut>{keys}</DropdownMenuShortcut>}
    </DropdownMenuItem>
  )
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`${line.name} 的動作`}
          className="flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <EllipsisIcon className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-52 font-normal"
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          onClose()
        }}
      >
        {!c ? (
          item('child', `新增${line.name}類別`, 'A')
        ) : (
          <>
            {item('below', '在下面新增類別', 'o')}
            {line.depth < 3 && item('child', '新增子類別', 'A')}
            {item('rename', '改名', 'i')}
            {line.kind === 'envelope' &&
              item('base', '設定每月基本額…', ':base')}
            <DropdownMenuSeparator />
            {item('up', '上移', 'K')}
            {item('down', '下移', 'J')}
            {item('indent', '放進上面的類別', '>>')}
            {c.parentId && item('outdent', '移出一層', '<<')}
            {c.kind === 'expense' && line.hasChildren && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuCheckboxItem
                  checked={c.pooled}
                  onCheckedChange={() => onAction('share')}
                >
                  子類別共用預算
                </DropdownMenuCheckboxItem>
              </>
            )}
            <DropdownMenuSeparator />
            {item('archive', c.archived ? '取消封存' : '封存')}
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => onAction('delete')}
            >
              刪除
              <DropdownMenuShortcut>dd</DropdownMenuShortcut>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
