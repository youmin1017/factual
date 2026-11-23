import { siblingsOf, topDown, uniqueName } from '#/lib/budget-month'
import type { Category } from '#/lib/budget'
import type { CategoryNode, NewPlace } from '#/lib/budget-month'
import type { CategoryApi } from './category-api'

/**
 * Deleting, putting back and pasting yanked category trees (ADR-079). Each
 * reloads the categories once at the end and keeps the nodes' ids current,
 * so undo and redo can run them again.
 */

/**
 * Deletes what can be deleted, deepest first: a category with money in it
 * (or under it) stays. Returns the deleted nodes, parents first, and the
 * first error.
 */
export async function deleteNodes(
  api: CategoryApi,
  nodes: Array<CategoryNode>,
): Promise<{ deleted: Array<CategoryNode>; error: string | null }> {
  const deleted: Array<CategoryNode> = []
  let error: string | null = null
  for (const n of topDown(nodes).toReversed()) {
    if (!n.id) continue
    const e = await api.remove(n.id, true)
    if (e) {
      error ??= e
      continue
    }
    n.id = null
    deleted.push(n)
  }
  await api.reload()
  return { deleted: deleted.toReversed(), error }
}

async function createNode(
  api: CategoryApi,
  n: CategoryNode,
  parentId: string | null,
  index: number,
  name = n.name,
): Promise<string | null> {
  const made = await api.create(
    {
      parentId,
      name,
      kind: n.kind,
      pooled: n.pooled,
      archived: n.archived,
      index,
    },
    true,
  )
  if ('error' in made) return made.error
  n.id = made.id
  return null
}

/** Creates deleted nodes again where they were (parents first). */
export async function restoreNodes(
  api: CategoryApi,
  nodes: Array<CategoryNode>,
): Promise<string | null> {
  let error: string | null = null
  for (const n of nodes) {
    if (n.id) continue
    const parentId = n.parent ? n.parent.id : n.parentId
    if (n.parent && !parentId) continue
    error = await createNode(api, n, parentId, n.index)
    if (error) break
  }
  await api.reload()
  return error
}

/** What a paste did, to take it back. */
export interface Pasted {
  created: Array<CategoryNode>
  moved: Array<{ id: string; parentId: string | null; index: number }>
}

/**
 * Puts cut categories at `place`: the ones still there (they had money) are
 * moved, the deleted ones created again, with their subcategories.
 */
export async function pasteCut(
  api: CategoryApi,
  categories: Array<Category>,
  nodes: Array<CategoryNode>,
  place: NewPlace,
): Promise<{ pasted: Pasted; error: string | null }> {
  const pasted: Pasted = { created: [], moved: [] }
  let error: string | null = null
  for (const [k, root] of nodes.entries()) {
    const at = place.index + k
    const now = root.id ? categories.find((c) => c.id === root.id) : undefined
    if (root.id && now) {
      const parentId = now.parentId ?? null
      const index = siblingsOf(categories, parentId, now.kind).findIndex(
        (s) => s.id === now.id,
      )
      error = await api.move(root.id, place.parentId, at, true)
      if (error) break
      pasted.moved.push({ id: root.id, parentId, index })
    } else {
      error = await createNode(api, root, place.parentId, at)
      if (error) break
      pasted.created.push(root)
    }
    for (const n of topDown(root.children)) {
      if (n.id || !n.parent?.id) continue
      error = await createNode(api, n, n.parent.id, n.index)
      if (error) break
      pasted.created.push(n)
    }
    if (error) break
  }
  await api.reload()
  return { pasted, error }
}

/** Creates copies of yanked categories at `place`, renamed if taken. */
export async function pasteCopy(
  api: CategoryApi,
  categories: Array<Category>,
  nodes: Array<CategoryNode>,
  place: NewPlace,
): Promise<{ pasted: Pasted; error: string | null }> {
  const pasted: Pasted = { created: [], moved: [] }
  const taken = siblingsOf(categories, place.parentId, place.kind).map(
    (c) => c.name,
  )
  let error: string | null = null
  // Copies are new nodes; the yanked ones stay as they are.
  const copy = (n: CategoryNode, parent: CategoryNode | null): CategoryNode => {
    const c: CategoryNode = {
      ...n,
      id: null,
      archived: false,
      parent,
      children: [],
      sourceId: n.sourceId,
    }
    c.children = n.children.map((child) => copy(child, c))
    return c
  }
  for (const [k, original] of nodes.entries()) {
    const root = copy(original, null)
    const name = uniqueName(root.name, taken)
    taken.push(name)
    error = await createNode(api, root, place.parentId, place.index + k, name)
    if (error) break
    pasted.created.push(root)
    for (const n of topDown(root.children)) {
      error = await createNode(api, n, n.parent?.id ?? null, n.index)
      if (error) break
      pasted.created.push(n)
    }
    if (error) break
  }
  await api.reload()
  return { pasted, error }
}

/** Takes a paste back: deletes what it created, moves back what it moved. */
export async function unpaste(
  api: CategoryApi,
  pasted: Pasted,
): Promise<string | null> {
  let error: string | null = null
  for (const n of pasted.created.toReversed()) {
    if (!n.id) continue
    const e = await api.remove(n.id, true)
    if (e) error ??= e
    else n.id = null
  }
  // Back to where they were, front positions first.
  for (const m of pasted.moved.toSorted((a, b) => a.index - b.index)) {
    const e = await api.move(m.id, m.parentId, m.index, true)
    if (e) error ??= e
  }
  await api.reload()
  return error
}
