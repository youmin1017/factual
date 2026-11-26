-- Groups (M13, ADR-037, ADR-115). A group's members are rows of
-- group_members without left_at; its shared expenses carry its id. Each
-- member's balance is worked out from those expenses, never stored.

-- name: ListGroups :many
-- The groups the user is a member of, with their group account in the
-- user's default budget.
select g.id, g.name, g.currency, (g.archived_at is not null)::boolean as archived, g.created_by,
       me.default_budget_id as budget_id, a.id as account_id,
       coalesce(ab.balance, 0)::bigint as balance,
       (select count(*) from shared_expenses se
         where se.group_id = g.id and se.deleted_at is null)::integer as expense_count
  from users me
  join group_members gm on gm.user_id = me.id and gm.left_at is null
  join groups g on g.id = gm.group_id
  left join accounts a on a.budget_id = me.default_budget_id and a.group_id = g.id
  left join account_balances ab on ab.account_id = a.id
 where me.id = sqlc.arg(user_id)
   and (sqlc.narg(group_id)::uuid is null or g.id = sqlc.narg(group_id)::uuid)
 order by (g.archived_at is not null), g.name, g.id;

-- name: ListGroupMembers :many
-- The members of the groups, the admin first, with what each has paid and
-- shared in the group's expenses (deleted ones left out).
select gm.group_id, u.id as user_id, u.display_name, (u.password_hash is null)::boolean as placeholder, gm.role,
       coalesce((select sum(p.amount) from shared_expense_payers p
                   join shared_expenses se on se.id = p.expense_id
                  where se.group_id = gm.group_id and se.deleted_at is null and p.user_id = u.id), 0)::bigint as paid,
       coalesce((select sum(s.amount) from shared_expense_shares s
                   join shared_expenses se on se.id = s.expense_id
                  where se.group_id = gm.group_id and se.deleted_at is null and s.user_id = u.id), 0)::bigint as share,
       (exists (select 1 from shared_expense_payers p join shared_expenses se on se.id = p.expense_id
                 where se.group_id = gm.group_id and se.deleted_at is null and p.user_id = u.id)
        or exists (select 1 from shared_expense_shares s join shared_expenses se on se.id = s.expense_id
                    where se.group_id = gm.group_id and se.deleted_at is null and s.user_id = u.id))::boolean as in_use
  from group_members gm
  join users u on u.id = gm.user_id
 where gm.group_id = any(sqlc.arg(group_ids)::uuid[]) and gm.left_at is null
 order by gm.group_id, (gm.role = 'admin') desc, gm.joined_at, u.display_name, u.id;

-- name: CreateGroup :one
insert into groups (name, currency, created_by) values ($1, $2, $3) returning id;

-- name: AddGroupMember :exec
insert into group_members (group_id, user_id, role) values ($1, $2, $3);

-- name: RemoveGroupMember :exec
-- Only members no live expense names are removed (in_use above).
delete from group_members where group_id = $1 and user_id = $2;

-- name: RenameGroup :exec
update groups set name = $2 where id = $1;

-- name: SetGroupArchived :exec
update groups set archived_at = case when sqlc.arg(archived)::boolean then coalesce(archived_at, now()) end
 where id = sqlc.arg(id);

-- name: CreateGroupAccount :one
insert into accounts (budget_id, name, kind, on_budget, group_id, sort_order)
values ($1, $2, 'friend', true, $3,
        coalesce((select max(sort_order) + 1 from accounts where budget_id = $1), 0))
returning id;

-- name: RenameGroupAccount :exec
update accounts set name = sqlc.arg(name)
 where budget_id = sqlc.arg(budget_id) and group_id = sqlc.arg(group_id);

-- name: SetGroupAccountClosed :exec
update accounts set closed_at = case when sqlc.arg(closed)::boolean then coalesce(closed_at, now()) end
 where budget_id = sqlc.arg(budget_id) and group_id = sqlc.arg(group_id);

-- name: DeleteGroupAccount :exec
delete from accounts where budget_id = sqlc.arg(budget_id) and group_id = sqlc.arg(group_id);

-- name: PurgeDeletedGroupExpenses :exec
delete from shared_expenses where group_id = $1 and deleted_at is not null;

-- name: DeleteGroup :exec
delete from groups where id = $1;

-- name: ListGroupExpenses :many
select se.id, se.kind, se.date, se.description, se.note, se.currency, se.total_amount,
       se.orig_currency, se.orig_amount, se.fx_rate, se.split_method, se.created_by
  from shared_expenses se
 where se.group_id = $1 and se.deleted_at is null
 order by se.date, se.created_at, se.id;

-- name: GetGroupExpenseHeads :many
-- What the batch needs to know about expenses that already exist.
select se.id, se.created_by, se.group_id, (se.deleted_at is not null)::boolean as deleted
  from shared_expenses se
 where se.id = any(sqlc.arg(ids)::uuid[]);


-- name: CreateGroupWithID :exec
-- A new group of the 分帳 page, keyed by the id the client chose.
insert into groups (id, name, currency, created_by) values ($1, $2, $3, $4);

-- name: GetUsersExist :many
-- Which of the ids are taken by users, so that a new friend's id is not
-- someone else's.
select id from users where id = any(sqlc.arg(ids)::uuid[]);

-- name: GetGroupsExist :many
select id from groups where id = any(sqlc.arg(ids)::uuid[]);
