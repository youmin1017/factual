-- +goose Up
-- A card's autopay is its own schedule (ADR-090): the transfer from the
-- autopay account on the due day, its amount taken from the statement when
-- it posts. It has no entries of its own and is not on the schedules page.
alter table schedules add column card_id uuid;
alter table schedules add constraint schedules_card_fkey
    foreign key (budget_id, card_id) references accounts (budget_id, id) on delete cascade;
create unique index schedules_card_key on schedules (card_id) where card_id is not null;

-- +goose Down
drop index schedules_card_key;
alter table schedules drop constraint schedules_card_fkey;
alter table schedules drop column card_id;
