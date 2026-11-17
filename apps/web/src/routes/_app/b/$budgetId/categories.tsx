import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { EllipsisIcon, PlusIcon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { ConfirmDialog, NameDialog } from '#/components/dialogs'
import { PageHeader } from '#/components/section'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '#/components/ui/dropdown-menu'
import { Label } from '#/components/ui/label'
import { Switch } from '#/components/ui/switch'
import { $api, api } from '#/lib/api'
import { apiErrorMessage } from '#/lib/apiError'
import { categoriesQuery } from '#/lib/budget'
import { cn } from '#/lib/utils'
import type { Budget, Category } from '#/lib/budget'

export const Route = createFileRoute('/_app/b/$budgetId/categories')({
  staticData: { crumb: '類別' },
  component: CategoriesPage,
})

/** Categories are at most three levels deep (ADR-027). */
const MAX_DEPTH = 3

interface Node {
  category: Category
  depth: number
  children: Array<Node>
}

/** Builds the tree from the flat list; siblings keep the API's order. */
function buildTree(categories: Array<Category>): Array<Node> {
  const byParent = new Map<string | null, Array<Category>>()
  for (const c of categories) {
    const key = c.parentId ?? null
    byParent.set(key, [...(byParent.get(key) ?? []), c])
  }
  const grow = (parent: string | null, depth: number): Array<Node> =>
    (byParent.get(parent) ?? [])
      .toSorted((a, b) => a.sortOrder - b.sortOrder)
      .map((category) => ({
        category,
        depth,
        children: grow(category.id, depth + 1),
      }))
  return grow(null, 1)
}

/** Hides archived categories, and everything under them. */
function withoutArchived(nodes: Array<Node>): Array<Node> {
  return nodes
    .filter((n) => !n.category.archived)
    .map((n) => ({ ...n, children: withoutArchived(n.children) }))
}

function CategoriesPage() {
  const { budget } = Route.useRouteContext()
  const categories = useQuery(categoriesQuery(budget.id))
  const [showArchived, setShowArchived] = useState(false)
  const [adding, setAdding] = useState<'expense' | 'income' | null>(null)
  const canManage = budget.role === 'owner'
  const invalidate = useInvalidateCategories(budget.id)

  const all = categories.data ?? []
  const tree = buildTree(all.filter((c) => !c.isSystem))
  const visible = showArchived ? tree : withoutArchived(tree)
  const archivedCount = all.filter((c) => c.archived).length
  const sections = [
    {
      kind: 'expense' as const,
      title: '支出',
      description:
        '每月從資金池分配預算給支出類別。子類別預設共用上層類別的預算。',
      nodes: visible.filter((n) => n.category.kind === 'expense'),
    },
    {
      kind: 'income' as const,
      title: '收入',
      description: '收入進入資金池，不屬於任何一個月。',
      nodes: visible.filter((n) => n.category.kind === 'income'),
    },
  ]

  return (
    <div>
      <PageHeader title="類別">
        {archivedCount > 0 && (
          <div className="flex items-center gap-2">
            <Switch
              id="show-archived"
              checked={showArchived}
              onCheckedChange={setShowArchived}
            />
            <Label htmlFor="show-archived" className="font-normal">
              顯示已封存
            </Label>
          </div>
        )}
      </PageHeader>

      {categories.isPending && (
        <p className="py-8 text-sm text-muted-foreground">載入中…</p>
      )}
      {categories.isError && (
        <p className="py-8 text-sm text-destructive" role="alert">
          {apiErrorMessage(categories.error)}
        </p>
      )}

      {categories.isSuccess &&
        sections.map((section) => (
          <section key={section.kind} className="border-b py-6 last:border-b-0">
            <div className="mb-3 flex items-center justify-between gap-4">
              <div>
                <h2 className="font-medium">{section.title}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {section.description}
                </p>
              </div>
              {canManage && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setAdding(section.kind)}
                >
                  <PlusIcon />
                  新增{section.title}類別
                </Button>
              )}
            </div>
            {section.nodes.length === 0 ? (
              <p className="border-y border-rule py-4 text-sm text-muted-foreground">
                還沒有{section.title}類別。
              </p>
            ) : (
              <ul className="border-t border-rule">
                {section.nodes.map((node) => (
                  <CategoryItem
                    key={node.category.id}
                    node={node}
                    siblings={section.nodes}
                    budget={budget}
                    canManage={canManage}
                  />
                ))}
              </ul>
            )}
          </section>
        ))}

      {adding && (
        <NameDialog
          title={adding === 'expense' ? '新增支出類別' : '新增收入類別'}
          maxLength={32}
          submitLabel="新增"
          onClose={() => setAdding(null)}
          onSave={async (name) => {
            const { error } = await api.POST('/budgets/{budgetId}/categories', {
              params: { path: { budgetId: budget.id } },
              body: { parentId: null, name, kind: adding },
            })
            if (error) return apiErrorMessage(error)
            setAdding(null)
            await invalidate()
          }}
        />
      )}
    </div>
  )
}

function useInvalidateCategories(budgetId: string) {
  const queryClient = useQueryClient()
  return () =>
    queryClient.invalidateQueries({
      queryKey: categoriesQuery(budgetId).queryKey,
    })
}

