-- +goose Up
-- Loans set up from their terms (ADR-096..098). The table is computed from
-- the terms and the loan account's entries, never stored. `tracked_after`
-- is the day the loan was set up: periods due up to it were paid before
-- Factual and come from the terms; later ones are paid by the loan's
-- schedule (kind 'loan', one per loan, no entries of its own).
alter table loans add column tracked_after date;
update loans set tracked_after = current_date;
alter table loans alter column tracked_after set not null;
alter table loans add column holiday_shift holiday_shift not null default 'next_workday';
alter table loans add column updated_at timestamptz not null default now();
comment on column loans.tracked_after is
    'The day the loan was set up; its periods due up to it come from the terms, later ones from its schedule (ADR-096)';

create unique index schedules_loan_key on schedules (loan_account_id) where loan_account_id is not null;
alter table schedules drop constraint schedules_budget_id_loan_account_id_fkey;
alter table schedules add constraint schedules_loan_fkey
    foreign key (budget_id, loan_account_id) references accounts (budget_id, id) on delete cascade;

-- +goose Down
alter table schedules drop constraint schedules_loan_fkey;
alter table schedules add constraint schedules_budget_id_loan_account_id_fkey
    foreign key (budget_id, loan_account_id) references accounts (budget_id, id);
drop index schedules_loan_key;
alter table loans drop column updated_at;
alter table loans drop column holiday_shift;
alter table loans drop column tracked_after;
