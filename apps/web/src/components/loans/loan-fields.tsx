import { useQuery } from '@tanstack/react-query'
import { PlusIcon, XIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Amount } from '#/components/amount'
import { DatePicker } from '#/components/date-picker'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#/components/ui/select'
import { api } from '#/lib/api'
import { accountsQuery, categoriesQuery } from '#/lib/budget'
import {
  methodLabels,
  monthAfter,
  parseLoanFields,
  payment,
  prepayLabels,
  shiftLabels,
} from '#/lib/loan'
import { categoryRefs, formatDate, isoDate } from '#/lib/register'
import { cn } from '#/lib/utils'
import { PeriodTable } from './period-table'
import type {
  LoanField,
  LoanFieldValues,
  LoanMethod,
  LoanPreview,
  LoanShift,
  PrepayMode,
} from '#/lib/loan'

const NONE = 'none'

export interface LoanFormProblem {
  field: LoanField | null
  message: string
}

/**
 * A loan's terms as typed (ADR-096), with the table they give previewed
 * as they are typed (`POST .../loans/preview`, which needs no account, so
 * the same fields serve a loan account being created, ADR-100). The caller
 * keeps the values and saves them.
 */
export function LoanFields({
  budgetId,
  minorUnits: mu,
  values: v,
  onChange,
  problem,
}: {
  budgetId: string
  minorUnits: number
  values: LoanFieldValues
  onChange: (values: LoanFieldValues) => void
  problem: LoanFormProblem | null
}) {
  const accounts = useQuery(accountsQuery(budgetId))
  const categories = useQuery(categoriesQuery(budgetId))
  const [preview, setPreview] = useState<LoanPreview | null>(null)

  useEffect(() => {
    const terms = parseLoanFields(v, mu)
    if ('field' in terms) return
    const timer = setTimeout(async () => {
      const { data } = await api.POST('/budgets/{budgetId}/loans/preview', {
        params: { path: { budgetId } },
        body: terms,
      })
      if (data) setPreview(data)
    }, 300)
    return () => clearTimeout(timer)
  }, [v, mu, budgetId])

  const set = (patch: Partial<LoanFieldValues>) => onChange({ ...v, ...patch })
  const payers = (accounts.data ?? []).filter(
    (a) => a.onBudget && !a.closed && a.kind !== 'credit_card',
  )
  const expense = [...categoryRefs(categories.data ?? []).values()]
    .filter((c) => c.kind === 'expense' && !c.isSystem && !c.archived)
    .sort((a, b) => a.path.localeCompare(b.path))

  const bad = (field: LoanField) => problem?.field === field
  const text = (
    field: 'principal' | 'months' | 'grace',
    label: string,
    placeholder: string,
  ) => (
    <div className="space-y-1.5">
      <Label htmlFor={`loan-${field}`}>{label}</Label>
      <Input
        id={`loan-${field}`}
        inputMode={field === 'principal' ? 'decimal' : 'text'}
        className={cn('font-mono', bad(field) && 'border-destructive')}
        placeholder={placeholder}
        value={v[field]}
        onChange={(e) => set({ [field]: e.target.value })}
      />
    </div>
  )
  const date = (field: 'start' | 'firstPayment', label: string) => (
    <div className="space-y-1.5">
      <Label htmlFor={`loan-${field}`}>{label}</Label>
      <DatePicker
        id={`loan-${field}`}
        className={cn('w-full', bad(field) && 'border-destructive')}
        aria-invalid={bad(field)}
        value={v[field]}
        onChange={(next) => {
          // A new 撥款日 moves the first payment along when it followed it.
          if (field === 'start' && v.firstPayment === monthAfter(v.start))
            set({ start: next, firstPayment: monthAfter(next) })
          else set({ [field]: next })
        }}
      />
    </div>
  )
  const choice = <T extends string>(
    id: string,
    label: string,
    value: T,
    options: Record<T, string>,
    pick: (value: T) => void,
  ) => (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={(x) => pick(x as T)}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(options) as Array<T>).map((k) => (
            <SelectItem key={k} value={k}>
              {options[k]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
  const category = (
    field: 'principalCategory' | 'interestCategory',
    label: string,
  ) => (
    <div className="space-y-1.5">
      <Label htmlFor={`loan-${field}`}>{label}</Label>
      <Select
        value={v[field] || NONE}
        onValueChange={(x) => set({ [field]: x === NONE ? '' : x })}
      >
        <SelectTrigger
          id={`loan-${field}`}
          className={cn('w-full', bad(field) && 'border-destructive')}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>選擇分類</SelectItem>
          {expense.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {c.path}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )

  const now = new Date()
  const last = preview?.periods.at(-1)
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {text('principal', '撥款金額', '1,000,000')}
        {date('start', '撥款日')}
        {date('firstPayment', '首期繳款日')}
        {text('months', '期數（月）', '240 或 20年')}
        {text('grace', '寬限期（月）', '0')}
        {choice<LoanMethod>(
          'loan-method',
          '攤還方式',
          v.method,
          methodLabels,
          (method) => set({ method }),
        )}
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">年利率</legend>
        {v.rates.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <DatePicker
              aria-label={i === 0 ? '從撥款日起' : `第 ${i + 1} 段的生效日`}
              className="w-40"
              disabled={i === 0}
              value={i === 0 ? v.start : r.from}
              onChange={(from) =>
                set({ rates: v.rates.with(i, { ...r, from }) })
              }
            />
            <Input
              aria-label={`第 ${i + 1} 段年利率`}
              inputMode="decimal"
              className={cn(
                'w-24 font-mono',
                bad('rates') && 'border-destructive',
              )}
              placeholder="2.35"
              value={r.rate}
              onChange={(e) =>
                set({ rates: v.rates.with(i, { ...r, rate: e.target.value }) })
              }
            />
            <span className="text-sm text-muted-foreground">%</span>
            {i === 0 ? (
              <span className="text-xs text-muted-foreground">從撥款日起</span>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="刪除這段利率"
                onClick={() =>
                  set({ rates: v.rates.filter((_, j) => j !== i) })
                }
              >
                <XIcon />
              </Button>
            )}
          </div>
        ))}
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0"
          onClick={() =>
            set({
              rates: [
                ...v.rates,
                { from: isoDate(now), rate: v.rates.at(-1)?.rate ?? '' },
              ],
            })
          }
        >
          <PlusIcon />
          利率調整
        </Button>
        <p className="text-xs text-muted-foreground">
          機動利率調過幾次就加幾段；只影響還沒入帳的期數。
        </p>
      </fieldset>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="loan-payFrom">扣款帳戶</Label>
          <Select
            value={v.payFrom || NONE}
            onValueChange={(x) => set({ payFrom: x === NONE ? '' : x })}
          >
            <SelectTrigger
              id="loan-payFrom"
              className={cn('w-full', bad('payFrom') && 'border-destructive')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>不自動還款（自己記）</SelectItem>
              {payers.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  從「{a.name}」扣款
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {v.payFrom && category('principalCategory', '本金記在')}
        {v.payFrom && category('interestCategory', '利息記在')}
        {choice<PrepayMode>(
          'loan-prepay',
          '提前還款時',
          v.prepay,
          prepayLabels,
          (prepay) => set({ prepay }),
        )}
        {v.payFrom &&
          choice<LoanShift>(
            'loan-shift',
            '扣款日遇假日',
            v.shift,
            shiftLabels,
            (shift) => set({ shift }),
          )}
      </div>

      {problem && (
        <p className="text-sm text-destructive" role="alert">
          {problem.message}
        </p>
      )}

      {preview && (
        <div className="space-y-2 rounded-md border border-rule p-3">
          <p className="text-sm">
            每月 <Amount value={preview.payment} minorUnits={mu} />
            <span className="text-muted-foreground">
              {' '}
              · 共 {preview.periods.length} 期 · 總利息{' '}
            </span>
            <Amount value={preview.totalInterest} minorUnits={mu} />
            {last && (
              <span className="text-muted-foreground">
                {' '}
                · {formatDate(last.date, now)} 還清
              </span>
            )}
          </p>
          <PeriodTable
            periods={preview.periods}
            minorUnits={mu}
            now={now}
            className="max-h-48"
          />
          <p className="text-xs text-muted-foreground">
            「設定前」是今天以前的期數，當作已經照表繳過。和銀行的還款明細差幾元是正常的，存檔後可以對齊。
            {preview.periods[0] &&
              payment(preview.periods[0]) !== preview.payment &&
              ' 首期不滿一個月時按天數計息。'}
          </p>
        </div>
      )}
    </div>
  )
}
