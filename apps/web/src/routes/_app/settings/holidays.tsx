import { useQueryClient } from '@tanstack/react-query'
import { createFileRoute, redirect } from '@tanstack/react-router'
import {
  DownloadIcon,
  RefreshCwIcon,
  Trash2Icon,
  UploadIcon,
} from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { ConfirmDialog } from '#/components/dialogs'
import { PageHeader, Section } from '#/components/section'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { $api } from '#/lib/api'
import { apiErrorMessage } from '#/lib/apiError'
import { can } from '#/lib/auth'
import type { Schemas } from '#/lib/api'

type HolidayYear = Schemas['HolidayYear']

export const Route = createFileRoute('/_app/settings/holidays')({
  staticData: { crumb: '國定假日', section: '設定' },
  // Only for the UI; the API checks the permission on its own (ADR-131).
  beforeLoad: ({ context }) => {
    if (!can(context.user, 'manage_holidays')) throw redirect({ to: '/' })
  },
  component: HolidaysPage,
})

// Days off for schedules that move off them (ADR-087): the government's
// office calendar, imported a year at a time by the instance admin.

function rocYear(year: number): number {
  return year - 1911
}

function HolidaysPage() {
  const queryClient = useQueryClient()
  const years = $api.useQuery('get', '/holidays/years')
  const yearsKey = $api.queryOptions('get', '/holidays/years').queryKey
  const [url, setUrl] = useState('')
  const [deleting, setDeleting] = useState<HolidayYear | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: yearsKey }),
      // Schedules show when occurrences are posted with the calendar.
      queryClient.invalidateQueries({ queryKey: ['get', '/holidays'] }),
    ])
  }

  const importer = $api.useMutation('post', '/holidays/import', {
    onSuccess: async (imported) => {
      toast.success(
        `已匯入 ${imported.map((y) => `${y.year}（民國 ${rocYear(y.year)} 年）`).join('、')}`,
      )
      setUrl('')
      await refresh()
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const remove = $api.useMutation('delete', '/holidays/years/{year}', {
    onSuccess: async () => {
      toast.success('已刪除這一年的行事曆')
      setDeleting(null)
      await refresh()
    },
    onError: (e) => {
      toast.error(apiErrorMessage(e))
      setDeleting(null)
    },
  })

  async function importFile(file: File) {
    if (file.size > 1_000_000) {
      toast.error('檔案超過 1 MB')
      return
    }
    importer.mutate({ body: { csv: await file.text() } })
  }

  const list = years.data ?? []

  return (
    <div className="space-y-6">
      <PageHeader title="國定假日" />

      <Section
        title="匯入"
        description={
          <>
            排程遇到放假日要延後或提前時，依照人事行政總處的「中華民國政府行政機關辦公日曆表」，補假、調整放假和補班都已算在裡面。沒有匯入的年份，只把週六、週日當放假日。
          </>
        }
      >
        <div className="space-y-4">
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault()
              if (url.trim()) importer.mutate({ body: { url: url.trim() } })
            }}
          >
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="CSV 的網址（檔名結尾是 utf8bom.csv 的版本）"
              aria-label="CSV 的網址"
              className="font-mono text-xs"
            />
            <Button type="submit" disabled={!url.trim() || importer.isPending}>
              <DownloadIcon />
              從網址匯入
            </Button>
          </form>
          <div className="flex items-center gap-3">
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (file) void importFile(file)
              }}
            />
            <Button
              variant="outline"
              disabled={importer.isPending}
              onClick={() => fileRef.current?.click()}
            >
              <UploadIcon />
              選擇 CSV 檔案
            </Button>
            <p className="text-xs text-muted-foreground">
              在人事行政總處網站下載「XXX 年中華民國政府行政機關辦公日曆表」的
              CSV（UTF-8 版本）。
            </p>
          </div>
        </div>
      </Section>

      <Section
        title="已匯入的年份"
        description="匯入同一年會取代原本的資料。已經入帳的交易不會因為之後匯入而改日期。"
      >
        {years.isError ? (
          <p className="text-sm text-destructive" role="alert">
            {apiErrorMessage(years.error)}
          </p>
        ) : list.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {years.isPending ? '載入中…' : '還沒有匯入任何年份。'}
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {list.map((y) => (
              <li key={y.year} className="flex items-center gap-4 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {y.year}
                    <span className="ml-2 text-sm font-normal text-muted-foreground">
                      民國 {rocYear(y.year)} 年 · 放假 {y.daysOff} 天
                    </span>
                  </p>
                  <p
                    className="truncate text-xs text-muted-foreground"
                    title={y.sourceUrl || undefined}
                  >
                    {y.sourceUrl ? y.sourceUrl : '從檔案匯入'} ·{' '}
                    {new Date(y.importedAt).toLocaleDateString('zh-TW')}
                    {y.importedBy ? ` · ${y.importedBy}` : ''}
                  </p>
                </div>
                {y.sourceUrl && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`重新下載 ${y.year}`}
                    title="重新下載"
                    disabled={importer.isPending}
                    onClick={() =>
                      importer.mutate({ body: { url: y.sourceUrl } })
                    }
                  >
                    <RefreshCwIcon />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`刪除 ${y.year}`}
                  title="刪除"
                  onClick={() => setDeleting(y)}
                >
                  <Trash2Icon />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <ConfirmDialog
        open={deleting !== null}
        title={`刪除 ${deleting?.year ?? ''} 年的行事曆？`}
        description="這一年會改回只把週六、週日當放假日。已經入帳的交易不受影響。"
        confirmLabel="刪除"
        pending={remove.isPending}
        onConfirm={() =>
          deleting &&
          remove.mutate({ params: { path: { year: deleting.year } } })
        }
        onClose={() => setDeleting(null)}
      />
    </div>
  )
}
