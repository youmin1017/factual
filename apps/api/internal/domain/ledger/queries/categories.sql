-- name: ListCategories :many
select id, parent_id, name, kind, pooled, is_system, sort_order, (archived_at is not null)::boolean as archived, budget_base
  from categories
 where budget_id = $1
 order by is_system, sort_order, name;

-- name: GetCategory :one
select id, parent_id, name, kind, pooled, is_system, sort_order, (archived_at is not null)::boolean as archived, budget_base
  from categories
 where budget_id = $1 and id = $2;

-- name: GetSystemCategory :one
select id from categories where budget_id = $1 and system_key = $2;

-- name: CreateCategory :one
insert into categories (budget_id, parent_id, name, kind, pooled, is_system, system_key, sort_order)
values (sqlc.arg(budget_id), sqlc.narg(parent_id), sqlc.arg(name), sqlc.arg(kind), sqlc.arg(pooled),
        sqlc.arg(is_system), sqlc.narg(system_key),
        coalesce((select max(c.sort_order) + 1 from categories c
                   where c.budget_id = sqlc.arg(budget_id)
                     and c.parent_id is not distinct from sqlc.narg(parent_id)), 0))
returning id;

-- name: UpdateCategory :exec
update categories
   set name = sqlc.arg(name),
       pooled = sqlc.arg(pooled),
       archived_at = case when sqlc.arg(archived)::boolean then coalesce(archived_at, now()) end
 where budget_id = sqlc.arg(budget_id) and id = sqlc.arg(id);

-- name: SetCategoryOrder :exec
update categories set sort_order = $3 where budget_id = $1 and id = $2;

-- name: SetCategoryParent :exec
update categories set parent_id = sqlc.narg(parent_id) where budget_id = sqlc.arg(budget_id) and id = sqlc.arg(id);

-- name: CategoryInUse :one
-- Whether deleting the category would lose anything: subcategories, money
-- recorded or budgeted in it, schedules or a goal.
select (exists (select 1 from categories ch where ch.parent_id = c.id)
     or exists (select 1 from entries e where e.category_id = c.id)
     or exists (select 1 from allocations al where al.category_id = c.id)
     or exists (select 1 from schedule_entries se where se.category_id = c.id)
     or exists (select 1 from goals g where g.category_id = c.id))::boolean as in_use
  from categories c
 where c.budget_id = $1 and c.id = $2;

-- name: DeleteCategory :execrows
delete from categories where budget_id = $1 and id = $2 and not is_system;

-- name: CreateCategoryWithID :exec
-- A new category of the budget page, keyed by the id the client chose.
insert into categories (id, budget_id, parent_id, name, kind, pooled, sort_order, archived_at)
values (sqlc.arg(id), sqlc.arg(budget_id), sqlc.narg(parent_id), sqlc.arg(name), sqlc.arg(kind), sqlc.arg(pooled),
        sqlc.arg(sort_order), case when sqlc.arg(archived)::boolean then now() end);

-- name: SaveCategory :exec
update categories
   set parent_id = sqlc.narg(parent_id),
       name = sqlc.arg(name),
       pooled = sqlc.arg(pooled),
       sort_order = sqlc.arg(sort_order),
       archived_at = case when sqlc.arg(archived)::boolean then coalesce(archived_at, now()) end
 where budget_id = sqlc.arg(budget_id) and id = sqlc.arg(id) and not is_system;

-- name: RenameCategoryTemporarily :exec
-- Moves a category out of the way (its id as its name, at the top level)
-- while a save rearranges the tree, so names can swap within one save.
update categories set name = id::text, parent_id = null where budget_id = $1 and id = $2 and not is_system;

-- name: GetCategoryOwners :many
select id, budget_id from categories where id = any(sqlc.arg(ids)::uuid[]);
