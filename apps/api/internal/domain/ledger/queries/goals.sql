-- name: ListGoals :many
-- Every goal of the budget in priority order (ADR-092).
select id, category_id, name, kind, target_amount, target_date, monthly_amount, maintain_months,
       note, url, wait_until, achieved_at, archived_at, sort_order, created_at
  from goals
 where budget_id = $1
 order by sort_order, created_at, id;

-- name: GetGoalOwners :many
select id, budget_id from goals where id = any(sqlc.arg(ids)::uuid[]);

-- name: UpsertGoal :exec
-- The caller has checked that an existing id belongs to this budget.
insert into goals (id, budget_id, category_id, name, kind, target_amount, target_date, monthly_amount,
                   maintain_months, note, url, wait_until, achieved_at, archived_at, sort_order, created_at)
values (sqlc.arg(id), sqlc.arg(budget_id), sqlc.arg(category_id), sqlc.arg(name), sqlc.arg(kind),
        sqlc.narg(target_amount), sqlc.narg(target_date), sqlc.narg(monthly_amount),
        sqlc.narg(maintain_months), sqlc.arg(note), sqlc.arg(url), sqlc.narg(wait_until),
        case when sqlc.arg(achieved)::boolean then sqlc.arg(now)::timestamptz end,
        case when sqlc.arg(archived)::boolean then sqlc.arg(now)::timestamptz end, sqlc.arg(sort_order),
        sqlc.arg(now)::timestamptz)
on conflict (id) do update
   set category_id = excluded.category_id, name = excluded.name, kind = excluded.kind,
       target_amount = excluded.target_amount, target_date = excluded.target_date,
       monthly_amount = excluded.monthly_amount, maintain_months = excluded.maintain_months,
       note = excluded.note, url = excluded.url, wait_until = excluded.wait_until,
       achieved_at = case when sqlc.arg(achieved)::boolean then coalesce(goals.achieved_at, sqlc.arg(now)::timestamptz) end,
       archived_at = case when sqlc.arg(archived)::boolean then coalesce(goals.archived_at, sqlc.arg(now)::timestamptz) end,
       sort_order = excluded.sort_order, updated_at = sqlc.arg(now)::timestamptz
 where goals.budget_id = excluded.budget_id;

-- name: DeleteGoal :execrows
delete from goals where budget_id = $1 and id = $2;

-- name: MonthlyTotals :many
-- What was recorded in expense and income categories per month in
-- [from, to), for the average spending and typical income of ADR-092/094.
-- Opening balances (system categories) are left out.
select date_trunc('month', t.date)::date as month, c.kind as kind, sum(e.amount)::bigint as amount
  from entries e
  join transactions t on t.id = e.transaction_id
  join categories c on c.id = e.category_id
 where e.budget_id = sqlc.arg(budget_id) and not c.is_system
   and t.date >= sqlc.arg(from_date)::date and t.date < sqlc.arg(to_date)::date
 group by 1, 2
 order by 1, 2;
