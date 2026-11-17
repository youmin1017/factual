import { formatAmount } from '#/lib/money'
import { cn } from '#/lib/utils'

/** A money amount in monospaced figures; negatives in red (赤字). */
export function Amount({
  value,
  minorUnits,
  className,
}: {
  value: number
  minorUnits: number
  className?: string
}) {
  return (
    <span
      className={cn('amount', value < 0 && 'amount-negative', className)}
      data-value={value}
    >
      {formatAmount(value, minorUnits)}
    </span>
  )
}
