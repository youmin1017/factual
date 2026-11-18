import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { $api } from './api'
import { emptyKeymap, parseKeymap } from './keymap'
import type { Keymap } from './keymap'

export function preferencesQuery() {
  return $api.queryOptions('get', '/me/preferences')
}

/**
 * The user's editor key mappings (ADR-070). Lines with errors are skipped;
 * the profile page shows them.
 */
export function useKeymap(): Keymap {
  const { data } = useQuery(preferencesQuery())
  const text = data?.editorKeymap ?? ''
  return useMemo(() => (text ? parseKeymap(text).keymap : emptyKeymap), [text])
}
