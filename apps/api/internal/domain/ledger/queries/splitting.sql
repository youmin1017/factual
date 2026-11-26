-- Friends and shared expenses (M12, ADR-103..106). A direct shared expense
-- (no group) is between the two users in its shares; both always have a
-- share row, the payer of a settlement with zero.

-- name: GetSplittingBudget :one
-- The user's default budget, which receives their side of shared expenses
-- (ADR-018), and their role in it.
select b.id, b.currency, m.role
  from users u
  join budgets b on b.id = u.default_budget_id
  join budget_members m on m.budget_id = b.id and m.user_id = u.id
 where u.id = $1;

-- name: ListFriends :many
select f.id, f.display_name, (f.password_hash is null)::boolean as placeholder,
       me.default_budget_id as budget_id, a.id as account_id,
       coalesce(ab.balance, 0)::bigint as balance,
       (select count(*)
          from shared_expenses se
         where se.group_id is null and se.deleted_at is null
           and exists (select 1 from shared_expense_shares s where s.expense_id = se.id and s.user_id = me.id)
           and exists (select 1 from shared_expense_shares s where s.expense_id = se.id and s.user_id = f.id)
       )::integer as expense_count
  from users me
  join friendships fs on (fs.user_a = me.id or fs.user_b = me.id) and fs.status = 'accepted'
  join users f on f.id = case when fs.user_a = me.id then fs.user_b else fs.user_a end
  left join accounts a on a.budget_id = me.default_budget_id and a.friend_user_id = f.id
  left join account_balances ab on ab.account_id = a.id
 where me.id = sqlc.arg(user_id)
   and (sqlc.narg(friend_id)::uuid is null or f.id = sqlc.narg(friend_id)::uuid)
 order by f.display_name, f.id;

-- name: CreatePlaceholder :one
insert into users (display_name, created_by) values ($1, $2) returning id;

-- name: CreateFriendship :exec
-- A placeholder cannot answer a request, so the friendship starts accepted
-- (ADR-104). user_a < user_b.
insert into friendships (user_a, user_b, status, requested_by)
values (least(sqlc.arg(user_id)::uuid, sqlc.arg(friend_id)::uuid),
        greatest(sqlc.arg(user_id)::uuid, sqlc.arg(friend_id)::uuid), 'accepted', sqlc.arg(user_id)::uuid);

-- name: CreateFriendAccount :one
insert into accounts (budget_id, name, kind, on_budget, friend_user_id, sort_order)
values ($1, $2, 'friend', true, $3,
        coalesce((select max(sort_order) + 1 from accounts where budget_id = $1), 0))
returning id;

-- name: RenamePlaceholder :execrows
update users set display_name = sqlc.arg(display_name)
 where id = sqlc.arg(id) and password_hash is null and created_by = sqlc.arg(created_by);

-- name: RenameFriendAccount :exec
update accounts set name = sqlc.arg(name)
 where budget_id = sqlc.arg(budget_id) and friend_user_id = sqlc.arg(friend_user_id);

-- name: PurgeDeletedExpensesWith :exec
-- Deleted direct expenses between the two, so that the friend can be removed.
delete from shared_expenses se
 where se.group_id is null and se.deleted_at is not null
   and exists (select 1 from shared_expense_shares s where s.expense_id = se.id and s.user_id = sqlc.arg(user_id))
   and exists (select 1 from shared_expense_shares s where s.expense_id = se.id and s.user_id = sqlc.arg(friend_id));

-- name: DeleteFriendAccount :exec
delete from accounts where budget_id = sqlc.arg(budget_id) and friend_user_id = sqlc.arg(friend_user_id);

-- name: DeleteFriendship :exec
delete from friendships
 where user_a = least(sqlc.arg(user_id)::uuid, sqlc.arg(friend_id)::uuid)
   and user_b = greatest(sqlc.arg(user_id)::uuid, sqlc.arg(friend_id)::uuid);

-- name: DeletePlaceholder :exec
delete from users where id = sqlc.arg(id) and password_hash is null and created_by = sqlc.arg(created_by);

