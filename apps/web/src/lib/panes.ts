import { useRouter } from '@tanstack/react-router'
import { useEffect, useMemo, useRef } from 'react'
import { NormalMapper, TIMEOUT_MS, forPane, keyOf } from './keymap'
import type { Key, Keymap, Pane } from './keymap'

/**
 * Moving between panes, as Vim moves between windows (ADR-072): the
 * sidebar, the page, the register and its split window. A pane is an element
 * with `data-pane`; one that holds other panes is not a pane itself. Moving
 * picks the pane in that direction that had focus last, else the nearest,
 * and puts focus back where it was in it.
 *
 * Nothing is bound by default. Vim's own commands are `<C-w>h/j/k/l` and
 * `:wincmd h`; the browser keeps the real Ctrl-w (it closes the tab), so
 * they are reached through the user's mappings, as a vimrc does:
 *
 *   nnoremap <C-h> <C-w>h
 */
export type Direction = 'left' | 'down' | 'up' | 'right'

/** `h`, `j`, `k`, `l` (and the arrows) after `<C-w>`. */
export function windowDirection(key: Key): Direction | null {
  switch (key) {
    case 'h':
    case '<Left>':
      return 'left'
    case 'j':
    case '<Down>':
      return 'down'
    case 'k':
    case '<Up>':
      return 'up'
    case 'l':
    case '<Right>':
      return 'right'
    default:
      return null
  }
}

/** When each pane last had focus, and where in it. */
const last = new WeakMap<Element, { at: number; el: HTMLElement }>()

/** Moves focus from the pane holding `from` to the next one in `dir`. */
export function movePane(dir: Direction, from: Element | null): void {
  const pane = from?.closest('[data-pane]') ?? null
  const next = choose(leafPanes(), pane, dir)
  if (next) focusPane(next)
}

/**
 * Tracks focus per pane, and applies the user's normal-mode mappings where
 * nothing else reads keys (the settings pages, pane `main`): a one-key
 * mapping to `<C-w>` and a direction moves between panes. Editors and the
 * sidebar (`data-editor`) apply mappings themselves; fields and open dialogs
 * or menus are left alone.
 */
export function usePaneNavigation(keymap: Keymap): void {
  useEffect(() => {
    function onFocusIn(event: FocusEvent) {
      const el = event.target
      if (!(el instanceof HTMLElement)) return
      const pane = el.closest('[data-pane]')
      if (pane) last.set(pane, { at: performance.now(), el })
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing) return
      const target = event.target instanceof HTMLElement ? event.target : null
      if (
        target?.closest(
          'input, textarea, select, [contenteditable="true"], [data-editor]',
        )
      ) {
        return
      }
      if (document.querySelector('[role="dialog"], [role="menu"]')) return
      const key = keyOf(event)
      if (!key) return
      const mapping = forPane(keymap.normal, 'main').find(
        (m) => m.lhs.length === 1 && m.lhs[0] === key,
      )
      if (!mapping) return
      const [first, second] = mapping.rhs
      const dir = first === '<C-w>' && second ? windowDirection(second) : null
      if (!dir) return
      event.preventDefault()
      movePane(dir, target)
    }

    document.addEventListener('focusin', onFocusIn)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('focusin', onFocusIn)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [keymap])
}

function leafPanes(): Array<HTMLElement> {
  const all = [...document.querySelectorAll<HTMLElement>('[data-pane]')].filter(
    (p) => {
      const r = p.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    },
  )
  return all.filter((p) => !all.some((q) => q !== p && p.contains(q)))
}

function inDirection(to: DOMRect, from: DOMRect, dir: Direction): boolean {
  const slack = 2
  switch (dir) {
    case 'left':
      return to.right <= from.left + slack
    case 'right':
      return to.left >= from.right - slack
    case 'up':
      return to.bottom <= from.top + slack
    case 'down':
      return to.top >= from.bottom - slack
  }
}

function distance(a: DOMRect, b: DOMRect): number {
  const dx = a.left + a.width / 2 - (b.left + b.width / 2)
  const dy = a.top + a.height / 2 - (b.top + b.height / 2)
  return Math.hypot(dx, dy)
}

function choose(
  panes: Array<HTMLElement>,
  from: Element | null,
  dir: Direction,
): HTMLElement | null {
  // Nothing focused yet: Ctrl-h goes to the sidebar, the others to the page.
  const origin = from?.getBoundingClientRect() ?? null
  const candidates = panes.filter((p) => {
    if (p === from) return false
    if (!origin)
      return dir === 'left'
        ? p.dataset.pane === 'sidebar'
        : p.dataset.pane !== 'sidebar'
    return inDirection(p.getBoundingClientRect(), origin, dir)
  })
  if (candidates.length === 0) return null
  return candidates.toSorted((a, b) => {
    const recency = (last.get(b)?.at ?? 0) - (last.get(a)?.at ?? 0)
    if (recency !== 0) return recency
    return origin
      ? distance(a.getBoundingClientRect(), origin) -
          distance(b.getBoundingClientRect(), origin)
      : 0
  })[0]
}

