import { cn } from '#/lib/utils'

/**
 * The app's mark: the ledger's F in kraft and a coin on ink (public/
 * favicon.svg, also the browser tab's icon). Its colours are the brand's
 * own, so it looks the same in both themes; it goes before the wordmark,
 * which says the name.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <img
      src="/favicon.svg"
      alt=""
      aria-hidden="true"
      draggable={false}
      className={cn('size-6 shrink-0', className)}
    />
  )
}
