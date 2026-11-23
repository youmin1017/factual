-- name: ListBudgetsForUser :many
select b.id, b.name, b.currency, b.created_at, m.role,
       coalesce(u.default_budget_id = b.id, false)::boolean as is_default
  from budget_members m
  join budgets b on b.id = m.budget_id
  join users u on u.id = m.user_id
 where m.user_id = $1
 order by b.created_at, b.name;

-- name: GetBudgetForUser :one
select b.id, b.name, b.currency, b.created_at, m.role,
       coalesce(u.default_budget_id = b.id, false)::boolean as is_default
  from budget_members m
  join budgets b on b.id = m.budget_id
  join users u on u.id = m.user_id
 where m.budget_id = $1 and m.user_id = $2;

-- name: GetMemberRole :one
select role from budget_members where budget_id = $1 and user_id = $2;

-- name: CreateBudget :one
insert into budgets (name, currency) values ($1, $2) returning id;

-- name: AddBudgetMember :exec
insert into budget_members (budget_id, user_id, role) values ($1, $2, $3);

-- name: SetDefaultBudgetIfUnset :exec
-- Splitting needs a default budget per user (ADR-018); the first one created wins.
update users set default_budget_id = sqlc.arg(budget_id) where id = sqlc.arg(user_id) and default_budget_id is null;

-- name: RenameBudget :exec
update budgets set name = $2 where id = $1;

-- name: GetBudgetSummary :one
select p.pool,
       ( coalesce((select sum(al.amount) from allocations al where al.budget_id = p.budget_id), 0)
       + coalesce((select sum(e.amount) from entries e join categories c on c.id = e.category_id
                    where e.budget_id = p.budget_id and c.kind = 'expense'), 0)
       )::bigint as envelope_balance,
       coalesce((select sum(b.balance) from account_balances b join accounts a on a.id = b.account_id
                  where a.budget_id = p.budget_id and a.on_budget), 0)::bigint as on_budget_balance,
       coalesce((select sum(b.balance) from account_balances b join accounts a on a.id = b.account_id
                  where a.budget_id = p.budget_id and not a.on_budget), 0)::bigint as off_budget_balance
  from budget_pool p
 where p.budget_id = $1;
