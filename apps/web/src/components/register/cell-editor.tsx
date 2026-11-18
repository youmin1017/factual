import { cn } from '#/lib/utils'

export interface Suggestion {
  value: string
  label: string
  hint?: string
}

/**
 * The one text field of an editor (ADR-045), laid over the cell being
 * edited, with its completion list.
 */
export function CellEditor({
  inputRef,
  value,
  label,
  numeric,
  width,
  options,
  pick,
  onChange,
  onKeyDown,
  onChoose,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>
  value: string
  label: string
  /** Dates and amounts: monospaced; amounts also right-aligned. */
  numeric?: 'date' | 'amount'
  width: number
  options: Array<Suggestion>
  /** The option Enter takes, highlighted; -1 when Enter keeps the text. */
  pick: number
  onChange: (value: string) => void
  onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void
  /** A suggestion clicked with the mouse. */
  onChoose: (index: number) => void
}) {
  return (
    <>
      <input
        ref={inputRef}
        autoFocus
        value={value}
        aria-label={label}
        aria-autocomplete={options.length > 0 ? 'list' : undefined}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        className={cn(
          'h-8 w-full border-2 border-positive bg-popover px-2 text-sm outline-none',
          numeric && 'font-mono',
          numeric === 'amount' && 'text-right',
        )}
      />
      {options.length > 0 && (
        <div
          className="mt-1 min-w-full overflow-hidden rounded-md border bg-popover text-sm shadow-md"
          style={{ width: Math.max(width, 240) }}
        >
          <ul role="listbox" className="max-h-64 overflow-auto py-1">
            {options.map((o, i) => (
              <li
                key={o.value}
                role="option"
                aria-selected={i === pick}
                // Ctrl-n/Ctrl-p past the edge of the list scroll it along.
                ref={
                  i === pick
                    ? (el) => el?.scrollIntoView({ block: 'nearest' })
                    : undefined
                }
                onMouseDown={(e) => {
                  e.preventDefault()
                  onChoose(i)
                }}
                // The picked option looks like the selection in the grid.
                className={cn(
                  'flex cursor-default items-center justify-between gap-3 border-l-2 border-transparent px-2 py-1 hover:bg-muted',
                  i === pick &&
                    'border-kraft bg-kraft/20 text-foreground hover:bg-kraft/20',
                )}
              >
                <span className="truncate">{o.label}</span>
                {o.hint && (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {o.hint}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {/* Nothing highlighted: say what Enter does instead. */}
          {pick < 0 && (
            <p className="border-t px-2 py-1 text-xs text-muted-foreground">
              {value.trim() === '' ? 'Enter 留空' : 'Enter 用你打的字'} · ↓
              選建議
            </p>
          )}
        </div>
      )}
    </>
  )
}

/**
 * The option Ctrl-n (`step` 1) or Ctrl-p (-1) moves to from `from`, wrapping;
 * with nothing highlighted they start at the first or the last.
 */
export function nextPick(count: number, from: number, step: 1 | -1): number {
  if (count === 0) return 0
  if (from < 0) return step === 1 ? 0 : count - 1
  return (from + step + count) % count
}

/** Removes the n characters before the caret of a cell editor. */
export function eraseBeforeCaret(
  input: HTMLInputElement | null,
  text: string,
  n: number,
): string {
  const caret = input?.selectionStart ?? text.length
  return text.slice(0, Math.max(0, caret - n)) + text.slice(caret)
}
