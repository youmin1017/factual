-- name: ListSchedules :many
select s.id, s.source, s.rrule, s.start_date, s.holiday_shift, s.payee_id, p.name as payee_name,
       s.note, s.amount_is_estimate, s.next_occurrence, (s.paused_at is not null)::boolean as paused,
       s.budget_mode, s.created_by, s.created_at, s.card_id
  from schedules s
  left join payees p on p.id = s.payee_id
 where s.budget_id = $1 and s.kind = 'template'
 order by s.created_at, s.id;

-- name: ListScheduleEntries :many
select e.schedule_id, e.account_id, e.category_id, e.amount, e.memo
  from schedule_entries e
 where e.budget_id = $1
 order by e.schedule_id, e.amount, e.id;

-- name: ListScheduleSkips :many
select k.schedule_id, k.occurrence_date
  from schedule_skips k
  join schedules s on s.id = k.schedule_id
 where s.budget_id = $1
 order by k.schedule_id, k.occurrence_date;

-- name: GetScheduleOwners :many
select id, budget_id from schedules where id = any(sqlc.arg(ids)::uuid[]);

-- name: UpsertSchedule :exec
-- The caller has checked that an existing id belongs to this budget.
insert into schedules (id, budget_id, source, rrule, start_date, holiday_shift, payee_id, note,
                       amount_is_estimate, next_occurrence, paused_at, budget_mode, created_by)
values (sqlc.arg(id), sqlc.arg(budget_id), sqlc.arg(source), sqlc.arg(rrule), sqlc.arg(start_date),
        sqlc.arg(holiday_shift), sqlc.narg(payee_id), sqlc.arg(note), sqlc.arg(amount_is_estimate),
        sqlc.narg(next_occurrence), case when sqlc.arg(paused)::boolean then now() end,
        sqlc.arg(budget_mode), sqlc.narg(created_by))
on conflict (id) do update
   set source = excluded.source, rrule = excluded.rrule, start_date = excluded.start_date,
       holiday_shift = excluded.holiday_shift, payee_id = excluded.payee_id, note = excluded.note,
       amount_is_estimate = excluded.amount_is_estimate, next_occurrence = excluded.next_occurrence,
       paused_at = case when sqlc.arg(paused)::boolean then coalesce(schedules.paused_at, now()) end,
       budget_mode = excluded.budget_mode, updated_at = now()
 where schedules.budget_id = excluded.budget_id;

-- name: DeleteScheduleEntriesOf :exec
delete from schedule_entries where budget_id = $1 and schedule_id = $2;

-- name: CreateScheduleEntry :exec
insert into schedule_entries (budget_id, schedule_id, account_id, category_id, amount, memo)
values ($1, $2, $3, $4, $5, $6);

-- name: DeleteSchedule :execrows
delete from schedules where budget_id = $1 and id = $2;

-- name: LastPostedOccurrences :many
-- The latest occurrence posted from each schedule among the ids.
select schedule_id::uuid as schedule_id, max(occurrence_date)::date as occurrence_date
  from transactions
 where schedule_id = any(sqlc.arg(ids)::uuid[])
 group by schedule_id;

-- name: PostedOccurrences :many
-- Occurrences of the budget's schedules posted on or after a date.
select schedule_id::uuid as schedule_id, occurrence_date::date as occurrence_date
  from transactions
 where budget_id = $1 and schedule_id is not null and occurrence_date >= $2;

-- name: ListDueSchedules :many
-- Schedules that may have an occurrence to post: next occurrence up to the
-- date given (today plus the longest shift back to a working day).
select s.id, s.budget_id
  from schedules s
 where s.next_occurrence <= $1 and s.paused_at is null and s.kind = 'template'
 order by s.next_occurrence;

-- name: LockSchedule :one
select s.id, s.budget_id, s.rrule, s.start_date, s.holiday_shift, s.payee_id, s.note,
       s.amount_is_estimate, s.next_occurrence, (s.paused_at is not null)::boolean as paused, s.created_by,
       s.card_id
  from schedules s
 where s.id = $1
   for update;

-- name: ScheduleEntriesOf :many
select account_id, category_id, amount, memo from schedule_entries where schedule_id = $1 order by amount, id;

-- name: ScheduleSkipsOf :many
select occurrence_date from schedule_skips where schedule_id = $1;

-- name: InsertOccurrence :one
-- A posted occurrence; nothing when it was posted already.
insert into transactions (id, budget_id, date, payee_id, note, needs_review, schedule_id, occurrence_date, created_by)
values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8)
on conflict (schedule_id, occurrence_date) do nothing
returning id;

-- name: SetNextOccurrence :exec
update schedules set next_occurrence = $2 where id = $1;

-- name: AddSkip :exec
insert into schedule_skips (schedule_id, occurrence_date) values ($1, $2) on conflict do nothing;

-- name: RemoveSkip :execrows
delete from schedule_skips where schedule_id = $1 and occurrence_date = $2;

-- name: SetCategoryBase :execrows
update categories set budget_base = sqlc.narg(budget_base) where budget_id = $1 and id = $2;

-- name: GetAutopaySchedule :one
select id from schedules where card_id = $1;

-- name: UpsertAutopaySchedule :exec
-- A card's autopay schedule (ADR-090); it posts no budget money of its own.
insert into schedules (id, budget_id, card_id, source, rrule, start_date, holiday_shift, note,
                       next_occurrence, budget_mode, created_by)
values (sqlc.arg(id), sqlc.arg(budget_id), sqlc.arg(card_id), sqlc.arg(source), sqlc.arg(rrule),
        sqlc.arg(start_date), 'next_workday', '自動扣繳', sqlc.narg(next_occurrence), 'none', sqlc.narg(created_by))
on conflict (id) do update
   set source = excluded.source, rrule = excluded.rrule, start_date = excluded.start_date,
       next_occurrence = excluded.next_occurrence, updated_at = now();

-- name: DeleteAutopaySchedule :exec
delete from schedules where card_id = $1;
