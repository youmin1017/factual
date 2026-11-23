-- name: ListRegisterTransactions :many
-- Transactions with an entry on the account, oldest first.
select t.id, t.date, t.payee_id, p.name as payee_name, t.note, t.needs_review, t.is_opening
  from transactions t
  left join payees p on p.id = t.payee_id
 where t.budget_id = $1
   and exists (select 1 from entries e where e.transaction_id = t.id and e.account_id = $2)
 order by t.date, t.created_at, t.id;

-- name: ListRegisterEntries :many
-- Every entry of the transactions above, including those on other accounts.
select e.id, e.transaction_id, e.account_id, e.category_id, e.amount, e.memo, e.cleared, e.statement_id
  from entries e
 where e.budget_id = $1
   and e.transaction_id in (select x.transaction_id from entries x where x.account_id = $2)
 order by e.transaction_id, e.amount, e.id;

-- name: ListAccountRefs :many
-- Every account of the budget, for validating entries.
select id, on_budget, (closed_at is not null)::boolean as closed from accounts where budget_id = $1;

-- name: ListCategoryRefs :many
select id, is_system from categories where budget_id = $1;

-- name: GetTransactionOwners :many
-- The budget of each existing transaction among the ids.
select id, budget_id, is_opening from transactions where id = any(sqlc.arg(ids)::uuid[]);

-- name: UpsertPayee :one
insert into payees (budget_id, name) values ($1, $2)
on conflict (budget_id, name) do update set name = excluded.name
returning id;

-- name: UpsertTransaction :exec
-- The caller has checked that an existing id belongs to this budget.
insert into transactions (id, budget_id, date, payee_id, note, created_by)
values (sqlc.arg(id), sqlc.arg(budget_id), sqlc.arg(date), sqlc.narg(payee_id), sqlc.arg(note), sqlc.narg(created_by))
on conflict (id) do update
   set date = excluded.date, payee_id = excluded.payee_id, note = excluded.note,
       -- Saving an edit is reviewing it (ADR-085).
       needs_review = false, updated_at = now()
 where transactions.budget_id = excluded.budget_id;

-- name: DeleteEntriesOf :exec
delete from entries where budget_id = $1 and transaction_id = $2;

-- name: DeleteTransaction :execrows
delete from transactions where budget_id = $1 and id = $2;

-- name: ListScopeTransactions :many
-- Transactions with an entry on an account in the scope (on_budget null:
-- every account), oldest first.
select t.id, t.date, t.payee_id, p.name as payee_name, t.note, t.needs_review, t.is_opening
  from transactions t
  left join payees p on p.id = t.payee_id
 where t.budget_id = sqlc.arg(budget_id)
   and exists (select 1
                 from entries e
                 join accounts a on a.id = e.account_id
                where e.transaction_id = t.id
                  and (sqlc.narg(on_budget)::boolean is null or a.on_budget = sqlc.narg(on_budget)::boolean))
 order by t.date, t.created_at, t.id;

-- name: ListScopeEntries :many
select e.id, e.transaction_id, e.account_id, e.category_id, e.amount, e.memo, e.cleared, e.statement_id
  from entries e
 where e.budget_id = sqlc.arg(budget_id)
   and e.transaction_id in (
        select x.transaction_id
          from entries x
          join accounts a on a.id = x.account_id
         where x.budget_id = sqlc.arg(budget_id)
           and (sqlc.narg(on_budget)::boolean is null or a.on_budget = sqlc.narg(on_budget)::boolean))
 order by e.transaction_id, e.amount, e.id;

-- name: SetTransactionOccurrence :execrows
-- Links a transaction to the schedule occurrence it posts (an edited 預定
-- row, ADR-085), unless it already belongs to one.
update transactions set schedule_id = $2, occurrence_date = $3
 where id = $1 and schedule_id is null;

-- name: MarkReviewed :execrows
update transactions
   set needs_review = false, updated_at = now()
 where budget_id = sqlc.arg(budget_id) and id = any(sqlc.arg(ids)::uuid[]) and needs_review;
