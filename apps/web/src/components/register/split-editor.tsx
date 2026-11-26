import { ArrowRightLeftIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { formatAmount } from '#/lib/money'
import { movePane, windowDirection } from '#/lib/panes'
import {
  amountCellText,
  evalAmount,
  findCategory,
  formatDate,
  lineCategoryMode,
  rankCell,
  splitLinesOf,
} from '#/lib/register'
import { cn } from '#/lib/utils'
import { CellEditor, eraseBeforeCaret, nextPick } from './cell-editor'
import { useKeyFeed } from './use-key-feed'
import type { Key, Keymap } from '#/lib/keymap'
import type { Context, Row, SplitLine } from '#/lib/register'
import type { Suggestion } from './cell-editor'

// The split editor (ADR-068): a small window under the register, like
// Vim's `:split`, with one line per part of the transaction.

type SplitColumn = 'transfer' | 'category' | 'memo' | 'outflow' | 'inflow'

const splitColumns: Array<SplitColumn> = [
  'transfer',
  'category',
  'memo',
  'outflow',
  'inflow',
]
const widths: Record<SplitColumn, number> = {
  transfer: 168,
  category: 220,
  memo: 260,
  outflow: 112,
  inflow: 112,
}
const labels: Record<SplitColumn, string> = {
  transfer: '轉帳帳戶',
  category: '類別',
  memo: '備註',
  outflow: '支出',
  inflow: '收入',
}
const LINE_HEIGHT = 32
const GUTTER = 28
/** How the text columns share room wider than they need. */
const stretch: Partial<Record<SplitColumn, number>> = {
  transfer: 3,
  category: 4,
  memo: 5,
}
const template = `${GUTTER}px ${splitColumns
  .map((c) => {
    const share = stretch[c]
    return share ? `minmax(${widths[c]}px, ${share}fr)` : `${widths[c]}px`
  })
  .join(' ')}`
const TOTAL_WIDTH = GUTTER + splitColumns.reduce((s, c) => s + widths[c], 0)

type Mode = 'normal' | 'insert'

interface Message {
  text: string
  tone: 'info' | 'error'
}

export function SplitEditor({
  row,
  ctx,
  keymap,
  onClose,
  onMode,
  onHelp,
}: {
  row: Row
  ctx: Context
  keymap: Keymap
  /** Closes the window with its lines; `then` are keys for the register (`<C-s>` saves). */
  onClose: (lines: Array<SplitLine>, then: Array<Key>) => void
  onMode: (mode: Mode) => void
  /** Shows the key reference (`?`). */
  onHelp: () => void
}) {
  const converting = !row.splits
  const original = row.amount
  const [lines, setLines] = useState(() =>
    splitLinesOf(row, () => crypto.randomUUID()),
  )
  const [cursor, setCursor] = useState(() => ({
    line: 0,
    col: splitColumns.indexOf(
      converting ? (row.amount > 0 ? 'inflow' : 'outflow') : 'category',
    ),
  }))
  const [mode, setMode] = useState<Mode>('normal')
  const [edit, setEdit] = useState('')
  const [pick, setPick] = useState(0)
  const [navigated, setNavigated] = useState(false)
  const [message, setMessage] = useState<Message | null>(
    converting
      ? {
          text: '先改這一行的金額，再按 o 新增一行（會帶入剩下的金額）',
          tone: 'info',
        }
      : null,
  )
  const history = useRef<{
    undo: Array<Array<SplitLine>>
    redo: Array<Array<SplitLine>>
  }>({ undo: [], redo: [] })
  const pending = useRef('')
  const boxRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLElement>(null)

  const current = lines.at(cursor.line)
  const column = splitColumns[cursor.col]
  const total = lines.reduce((sum, l) => sum + l.amount, 0)
  const today = new Date()

  useEffect(() => {
    onMode(mode)
  }, [mode, onMode])
  useEffect(() => {
    if (mode === 'normal') boxRef.current?.focus({ preventScroll: true })
  }, [mode])

  function say(text: string, tone: Message['tone'] = 'info') {
    setMessage({ text, tone })
  }

  function change(next: Array<SplitLine>) {
    history.current.undo.push(lines)
    history.current.redo = []
    setLines(next)
  }

  function moveTo(line: number, col: number) {
    setCursor({
      line: Math.max(0, Math.min(line, lines.length - 1)),
      col: Math.max(0, Math.min(col, splitColumns.length - 1)),
    })
  }

  function accountName(id: string | null): string {
    return id ? (ctx.accounts.get(id)?.name ?? '') : ''
  }

  function cellText(line: SplitLine, col: SplitColumn): string {
    switch (col) {
      case 'transfer':
        return accountName(line.transferTo)
      case 'category':
        return line.categoryId
          ? (ctx.categories.get(line.categoryId)?.path ?? '')
          : ''
      case 'memo':
        return line.memo
      case 'outflow':
      case 'inflow':
        return amountCellText(line.amount, col, ctx.minorUnits)
    }
  }

  function editable(line: SplitLine, col: SplitColumn): string | null {
    if (
      col === 'category' &&
      lineCategoryMode(row.accountId, line.transferTo, ctx) === 'none'
    ) {
      return '這一行是預算內帳戶之間的轉帳，不需要類別'
    }
    return null
  }

  function startInsert(clear = false, at = cursor) {
    const line = lines.at(at.line)
    if (!line) return say('沒有拆分行，按 o 新增一行')
    const col = splitColumns[at.col]
    const reason = editable(line, col)
    if (reason) return say(reason, 'error')
    setEdit(clear ? '' : cellText(line, col))
    setPick(0)
    setNavigated(false)
    setMessage(null)
    setMode('insert')
  }

  function addLine(at: number) {
    const line: SplitLine = {
      id: crypto.randomUUID(),
      transferTo: null,
      categoryId: null,
      memo: '',
      // What is left of the amount the transaction had when the window opened.
      amount: original - total,
      counterCleared: 'uncleared',
    }
    const index = Math.max(0, Math.min(at, lines.length))
    change(lines.toSpliced(index, 0, line))
    setCursor({ line: index, col: splitColumns.indexOf('category') })
    setEdit('')
    setPick(0)
    setNavigated(false)
    setMessage(null)
    setMode('insert')
  }

  function deleteLine(index: number) {
    if (!lines.at(index)) return
    const next = lines.toSpliced(index, 1)
    change(next)
    setCursor((c) => ({
      ...c,
      line: Math.max(0, Math.min(c.line, next.length - 1)),
    }))
  }

  function undo() {
    const prev = history.current.undo.pop()
    if (!prev) return say('已經是最早的狀態')
    history.current.redo.push(lines)
    setLines(prev)
  }

  function redo() {
    const next = history.current.redo.pop()
    if (!next) return say('已經是最新的狀態')
    history.current.undo.push(lines)
    setLines(next)
  }

  function suggestions(): Array<Suggestion> {
    if (mode !== 'insert') return []
    // The cell's own text, while nothing has been typed over it: every
    // option is offered, that one first.
    const own = current ? cellText(current, column) : null
    if (column === 'transfer') {
      const accounts = [...ctx.accounts.values()]
        .filter((a) => a.id !== row.accountId && !a.closed)
        .map((a) => ({
          value: a.name,
          label: a.name,
          hint: a.onBudget ? '預算內' : '預算外',
        }))
      return rankCell(
        accounts,
        edit.replace(/^@/, ''),
        own?.replace(/^@/, '') ?? null,
        (s) => s.value,
      )
    }
    if (column === 'category') {
      const usable = [...ctx.categories.values()].filter(
        (c) => !c.isSystem && !c.archived,
      )
      return rankCell(usable, edit, own, (c) => c.path).map((c) => ({
        value: c.path,
        label: c.path,
        hint: c.kind === 'income' ? '收入' : undefined,
      }))
    }
    return []
  }

  function chosenText(): string {
    const options = suggestions()
    if (options.length === 0) return edit
    const highlighted = options[Math.min(pick, options.length - 1)].value
    // Picked with Ctrl-n/Ctrl-p or the arrows, even before anything is typed.
    if (navigated) return highlighted
    if (edit === '') return edit
    if (column === 'category') {
      return findCategory(edit, ctx.categories.values()) ? edit : highlighted
    }
    if (column === 'transfer') {
      const name = edit.replace(/^@/, '').trim()
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
    return options.findIndex((o) => o.value === value.replace(/^@/, ''))
  }

  /** Applies the cell editor's text; null (with a message) when it is not valid. */
  function commitCell(text: string): SplitLine | null {
    if (!current) return null
    const value = text.trim()
    const patch: Partial<SplitLine> = {}
    switch (column) {
      case 'transfer': {
        const name = value.replace(/^@/, '').trim()
        if (!name) {
          patch.transferTo = null
        } else {
          const account = [...ctx.accounts.values()].find(
            (a) => a.name === name,
          )
          if (!account) {
            say(`找不到帳戶「${name}」`, 'error')
            return null
          }
          if (account.id === row.accountId) {
            say('不能轉帳給同一個帳戶', 'error')
            return null
          }
          patch.transferTo = account.id
        }
        if (patch.transferTo !== current.transferTo) {
          patch.counterCleared = 'uncleared'
        }
        if (
          lineCategoryMode(row.accountId, patch.transferTo ?? null, ctx) ===
          'none'
        ) {
          patch.categoryId = null
        }
        break
      }
      case 'category': {
        if (!value) {
          patch.categoryId = null
          break
        }
        const found = findCategory(value, ctx.categories.values())
        if (!found) {
          say(`找不到類別「${value}」：請從清單選，或輸入完整路徑`, 'error')
          return null
        }
        patch.categoryId = found.id
        break
      }
      case 'memo':
        patch.memo = value
        break
      case 'outflow':
      case 'inflow': {
        const amount = evalAmount(value, ctx.minorUnits)
        if (amount === null) {
          say('金額格式不對：可以輸入 1280、1,280 或 120*3', 'error')
          return null
        }
        if (amount !== 0) {
          patch.amount = column === 'outflow' ? -amount : amount
        } else if (
          (column === 'outflow' && current.amount < 0) ||
          (column === 'inflow' && current.amount > 0)
        ) {
          patch.amount = 0
        }
        break
      }
    }
    const next = { ...current, ...patch }
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      change(lines.with(cursor.line, next))
    }
    setMessage(null)
    return next
  }

  function finishCell(move: 'stay' | 'next' | 'prev') {
    const line = commitCell(chosenText())
    if (!line) return
    if (move === 'stay') {
      setMode('normal')
      return
    }
    let col = cursor.col
    for (;;) {
      col += move === 'next' ? 1 : -1
      if (col < 0 || col >= splitColumns.length) {
        setMode('normal')
        return
      }
      if (!editable(line, splitColumns[col])) break
    }
    setCursor((c) => ({ ...c, col }))
    setEdit(cellText(line, splitColumns[col]))
    setPick(0)
    setNavigated(false)
  }

  function close(then: Array<Key> = []) {
    onClose(lines, then)
  }

  // ---------- keys

  function runNormal(key: Key): boolean {
    const op = pending.current
    pending.current = ''
    if (op) {
      const dir = op === '<C-w>' ? windowDirection(key) : null
      if (dir) movePane(dir, boxRef.current)
      else if (op + key === 'dd') deleteLine(cursor.line)
      else if (op + key === 'gg') moveTo(0, cursor.col)
      return true
    }
    switch (key) {
      case 'j':
      case '<Down>':
        moveTo(cursor.line + 1, cursor.col)
        return true
      case 'k':
      case '<Up>':
        moveTo(cursor.line - 1, cursor.col)
        return true
      case 'l':
      case 'w':
      case '<Right>':
      case '<Tab>':
        moveTo(cursor.line, cursor.col + 1)
        return true
      case 'h':
      case 'b':
      case '<Left>':
      case '<S-Tab>':
        moveTo(cursor.line, cursor.col - 1)
        return true
      case '0':
      case '^':
      case '<Home>':
        moveTo(cursor.line, 0)
        return true
      case '$':
      case '<End>':
        moveTo(cursor.line, splitColumns.length - 1)
        return true
      case 'G':
        moveTo(lines.length - 1, cursor.col)
        return true
      case 'd':
      case 'g':
      case '<C-w>':
        pending.current = key
        return true
      case 'i':
      case 'a':
      case '<CR>':
      case '<F2>':
        startInsert()
        return true
      case 'c':
      case 's':
        startInsert(true)
        return true
      case 'o':
        addLine(lines.length === 0 ? 0 : cursor.line + 1)
        return true
      case 'O':
        addLine(cursor.line)
        return true
      case 'u':
        undo()
        return true
      case '<C-r>':
        redo()
        return true
      case 'q':
      case '<Esc>':
        close()
        return true
      case '<C-s>':
        close(['<C-s>'])
        return true
      case '?':
        onHelp()
        return true
      default:
        return false
    }
  }

  function runInsert(key: Key): boolean {
    const options = suggestions()
    switch (key) {
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
        // Esc keeps what was typed, or the suggestion picked with the keys.
        if (commitCell(navigated ? chosenText() : edit)) setMode('normal')
        return true
      case '<C-c>':
        setMode('normal')
        say('已取消編輯')
        return true
      case '<C-s>': {
        const line = commitCell(edit)
        if (line) onClose(lines.with(cursor.line, line), ['<C-s>'])
        return true
      }
      default:
        if ([...key].length === 1) {
          setEdit((e) => e + key)
          setPick(0)
          setNavigated(false)
          return true
        }
        return false
    }
  }

  const feed = useKeyFeed(keymap, 'split', (key) =>
    mode === 'normal' ? runNormal(key) : runInsert(key),
  )

  // ---------- render

  const options = suggestions()
  const inserting = mode === 'insert'
  const heading = row.transferTo
    ? `@${accountName(row.transferTo)}`
    : row.payee || '（無收付款對象）'

  return (
    <section
      aria-label="拆分"
      className="mt-2 shrink-0 rounded-md border border-kraft/60 bg-card"
    >
      <header className="flex items-baseline justify-between gap-4 border-b border-rule px-3 py-1.5 text-sm">
        <span className="min-w-0 truncate">
          <span className="font-semibold">拆分</span>
          <span className="ml-2 font-mono text-muted-foreground">
            {formatDate(row.date, today)}
          </span>
          <span className="ml-2">{heading}</span>
        </span>
        <span className="shrink-0 font-mono text-xs text-muted-foreground">
          o 新增一行 · dd 刪除 · q 完成 · ? 快捷鍵
        </span>
      </header>
      <div
        ref={boxRef}
        data-pane="split"
        data-editor
        tabIndex={0}
        role="grid"
        aria-label="拆分行"
        onKeyDown={mode === 'normal' ? feed.onNormalKeyDown : undefined}
        className="max-h-56 overflow-auto outline-none"
      >
        <div style={{ minWidth: TOTAL_WIDTH }}>
          <div
            role="row"
            className="grid border-b border-rule text-xs text-muted-foreground"
            style={{ gridTemplateColumns: template, height: LINE_HEIGHT }}
          >
            <span />
            {splitColumns.map((c) => (
              <span
                key={c}
                role="columnheader"
                className={cn(
                  'flex items-center px-2',
                  (c === 'outflow' || c === 'inflow') && 'justify-end',
                )}
              >
                {labels[c]}
              </span>
            ))}
          </div>
          {lines.length === 0 && (
            <p className="px-4 py-2 text-sm text-muted-foreground">
              沒有拆分行。按 <kbd className="font-mono text-foreground">o</kbd>{' '}
              新增一行。
            </p>
          )}
          {lines.map((line, i) => {
            const categoryMode = lineCategoryMode(
              row.accountId,
              line.transferTo,
              ctx,
            )
            return (
              <div
                key={line.id}
                role="row"
                className={cn(
                  'grid border-b border-rule/60 text-sm leading-normal',
                  i === cursor.line && 'bg-accent/50',
                )}
                style={{ gridTemplateColumns: template, height: LINE_HEIGHT }}
              >
                <span className="flex items-center justify-center font-mono text-xs text-muted-foreground">
                  {i + 1}
                </span>
                {splitColumns.map((c, col) => {
                  const here = i === cursor.line && col === cursor.col
                  const text =
                    c === 'category' && categoryMode === 'none'
                      ? '—'
                      : c === 'outflow'
                        ? line.amount < 0
                          ? formatAmount(-line.amount, ctx.minorUnits)
                          : ''
                        : c === 'inflow'
                          ? line.amount > 0
                            ? formatAmount(line.amount, ctx.minorUnits)
                            : ''
                          : cellText(line, c)
                  return (
                    <span
                      key={c}
                      role="gridcell"
                      onMouseDown={(e) => {
                        // Clicks in the cell editor itself are its own.
                        const target = e.target as HTMLElement
                        if (target.closest('input, [role=listbox]')) return
                        e.preventDefault()
                        if (inserting && !commitCell(edit)) return
                        setMode('normal')
                        setCursor({ line: i, col })
                        if (e.detail === 2) startInsert(false, { line: i, col })
                      }}
                      className={cn(
                        'relative flex items-center overflow-hidden px-2 whitespace-nowrap',
                        (c === 'outflow' || c === 'inflow') &&
                          'amount justify-end',
                        c === 'category' &&
                          categoryMode === 'none' &&
                          'text-muted-foreground',
                        here &&
                          !inserting &&
                          'outline-2 -outline-offset-2 outline-kraft',
                      )}
                    >
                      {c === 'transfer' && line.transferTo && (
                        <ArrowRightLeftIcon className="mr-1.5 size-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <span className="truncate">{text}</span>
                      {here && inserting && (
                        <span className="absolute top-0 left-0 z-30 w-full">
                          <CellEditor
                            inputRef={inputRef}
                            value={edit}
                            label={labels[c]}
                            numeric={
                              c === 'outflow' || c === 'inflow'
                                ? 'amount'
                                : undefined
                            }
                            width={widths[c]}
                            options={options}
                            pick={takenIndex(options)}
                            onChange={(v) => {
                              setEdit(v)
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
                            onChoose={(index) => {
                              setEdit(options[index].value)
                              setPick(index)
                              setNavigated(true)
                            }}
                          />
                        </span>
                      )}
                    </span>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 border-t border-rule px-3 py-1.5 text-sm">
        <span
          role={message?.tone === 'error' ? 'alert' : 'status'}
          className={cn(
            'min-w-0 truncate',
            message?.tone === 'error'
              ? 'text-destructive'
              : 'text-muted-foreground',
          )}
        >
          {message?.text ?? ''}
        </span>
        <span className="flex shrink-0 gap-4 font-mono text-xs">
          <span>
            合計{' '}
            <span className="amount">
              {formatAmount(total, ctx.minorUnits)}
            </span>
          </span>
          {total !== original && (
            <span className="text-kraft">
              {original - total < 0 ? '還有支出' : '還有收入'}{' '}
              {formatAmount(Math.abs(original - total), ctx.minorUnits)}{' '}
              沒分（開啟時 {formatAmount(original, ctx.minorUnits)}；o
              新增一行會帶入）
            </span>
          )}
        </span>
      </footer>
    </section>
  )
}
