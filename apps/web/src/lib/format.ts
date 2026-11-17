const dateTime = new Intl.DateTimeFormat('zh-TW', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

/** A date-time from the API for display; `fallback` when there is none. */
export function formatDateTime(
  value: string | null | undefined,
  fallback = '—',
): string {
  if (!value) return fallback
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? fallback : dateTime.format(date)
}
