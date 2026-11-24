-- +goose Up
-- Savings goals (ADR-092): several per envelope, in one priority order per
-- budget. What a goal has saved is still derived from its envelope's
-- balance, now handed down the envelope's goals in that order.
alter table goals drop constraint goals_category_id_key;
alter table goals add column name text;
update goals g set name = c.name from categories c where c.id = g.category_id;
alter table goals alter column name set not null;
alter table goals add constraint goals_name_check check (length(name) between 1 and 100);
alter table goals add column sort_order integer not null default 0;
alter table goals add column note text not null default '' check (length(note) <= 500);
alter table goals add column url text not null default '' check (length(url) <= 2000);
alter table goals add column wait_until date;
alter table goals add column updated_at timestamptz not null default now();
create index goals_budget_order_idx on goals (budget_id, sort_order);
create index goals_category_idx on goals (category_id);
comment on column goals.sort_order is '整份預算的目標優先序;同一個預算(信封)的餘額依此順序分給各目標';
comment on column goals.monthly_amount is 'monthly:每月固定金額;target、maintain:每月最多存多少(選填)';
comment on column goals.wait_until is '考慮到這天:之前存滿也顯示「冷靜中」';
comment on column goals.url is '想買的東西的連結';

-- +goose Down
comment on column goals.monthly_amount is null;
drop index goals_category_idx;
drop index goals_budget_order_idx;
alter table goals drop column updated_at;
alter table goals drop column wait_until;
alter table goals drop column url;
alter table goals drop column note;
alter table goals drop column sort_order;
alter table goals drop column name;
alter table goals add constraint goals_category_id_key unique (category_id);
