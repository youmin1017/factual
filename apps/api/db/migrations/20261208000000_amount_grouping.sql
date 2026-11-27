-- +goose Up
-- How amounts group their digits (ADR-122): 3 (1,000,000) or 4 (100,0000).
alter table users add column amount_grouping smallint not null default 3
    check (amount_grouping in (3, 4));

-- +goose Down
alter table users drop column amount_grouping;
