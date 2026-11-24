-- name: GetLoan :one
-- A loan's terms; the account must belong to the budget.
select l.account_id, l.principal, l.term_months, l.start_date, l.first_payment_date, l.method,
       l.grace_months, l.prepay_mode, l.pay_from_account_id, l.principal_category_id,
       l.interest_category_id, l.tracked_after, l.holiday_shift
  from loans l
  join accounts a on a.id = l.account_id
 where a.budget_id = $1 and l.account_id = $2;

-- name: ListLoanRates :many
-- A loan's rates, oldest first, in ten-thousandths of a percent.
select effective_from, (annual_rate * 10000)::bigint as rate
  from loan_rates
 where loan_account_id = $1
 order by effective_from;

-- name: UpsertLoan :exec
insert into loans (account_id, principal, term_months, start_date, first_payment_date, method, grace_months,
                   prepay_mode, pay_from_account_id, principal_category_id, interest_category_id,
                   tracked_after, holiday_shift)
values (sqlc.arg(account_id), sqlc.arg(principal), sqlc.arg(term_months), sqlc.arg(start_date),
        sqlc.arg(first_payment_date), sqlc.arg(method), sqlc.arg(grace_months), sqlc.arg(prepay_mode),
        sqlc.narg(pay_from_account_id), sqlc.narg(principal_category_id), sqlc.narg(interest_category_id),
        sqlc.arg(tracked_after), sqlc.arg(holiday_shift))
on conflict (account_id) do update
   set principal = excluded.principal, term_months = excluded.term_months, start_date = excluded.start_date,
       first_payment_date = excluded.first_payment_date, method = excluded.method,
       grace_months = excluded.grace_months, prepay_mode = excluded.prepay_mode,
       pay_from_account_id = excluded.pay_from_account_id,
       principal_category_id = excluded.principal_category_id,
       interest_category_id = excluded.interest_category_id, holiday_shift = excluded.holiday_shift,
       updated_at = now();

-- name: DeleteLoanRates :exec
delete from loan_rates where loan_account_id = $1;

-- name: CreateLoanRate :exec
insert into loan_rates (loan_account_id, effective_from, annual_rate)
values (sqlc.arg(loan_account_id), sqlc.arg(effective_from), sqlc.arg(rate)::bigint / 10000.0);

-- name: DeleteLoan :execrows
delete from loans where account_id = $1;

-- name: GetLoanSchedule :one
select id from schedules where loan_account_id = $1;

-- name: UpsertLoanSchedule :exec
-- A loan's payments (ADR-097): its amounts come from the loan's table when
-- it posts, so it has no entries.
insert into schedules (id, budget_id, kind, loan_account_id, source, rrule, start_date, holiday_shift, note,
                       next_occurrence, budget_mode, created_by)
values (sqlc.arg(id), sqlc.arg(budget_id), 'loan', sqlc.arg(loan_account_id), sqlc.arg(source), sqlc.arg(rrule),
        sqlc.arg(start_date), sqlc.arg(holiday_shift), '貸款還款', sqlc.narg(next_occurrence), 'full',
        sqlc.narg(created_by))
on conflict (id) do update
   set source = excluded.source, rrule = excluded.rrule, start_date = excluded.start_date,
       holiday_shift = excluded.holiday_shift, next_occurrence = excluded.next_occurrence, updated_at = now();

-- name: DeleteLoanSchedule :exec
delete from schedules where loan_account_id = $1;

-- name: ListLoanEntries :many
-- Every entry on the loan account, with the schedule occurrence its
-- transaction posts, if any.
select t.id as transaction_id, t.date, t.schedule_id, t.occurrence_date, e.amount
  from entries e
  join transactions t on t.id = e.transaction_id
 where e.budget_id = $1 and e.account_id = $2
 order by t.date, t.created_at, t.id;

-- name: ListLoanPayments :many
-- What each posted occurrence of the loan's schedule paid in all, and of
-- that how much went to the loan's principal.
select t.occurrence_date::date as occurrence_date,
       coalesce(sum(e.amount) filter (where e.account_id = sqlc.arg(account_id)), 0)::bigint as principal,
       coalesce(-sum(e.amount) filter (where e.account_id <> sqlc.arg(account_id)), 0)::bigint as paid
  from transactions t
  join entries e on e.transaction_id = t.id
 where t.budget_id = sqlc.arg(budget_id) and t.schedule_id = sqlc.arg(schedule_id)
   and t.occurrence_date is not null
 group by t.id, t.occurrence_date;

-- name: CountAccountEntries :one
select count(*) from entries where budget_id = $1 and account_id = $2;