function focusPane(pane: HTMLElement): void {
  const remembered = last.get(pane)?.el
  if (remembered?.isConnected && pane.contains(remembered)) {
    remembered.focus()
    return
  }
  if (pane.hasAttribute('tabindex')) {
    pane.focus()
    return
  }
  // Some links are only shown on narrow screens; focus the visible ones.
  const visible = (selector: string) =>
    [...pane.querySelectorAll<HTMLElement>(selector)].find(isVisible)
  const target =
    visible('[aria-current="page"]') ??
    visible('a[href], button:not([disabled])')
  target?.focus()
}

function isVisible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0
}

/** The part of the router's history the jump keys use. */
export interface Jumps {
  canGoBack: () => boolean
  back: () => void
  forward: () => void
}

/**
 * Ctrl-o and Ctrl-i, where the pane has no other use for them: back and
 * forward through the pages visited, as Vim's go through its jump list
 * (ADR-124), so a page opened with `gx` is left with Ctrl-o. Ctrl-o never
 * leaves the app (nor opens the browser's file dialog) when it was the
 * first page.
 */
export function jump(key: Key, history: Jumps): boolean {
  if (key === '<C-o>') {
    if (history.canGoBack()) history.back()
    return true
  }
  if (key === '<C-i>') {
    history.forward()
    return true
  }
  return false
}

/**
 * Keys in a list of links (the sidebar), through the user's mappings for
 * that pane (`autocmd FileType sidebar nnoremap l <CR>`, ADR-075): j/k and
 * the arrows move between the links, gg/G go to the first and last, Enter
 * opens one, and `<C-w>h/j/k/l` move to another pane.
 */
export function useListKeys(
  keymap: Keymap,
  pane: Pane,
): (event: React.KeyboardEvent<HTMLElement>) => void {
  const mapper = useMemo(
    () => new NormalMapper(forPane(keymap.normal, pane)),
    [keymap, pane],
  )
  const state = useRef({ op: '', timer: 0 })
  const { history } = useRouter()

  function items(list: HTMLElement): Array<HTMLElement> {
    return [
      ...list.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'),
    ].filter(isVisible)
  }

  function step(list: HTMLElement, to: (at: number, end: number) => number) {
    const all = items(list)
    const at = all.indexOf(document.activeElement as HTMLElement)
    all
      .at(Math.max(0, Math.min(all.length - 1, to(at, all.length - 1))))
      ?.focus()
  }

  /** Runs one key; false when the list has no use for it. */
  function run(key: Key, list: HTMLElement): boolean {
    const { op } = state.current
    if (op) {
      state.current.op = ''
      const dir = op === '<C-w>' ? windowDirection(key) : null
      if (dir) movePane(dir, list)
      else if (op + key === 'gg') step(list, () => 0)
      return true
    }
    switch (key) {
      case 'j':
      case '<Down>':
        step(list, (at) => at + 1)
        return true
      case 'k':
      case '<Up>':
        step(list, (at) => at - 1)
        return true
      case 'G':
        step(list, (_, end) => end)
        return true
      case 'g':
      case '<C-w>':
        state.current.op = key
        return true
      case '<CR>': {
        // Links open; buttons (the menus) keep their own Enter.
        const el = document.activeElement
        if (!(el instanceof HTMLAnchorElement) || !list.contains(el)) {
          return false
        }
        el.click()
        return true
      }
      default:
        return jump(key, history)
    }
  }

  return (event) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return
    // Fields, and open menus (their portals bubble through React).
    if ((event.target as HTMLElement).closest('input, textarea, [role=menu]'))
      return
    const key = keyOf(event)
    if (!key) return
    const list = event.currentTarget
    window.clearTimeout(state.current.timer)
    const keys = mapper.feed(key)
    if (mapper.waiting) {
      event.preventDefault()
      state.current.timer = window.setTimeout(() => {
        for (const k of mapper.flush()) run(k, list)
      }, TIMEOUT_MS)
      return
    }
    let used = false
    for (const k of keys) used = run(k, list) || used
    // Unmapped keys the list does not use (Tab, F5...) keep their default.
    if (used || keys.length !== 1 || keys[0] !== key) event.preventDefault()
  }
}
