-- name: ListPayees :many
-- Payees with the category last used for each and how often each is used.
select p.id, p.name, lc.category_id as last_category_id,
       (select count(*) from transactions t where t.payee_id = p.id)::int as transaction_count
  from payees p
  left join lateral (
        select e.category_id
          from transactions t
          join entries e on e.transaction_id = t.id
         where t.payee_id = p.id and e.category_id is not null
         order by t.date desc, t.created_at desc
         limit 1) lc on true
 where p.budget_id = $1
 order by p.name;

-- name: GetPayee :one
select p.id, p.name, lc.category_id as last_category_id,
       (select count(*) from transactions t where t.payee_id = p.id)::int as transaction_count
  from payees p
  left join lateral (
        select e.category_id
          from transactions t
          join entries e on e.transaction_id = t.id
         where t.payee_id = p.id and e.category_id is not null
         order by t.date desc, t.created_at desc
         limit 1) lc on true
 where p.budget_id = $1 and p.id = $2;

-- name: RenamePayee :execrows
update payees set name = sqlc.arg(name) where budget_id = sqlc.arg(budget_id) and id = sqlc.arg(id);

-- name: CountPayees :one
-- How many of the ids are payees of the budget.
select count(*)::int from payees where budget_id = $1 and id = any(sqlc.arg(ids)::uuid[]);

-- name: MovePayeeTransactions :exec
update transactions set payee_id = sqlc.arg(target_id)
 where budget_id = sqlc.arg(budget_id) and payee_id = any(sqlc.arg(source_ids)::uuid[]);

-- name: MovePayeeSchedules :exec
update schedules set payee_id = sqlc.arg(target_id)
 where budget_id = sqlc.arg(budget_id) and payee_id = any(sqlc.arg(source_ids)::uuid[]);

-- name: DeletePayees :exec
delete from payees where budget_id = sqlc.arg(budget_id) and id = any(sqlc.arg(ids)::uuid[]);

-- name: PayeeInUse :one
select (exists (select 1 from transactions t where t.payee_id = sqlc.arg(id)::uuid)
     or exists (select 1 from schedules s where s.payee_id = sqlc.arg(id)::uuid))::boolean as in_use;
