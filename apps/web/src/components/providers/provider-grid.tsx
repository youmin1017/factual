import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  LockIcon,
  XIcon,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '#/lib/api'
import { errorCodeMessage } from '#/lib/apiError'
import { setEditorStatus } from '#/lib/editorStatus'
import {
  draftRows,
  dropScope,
  isSetting,
  kindLabels,
  lockedReason,
  newProviderRow,
  problemField,
  providerCellText,
  providerColumns,
  providerLabels,
  providerPatch,
  providerProblemMessages,
  providerRows,
  providerStatus,
  scopeLocked,
  scopeOptions,
  settingKeys,
  settingLabel,
  settingPatch,
  settingPlaceholder,
  settingText,
  startScopes,
  templateOf,
  templates,
  toBatch,
  validateProvider,
} from '#/lib/oidc-providers'
import { movePane, windowDirection } from '#/lib/panes'
import { rankCell } from '#/lib/register'
import { cn } from '#/lib/utils'
import { BrandIcon, useIconSlugs } from '../brand-icon'
import { CellEditor, eraseBeforeCaret, nextPick } from '../register/cell-editor'
import { KeyHelp, providerKeys } from '../register/key-help'
import { useKeyFeed } from '../register/use-key-feed'
import type { Key, Keymap } from '#/lib/keymap'
import type {
  Provider,
  ProviderColumn,
  ProviderProblem,
  ProviderRow,
  ProviderStatus,
  SettingKey,
} from '#/lib/oidc-providers'
import type { Suggestion } from '../register/cell-editor'

// The identity providers page (ADR-126): a grid edited as the accounts page
// is (ADR-108), whose line order is the order of the login buttons; saved
// with :w through the batch endpoint, drafts kept locally without secrets
// (ADR-043). A new line starts from a template (ADR-125); the address,
// secret, scopes and remark are lines under the provider's line (ADR-110),
// scopes picked as chips (ADR-120).

const ROW_HEIGHT = 32
const GUTTER = 28
const widths: Record<ProviderColumn, number> = {
  kind: 112,
  name: 200,
  code: 140,
  icon: 180,
  enabled: 56,
}
// The icon column takes the room left, keeping 名稱, 類型 and ID together.
const stretch: Partial<Record<ProviderColumn, number>> = { icon: 1 }

interface Layout {
  lefts: Record<ProviderColumn, number>
  widths: Record<ProviderColumn, number>
  template: string
  width: number
}

function layoutOf(room: number): Layout {
  const least = providerColumns.reduce((sum, c) => sum + widths[c], GUTTER)
  const extra = Math.max(0, room - least)
  const lefts = {} as Record<ProviderColumn, number>
  const sized = {} as Record<ProviderColumn, number>
  let x = GUTTER
  for (const c of providerColumns) {
    sized[c] = widths[c] + Math.floor(extra * (stretch[c] ?? 0))
    lefts[c] = x
    x += sized[c]
  }
  return {
    lefts,
    widths: sized,
    template: `${GUTTER}px ${providerColumns.map((c) => `${sized[c]}px`).join(' ')}`,
    width: x,
  }
}

/** Where a setting's label and value sit on its line. */
const SETTING_INDENT = GUTTER + 24
const SETTING_LABEL = 120

type Mode = 'normal' | 'visual' | 'insert' | 'command'

interface Message {
  text: string
  tone: 'info' | 'error'
}

interface Range {
  from: number
  to: number
}

/** A line's state: its content, or only its place in the order. */
type LineState = ProviderStatus | 'moved'

const DRAFT_KEY = 'factual:oidc-providers'
const DRAFT_VERSION = 1

