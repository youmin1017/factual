-- +goose Up
-- Schedules (M9, ADR-084..087).

-- How a schedule is budgeted (ADR-086): not at all, the sum of its
-- occurrences in their month, or each occurrence spread over the months
-- before it.
create type budget_mode as enum ('none', 'full', 'spread');
alter table schedules
    add column budget_mode budget_mode not null default 'none',
    add column updated_at  timestamptz not null default now();

-- An envelope's base amount per month; its target is this plus what the
-- schedules it covers ask for (ADR-086). null = no base.
alter table categories add column budget_base bigint check (budget_base > 0);

-- Days off for the whole instance from the government's office calendar
-- (ADR-087), one row per day of each imported year. A year without rows
-- counts Saturdays and Sundays as off.
create table holidays (
    date   date primary key,
    is_off boolean not null,
    note   text not null default ''
);

create table holiday_years (
    year        integer primary key check (year between 1900 and 2999),
    source_url  text not null default '',  -- empty: imported from a file
    days        integer not null,
    days_off    integer not null,
    imported_by uuid references users (id) on delete set null,
    imported_at timestamptz not null default now()
);

-- +goose Down
drop table holiday_years, holidays;
alter table categories drop column budget_base;
alter table schedules drop column updated_at, drop column budget_mode;
drop type budget_mode;
