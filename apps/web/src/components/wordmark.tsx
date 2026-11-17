import { cn } from '#/lib/utils'

/**
 * "Factual" followed by a block cursor. The cursor blinks only where the
 * page is waiting for input (the login page); elsewhere it stands still.
 */
export function Wordmark({
  blink = false,
  className,
}: {
  blink?: boolean
  className?: string
}) {
  return (
    <span className={cn('font-mono font-bold tracking-tight', className)}>
      Factual
      <span
        aria-hidden="true"
        className={cn('cursor-block', blink && 'cursor-blink')}
      />
    </span>
  )
}
