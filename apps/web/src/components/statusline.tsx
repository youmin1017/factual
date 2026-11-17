import { useMatches } from '@tanstack/react-router'
import { $api } from '#/lib/api'
import { cn } from '#/lib/utils'

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    /** This page's name in the statusline, e.g. `第三方登入`. */
    crumb?: string
    /** The part of the app the page belongs to, e.g. `設定`. */
    section?: string
  }
}

/**
 * The editor's status line, fixed to the bottom of the app: where you are,
 * and whether the server is reachable. Editing mode and unsaved changes will
 * live here too.
 */
export function Statusline({ username }: { username: string }) {
  // The deepest matched route that names itself.
  const page = useMatches()
    .filter((match) => match.staticData.crumb)
    .at(-1)
  const here = page?.staticData.crumb
  const section = page?.staticData.section

  return (
    <footer className="flex h-7 shrink-0 items-stretch border-t bg-sidebar font-mono text-xs text-muted-foreground">
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
      <Connection />
      <span className="flex items-center border-l px-3">{username}</span>
    </footer>
  )
}

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
