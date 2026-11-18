import { useMatches } from '@tanstack/react-router'
import { $api } from '#/lib/api'
import { useEditorStatus } from '#/lib/editorStatus'
import { cn } from '#/lib/utils'

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    /** This page's name in the statusline, e.g. `第三方登入`. */
    crumb?: string
    /** The part of the app the page belongs to, e.g. `設定`. */
    section?: string
    /** The page uses the full width and height (the account register). */
    wide?: boolean
  }
}

/**
 * The editor's status line, fixed to the bottom of the app: the editing mode
 * when an editor is open, where you are, unsaved changes, and whether the
 * server is reachable.
 */
export function Statusline({ username }: { username: string }) {
  // The deepest matched route that names itself.
  const page = useMatches()
    .filter((match) => match.staticData.crumb)
    .at(-1)
  const here = page?.staticData.crumb
  // Pages inside a budget are placed under the budget's name.
  const budgetName = (
    page?.context as { budget?: { name: string } } | undefined
  )?.budget?.name
  const section = budgetName ?? page?.staticData.section
  const editor = useEditorStatus()

  return (
    <footer className="flex h-7 shrink-0 items-stretch border-t bg-sidebar font-mono text-xs text-muted-foreground">
      {editor && (
        <span
          data-testid="editor-mode"
          className={cn(
            'flex items-center px-3 font-semibold',
            editor.mode === 'normal' && 'bg-foreground text-background',
            // The selection's own colour, lighter than the kraft block beside it.
            editor.mode === 'visual' && 'bg-kraft/25 text-foreground',
            editor.mode === 'insert' && 'bg-positive text-background',
            editor.mode === 'command' && 'bg-muted text-foreground',
          )}
        >
          {modeLabels[editor.mode]}
        </span>
      )}
      {/* The kraft block is the broad place (a section, or a top-level page);
          the page inside a section follows it. */}
      <span className="flex items-center bg-kraft px-3 font-semibold text-primary-foreground">
        {section ?? here ?? 'Factual'}
      </span>
      {section && here && (
        <span className="flex items-center border-r px-3 text-foreground">
          {here}
        </span>
      )}
      <span className="flex-1" />
      {editor && editor.dirty > 0 && (
        <span className="flex items-center border-l px-3 text-kraft">
          {editor.dirty} 筆未儲存
        </span>
      )}
      <Connection />
      <span className="flex items-center border-l px-3">{username}</span>
    </footer>
  )
}

// Vim's own names for its modes, which is what its users look for.
const modeLabels = {
  normal: 'NORMAL',
  visual: 'V-LINE',
  insert: 'INSERT',
  command: 'COMMAND',
} as const

function Connection() {
  const health = $api.useQuery(
    'get',
    '/healthz',
    {},
    { retry: false, refetchInterval: 30_000 },
  )
  const state =
    health.data?.status === 'ok'
      ? 'ok'
      : health.isError || health.data
        ? 'down'
        : 'pending'
  const label = { ok: '已連線', down: '無法連線', pending: '連線中' }[state]

  return (
    <span
      className={cn(
        'flex items-center gap-2 border-l px-3',
        state === 'down' && 'text-destructive',
      )}
      data-testid="api-status"
      data-state={state}
    >
      <span
        aria-hidden="true"
        className={cn(
          'size-1.5 rounded-full',
          state === 'ok' && 'bg-positive',
          state === 'down' && 'bg-destructive',
          state === 'pending' && 'bg-muted-foreground',
        )}
      />
      {label}
    </span>
  )
}
