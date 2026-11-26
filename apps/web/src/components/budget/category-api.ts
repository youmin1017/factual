import { useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { api } from '#/lib/api'
import { apiErrorMessage, errorCodeMessage } from '#/lib/apiError'
import { budgetMonthQuery, categoriesQuery, summaryQuery } from '#/lib/budget'
import {
  batchOf,
  changeCount,
  createCategory,
  emptyBuffer,
  moveCategory,
  removeCategory,
  setAllocations,
  setBase,
  updateCategory,
} from '#/lib/budget-buffer'
import { categoryRefs } from '#/lib/register'
import type { Category } from '#/lib/budget'
import type { BudgetBuffer } from '#/lib/budget-buffer'

type Result = string | null

export interface NewCategory {
  parentId: string | null
  name: string
  kind: Category['kind']
  pooled?: boolean
  archived?: boolean
  /** Position among its siblings of the same kind; last when absent. */
  index?: number
}

/**
 * Changes to the category tree from the budget page (ADR-079). They go into
 * the page's buffer and are saved with :w (ADR-109); each resolves to an
 * error message or null. `quiet` and `reload` are kept for the callers that
 * change several at once.
 */
export interface CategoryApi {
  create: (
    input: NewCategory,
    quiet?: boolean,
  ) => Promise<{ id: string } | { error: string }>
  update: (
    category: Category,
    changes: Partial<Pick<Category, 'name' | 'pooled' | 'archived'>>,
    quiet?: boolean,
  ) => Promise<Result>
  remove: (id: string, quiet?: boolean) => Promise<Result>
  move: (
    id: string,
    parentId: string | null,
    index: number,
    quiet?: boolean,
  ) => Promise<Result>
  reload: () => Promise<void>
}

const DRAFT_VERSION = 1

interface Draft {
  version: number
  buffer: BudgetBuffer
}

function draftKey(budgetId: string): string {
  return `factual:budget:${budgetId}`
}

function readDraft(key: string): BudgetBuffer | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<Draft>
    return parsed.version === DRAFT_VERSION && parsed.buffer
      ? parsed.buffer
      : null
  } catch {
    return null
  }
}

function writeDraft(key: string, buffer: BudgetBuffer | null): void {
  try {
    if (!buffer) localStorage.removeItem(key)
    else
      localStorage.setItem(
        key,
        JSON.stringify({ version: DRAFT_VERSION, buffer } satisfies Draft),
      )
  } catch {
    // Drafts are a convenience (ADR-043).
  }
}

export interface BudgetEdits {
  /** The categories as the page leaves them. */
  categories: Array<Category>
  buffer: BudgetBuffer
  categoryApi: CategoryApi
  allocate: (
    month: string,
    set: Array<{ categoryId: string; amount: number }>,
  ) => Promise<Result>
  setBase: (categoryId: string, amount: number) => Promise<Result>
  /** How many changes wait for :w. */
  dirty: number
  /** Whether the buffer was a draft left by an earlier visit. */
  restored: boolean
  /** Saves the buffer (:w); resolves to a message, an error when `ok` is false. */
  save: () => Promise<{ ok: boolean; message: string }>
  /** Drops the buffer (:e!). */
  discard: () => void
  /** The page says which categories hold money in the months it shows. */
  holdsMoney: React.RefObject<(id: string) => boolean>
}

/**
 * The budget page's buffer (ADR-109): the category tree, allocations and
 * bases as the page left them, kept as a draft until :w. While nothing is
 * changed it follows the saved categories.
 */
