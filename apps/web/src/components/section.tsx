import { cn } from '#/lib/utils'

/** The page heading with an optional action on the right. */
export function PageHeader({
  title,
  children,
}: {
  title: string
  children?: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b pb-4">
      <h1 className="text-2xl font-semibold">{title}</h1>
      {children}
    </div>
  )
}

/**
 * One part of a settings page: what it is on the left, the controls on the
 * right, a rule between parts. Parts stack on narrow screens.
 */
export function Section({
  title,
  description,
  stacked,
  children,
}: {
  title: string
  description?: React.ReactNode
  /** The controls under the title, the page's whole width (a wide table). */
  stacked?: boolean
  children: React.ReactNode
}) {
  return (
    <section
      className={cn(
        'grid gap-x-10 gap-y-4 border-b py-8 last:border-b-0',
        !stacked && 'md:grid-cols-[14rem_1fr]',
      )}
    >
      <div className="space-y-1">
        <h2 className="font-medium">{title}</h2>
        {description && (
          <p className="text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  )
}
