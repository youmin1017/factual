import { CalendarIcon } from 'lucide-react'
import { useState } from 'react'
import { zhTW } from 'react-day-picker/locale'
import { Button } from '#/components/ui/button'
import { Calendar } from '#/components/ui/calendar'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '#/components/ui/popover'
import { isoDate } from '#/lib/register'
import { cn } from '#/lib/utils'

/** A local date from `YYYY-MM-DD`; undefined when it is not one. */
function fromIso(iso: string): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : undefined
}

/**
 * A date field: the shadcn calendar in a popover, instead of the browser's
 * own date input, so it looks the same in every browser and both themes.
 * Dates go in and out as `YYYY-MM-DD`; months and years have dropdowns, so
 * a loan's 撥款日 years back is two picks away.
 */
export function DatePicker({
  value,
  onChange,
  id,
  disabled,
  className,
  placeholder = '選擇日期',
  'aria-label': ariaLabel,
  'aria-invalid': ariaInvalid,
}: {
  value: string
  onChange: (iso: string) => void
  id?: string
  disabled?: boolean
  className?: string
  placeholder?: string
  'aria-label'?: string
  'aria-invalid'?: boolean
}) {
  const [open, setOpen] = useState(false)
  const selected = fromIso(value)
  const thisYear = new Date().getFullYear()
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          disabled={disabled}
          aria-label={ariaLabel}
          aria-invalid={ariaInvalid}
          className={cn(
            'justify-start px-3 font-mono font-normal',
            !selected && 'text-muted-foreground',
            className,
          )}
        >
          <CalendarIcon className="text-muted-foreground" />
          {selected ? value.replaceAll('-', '/') : placeholder}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          locale={zhTW}
          captionLayout="dropdown"
          startMonth={new Date(thisYear - 50, 0)}
          endMonth={new Date(thisYear + 50, 11)}
          selected={selected}
          defaultMonth={selected}
          formatters={{ formatMonthDropdown: (d) => `${d.getMonth() + 1}月` }}
          autoFocus
          onSelect={(d) => {
            if (!d) return
            onChange(isoDate(d))
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}
