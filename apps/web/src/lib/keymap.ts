/**
 * The editors' key mappings (ADR-070), written like a vimrc:
 *
 *   " comments start with a double quote
 *   let mapleader = ","
 *   inoremap jk <Esc>
 *   nnoremap H 0
 *   nnoremap <Leader>w :w<CR>
 *   vnoremap D d
 *   autocmd FileType sidebar nnoremap <buffer> l <CR>
 *
 * Mappings never remap their right-hand side (every `map` is a `noremap`).
 * `autocmd FileType` limits a mapping to some panes (ADR-075), as Vim users
 * map keys for netrw; the panes are the `data-pane` names.
 * Without React, so it is tested with plain node (`keymap.test.ts`).
 */

/**
 * One key as Vim writes it: a printable character (`j`, `:`, ` `), or a
 * name in angle brackets (`<Esc>`, `<CR>`, `<C-d>`, `<S-Tab>`).
 */
export type Key = string

export interface Mapping {
  lhs: Array<Key>
  rhs: Array<Key>
  /** Only in this pane (`autocmd FileType sidebar ...`); everywhere when absent. */
  pane?: Pane
}

/** The panes a mapping can be limited to (`data-pane` values, ADR-072). */
export const panes = [
  'sidebar',
  'register',
  'split',
  'budget',
  'schedules',
  'goals',
  'friends',
  'accounts',
  'main',
] as const
export type Pane = (typeof panes)[number]

/**
 * The mappings that apply in `pane`: its own, and the global ones it does
 * not map the same keys of.
 */
export function forPane(maps: Array<Mapping>, pane: Pane): Array<Mapping> {
  const own = maps.filter((m) => m.pane === pane)
  return [
    ...maps.filter((m) => !m.pane && !own.some((o) => sameKeys(o.lhs, m.lhs))),
    ...own,
  ]
}

export interface Keymap {
  normal: Array<Mapping>
  /** Visual mode (rows selected with `V`): `vnoremap`, `xnoremap`, `noremap`. */
  visual: Array<Mapping>
  insert: Array<Mapping>
  /** `set timeoutlen=…`: how long a partly typed mapping waits, in ms (TIMEOUT_MS when not set). */
  timeoutlen?: number
}

export interface KeymapError {
  line: number
  message: string
}

export const emptyKeymap: Keymap = { normal: [], visual: [], insert: [] }

/** How long a partly typed mapping waits for its next key by default (Vim's timeoutlen). */
export const TIMEOUT_MS = 1000

/** The bounds of `set timeoutlen`, in ms. */
export const TIMEOUT_RANGE = { min: 100, max: 5000 }

const named: Record<string, Key> = {
  esc: '<Esc>',
  cr: '<CR>',
  enter: '<CR>',
  return: '<CR>',
  tab: '<Tab>',
  's-tab': '<S-Tab>',
  bs: '<BS>',
  del: '<Del>',
  up: '<Up>',
  down: '<Down>',
  left: '<Left>',
  right: '<Right>',
  home: '<Home>',
  end: '<End>',
  pageup: '<PageUp>',
  pagedown: '<PageDown>',
  space: ' ',
  lt: '<',
  bar: '|',
  bslash: '\\',
}
for (let i = 1; i <= 12; i++) named[`f${i}`] = `<F${i}>`

/** `<c-D>` -> `<C-d>`; null for a name Vim would not know. */
function normalizeName(inner: string, leader: Key): Key | null {
  const lower = inner.toLowerCase()
  if (lower === 'leader') return leader
  if (lower in named) return named[lower]
  const m = /^([cmad])-(.+)$/i.exec(inner)
  if (m) {
    const mod = { c: 'C', m: 'M', a: 'M', d: 'D' }[
      m[1].toLowerCase() as 'c' | 'm' | 'a' | 'd'
    ]
    const rest = m[2]
    if (rest.length === 1) return `<${mod}-${rest.toLowerCase()}>`
    const lowerRest = rest.toLowerCase()
    const base = Object.hasOwn(named, lowerRest) ? named[lowerRest] : ''
    if (base.startsWith('<')) return `<${mod}-${base.slice(1, -1)}>`
  }
  return null
}

/** Splits `:w<CR>` into keys; throws on an unknown `<name>`. */
export function parseKeys(text: string, leader: Key = '\\'): Array<Key> {
  const keys: Array<Key> = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '<') {
      const close = text.indexOf('>', i + 1)
      const inner = close > i + 1 ? text.slice(i + 1, close) : ''
      // `<` that does not start a name is the key itself, as in Vim.
      if (inner && /^[\w-]+$/.test(inner)) {
        const key = normalizeName(inner, leader)
        if (!key) throw new Error(`不認得的按鍵 <${inner}>`)
        keys.push(key)
        i = close + 1
        continue
      }
    }
    keys.push(ch)
    i++
  }
  return keys
}

