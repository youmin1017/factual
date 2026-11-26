import { useLayoutEffect } from 'react'
import { zhTW } from 'react-day-picker/locale'
import { Calendar } from '#/components/ui/calendar'
import { isoDate } from '#/lib/register'
import { cn } from '#/lib/utils'

export interface Suggestion {
  value: string
  label: string
  hint?: string
}

/**
 * The one text field of an editor (ADR-045), laid over the cell being
 * edited, with its completion list. It is a line of editable text laid out
 * as the cell's own text is, not an input: an input places a line with
 * Chinese (a fallback font after Recursive) about a pixel lower than a cell
 * does, so the text would move when editing starts (ADR-119).
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
  calendar,
}: {
  inputRef: React.RefObject<HTMLElement | null>
  value: string
  label: string
  /** Dates and amounts: monospaced; amounts also right-aligned. */
  numeric?: 'date' | 'amount'
  width: number
  options: Array<Suggestion>
  /** The option Enter takes, highlighted; -1 when Enter keeps the text. */
  pick: number
  onChange: (value: string) => void
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void
  /** A suggestion clicked with the mouse. */
  onChoose: (index: number) => void
  /**
   * A date cell: a calendar under the field, on the date typed so far
   * (`value`, ISO or ''); a day clicked is taken at once.
   */
  calendar?: { value: string; onPick: (iso: string) => void }
}) {
  const day = calendar ? fromIso(calendar.value) : undefined
  const thisYear = new Date().getFullYear()
  return (
    <>
      <TextField
        fieldRef={inputRef}
        value={value}
        label={label}
        numeric={numeric}
        listed={options.length > 0}
        onChange={onChange}
        onKeyDown={onKeyDown}
      />
      {calendar && options.length === 0 && (
        <div className="mt-1 w-fit rounded-md border bg-popover shadow-md">
          <Calendar
            key={calendar.value}
            mode="single"
            // Clicking the day already chosen takes it too.
            required
            locale={zhTW}
            captionLayout="dropdown"
            startMonth={new Date(thisYear - 50, 0)}
            endMonth={new Date(thisYear + 50, 11)}
            selected={day}
            defaultMonth={day}
            formatters={{
              formatMonthDropdown: (d) => `${d.getMonth() + 1}月`,
            }}
            onSelect={(d) => {
              calendar.onPick(isoDate(d))
            }}
          />
        </div>
      )}
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
  field: HTMLElement | null,
  text: string,
  n: number,
): string {
  const caret = caretOf(field) ?? text.length
  return text.slice(0, Math.max(0, caret - n)) + text.slice(caret)
}

/** Where the caret is in a cell editor's text, or null when it is not in it. */
function caretOf(field: HTMLElement | null): number | null {
  if (!field) return null
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || !field.contains(sel.focusNode))
    return null
  const range = document.createRange()
  range.selectNodeContents(field)
  range.setEnd(sel.focusNode as Node, sel.focusOffset)
  return range.toString().length
}

/** Puts the caret after the text of an editable element. */
function caretToEnd(el: HTMLElement) {
  const sel = window.getSelection()
  if (!sel) return
  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(false)
  sel.removeAllRanges()
  sel.addRange(range)
}

/**
 * One line of editable plain text in the cell's box, laid out as the cell's
 * own text is (a flex line, leading-normal), so the text stays where it was
 * when editing starts, Chinese included. The DOM holds what is typed (input
 * methods compose in it); `value` is written back only when it changes
 * from outside (a completion taken, Ctrl-w), with the caret at the end as
 * an input would put it.
 */
function TextField({
  fieldRef,
  value,
  label,
  numeric,
  listed,
  onChange,
  onKeyDown,
}: {
  fieldRef: React.RefObject<HTMLElement | null>
  value: string
  label: string
  numeric?: 'date' | 'amount'
  listed: boolean
  onChange: (value: string) => void
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void
}) {
  useLayoutEffect(() => {
    const el = fieldRef.current
    if (!el) return
    if (el.textContent !== value) {
      el.textContent = value
      if (document.activeElement === el) caretToEnd(el)
    }
  }, [fieldRef, value])
  useLayoutEffect(() => {
    const el = fieldRef.current
    if (!el) return
    el.focus({ preventScroll: true })
    caretToEnd(el)
  }, [fieldRef])

  return (
    <div
      className={cn(
        // The cursor's box, with the line where the cell's text is: px-1.5
        // and the 2px border make the cell's px-2, pb-px leaves the 31px a
        // row has above its bottom border.
        'flex h-8 w-full cursor-text items-center border-2 border-positive bg-popover px-1.5 pb-px text-sm leading-normal',
        numeric && 'font-mono',
      )}
      onMouseDown={(e) => {
        // A click beside the text still edits it.
        if (e.target !== fieldRef.current) {
          e.preventDefault()
          fieldRef.current?.focus()
        }
      }}
    >
      <span
        ref={fieldRef}
        role="textbox"
        aria-label={label}
        aria-autocomplete={listed ? 'list' : undefined}
        contentEditable="plaintext-only"
        suppressContentEditableWarning
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        className={cn(
          'min-w-0 flex-1 overflow-x-auto whitespace-pre outline-none [scrollbar-width:none]',
          numeric === 'amount' && 'text-right',
        )}
        onKeyDown={onKeyDown}
        onBeforeInput={(e) => {
          // One line: Enter is the editor's, never a line break.
          const type = e.nativeEvent.inputType
          if (type === 'insertParagraph' || type === 'insertLineBreak')
            e.preventDefault()
        }}
        onInput={(e) => {
          const el = e.currentTarget
          const raw = el.textContent
          // Pasted line breaks become spaces.
          const clean = raw.replace(/[\r\n]+/g, ' ')
          if (clean !== raw) {
            el.textContent = clean
            caretToEnd(el)
          }
          onChange(clean)
        }}
      />
    </div>
  )
}

/** A local date from `YYYY-MM-DD`; undefined when it is not one. */
function fromIso(iso: string): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : undefined
}