function CategoryItem({
  node,
  siblings,
  budget,
  canManage,
}: {
  node: Node
  siblings: Array<Node>
  budget: Budget
  canManage: boolean
}) {
  const { category, depth, children } = node
  const invalidate = useInvalidateCategories(budget.id)
  const [dialog, setDialog] = useState<'rename' | 'child' | 'delete' | null>(
    null,
  )
  const path = {
    params: { path: { budgetId: budget.id, categoryId: category.id } },
  }

  const update = $api.useMutation(
    'put',
    '/budgets/{budgetId}/categories/{categoryId}',
    {
      onSuccess: invalidate,
      onError: (e) => toast.error(apiErrorMessage(e)),
    },
  )
  const remove = $api.useMutation(
    'delete',
    '/budgets/{budgetId}/categories/{categoryId}',
    {
      onSuccess: async () => {
        toast.success(`已刪除「${category.name}」`)
        setDialog(null)
        await invalidate()
      },
      onError: (e) => {
        toast.error(apiErrorMessage(e))
        setDialog(null)
      },
    },
  )
  const reorder = $api.useMutation(
    'put',
    '/budgets/{budgetId}/categories/order',
    {
      onSuccess: invalidate,
      onError: (e) => toast.error(apiErrorMessage(e)),
    },
  )

  const index = siblings.findIndex((n) => n.category.id === category.id)
  function move(offset: -1 | 1) {
    const ids = siblings.map((n) => n.category.id)
    const other = index + offset
    if (other < 0 || other >= ids.length) return
    ;[ids[index], ids[other]] = [ids[other], ids[index]]
    reorder.mutate({ params: { path: { budgetId: budget.id } }, body: { ids } })
  }

  function save(changes: Partial<Pick<Category, 'pooled' | 'archived'>>) {
    update.mutate({
      ...path,
      body: {
        name: category.name,
        pooled: category.pooled,
        archived: category.archived,
        ...changes,
      },
    })
  }

  return (
    <li className={cn(depth === 1 && 'border-b border-rule')}>
      <div
        className={cn(
          'flex items-center gap-3 py-2',
          depth === 1 && 'font-medium',
          category.archived && 'text-muted-foreground',
        )}
        data-testid={`category-${category.name}`}
      >
        <span className="min-w-0 flex-1 truncate">{category.name}</span>
        {/* Sharing is the default; mark parents that budget each subcategory separately. */}
        {category.kind === 'expense' &&
          children.length > 0 &&
          !category.pooled && <Badge variant="outline">子類別各自預算</Badge>}
        {category.archived && <Badge variant="secondary">已封存</Badge>}
        {canManage && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={`${category.name} 的動作`}
              >
                <EllipsisIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              {depth < MAX_DEPTH && !category.archived && (
                <DropdownMenuItem onSelect={() => setDialog('child')}>
                  新增子類別
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => setDialog('rename')}>
                重新命名
              </DropdownMenuItem>
              <DropdownMenuItem disabled={index <= 0} onSelect={() => move(-1)}>
                上移
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={index === siblings.length - 1}
                onSelect={() => move(1)}
              >
                下移
              </DropdownMenuItem>
              {category.kind === 'expense' && children.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuCheckboxItem
                    checked={category.pooled}
                    onCheckedChange={(pooled) => save({ pooled })}
                  >
                    子類別共用預算
                  </DropdownMenuCheckboxItem>
                </>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => save({ archived: !category.archived })}
              >
                {category.archived ? '取消封存' : '封存'}
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                disabled={children.length > 0}
                onSelect={() => setDialog('delete')}
              >
                刪除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {children.length > 0 && (
        <ul
          className={cn(
            'ml-1 border-l border-rule pl-4',
            depth === 1 ? 'mb-2' : '',
          )}
        >
          {children.map((child) => (
            <CategoryItem
              key={child.category.id}
              node={child}
              siblings={children}
              budget={budget}
              canManage={canManage}
            />
          ))}
        </ul>
      )}

      {dialog === 'rename' && (
        <NameDialog
          title="重新命名類別"
          initial={category.name}
          maxLength={32}
          onClose={() => setDialog(null)}
          onSave={async (name) => {
            const { error } = await api.PUT(
              '/budgets/{budgetId}/categories/{categoryId}',
              {
                ...path,
                body: {
                  name,
                  pooled: category.pooled,
                  archived: category.archived,
                },
              },
            )
            if (error) return apiErrorMessage(error)
            setDialog(null)
            await invalidate()
          }}
        />
      )}
      {dialog === 'child' && (
        <NameDialog
          title={`在「${category.name}」下新增子類別`}
          maxLength={32}
          submitLabel="新增"
          onClose={() => setDialog(null)}
          onSave={async (name) => {
            const { error } = await api.POST('/budgets/{budgetId}/categories', {
              params: { path: { budgetId: budget.id } },
              body: {
                parentId: category.id,
                name,
                kind: category.kind,
              },
            })
            if (error) return apiErrorMessage(error)
            setDialog(null)
            await invalidate()
          }}
        />
      )}
      <ConfirmDialog
        open={dialog === 'delete'}
        title="刪除類別"
        description={`確定要刪除「${category.name}」嗎？有交易或預算的類別無法刪除，請改用封存。`}
        confirmLabel="刪除"
        pending={remove.isPending}
        onConfirm={() => remove.mutate(path)}
        onClose={() => setDialog(null)}
      />
    </li>
  )
}