/** The modes a keymap maps keys in. */
export type KeymapMode = 'normal' | 'visual' | 'insert'
type Mode = KeymapMode

// As in Vim, `map` and `noremap` apply to normal and visual mode.
const commands: Record<string, Array<Mode>> = {
  map: ['normal', 'visual'],
  noremap: ['normal', 'visual'],
  no: ['normal', 'visual'],
  nmap: ['normal'],
  nnoremap: ['normal'],
  nn: ['normal'],
  nno: ['normal'],
  vmap: ['visual'],
  vnoremap: ['visual'],
  vn: ['visual'],
  vno: ['visual'],
  xmap: ['visual'],
  xnoremap: ['visual'],
  xn: ['visual'],
  xno: ['visual'],
  imap: ['insert'],
  inoremap: ['insert'],
  ino: ['insert'],
}

/** Reads a keymap; lines with errors are skipped and reported. */
export function parseKeymap(text: string): {
  keymap: Keymap
  errors: Array<KeymapError>
} {
  const keymap: Keymap = { normal: [], visual: [], insert: [] }
  const errors: Array<KeymapError> = []
  let leader: Key = '\\'
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1
    const src = raw.trim()
    if (!src || src.startsWith('"')) return
    // `set timeoutlen=500` (or `set tm=500`), as in Vim.
    const timeout = /^set?\s+(?:timeoutlen|tm)\s*=\s*(\S*)$/.exec(src)
    if (timeout) {
      const ms = Number(timeout[1])
      if (
        !/^\d+$/.test(timeout[1]) ||
        ms < TIMEOUT_RANGE.min ||
        ms > TIMEOUT_RANGE.max
      ) {
        errors.push({
          line,
          message: `timeoutlen 是 ${TIMEOUT_RANGE.min} 到 ${TIMEOUT_RANGE.max} 的毫秒數，例如 set timeoutlen=500`,
        })
      } else {
        keymap.timeoutlen = ms
      }
      return
    }
    const leaderMatch = /^let\s+(?:g:)?mapleader\s*=\s*(["'])(.*)\1$/.exec(src)
    if (leaderMatch) {
      const value = leaderMatch[2] === '\\<Space>' ? ' ' : leaderMatch[2]
      if ([...value].length !== 1) {
        errors.push({ line, message: 'mapleader 只能是一個字元' })
      } else {
        leader = value
      }
      return
    }
    let words = src.split(/\s+/)
    // `autocmd FileType sidebar,register nnoremap ...`: only in those panes.
    let only: Array<Pane | undefined> = [undefined]
    if (/^au(tocmd)?$/.test(words[0])) {
      if (words[1]?.toLowerCase() !== 'filetype' || words.length < 4) {
        errors.push({
          line,
          message:
            '只支援 autocmd FileType，例如 autocmd FileType sidebar nnoremap l <CR>',
        })
        return
      }
      const names = words[2].split(',')
      const unknown = names.find((n) => !panes.includes(n as Pane))
      if (unknown !== undefined) {
        errors.push({
          line,
          message: `不認得的窗格「${unknown}」：可以用 ${panes.join('、')}`,
        })
        return
      }
      only = names as Array<Pane>
      words = words.slice(3)
    }
    const [cmd, ...rest] = words
    const modes = Object.hasOwn(commands, cmd) ? commands[cmd] : undefined
    if (!modes) {
      errors.push({ line, message: `不支援的指令「${cmd}」` })
      return
    }
    // Options such as <silent> change nothing here.
    while (
      rest.length > 0 &&
      /^<(silent|buffer|nowait|unique)>$/i.test(rest[0])
    ) {
      rest.shift()
    }
    if (rest.length < 2) {
      errors.push({
        line,
        message: '需要按鍵和對應的內容，例如 inoremap jk <Esc>',
      })
      return
    }
    const [lhsText, ...rhsParts] = rest
    try {
      const lhs = parseKeys(lhsText, leader)
      const rhs = parseKeys(rhsParts.join(' '), leader)
      if (
        modes.includes('insert') &&
        lhs.length > 1 &&
        lhs.some((k) => !isPrintable(k))
      ) {
        errors.push({ line, message: '插入模式的多鍵對應只能用一般字元' })
        return
      }
      for (const mode of modes) {
        for (const pane of only) {
          const list = keymap[mode]
          // A later mapping of the same keys (and pane) replaces the earlier one.
          const at = list.findIndex(
            (m) => m.pane === pane && sameKeys(m.lhs, lhs),
          )
          if (at >= 0) list.splice(at, 1)
          list.push(pane ? { lhs, rhs, pane } : { lhs, rhs })
        }
      }
    } catch (e) {
      errors.push({ line, message: (e as Error).message })
    }
  })
  return { keymap, errors }
}

