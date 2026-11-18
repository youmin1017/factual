import { useSyncExternalStore } from 'react'

/**
 * What the editor tells the status line: its mode and how many rows are not
 * saved yet. `null` when no editor is on the page.
 */
export interface EditorStatus {
  mode: 'normal' | 'visual' | 'insert' | 'command'
  dirty: number
}

let current: EditorStatus | null = null
const listeners = new Set<() => void>()

export function setEditorStatus(next: EditorStatus | null): void {
  if (
    current === next ||
    (current &&
      next &&
      current.mode === next.mode &&
      current.dirty === next.dirty)
  ) {
    return
  }
  current = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useEditorStatus(): EditorStatus | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  )
}
