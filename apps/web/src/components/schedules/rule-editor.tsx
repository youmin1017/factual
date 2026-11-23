import { useEffect, useRef } from 'react'
import {
  fieldLabels,
  fieldParts,
  formFields,
  formText,
  isChoice,
  isText,
  weekdayLabels,
} from '#/lib/rule-form'
import { cn } from '#/lib/utils'
import type { FieldKey, RuleFormState } from '#/lib/rule-form'

/**
 * The rule editor (ADR-084), laid under the rule cell: one field per line,
 * the one with the cursor marked as the grid marks its cursor. Keys come
 * through the grid's key feed (`onKeyDown`); the mouse picks a field and
 * toggles weekdays.
 */
export function RuleEditor({
  state,
  width,
  preview,
  onKeyDown,
  onField,
  onDay,
}: {
  state: RuleFormState
  width: number
  /** The dates the rule gives, as shown in the status line. */
  preview: string
  onKeyDown: (event: React.KeyboardEvent) => void
  onField: (field: FieldKey) => void
  onDay: (day: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.focus({ preventScroll: true })
  }, [])
  const fields = formFields(state.form)

  return (
    <div
      ref={ref}
      tabIndex={0}
      role="group"
      aria-label="週期"
      data-editor
      onKeyDown={onKeyDown}
      className="overflow-hidden rounded-md border-2 border-positive bg-popover text-sm shadow-md outline-none"
      style={{ width: Math.max(width, 300) }}
    >
      <div className="border-b border-rule px-2 py-1.5 font-medium">
        {formText(state.form)}
      </div>
      <ul className="py-1">
        {fields.map((f) => {
          const at = f === state.field
          return (
            <li
              key={f}
              aria-current={at || undefined}
              onMouseDown={(e) => {
                e.preventDefault()
                onField(f)
              }}
              className={cn(
                'flex h-7 cursor-default items-center gap-3 border-l-2 border-transparent px-2',
                at && 'border-kraft bg-kraft/20',
              )}
            >
              <span className="w-12 shrink-0 text-xs text-muted-foreground">
                {fieldLabels[f]}
              </span>
              {f === 'weekdays' ? (
                <span className="flex gap-1">
                  {weekdayLabels.map((label, day) => (
                    <button
                      key={label}
                      type="button"
                      tabIndex={-1}
                      onMouseDown={(e) => {
                        e.preventDefault()
                        onDay(day)
                      }}
                      className={cn(
                        'size-6 rounded-sm border border-transparent text-xs',
                        state.form.weekdays.includes(day)
                          ? 'bg-positive/25 text-foreground'
                          : 'text-muted-foreground',
                        at && state.dayCursor === day && 'border-kraft',
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </span>
              ) : (
                <FieldValue
                  parts={fieldParts(state, f)}
                  choice={isChoice(f) && at}
                  mono={isText(f)}
                />
              )}
            </li>
          )
        })}
      </ul>
      <div className="border-t border-rule px-2 py-1 text-xs text-muted-foreground">
        {preview}
      </div>
    </div>
  )
}

/** A field's value; while edited, the caret where it is in the text. */
function FieldValue({
  parts,
  choice,
  mono,
}: {
  parts: ReturnType<typeof fieldParts>
  /** The cursor is on a choice: shown between ‹ ›. */
  choice: boolean
  mono: boolean
}) {
  const { before, text, after, caret } = parts
  return (
    <span className="flex items-center gap-1">
      {choice && <span className="text-muted-foreground">‹</span>}
      <span className="whitespace-pre">
        {before}
        {caret === null ? (
          <span className={cn(mono && 'font-mono')}>{text}</span>
        ) : (
          <span className={cn('relative', mono && 'font-mono')}>
            {text.slice(0, caret)}
            <span
              aria-hidden
              className="absolute -ml-px h-4 w-0.5 translate-y-0.5 animate-pulse bg-foreground"
            />
            {text.slice(caret)}
          </span>
        )}
        {after}
      </span>
      {choice && <span className="text-muted-foreground">›</span>}
    </span>
  )
}