export function isPrintable(key: Key): boolean {
  return [...key].length === 1
}

function sameKeys(a: Array<Key>, b: Array<Key>): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i])
}

function startsWith(keys: Array<Key>, prefix: Array<Key>): boolean {
  return prefix.length <= keys.length && prefix.every((k, i) => k === keys[i])
}

interface KeyEventLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

const eventNames: Record<string, Key> = {
  Escape: '<Esc>',
  Enter: '<CR>',
  Tab: '<Tab>',
  Backspace: '<BS>',
  Delete: '<Del>',
  ArrowUp: '<Up>',
  ArrowDown: '<Down>',
  ArrowLeft: '<Left>',
  ArrowRight: '<Right>',
  Home: '<Home>',
  End: '<End>',
  PageUp: '<PageUp>',
  PageDown: '<PageDown>',
}
for (let i = 1; i <= 12; i++) eventNames[`F${i}`] = `<F${i}>`

/** The key a keyboard event stands for; null for a lone modifier. */
export function keyOf(e: KeyEventLike): Key | null {
  const { key } = e
  if (
    ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Process', 'Dead'].includes(
      key,
    )
  ) {
    return null
  }
  if (key === 'Tab' && e.shiftKey && !e.ctrlKey) return '<S-Tab>'
  const base = Object.hasOwn(eventNames, key)
    ? eventNames[key]
    : isPrintable(key)
      ? key
      : null
  if (base === null) return null
  const mod = e.ctrlKey ? 'C' : e.metaKey ? 'D' : e.altKey ? 'M' : null
  if (!mod) return base
  if (base.startsWith('<')) return `<${mod}-${base.slice(1, -1)}>`
  return `<${mod}-${base.toLowerCase()}>`
}

/**
 * Normal mode: collects keys while they could still become a mapping, and
 * hands back the keys to run (the mapping's right-hand side, or the typed
 * keys when no mapping matches).
 */
export class NormalMapper {
  private pending: Array<Key> = []
  private maps: Array<Mapping>

  constructor(maps: Array<Mapping>) {
    this.maps = maps
  }

  /** Whether keys are waiting for more (or for the timeout). */
  get waiting(): boolean {
    return this.pending.length > 0
  }

  feed(key: Key): Array<Key> {
    const out: Array<Key> = []
    let buffer = [...this.pending, key]
    this.pending = []
    while (buffer.length > 0) {
      const longer = this.maps.some(
        (m) => m.lhs.length > buffer.length && startsWith(m.lhs, buffer),
      )
      if (longer) {
        this.pending = buffer
        break
      }
      const exact = this.maps.find((m) => sameKeys(m.lhs, buffer))
      if (exact) {
        out.push(...exact.rhs)
        break
      }
      // No mapping starts with these keys: the first one is itself, and the
      // rest are looked at again.
      out.push(buffer[0])
      buffer = buffer.slice(1)
    }
    return out
  }

  /** The timeout passed: a complete mapping wins, else the keys are themselves. */
  flush(): Array<Key> {
    const buffer = this.pending
    this.pending = []
    const exact = this.maps.find((m) => sameKeys(m.lhs, buffer))
    return exact ? [...exact.rhs] : buffer
  }
}

/**
 * Insert mode: typed characters go into the cell as usual, and when the last
 * ones complete a mapping (`jk` within the timeout) they are taken back out
 * and the mapping runs, as in Vim.
 */
export class InsertMapper {
  private typed: Array<Key> = []
  private at = 0
  private maps: Array<Mapping>
  private timeout: number

  constructor(maps: Array<Mapping>, timeout = TIMEOUT_MS) {
    this.maps = maps
    this.timeout = timeout
  }

  reset(): void {
    this.typed = []
  }

  /** Whether the last keys typed start a mapping (it may still complete). */
  get waiting(): boolean {
    return this.typed.length > 0
  }

  /**
   * A key pressed in a cell editor. Returns the mapping it completes and how
   * many characters already typed belong to it, or null to type the key.
   */
  feed(key: Key, now: number): { rhs: Array<Key>; erase: number } | null {
    if (now - this.at > this.timeout) this.typed = []
    this.at = now
    const buffer = isPrintable(key) ? [...this.typed, key] : [key]
    for (let i = 0; i < buffer.length; i++) {
      const tail = buffer.slice(i)
      const exact = this.maps.find((m) => sameKeys(m.lhs, tail))
      if (exact) {
        this.typed = []
        return { rhs: [...exact.rhs], erase: tail.length - 1 }
      }
      if (this.maps.some((m) => startsWith(m.lhs, tail))) {
        this.typed = tail
        return null
      }
    }
    this.typed = []
    return null
  }
}