-- name: ListFriendExpenses :many
select se.id, se.kind, se.date, se.description, se.note, se.currency, se.total_amount,
       se.orig_currency, se.orig_amount, se.fx_rate, se.split_method, se.created_by
  from shared_expenses se
 where se.group_id is null and se.deleted_at is null
   and exists (select 1 from shared_expense_shares s where s.expense_id = se.id and s.user_id = sqlc.arg(user_id))
   and exists (select 1 from shared_expense_shares s where s.expense_id = se.id and s.user_id = sqlc.arg(friend_id))
 order by se.date, se.created_at, se.id;

-- name: ListExpensePayers :many
select expense_id, user_id, amount
  from shared_expense_payers
 where expense_id = any(sqlc.arg(ids)::uuid[])
 order by expense_id, user_id;

-- name: ListExpenseShares :many
select expense_id, user_id, amount, weight
  from shared_expense_shares
 where expense_id = any(sqlc.arg(ids)::uuid[])
 order by expense_id, user_id;

-- name: ListMySharedEntries :many
-- The entries of the transactions the expenses generated in the budget.
select t.id as transaction_id, t.shared_expense_id, e.account_id, e.category_id, e.amount, e.cleared,
       a.kind as account_kind
  from transactions t
  join entries e on e.transaction_id = t.id
  join accounts a on a.id = e.account_id
 where t.budget_id = sqlc.arg(budget_id) and t.shared_expense_id = any(sqlc.arg(ids)::uuid[])
 order by t.id, e.amount, e.id;

-- name: GetExpenseHeads :many
-- What the batch needs to know about expenses that already exist.
select se.id, se.created_by, se.group_id, (se.deleted_at is not null)::boolean as deleted,
       exists (select 1 from shared_expense_shares s where s.expense_id = se.id and s.user_id = sqlc.arg(user_id))::boolean as with_user,
       exists (select 1 from shared_expense_shares s where s.expense_id = se.id and s.user_id = sqlc.arg(friend_id))::boolean as with_friend
  from shared_expenses se
 where se.id = any(sqlc.arg(ids)::uuid[]);

-- name: UpsertSharedExpense :exec
-- The caller has checked that an existing id is theirs.
insert into shared_expenses (id, kind, date, description, note, currency, total_amount,
                             orig_currency, orig_amount, fx_rate, split_method, created_by)
values (sqlc.arg(id), sqlc.arg(kind), sqlc.arg(date), sqlc.arg(description), sqlc.arg(note), sqlc.arg(currency),
        sqlc.arg(total_amount), sqlc.narg(orig_currency), sqlc.narg(orig_amount), sqlc.narg(fx_rate),
        sqlc.arg(split_method), sqlc.arg(created_by))
on conflict (id) do update
   set kind = excluded.kind, date = excluded.date, description = excluded.description, note = excluded.note,
       total_amount = excluded.total_amount, orig_currency = excluded.orig_currency,
       orig_amount = excluded.orig_amount, fx_rate = excluded.fx_rate, split_method = excluded.split_method,
       updated_at = now()
 where shared_expenses.created_by = excluded.created_by and shared_expenses.deleted_at is null;

-- name: DeleteExpensePayers :exec
delete from shared_expense_payers where expense_id = $1;

-- name: DeleteExpenseShares :exec
delete from shared_expense_shares where expense_id = $1;

-- name: CreateExpensePayer :exec
insert into shared_expense_payers (expense_id, user_id, amount) values ($1, $2, $3);

-- name: CreateExpenseShare :exec
insert into shared_expense_shares (expense_id, user_id, amount, weight) values ($1, $2, $3, $4);

-- name: SoftDeleteSharedExpense :execrows
update shared_expenses set deleted_at = now(), updated_at = now()
 where id = sqlc.arg(id) and created_by = sqlc.arg(created_by) and deleted_at is null;

-- name: GetSharedTransaction :one
select id from transactions where budget_id = $1 and shared_expense_id = $2;

-- name: CreateSharedTransaction :one
insert into transactions (budget_id, date, note, shared_expense_id, created_by)
values ($1, $2, $3, $4, $5)
returning id;

-- name: UpdateSharedTransaction :exec
update transactions set date = $3, note = $4, needs_review = false, updated_at = now()
 where budget_id = $1 and id = $2;

-- name: ListEntryCleared :many
select account_id, (category_id is null)::boolean as uncategorized, cleared
  from entries
 where transaction_id = $1;

-- name: DeleteSharedTransaction :exec
delete from transactions where budget_id = $1 and shared_expense_id = $2;
