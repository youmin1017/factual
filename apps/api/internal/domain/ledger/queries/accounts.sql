-- name: ListAccounts :many
-- The budget's accounts; friend accounts are listed with the friend they are
-- with (ADR-106), suspense accounts belong to splitting with registered users.
select a.id, a.name, a.kind, a.on_budget, a.sort_order, (a.closed_at is not null)::boolean as closed,
       b.balance, b.cleared_balance, a.friend_user_id,
       exists (select 1 from entries e join transactions t on t.id = e.transaction_id
                where e.account_id = a.id and not t.is_opening)::boolean as has_activity
  from accounts a
  join account_balances b on b.account_id = a.id
 where a.budget_id = $1 and a.kind in ('cash', 'bank', 'credit_card', 'loan', 'investment', 'friend')
 order by a.on_budget desc, a.sort_order, a.name;

-- name: GetAccount :one
select a.id, a.name, a.kind, a.on_budget, a.sort_order, (a.closed_at is not null)::boolean as closed,
       b.balance, b.cleared_balance, a.friend_user_id,
       exists (select 1 from entries e join transactions t on t.id = e.transaction_id
                where e.account_id = a.id and not t.is_opening)::boolean as has_activity
  from accounts a
  join account_balances b on b.account_id = a.id
 where a.budget_id = $1 and a.id = $2 and a.kind in ('cash', 'bank', 'credit_card', 'loan', 'investment', 'friend');

-- name: CreateAccount :one
insert into accounts (budget_id, name, kind, on_budget, sort_order)
values ($1, $2, $3, $4,
        coalesce((select max(sort_order) + 1 from accounts where budget_id = $1), 0))
returning id;

-- name: UpdateAccount :exec
update accounts
   set name = sqlc.arg(name),
       closed_at = case when sqlc.arg(closed)::boolean then coalesce(closed_at, now()) end
 where budget_id = sqlc.arg(budget_id) and id = sqlc.arg(id);

-- name: SetAccountOrder :exec
update accounts set sort_order = $3 where budget_id = $1 and id = $2;

-- name: DeleteOpeningTransactions :exec
delete from transactions t
 where t.budget_id = $1 and t.is_opening
   and exists (select 1 from entries e where e.transaction_id = t.id and e.account_id = $2);

-- name: DeleteAccount :execrows
delete from accounts where budget_id = $1 and id = $2;

-- name: CreateOpeningTransaction :one
insert into transactions (budget_id, date, note, is_opening, created_by)
values ($1, $2, '期初餘額', true, $3)
returning id;

-- name: CreateEntry :exec
insert into entries (budget_id, transaction_id, account_id, category_id, amount, memo, cleared)
values ($1, $2, $3, $4, $5, $6, $7);

-- name: CreateAccountWithID :exec
-- A new account of the accounts page, keyed by the id the client chose.
insert into accounts (id, budget_id, name, kind, on_budget, sort_order)
values (sqlc.arg(id), sqlc.arg(budget_id), sqlc.arg(name), sqlc.arg(kind), sqlc.arg(on_budget), sqlc.arg(sort_order));

-- name: ListAccountHeads :many
-- What the accounts batch checks: every account of the budget.
select a.id, a.name, a.kind, (a.closed_at is not null)::boolean as closed, b.balance,
       exists (select 1 from entries e join transactions t on t.id = e.transaction_id
                where e.account_id = a.id and not t.is_opening)::boolean as has_activity
  from accounts a
  join account_balances b on b.account_id = a.id
 where a.budget_id = $1;

-- name: GetAccountOwners :many
select id, budget_id from accounts where id = any(sqlc.arg(ids)::uuid[]);