export function useBudgetEdits(
  budgetId: string,
  saved: Array<Category>,
): BudgetEdits {
  const queryClient = useQueryClient()
  const key = draftKey(budgetId)
  const [restored] = useState(() => readDraft(key) !== null)
  const store = useRef<{ buffer: BudgetBuffer; base: Array<Category> } | null>(
    null,
  )
  const [, setTick] = useState(0)
  /** Whether a category holds money in the months shown; set by the page. */
  const holdsMoney = useRef<(id: string) => boolean>(() => false)
  if (!store.current) {
    store.current = {
      buffer: readDraft(key) ?? emptyBuffer(saved),
      base: saved,
    }
  }
  // Nothing changed: follow the saved categories as they are reloaded.
  if (
    store.current.base !== saved &&
    changeCount(store.current.buffer, store.current.base) === 0
  ) {
    store.current = { buffer: emptyBuffer(saved), base: saved }
  }
  const current = store.current

  function apply(next: BudgetBuffer) {
    if (!store.current) return
    store.current = { ...store.current, buffer: next }
    writeDraft(key, changeCount(next, saved) > 0 ? next : null)
    setTick((t) => t + 1)
  }
  const buffer = () => store.current?.buffer ?? emptyBuffer(saved)
  const savedIds = new Set(saved.map((c) => c.id))

  // The buffer changes at once; the promises keep the callers' shape.
  const categoryApi: CategoryApi = {
    reload: () => Promise.resolve(),
    create(input) {
      const id = crypto.randomUUID()
      const next = createCategory(buffer(), id, input, saved)
      apply(next)
      // A deleted category put back keeps its own id.
      const made = next.categories.find(
        (c) => (c.parentId ?? null) === input.parentId && c.name === input.name,
      )
      return Promise.resolve({ id: made?.id ?? id })
    },
    update(category, changes) {
      apply(updateCategory(buffer(), category.id, changes))
      return Promise.resolve(null)
    },
    remove(id) {
      // Money recorded or budgeted in a category keeps it (ADR-060); the
      // server checks the months not shown, schedules and goals at :w.
      if (buffer().categories.some((c) => c.parentId === id))
        return Promise.resolve('底下還有子類別')
      if (savedIds.has(id) && holdsMoney.current(id))
        return Promise.resolve('有交易或預算')
      apply(removeCategory(buffer(), id, savedIds))
      return Promise.resolve(null)
    },
    move(id, parentId, index) {
      apply(moveCategory(buffer(), id, parentId, index))
      return Promise.resolve(null)
    },
  }

  function allocate(
    month: string,
    set: Array<{ categoryId: string; amount: number }>,
  ): Promise<Result> {
    const data = queryClient.getQueryData(
      budgetMonthQuery(budgetId, month).queryKey,
    )
    const original = (categoryId: string) =>
      data?.envelopes.find((e) => e.categoryId === categoryId)?.allocated ?? 0
    apply(setAllocations(buffer(), month, set, original))
    return Promise.resolve(null)
  }

  function changeBase(categoryId: string, amount: number): Promise<Result> {
    apply(setBase(buffer(), categoryId, amount))
    return Promise.resolve(null)
  }

  async function save(): Promise<{ ok: boolean; message: string }> {
    const batch = batchOf(buffer(), saved)
    const count =
      batch.categories.length +
      batch.deleteCategories.length +
      batch.allocations.length +
      batch.bases.length
    if (count === 0) return { ok: true, message: '沒有需要儲存的變更' }
    try {
      const { error, response } = await api.POST(
        '/budgets/{budgetId}/budget/batch',
        { params: { path: { budgetId } }, body: batch },
      )
      if (response.status === 422 && error && 'errors' in error) {
        const paths = categoryRefs([...saved, ...buffer().categories])
        const first = error.errors[0]
        const where = paths.get(first.id)?.path
        const known = errorCodeMessage(first.code)
        const text = known === '發生未知錯誤' ? first.message : known
        return {
          ok: false,
          message: `沒有儲存：${where ? `「${where}」` : ''}${text}${
            error.errors.length > 1
              ? `（另有 ${error.errors.length - 1} 個問題）`
              : ''
          }`,
        }
      }
      if (error) return { ok: false, message: apiErrorMessage(error) }
    } catch {
      return { ok: false, message: '無法連線至伺服器；變更仍保留在草稿裡' }
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['budget-month', budgetId] }),
      queryClient.invalidateQueries({
        queryKey: summaryQuery(budgetId).queryKey,
      }),
      queryClient.invalidateQueries({
        queryKey: ['get', '/budgets/{budgetId}/goals'],
      }),
    ])
    const fresh = await queryClient.fetchQuery({
      ...categoriesQuery(budgetId),
      staleTime: 0,
    })
    store.current = { buffer: emptyBuffer(fresh), base: fresh }
    writeDraft(key, null)
    setTick((t) => t + 1)
    return { ok: true, message: `已儲存 ${count} 個變更` }
  }

  function discard() {
    store.current = { buffer: emptyBuffer(saved), base: saved }
    writeDraft(key, null)
    setTick((t) => t + 1)
  }

  return {
    categories: current.buffer.categories,
    buffer: current.buffer,
    categoryApi,
    allocate,
    setBase: changeBase,
    dirty: changeCount(current.buffer, saved),
    restored,
    save,
    discard,
    holdsMoney,
  }
}
