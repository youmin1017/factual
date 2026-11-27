-- name: GetCardSettings :one
select c.account_id, c.statement_day, c.due_day, c.credit_limit, c.autopay_account_id
  from credit_cards c
  join accounts a on a.id = c.account_id
 where a.budget_id = $1 and c.account_id = $2;

-- name: ListCardSettings :many
select c.account_id, c.statement_day, c.due_day, c.credit_limit, c.autopay_account_id
  from credit_cards c
  join accounts a on a.id = c.account_id
 where a.budget_id = $1;

-- name: UpsertCardSettings :exec
insert into credit_cards (account_id, statement_day, due_day, credit_limit, autopay_account_id)
values ($1, $2, $3, $4, $5)
on conflict (account_id) do update
   set statement_day = excluded.statement_day, due_day = excluded.due_day,
       credit_limit = excluded.credit_limit, autopay_account_id = excluded.autopay_account_id;

-- name: GetOpenStatement :one
select id, period_start, period_end, due_date
  from statements
 where budget_id = $1 and account_id = $2 and closed_at is null;

-- name: LastClosingDay :one
-- The end of the card's last closed statement; no rows before the first.
select period_end
  from statements
 where account_id = $1 and closed_at is not null
 order by period_end desc
 limit 1;

-- name: CreateStatement :exec
insert into statements (budget_id, account_id, period_start, period_end, due_date)
values ($1, $2, $3, $4, $5);

-- name: CreateClosedStatement :one
-- A statement already closed: the latest bill of a new card (ADR-137).
insert into statements (budget_id, account_id, period_start, period_end, due_date, closed_at)
values ($1, $2, $3, $4, $5, now())
returning id;

-- name: UpdateOpenStatement :exec
update statements
   set period_end = $3, due_date = $4
 where budget_id = $1 and id = $2 and closed_at is null;

-- name: ListClosableStatements :many
-- Open statements whose last day is before `today`, of cards that still
-- have their settings.
select s.id, s.budget_id, s.account_id, s.period_start, s.period_end, s.due_date,
       c.statement_day, c.due_day
  from statements s
  join credit_cards c on c.account_id = s.account_id
 where s.closed_at is null and s.period_end < sqlc.arg(today)::date
 order by s.period_end;

-- name: BillEntries :execrows
-- Bills every entry of the card not yet billed, dated up to the closing day.
update entries e
   set statement_id = sqlc.arg(statement_id)
  from transactions t
 where t.id = e.transaction_id
   and e.budget_id = sqlc.arg(budget_id) and e.account_id = sqlc.arg(account_id)
   and e.statement_id is null and t.date <= sqlc.arg(period_end)::date;

-- name: CloseStatement :exec
update statements set closed_at = now() where id = $1 and closed_at is null;

-- name: ListStatements :many
-- A card's statements, newest first, with the entries billed in them split
-- into payments (transfers in from another account) and everything else.
select s.id, s.period_start, s.period_end, s.due_date, s.amount_due, s.closed_at,
       coalesce(sum(e.amount) filter (where p.is_payment), 0)::bigint as payments,
       coalesce(sum(e.amount) filter (where not p.is_payment), 0)::bigint as charges
  from statements s
  left join entries e on e.statement_id = s.id
  left join lateral (
       select (e.category_id is null and e.amount > 0 and exists (
                 select 1 from entries o
                  where o.transaction_id = e.transaction_id and o.account_id <> e.account_id)) as is_payment
  ) p on true
 where s.budget_id = $1 and s.account_id = $2
 group by s.id
 order by s.period_end desc;

-- name: UnbilledEntries :one
-- The card's entries not billed yet: payments, and everything else.
select coalesce(sum(e.amount) filter (where p.is_payment), 0)::bigint as payments,
       coalesce(sum(e.amount) filter (where not p.is_payment), 0)::bigint as charges
  from entries e
  cross join lateral (
       select (e.category_id is null and e.amount > 0 and exists (
                 select 1 from entries o
                  where o.transaction_id = e.transaction_id and o.account_id <> e.account_id)) as is_payment
  ) p
 where e.budget_id = $1 and e.account_id = $2 and e.statement_id is null;

-- name: PaymentsAfter :one
-- What was paid into the card after a day (ADR-089).
select coalesce(sum(e.amount), 0)::bigint
  from entries e
  join transactions t on t.id = e.transaction_id
 where e.budget_id = $1 and e.account_id = $2 and t.date > sqlc.arg(after)::date
   and e.category_id is null and e.amount > 0
   and exists (select 1 from entries o where o.transaction_id = e.transaction_id and o.account_id <> e.account_id);

-- name: SetStatementDue :execrows
update statements s
   set amount_due = sqlc.narg(amount_due)
 where s.budget_id = $1 and s.id = $2 and s.closed_at is not null;

-- name: GetStatementCard :one
select account_id from statements where budget_id = $1 and id = $2;

-- name: ListEntryStatements :many
-- The statements the entries of these transactions are billed in, to keep
-- them when the transactions are saved again (ADR-088).
select transaction_id, account_id, statement_id, pays_statement_id
  from entries
 where transaction_id = any(sqlc.arg(ids)::uuid[])
   and (statement_id is not null or pays_statement_id is not null);

-- name: RestoreEntryStatement :exec
update entries
   set statement_id = coalesce(statement_id, sqlc.narg(statement_id)),
       pays_statement_id = coalesce(pays_statement_id, sqlc.narg(pays_statement_id))
 where transaction_id = $1 and account_id = $2;

-- name: LatestClosedStatement :one
select id, period_end
  from statements
 where budget_id = $1 and account_id = $2 and closed_at is not null
 order by period_end desc
 limit 1;

-- name: UnbillChosen :execrows
-- Takes entries out of a statement: they are billed at the next closing.
update entries
   set statement_id = null
 where budget_id = sqlc.arg(budget_id) and account_id = sqlc.arg(account_id)
   and statement_id = sqlc.arg(statement_id) and transaction_id = any(sqlc.arg(ids)::uuid[]);

-- name: BillChosen :execrows
-- Puts unbilled entries dated up to its closing day back into a statement.
update entries e
   set statement_id = sqlc.arg(statement_id)
  from transactions t
 where t.id = e.transaction_id
   and e.budget_id = sqlc.arg(budget_id) and e.account_id = sqlc.arg(account_id)
   and e.statement_id is null and t.date <= sqlc.arg(period_end)::date
   and e.transaction_id = any(sqlc.arg(ids)::uuid[]);
