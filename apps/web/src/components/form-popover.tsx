import { useEffect, useRef } from 'react'
import { shownValue } from '#/lib/form'
import { cn } from '#/lib/utils'
import type { Field, FormState } from '#/lib/form'

/**
 * A form laid under a grid cell (ADR-107): one field per line, the one with
 * the cursor marked as the grid marks its cursor. Keys come through the
 * grid's key feed (`onKeyDown`); the mouse picks a field or an option.
 */
export function FormPopover({
  title,
  fields,
  state,
  preview,
  width,
  onKeyDown,
  onField,
  onChoose,
}: {
  title: string
  fields: Array<Field>
  state: FormState
  /** What the values come to, under the fields. */
  preview?: string
  width: number
  onKeyDown: (event: React.KeyboardEvent) => void
  onField: (key: string) => void
  onChoose: (key: string, value: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.focus({ preventScroll: true })
  }, [])

  return (
    <div
      ref={ref}
      tabIndex={0}
      role="group"
      aria-label={title}
      data-editor
      onKeyDown={onKeyDown}
      className="overflow-hidden rounded-md border-2 border-positive bg-popover text-sm shadow-md outline-none"
      style={{ width: Math.max(width, 320) }}
    >
      <div className="border-b border-rule px-2 py-1.5 font-medium">
        {title}
      </div>
      <ul className="py-1">
        {fields.map((f) => {
          const at = f.key === state.field
          const value = state.values[f.key] ?? ''
          return (
            <li
              key={f.key}
              aria-current={at || undefined}
              onMouseDown={(e) => {
                e.preventDefault()
                onField(f.key)
              }}
              className={cn(
                'flex min-h-7 cursor-default items-center gap-3 border-l-2 border-transparent px-2 py-0.5',
                at && 'border-kraft bg-kraft/20',
              )}
            >
              <span className="w-16 shrink-0 text-xs text-muted-foreground">
                {f.label}
              </span>
              {f.type === 'choice' ? (
                <span className="flex flex-wrap gap-1">
                  {f.options.map((o, i) => (
                    <button
                      key={o.value}
                      type="button"
                      tabIndex={-1}
                      title={i < 9 ? `${i + 1}` : undefined}
                      onMouseDown={(e) => {
                        e.preventDefault()
                        onChoose(f.key, o.value)
                      }}
                      className={cn(
                        'rounded-sm border border-transparent px-1.5 text-xs leading-5',
                        o.value === value
                          ? 'bg-positive/25 text-foreground'
                          : 'text-muted-foreground',
                        at && o.value === value && 'border-kraft',
                      )}
                    >
                      {o.label}
                    </button>
                  ))}
                </span>
              ) : (
                <TypedValue
                  text={(at ? state.typed : null) ?? shownValue(f, value)}
                  caret={at ? state.caret : null}
                  placeholder={f.placeholder}
                  suffix={f.suffix}
                  mono={f.type !== 'text'}
                />
              )}
            </li>
          )
        })}
      </ul>
      {(state.error || preview) && (
        <div
          role={state.error ? 'alert' : undefined}
          className={cn(
            'border-t border-rule px-2 py-1 text-xs',
            state.error ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {state.error ?? preview}
        </div>
      )}
    </div>
  )
}

/** A typed value; while edited, the caret where it is in the text. */
function TypedValue({
  text,
  caret,
  placeholder,
  suffix,
  mono,
}: {
  text: string
  caret: number | null
  placeholder?: string
  suffix?: string
  mono: boolean
}) {
  const at = caret === null ? null : Math.min(caret, text.length)
  return (
    <span className="flex items-center gap-1 whitespace-pre">
      <span className={cn('relative', mono && 'font-mono')}>
        {text === '' && placeholder && at === null ? (
          <span className="text-muted-foreground">{placeholder}</span>
        ) : at === null ? (
          text
        ) : (
          <>
            {text.slice(0, at)}
            <span
              aria-hidden
              className="absolute -ml-px h-4 w-0.5 translate-y-0.5 animate-pulse bg-foreground"
            />
            {text.slice(at)}
          </>
        )}
      </span>
      {suffix && (
        <span className="text-xs text-muted-foreground">{suffix}</span>
      )}
    </span>
  )
}
