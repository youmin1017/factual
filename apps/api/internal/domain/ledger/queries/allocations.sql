-- name: ListEnvelopeMonth :many
-- Every expense category with money budgeted or recorded up to the end of
-- the month: this month's allocation and activity, and the balance carried
-- in from before it (ADR-026). Folding a pooled parent's children into its
-- envelope is left to the client, which has the tree.
with alloc as (
    select al.category_id,
           coalesce(sum(al.amount) filter (where al.month = sqlc.arg(month)::date), 0)::bigint as allocated,
           coalesce(sum(al.amount) filter (where al.month < sqlc.arg(month)::date), 0)::bigint as before
      from allocations al
     where al.budget_id = sqlc.arg(budget_id) and al.month <= sqlc.arg(month)::date
     group by al.category_id
), act as (
    select e.category_id,
           coalesce(sum(e.amount) filter (where t.date >= sqlc.arg(month)::date), 0)::bigint as activity,
           coalesce(sum(e.amount) filter (where t.date < sqlc.arg(month)::date), 0)::bigint as before
      from entries e
      join transactions t on t.id = e.transaction_id
     where e.budget_id = sqlc.arg(budget_id) and e.category_id is not null
       and t.date < (sqlc.arg(month)::date + interval '1 month')
     group by e.category_id
)
select c.id as category_id,
       coalesce(a.allocated, 0)::bigint as allocated,
       coalesce(x.activity, 0)::bigint as activity,
       (coalesce(a.before, 0) + coalesce(x.before, 0))::bigint as carried
  from categories c
  left join alloc a on a.category_id = c.id
  left join act x on x.category_id = c.id
 where c.budget_id = sqlc.arg(budget_id) and c.kind = 'expense'
   and (a.category_id is not null or x.category_id is not null);

-- name: GetMonthIncome :one
-- Income recorded in the month; it went to the pool (ADR-025).
select coalesce(sum(e.amount), 0)::bigint
  from entries e
  join transactions t on t.id = e.transaction_id
  join categories c on c.id = e.category_id
 where e.budget_id = sqlc.arg(budget_id) and c.kind = 'income'
   and t.date >= sqlc.arg(month)::date and t.date < (sqlc.arg(month)::date + interval '1 month');

-- name: ListIncomeMonth :many
-- The month's income per income category, for the income lines.
select e.category_id as category_id, sum(e.amount)::bigint as received
  from entries e
  join transactions t on t.id = e.transaction_id
  join categories c on c.id = e.category_id
 where e.budget_id = sqlc.arg(budget_id) and c.kind = 'income'
   and t.date >= sqlc.arg(month)::date and t.date < (sqlc.arg(month)::date + interval '1 month')
 group by e.category_id;

-- name: GetPool :one
select pool from budget_pool where budget_id = $1;

-- name: SetAllocation :exec
insert into allocations (budget_id, category_id, month, amount, updated_by)
values ($1, $2, $3, $4, $5)
on conflict (category_id, month) do update
   set amount = excluded.amount, updated_by = excluded.updated_by, updated_at = now();

-- name: DeleteAllocation :exec
delete from allocations where budget_id = $1 and category_id = $2 and month = $3;