interface Draft {
  version: number
  rows: Array<ProviderRow>
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

function writeDraft(rows: Array<ProviderRow> | null): void {
  try {
    if (!rows) localStorage.removeItem(DRAFT_KEY)
    else
      localStorage.setItem(
        DRAFT_KEY,
        // Secrets never go to localStorage.
        JSON.stringify({
          version: DRAFT_VERSION,
          rows: draftRows(rows),
        } satisfies Draft),
      )
  } catch {
    // Drafts are a convenience (ADR-043).
  }
}

/** The saved lines with a draft's changes and order on top. */
function initialRows(
  providers: Array<Provider>,
  draft: Draft | null,
): Array<ProviderRow> {
  const saved = providerRows(providers)
  if (!draft) return saved
  const fresh = new Map(saved.map((r) => [r.id, r]))
  const out: Array<ProviderRow> = []
  for (const d of draft.rows) {
    if (!d.base) out.push(d)
    else {
      const now = fresh.get(d.id)
      if (!now) continue
      out.push({ ...d, base: now.base })
      fresh.delete(d.id)
    }
  }
  return [...out, ...fresh.values()]
}

interface Props {
  providers: Array<Provider>
  keymap: Keymap
  /** Fetches the providers again (after :w). */
  reload: () => Promise<Array<Provider>>
}

export function ProviderGrid({ providers, keymap, reload }: Props) {
  const iconSlugs = useIconSlugs()
  const [room, setRoom] = useState(0)
  const layout = layoutOf(room)
  const columns = providerColumns
  const [loaded, setLoaded] = useState(providers)
  const [rows, setRows] = useState<Array<ProviderRow>>(() =>
    initialRows(providers, readDraft()),
  )
  const [cursor, setCursor] = useState({ row: 0, col: 0 })
  /** The cursor on a setting under the cursor's line (its index), or null. */
  const [sub, setSub] = useState<number | null>(null)
  /** Whether insert mode edits a setting (not a cell of the line). */
  const [subEdit, setSubEdit] = useState(false)
  const [mode, setMode] = useState<Mode>('normal')
  const [edit, setEdit] = useState('')
  const [pick, setPick] = useState(0)
  const [navigated, setNavigated] = useState(false)
  const [command, setCommand] = useState('')
  const [message, setMessage] = useState<Message | null>(() =>
    readDraft()
      ? {
          text: '已還原上次未儲存的變更（輸入過的 Client Secret 不會保留，要再輸入一次）',
          tone: 'info',
        }
      : null,
  )
  const [problems, setProblems] = useState<Map<string, ProviderProblem>>(
    new Map(),
  )
  const [saving, setSaving] = useState(false)
  const [anchor, setAnchor] = useState(0)
  const [help, setHelp] = useState(false)
  /** Lines whose settings are shown under them. */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  /** The scopes picker, while a line's Scopes are edited. */
  const [picker, setPicker] = useState<Array<string> | null>(null)

  const gridRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLElement>(null)
  const history = useRef<{
    undo: Array<Array<ProviderRow>>
    redo: Array<Array<ProviderRow>>
  }>({ undo: [], redo: [] })
  const pending = useRef({ count: '', op: '' })
  const opened = useRef<{ id: string; from: typeof cursor } | null>(null)
  const commandRange = useRef<Range | null>(null)

  const was = new Map(providerRows(loaded).map((r, i) => [r.id, i]))
  const kept = new Map(rows.filter((r) => !r.deleted).map((r, i) => [r.id, i]))
  const states: Array<LineState> = rows.map((r) => {
    const s = providerStatus(r)
    return s === 'clean' && kept.get(r.id) !== was.get(r.id) ? 'moved' : s
  })
  const dirty = states.filter((s) => s !== 'clean').length
  const current = rows.at(cursor.row)
  const column = columns[cursor.col]
  const setting: SettingKey | null =
    sub !== null && current && expanded.has(current.id)
      ? settingKeys[sub]
      : null
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
    writeDraft(dirty > 0 ? rows : null)
  }, [rows, dirty])
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

  function change(next: Array<ProviderRow>) {
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

  /** Replaces a line (by id); false when nothing changed. */
  function putRow(row: ProviderRow): boolean {
    const i = rows.findIndex((r) => r.id === row.id)
    if (i < 0 || JSON.stringify(rows[i]) === JSON.stringify(row)) return false
    change(rows.with(i, row))
    clearProblems([row.id])
    return true
  }

  function patchRows(
    ids: Array<string>,
    patchOf: (row: ProviderRow) => Partial<ProviderRow> | null,
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

  // ---------- line commands

  /** `o` / `O`: a new line, its 類型 cell open on the templates. */
  function openRow(at: number) {
    const row = newProviderRow(crypto.randomUUID())
    const index = Math.max(0, Math.min(at, rows.length))
    change(rows.toSpliced(index, 0, row))
    opened.current = { id: row.id, from: cursor }
    setSub(null)
    setCursor({ row: index, col: columns.indexOf('kind') })
    setEdit('')
    setPick(0)
    setNavigated(false)
    setSubEdit(false)
    setMode('insert')
    say('選一個範本：Google、GitHub、Discord，或自架的 OIDC 服務（打字找）')
  }

  /** Esc on a new line left empty takes it away again. */
  function dropOpened(): boolean {
    const o = opened.current
    opened.current = null
    if (!o || !current || current.id !== o.id) return false
    if (edit.trim() !== '' || current.base || current.template) return false
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
    const ids = new Set(targets.map((t) => t.id))
    if (targets.every((t) => t.deleted)) {
      change(rows.map((r) => (ids.has(r.id) ? { ...r, deleted: false } : r)))
      return say(`已取消 ${ids.size} 個的刪除標記`)
    }
    const next = rows.flatMap((r) =>
      !ids.has(r.id) ? [r] : r.base ? [{ ...r, deleted: true }] : [],
    )
    change(next)
    setSub(null)
    setCursor((c) => ({ ...c, row: clamp(from, next.length) }))
    const saved = targets.filter((t) => t.base).length
    say(
      saved > 0
        ? `已標記刪除 ${saved} 個（:w 才刪除，連結它的帳號也一起解除，不能復原）；只是暫停的話用 x 停用，u 可以復原`
        : `已移除 ${targets.length} 個未儲存的登入方式，u 可以復原`,
    )
  }

  /** `x`: enable or disable the lines. */
  function toggleEnabled(range: Range) {
    const targets = rows
      .slice(range.from, range.to + 1)
      .filter((r) => !r.deleted)
    if (targets.length === 0) return
    const enabled = !targets.every((t) => t.enabled)
    const n = patchRows(
      targets.map((t) => t.id),
      () => ({ enabled }),
    )
    if (n > 0)
      say(
        enabled
          ? `已啟用 ${n} 個：會出現在登入頁（:w 儲存）`
          : `已停用 ${n} 個：登入頁不再出現，已連結的帳號也暫時不能用它登入（:w 儲存）`,
      )
  }

  /** Alt-j / Alt-k (and :m): moves lines among those kept; `to` says where the first goes. */
  function moveLines(range: Range, to: (from: number, kept: number) => number) {
    const block = rows.slice(range.from, range.to + 1)
    if (block.length === 0) return
    if (block.some((r) => r.deleted))
      return say('標記刪除的不能搬：先 dd 取消刪除', 'error')
    const rest = rows.filter((r) => !block.includes(r))
    const count = rest.filter((r) => !r.deleted).length
    const at = Math.max(0, Math.min(count, to(range.from, count)))
    if (at === range.from) return
    change(rest.toSpliced(at, 0, ...block))
    const shift = at - range.from
    setSub(null)
    setCursor((c) => ({ ...c, row: c.row + shift }))
    if (mode === 'visual') setAnchor((a) => a + shift)
    say(`已搬到第 ${at + 1} 個（:w 儲存登入按鈕的順序）`)
  }

  /**
   * `za` (and the arrow): shows or hides a line's settings under it; `zo`
   * opens them with the cursor on the first, `zc` closes them.
   */
  function toggleSettings(id: string, enter: boolean, open?: boolean) {
    const next = new Set(expanded)
    const show = open ?? !next.has(id)
    if (show) next.add(id)
    else next.delete(id)
    setExpanded(next)
    setSub(show && enter ? 0 : null)
  }

  /** Moves down `n` lines, through the settings of open lines. */
  function down(n: number) {
    let r = cursor.row
    let at = sub
    for (let i = 0; i < n; i++) {
      const open = rows[r] && expanded.has(rows[r].id)
      if (at === null) {
        if (open) at = 0
        else if (r < rows.length - 1) r++
      } else if (at < settingKeys.length - 1) at++
      else if (r < rows.length - 1) {
        r++
        at = null
      }
    }
    setCursor((c) => ({ ...c, row: r }))
    setSub(at)
  }

  /** Moves up `n` lines, through the settings of open lines. */
  function up(n: number) {
    let r = cursor.row
    let at = sub
    for (let i = 0; i < n; i++) {
      if (at === null) {
        if (r === 0) break
        r--
        at = expanded.has(rows[r].id) ? settingKeys.length - 1 : null
      } else if (at > 0) at--
      else at = null
    }
    setCursor((c) => ({ ...c, row: r }))
    setSub(at)
  }

  // ---------- cells

  function startInsertAt(index: number, colIndex: number, clear = false) {
    const row = rows.at(index)
    const col = columns[colIndex]
    if (!row) return say('還沒有登入方式，按 o 新增')
    const reason = lockedReason(row, col)
    if (reason) return say(reason, 'error')
    if (col === 'enabled') return toggleEnabled({ from: index, to: index })
    setSub(null)
    setSubEdit(false)
    setEdit(clear || col === 'kind' ? '' : providerCellText(row, col))
    setPick(0)
    setNavigated(false)
    setMode('insert')
  }

  function suggestions(): Array<Suggestion> {
    if (mode !== 'insert' || !current) return []
    if (picker) {
      return scopeOptions(current.kind, picker, edit)
    }
    if (subEdit) return []
    if (column === 'kind')
      return rankCell(
        templates.map((t) => ({
          value: t.label,
          label: t.label,
          hint: kindLabels[t.kind],
          icon: <BrandIcon slug={t.icon} className="size-3.5" />,
        })),
        edit,
        null,
        (o) => o.value,
        templates.length,
      )
    if (column === 'icon')
      return rankCell(
        [...(iconSlugs ?? [])],
        edit,
        current.icon || null,
        (s) => s,
      ).map((s) => ({
        value: s,
        label: s,
        icon: <BrandIcon slug={s} className="size-3.5" />,
      }))
    return []
  }

  function chosenText(): string {
    const options = suggestions()
    if (options.length === 0) return edit
    const highlighted = options[Math.min(pick, options.length - 1)].value
    if (navigated) return highlighted
    // An empty icon is no icon; an empty kind keeps the template picked
    // (or takes the first).
    if (column === 'icon' && edit.trim() === '') return ''
    if (column === 'kind' && edit.trim() === '' && current?.template)
      return templateOf(current.template)?.label ?? highlighted
    return options.some((o) => o.value === edit.trim()) ? edit : highlighted
  }

  function takenIndex(options: Array<Suggestion>): number {
    if (options.length === 0) return -1
    return options.findIndex((o) => o.value === chosenText())
  }

  /** Writes the cell; the line as it then is, or null when refused. */
  function commitCell(text: string): ProviderRow | null {
    if (!current) return null
    const next = providerPatch(current, column, text, iconSlugs)
    if (typeof next === 'string') {
      say(next, 'error')
      return null
    }
    opened.current = null
    // A template picked on a new line shows its settings and what to do.
    if (column === 'kind' && next.template !== current.template) {
      setExpanded(new Set(expanded).add(next.id))
      const t = templateOf(next.template)
      if (t) say(t.help)
    } else setMessage(null)
    putRow(next)
    return next
  }

  /** Leaves insert mode; a missing Client ID is found at :w, as any problem is. */
  function leaveInsert() {
    setSubEdit(false)
    setPicker(null)
    setEdit('')
    setMode('normal')
  }

  /**
   * Tab: on to the next cell that can be edited; past the line's last, a
   * new line goes on to its settings.
   */
  function finishCell(move: 'stay' | 'next' | 'prev') {
    const row = commitCell(chosenText())
    if (!row) return
    if (move === 'stay') return leaveInsert()
    let col = cursor.col
    for (;;) {
      col += move === 'next' ? 1 : -1
      if (col < 0) return leaveInsert()
      if (col >= columns.length) {
        if (!row.base && move === 'next') {
          setExpanded(new Set(expanded).add(row.id))
          return startSettingEdit(row, 0)
        }
        return leaveInsert()
      }
      const c = columns[col]
      if (c !== 'enabled' && !lockedReason(row, c)) break
    }
    setCursor((c) => ({ ...c, col }))
    setEdit(columns[col] === 'kind' ? '' : providerCellText(row, columns[col]))
    setPick(0)
    setNavigated(false)
  }

  // ---------- settings

  /** Edits setting `index` of `row` (the cursor's line). */
  function startSettingEdit(row: ProviderRow, index: number, clear = false) {
    const key = settingKeys[index]
    const reason = lockedReason(row, key)
    if (reason) return say(reason, 'error')
    setSub(index)
    setSubEdit(true)
    setPick(0)
    setNavigated(false)
    setMode('insert')
    if (key === 'scopes') {
      setPicker(clear ? startScopes({ ...row, scopes: [] }) : startScopes(row))
      setEdit('')
      say(
        '打字找 scope，Enter 加入；清單沒有的也可以直接加；Backspace 拿掉最後一個；Tab 或 Esc 完成',
      )
      return
    }
    setPicker(null)
    setEdit(
      clear ? '' : key === 'clientSecret' ? row.secret : settingText(row, key),
    )
    if (key === 'clientSecret')
      say(
        row.base?.hasSecret
          ? '輸入新的 Client Secret 會換掉已儲存的；留空就不變'
          : 'Client Secret 加密後儲存，之後不會再顯示',
      )
  }

  /** Writes the setting being edited; the line as it then is, or null when refused. */
  function commitSetting(): ProviderRow | null {
    if (!current || !setting) return null
    if (setting === 'scopes') {
      if (!picker) return current
      const next = { ...current, scopes: picker }
      putRow(next)
      setPicker(null)
      return next
    }
    const next = settingPatch(current, setting, edit)
    if (typeof next === 'string') {
      say(next, 'error')
      return null
    }
    putRow(next)
    setMessage(null)
    return next
  }

  function endSettingEdit() {
    setSubEdit(false)
    setPicker(null)
    setEdit('')
    setMode('normal')
  }

  /**
   * Tab in a setting: on to the next one, done after the last; Shift-Tab
   * from the first goes back to the line's last cell.
   */
  function nextSetting(move: 'next' | 'prev') {
    const row = commitSetting()
    if (!row || sub === null) return
    const to = sub + (move === 'next' ? 1 : -1)
    if (to >= settingKeys.length) return leaveInsert()
    if (to < 0) {
      const col = columns.indexOf('icon')
      setSub(null)
      setSubEdit(false)
      setPicker(null)
      setCursor((c) => ({ ...c, col }))
      setEdit(providerCellText(row, 'icon'))
      setPick(0)
      setNavigated(false)
      return
    }
    startSettingEdit(row, to)
  }

  /** Enter or Esc in a setting: take it and leave insert mode. */
  function doneSetting() {
    const row = commitSetting()
    if (row) leaveInsert()
  }

  function saveFromSetting() {
    const row = commitSetting()
    if (!row) return
    leaveInsert()
    void save()
  }

  function cancelSetting(what: string) {
    endSettingEdit()
    say(what)
  }

  function addScope(index: number) {
    const option = suggestions().at(index)
    if (!picker || !option) return
    if (!picker.includes(option.value)) setPicker([...picker, option.value])
    setEdit('')
    setPick(0)
    setNavigated(false)
  }

  function removeScope(scope: string) {
    if (!picker || !current) return
    const next = dropScope(current.kind, picker, scope)
    if (typeof next === 'string') return say(next, 'error')
    setPicker(next)
  }

  function runScopes(k: Key): boolean {
    const options = suggestions()
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
        if (choosing) addScope(Math.min(pick, options.length - 1))
        else if (edit.trim() !== '') say('scope 是一個字，不能有空白', 'error')
        else doneSetting()
        return true
      case '<Tab>':
        nextSetting('next')
        return true
      case '<S-Tab>':
        nextSetting('prev')
        return true
      case '<Esc>':
        doneSetting()
        return true
      case '<C-c>':
        cancelSetting('已取消編輯 Scopes')
        return true
      case '<BS>':
        if (edit !== '' || !picker) return false
        if (picker.length > 0) removeScope(picker[picker.length - 1])
        return true
      case '<C-s>':
      case '<D-s>':
        saveFromSetting()
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

  function runSetting(k: Key): boolean {
    if (picker) return runScopes(k)
    switch (k) {
      case '<Tab>':
        nextSetting('next')
        return true
      case '<S-Tab>':
        nextSetting('prev')
        return true
      case '<CR>':
      case '<Esc>':
        doneSetting()
        return true
      case '<C-c>':
        cancelSetting('已取消編輯')
        return true
      case '<C-s>':
      case '<D-s>':
        saveFromSetting()
        return true
      default:
        if ([...k].length === 1) {
          setEdit((e) => e + k)
          return true
        }
        return false
    }
  }

  /**
   * A click elsewhere while a cell is edited takes what was typed, as Enter
   * would; false when it cannot.
   */
  function finishEditing(): boolean {
    if (mode !== 'insert') return true
    const row = subEdit ? commitSetting() : commitCell(chosenText())
    if (!row) return false
    leaveInsert()
    return true
  }

  // ---------- saving

  function messageFor(code: string, fallback: string): string {
    if (providerProblemMessages[code]) return providerProblemMessages[code]
    const known = errorCodeMessage(code)
    return known === '發生未知錯誤' ? fallback : known
  }

  function reportProblems(found: Map<string, ProviderProblem>): false {
    setProblems(found)
    const first = rows.findIndex((r) => found.has(r.id))
    const p = found.get(rows[first]?.id ?? '')
    if (first >= 0) {
      const field = p?.fields[0] ?? null
      if (p?.fields.some((f) => isSetting(f)))
        setExpanded(new Set(expanded).add(rows[first].id))
      if (isSetting(field)) {
        setExpanded(new Set(expanded).add(rows[first].id))
        setCursor((c) => ({ ...c, row: first }))
        setSub(settingKeys.indexOf(field))
      } else {
        const col = field ? columns.indexOf(field) : -1
        setSub(null)
        setCursor({ row: first, col: col >= 0 ? col : cursor.col })
      }
    }
    say(`${found.size} 個有問題，沒有儲存：${p?.message ?? ''}`, 'error')
    return false
  }

  async function save(): Promise<boolean> {
    const found = new Map<string, ProviderProblem>()
    for (const [i, row] of rows.entries()) {
      if (states[i] === 'clean' || states[i] === 'moved') continue
      const p = validateProvider(row, rows)
      if (p) found.set(row.id, p)
    }
    if (found.size > 0) return reportProblems(found)
    const body = toBatch(rows)
    if (body.upserts.length === 0 && body.deletes.length === 0) {
      say('沒有需要儲存的變更')
      return true
    }
    setSaving(true)
    try {
      const { data, error, response } = await api.POST(
        '/oidc-providers/batch',
        { body },
      )
      if (response.status === 422 && error && 'errors' in error) {
        const fromServer = new Map<string, ProviderProblem>()
        for (const p of error.errors) {
          const field = problemField(p.field)
          const text = messageFor(p.code, p.message)
          const before = fromServer.get(p.id)
          fromServer.set(p.id, {
            fields: [...(before?.fields ?? []), ...(field ? [field] : [])],
            message: before ? `${before.message}；${text}` : text,
          })
        }
        return reportProblems(fromServer)
      }
      if (!data) {
        const code = 'code' in error ? String(error.code) : ''
        say(
          `${messageFor(code, '儲存失敗，請稍後再試')}；變更仍保留在草稿裡（Client Secret 除外）`,
          'error',
        )
        return false
      }
      const fresh = await reload()
      const next = providerRows(fresh)
      writeDraft(null)
      history.current = { undo: [], redo: [] }
      setLoaded(fresh)
      setRows(next)
      setProblems(new Map())
      setSub(null)
      setCursor((c) => ({ ...c, row: clamp(c.row, next.length) }))
      say(`已儲存：${data.upserted} 個新增或修改，${data.deleted} 個刪除`)
      return true
    } catch {
      say('無法連線至伺服器；變更仍保留在草稿裡（Client Secret 除外）', 'error')
      return false
    } finally {
      setSaving(false)
    }
  }

  function discard() {
    const fresh = providerRows(loaded)
    writeDraft(null)
    change(fresh)
    setProblems(new Map())
    setSub(null)
    setCursor((c) => ({ ...c, row: clamp(c.row, fresh.length) }))
    say('已放棄所有未儲存的變更（u 可以復原）')
  }

  async function runCommand(raw: string) {
    const cmd = raw.trim()
    const range = commandRange.current ?? { from: cursor.row, to: cursor.row }
    commandRange.current = null
    setMode('normal')
    setCommand('')
    if (cmd === 'w') await save()
    else if (cmd === 'e!') discard()
    else if (/^m(ove)?\s*(\d+|\$)$/.test(cmd)) {
      const target = cmd.replace(/^m(ove)?\s*/, '')
      moveLines(range, (_, count) =>
        target === '$' ? count : Math.max(0, Number(target) - 1),
      )
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
    const range = visual && selection ? selection : counted

    if (p.op) {
      const op = p.op + k
      if (op === 'dd')
        return done(() =>
          sub !== null
            ? say('設定不能刪：zc 收起，或 i 改它的值', 'error')
            : deleteRange(counted),
        )
      if (op === 'gg')
        return done(() => moveTo(p.count ? count - 1 : 0, cursor.col))
      if (current && (op === 'za' || op === 'zo' || op === 'zc'))
        return done(() =>
          toggleSettings(
            current.id,
            op === 'zo',
            op === 'za' ? undefined : op === 'zo',
          ),
        )
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
      case '<M-j>':
      case '<M-Down>':
        return done(() => moveLines(range, (from) => from + count))
      case '<M-k>':
      case '<M-Up>':
        return done(() => moveLines(range, (from) => from - count))
      case 'g':
      case 'z':
      case '<C-w>':
        pending.current = { count: p.count, op: k }
        return true
      case ':':
        return done(() => {
          if (visual && selection) {
            commandRange.current = selection
            setMode('normal')
          }
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
          toggleEnabled(range)
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
        pending.current = { count: p.count, op: k }
        return true
      case 'i':
      case 'a':
      case '<CR>':
      case '<F2>':
        return done(() =>
          sub !== null && current
            ? startSettingEdit(current, sub)
            : startInsertAt(cursor.row, cursor.col),
        )
      case 'c':
      case 's':
        return done(() =>
          sub !== null && current
            ? startSettingEdit(current, sub, true)
            : startInsertAt(cursor.row, cursor.col, true),
        )
      case 'o':
        return done(() => openRow(rows.length === 0 ? 0 : cursor.row + 1))
      case 'O':
        return done(() => openRow(cursor.row))
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

  function runInsert(k: Key): boolean {
    if (subEdit) return runSetting(k)
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
      case '<Esc>': {
        if (dropOpened()) return true
        const row = commitCell(chosenText())
        if (row) leaveInsert()
        return true
      }
      case '<C-c>':
        if (dropOpened()) return true
        setMode('normal')
        say('已取消編輯')
        return true
      case '<C-s>':
      case '<D-s>': {
        const row = commitCell(chosenText())
        if (row) {
          leaveInsert()
          void save()
        }
        return true
      }
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

  const feed = useKeyFeed(keymap, 'providers', (k) => {
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
  const valueWidth = Math.max(
    240,
    Math.min(
      640,
      Math.max(room, layout.width) - SETTING_INDENT - SETTING_LABEL - 16,
    ),
  )
  const valueLeft = SETTING_INDENT + SETTING_LABEL

  function editor(width: number, label: string) {
    return (
      <CellEditor
        inputRef={inputRef}
        value={edit}
        label={label}
        width={width}
        options={feed.waiting ? [] : options}
        pick={
          picker
            ? options.length > 0 && (edit.trim() !== '' || navigated)
              ? Math.min(pick, options.length - 1)
              : -1
            : takenIndex(options)
        }
        enterHint={picker ? 'Enter 完成' : undefined}
        chips={
          picker && current
            ? picker.map((s) => (
                <ScopeChip
                  key={s}
                  scope={s}
                  locked={scopeLocked(current.kind, s)}
                  onRemove={() => removeScope(s)}
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
          if (picker) return addScope(i)
          opened.current = null
          setEdit(options[i].value)
          setPick(i)
          setNavigated(true)
        }}
      />
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div
        ref={gridRef}
        tabIndex={0}
        role="grid"
        aria-label="第三方登入"
        aria-rowcount={rows.length}
        data-pane="providers"
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
                    c === 'enabled' && 'justify-center',
                  )}
                >
                  {providerLabels[c]}
                </span>
              ))}
            </div>

            {rows.length === 0 && (
              <p className="px-4 py-6 text-sm text-muted-foreground">
                還沒有第三方登入。按{' '}
                <kbd className="font-mono text-foreground">o</kbd>{' '}
                選一個範本：Google、GitHub、Discord，或自架的
                Authentik、Keycloak 等 OIDC 服務。
              </p>
            )}

            <div>
              {rows.map((row, index) => {
                const at = index === cursor.row
                const selected =
                  selection !== null &&
                  index >= selection.from &&
                  index <= selection.to
                const open = expanded.has(row.id)
                const rowProblem = problems.get(row.id)
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
                    <ProviderLine
                      row={row}
                      index={index}
                      layout={layout}
                      state={states[index]}
                      problem={rowProblem}
                      open={open}
                      onToggle={() => toggleSettings(row.id, false)}
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
                        {editor(layout.widths[column], providerLabels[column])}
                      </div>
                    )}

                    {open &&
                      settingKeys.map((key, li) => {
                        const on = at && sub === li
                        const typing = on && mode === 'insert' && subEdit
                        const text = settingText(row, key)
                        const bad = rowProblem?.fields.includes(key)
                        return (
                          <div
                            key={key}
                            className="relative border-b border-rule/40 bg-card/40 text-sm leading-normal"
                            style={{ height: ROW_HEIGHT }}
                            onMouseDown={(e) => {
                              e.preventDefault()
                              if (!finishEditing()) return
                              setMode('normal')
                              setCursor((c) => ({ ...c, row: index }))
                              if (e.detail === 2) startSettingEdit(row, li)
                              else {
                                setSub(li)
                                gridRef.current?.focus({ preventScroll: true })
                              }
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
                            <span
                              className={cn(
                                'absolute inset-y-0 flex items-center truncate pr-2 text-xs',
                                bad
                                  ? 'text-destructive'
                                  : 'text-muted-foreground',
                              )}
                              style={{
                                left: SETTING_INDENT,
                                width: SETTING_LABEL,
                              }}
                            >
                              {settingLabel(row, key)}
                            </span>
                            <span
                              className={cn(
                                'absolute inset-y-0 flex min-w-0 items-center gap-1.5 overflow-hidden px-2 whitespace-nowrap',
                              )}
                              style={{ left: valueLeft, width: valueWidth }}
                            >
                              {key === 'scopes' && row.scopes.length > 0 ? (
                                row.scopes.map((s, i) => (
                                  <ScopeChip
                                    key={s}
                                    scope={s}
                                    locked={scopeLocked(row.kind, s)}
                                    comma={i < row.scopes.length - 1}
                                  />
                                ))
                              ) : text ? (
                                <span className="truncate">{text}</span>
                              ) : (
                                <span className="truncate text-muted-foreground/60">
                                  {settingPlaceholder(row, key)}
                                </span>
                              )}
                            </span>
                            {on && !typing && (
                              <div
                                aria-hidden
                                className="pointer-events-none absolute top-0 z-10 border-2 border-kraft/40 group-focus:border-kraft"
                                style={{
                                  left: valueLeft,
                                  width: valueWidth,
                                  height: ROW_HEIGHT,
                                }}
                              />
                            )}
                            {typing && (
                              <div
                                className="absolute top-0 z-30"
                                style={{ left: valueLeft, width: valueWidth }}
                              >
                                {editor(
                                  valueWidth,
                                  picker
                                    ? '找 scope 或輸入新的'
                                    : settingLabel(row, key),
                                )}
                              </div>
                            )}
                          </div>
                        )
                      })}
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
        groups={providerKeys}
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
            title={line.text}
          >
            {line.text}
          </span>
        ) : (
          <span className="truncate text-muted-foreground">
            {selection
              ? `已選 ${selection.to - selection.from + 1} 個 · d 刪除 · x 啟用/停用 · Alt-j/k 搬 · Esc 取消`
              : 'hjkl 移動 · o 新增 · i 編輯 · za 展開 Client ID 等設定 · x 啟用/停用 · Alt-j/k 順序 · :w 儲存 · ? 快捷鍵'}
          </span>
        )}
      </div>
    </div>
  )
}

function ProviderLine({
  row,
  index,
  layout,
  state,
  problem,
  open,
  onToggle,
  onPick,
}: {
  row: ProviderRow
  index: number
  layout: Layout
  state: LineState
  problem: ProviderProblem | undefined
  /** Whether the line's settings are shown under it. */
  open: boolean
  onToggle: () => void
  onPick: (col: number, enter: boolean) => void
}) {
  const marker = problem
    ? '!'
    : { clean: '', new: '+', changed: '~', deleted: '-', moved: '↕' }[state]
  const cell = 'flex items-center overflow-hidden px-2 whitespace-nowrap'
  const muted = 'text-muted-foreground'
  // A problem with a setting shows on the line too, by the arrow.
  const settingBad = problem?.fields.some((f) => isSetting(f))

  function content(c: ProviderColumn, col: number): React.ReactNode {
    const bad = problem?.fields.includes(c) && 'text-destructive'
    switch (c) {
      case 'kind':
        return (
          <span key={c} data-col={col} className={cn(cell, bad)}>
            <span
              className={cn('truncate', !row.template && !row.base && muted)}
            >
              {row.base || row.template ? kindLabels[row.kind] : '選範本'}
            </span>
          </span>
        )
      case 'name':
        return (
          <span key={c} data-col={col} className={cn(cell, 'gap-1', bad)}>
            <button
              type="button"
              tabIndex={-1}
              aria-label={open ? '收起設定' : '展開設定'}
              aria-expanded={open}
              onMouseDown={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onToggle()
              }}
              className={cn(
                '-ml-1 shrink-0 hover:text-foreground',
                settingBad ? 'text-destructive' : muted,
              )}
            >
              {open ? (
                <ChevronDownIcon className="size-3.5" />
              ) : (
                <ChevronRightIcon className="size-3.5" />
              )}
            </button>
            <span className="truncate">{row.name}</span>
            {row.secret && (
              <span className="ml-2 shrink-0 text-xs text-kraft">新密鑰</span>
            )}
          </span>
        )
      case 'code':
        return (
          <span key={c} data-col={col} className={cn(cell, bad)}>
            {row.code}
          </span>
        )
      case 'icon':
        return (
          <span key={c} data-col={col} className={cn(cell, 'gap-2', bad)}>
            <BrandIcon slug={row.icon} />
            <span className={cn('truncate', !row.icon && muted)}>
              {row.icon || '預設'}
            </span>
          </span>
        )
      case 'enabled':
        return (
          <span
            key={c}
            data-col={col}
            className={cn(cell, 'justify-center', muted, bad)}
          >
            {row.enabled && (
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
        row.deleted && 'text-muted-foreground line-through',
        !row.enabled && !row.deleted && 'text-muted-foreground',
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
        title={
          problem?.message ??
          (state === 'moved' ? '順序變了（:w 儲存）' : undefined)
        }
      >
        {marker}
      </span>
      {providerColumns.map((c, col) => content(c, col))}
    </div>
  )
}

/** A scope as the Scopes line shows it, in the picker with a button to take it off. */
function ScopeChip({
  scope,
  locked,
  onRemove,
  comma,
}: {
  scope: string
  locked: boolean
  onRemove?: () => void
  comma?: boolean
}) {
  return (
    <span className="flex h-6 shrink-0 items-center gap-1 text-sm text-foreground">
      {scope}
      {locked ? (
        <LockIcon
          aria-label="一定要有"
          className="size-3 text-muted-foreground"
        />
      ) : (
        onRemove && (
          <button
            type="button"
            tabIndex={-1}
            aria-label={`移除 ${scope}`}
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
