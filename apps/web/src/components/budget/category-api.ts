import { useQueryClient } from '@tanstack/react-query'
import { api } from '#/lib/api'
import { apiErrorMessage } from '#/lib/apiError'
import { categoriesQuery } from '#/lib/budget'
import type { Category } from '#/lib/budget'

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
 * Changes to the category tree from the budget page (ADR-079). Each resolves
 * to an error message or null once the categories are reloaded; with `quiet`
 * they are not, so several changes reload once (`reload`).
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

export function useCategoryApi(budgetId: string): CategoryApi {
  const queryClient = useQueryClient()
  const reload = () =>
    queryClient.invalidateQueries({
      queryKey: categoriesQuery(budgetId).queryKey,
    })
  const done = async (error: unknown, quiet = false): Promise<Result> => {
    if (!quiet) await reload()
    return error ? apiErrorMessage(error) : null
  }
  const one = (categoryId: string) => ({
    params: { path: { budgetId, categoryId } },
  })

  return {
    reload,
    async create({ parentId, name, kind, pooled, archived, index }, quiet) {
      const { data, error } = await api.POST('/budgets/{budgetId}/categories', {
        params: { path: { budgetId } },
        body: { parentId, name, kind, pooled },
      })
      if (!data) {
        if (!quiet) await reload()
        return { error: apiErrorMessage(error) }
      }
      // Created last among its siblings; put it where it was asked for.
      if (index !== undefined)
        await api.POST('/budgets/{budgetId}/categories/{categoryId}/move', {
          ...one(data.id),
          body: { parentId, index },
        })
      if (archived)
        await api.PUT('/budgets/{budgetId}/categories/{categoryId}', {
          ...one(data.id),
          body: { name: data.name, pooled: data.pooled, archived: true },
        })
      if (!quiet) await reload()
      return { id: data.id }
    },
    async update(category, changes, quiet) {
      const { error } = await api.PUT(
        '/budgets/{budgetId}/categories/{categoryId}',
        {
          ...one(category.id),
          body: {
            name: category.name,
            pooled: category.pooled,
            archived: category.archived,
            ...changes,
          },
        },
      )
      return done(error, quiet)
    },
    async remove(id, quiet) {
      const { error } = await api.DELETE(
        '/budgets/{budgetId}/categories/{categoryId}',
        one(id),
      )
      return done(error, quiet)
    },
    async move(id, parentId, index, quiet) {
      const { error } = await api.POST(
        '/budgets/{budgetId}/categories/{categoryId}/move',
        { ...one(id), body: { parentId, index } },
      )
      return done(error, quiet)
    },
  }
}
