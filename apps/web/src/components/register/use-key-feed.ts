import { useRouter } from '@tanstack/react-router'
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import {
  InsertMapper,
  NormalMapper,
  TIMEOUT_MS,
  forPane,
  isPrintable,
  keyOf,
} from '#/lib/keymap'
import { jump } from '#/lib/panes'
import type { Key, Keymap, Pane } from '#/lib/keymap'

/**
 * Runs keyboard input through the user's mappings (ADR-070), those of every
 * pane and those of `pane` (ADR-075). `run` gets one key at a time, in
 * whatever mode the editor is in, and says whether it used it. Keys that
 * come from a mapping run one per render, so each one sees the state the one
 * before left (`:w<CR>` opens the command line, types, runs).
 */
export function useKeyFeed(
  keymap: Keymap,
  pane: Pane,
  run: (key: Key) => boolean,
) {
  /** How long a partly typed mapping waits (`set timeoutlen`). */
  const timeoutlen = keymap.timeoutlen ?? TIMEOUT_MS
  const normal = useMemo(
    () => new NormalMapper(forPane(keymap.normal, pane)),
    [keymap, pane],
  )
  const visual = useMemo(
    () => new NormalMapper(forPane(keymap.visual, pane)),
    [keymap, pane],
  )
  const insert = useMemo(
    () => new InsertMapper(forPane(keymap.insert, pane), timeoutlen),
    [keymap, pane, timeoutlen],
  )
  const { history } = useRouter()
  /** Keys to run; `jumps` when typed in normal or visual mode (ADR-124). */
  const queue = useRef<Array<{ key: Key; jumps: boolean }>>([])
  const timer = useRef<number | undefined>(undefined)
  const [tick, setTick] = useState(0)
  /** A mapping is partly typed in insert mode (until it completes or times out). */
  const [waiting, setWaiting] = useState(false)
  const waitTimer = useRef<number | undefined>(undefined)

  const runNext = useEffectEvent(() => {
    const next = queue.current.shift()
    if (next === undefined) return
    if (!run(next.key) && next.jumps) jump(next.key, history)
    if (queue.current.length > 0) setTick((t) => t + 1)
  })
  useEffect(() => {
    if (tick > 0) runNext()
  }, [tick])
  useEffect(
    () => () => {
      window.clearTimeout(timer.current)
      window.clearTimeout(waitTimer.current)
    },
    [],
  )

  /** Notes whether the insert mapper waits for more keys, for at most its timeout. */
  function noteWaiting() {
    window.clearTimeout(waitTimer.current)
    if (insert.waiting) {
      setWaiting(true)
      waitTimer.current = window.setTimeout(() => setWaiting(false), timeoutlen)
    } else {
      setWaiting(false)
    }
  }

  function push(keys: Array<Key>, jumps = false) {
    if (keys.length === 0) return
    queue.current.push(...keys.map((key) => ({ key, jumps })))
    setTick((t) => t + 1)
  }

  /** keydown where nothing is typed into a field, through `mapper`. */
  function mappedKeyDown(mapper: NormalMapper, event: React.KeyboardEvent) {
    const key = keyOf(event)
    if (!key) return
    window.clearTimeout(timer.current)
    const keys = mapper.feed(key)
    if (mapper.waiting) {
      timer.current = window.setTimeout(
        () => push(mapper.flush(), true),
        timeoutlen,
      )
    }
    // An unmapped key runs at once, and keeps the browser's default
    // (Ctrl-c, F5...) unless the editor used it; Ctrl-o and Ctrl-i it does
    // not use go back and forward (ADR-124).
    if (
      !mapper.waiting &&
      keys.length === 1 &&
      keys[0] === key &&
      queue.current.length === 0
    ) {
      if (run(key) || jump(key, history)) event.preventDefault()
      return
    }
    event.preventDefault()
    push(keys, true)
  }

  return {
    /** Feeds keys as if typed, after the ones already waiting. */
    push(keys: Array<Key>): void {
      push(keys)
    },

    /**
     * Whether the last characters typed in a cell editor may still turn out
     * to be a mapping (`jk` after its `j`): editors hide their completion
     * list meanwhile, so it does not flash up and away.
     */
    waiting,

    /** keydown in normal mode. */
    onNormalKeyDown(event: React.KeyboardEvent): void {
      mappedKeyDown(normal, event)
    },

    /** keydown in visual mode (rows selected), with its own mappings. */
    onVisualKeyDown(event: React.KeyboardEvent): void {
      mappedKeyDown(visual, event)
    },

    /**
     * keydown in a cell editor (insert mode). Characters are typed by the
     * field itself; when the last ones complete a mapping, `erase` takes
     * them back out before the mapping runs.
     */
    onInsertKeyDown(event: React.KeyboardEvent, erase: (n: number) => void) {
      // Keys that compose Chinese input belong to the input method.
      if (event.nativeEvent.isComposing) return
      const key = keyOf(event)
      if (!key) return
      const mapped = insert.feed(key, Date.now())
      noteWaiting()
      if (mapped) {
        event.preventDefault()
        if (mapped.erase > 0) erase(mapped.erase)
        push(mapped.rhs)
        return
      }
      if (isPrintable(key)) return
      if (run(key)) event.preventDefault()
    },

    /** keydown in a field without mappings (the command line). */
    onTextKeyDown(event: React.KeyboardEvent) {
      if (event.nativeEvent.isComposing) return
      const key = keyOf(event)
      if (!key || isPrintable(key)) return
      if (run(key)) event.preventDefault()
    },
  }
}
