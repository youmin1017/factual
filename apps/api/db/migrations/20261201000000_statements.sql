-- +goose Up
-- Credit card statements (ADR-088, ADR-089). A card has one open statement
-- (closed_at null); closing it bills the card's entries up to its last day.
-- amount_due is now only what the owner typed to match the bank's bill:
-- null means the computed amount (the outstanding balance at closing).
alter table statements add column closed_at timestamptz;
create unique index statements_open_key on statements (account_id) where closed_at is null;
create index statements_account_idx on statements (account_id, period_end desc);
comment on column statements.amount_due is '對齊銀行帳單時手動輸入的應繳金額;null = 依已列帳的分錄計算';

-- +goose Down
comment on column statements.amount_due is null;
drop index statements_account_idx;
drop index statements_open_key;
alter table statements drop column closed_at;
