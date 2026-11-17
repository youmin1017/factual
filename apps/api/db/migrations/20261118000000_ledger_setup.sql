-- +goose Up
-- 帳本設定:
--   * 系統類別用穩定的代碼辨識(例如 opening_balance),不依賴名稱。
--   * 期初餘額的交易有標記:帳戶只有期初餘額時仍可刪除。

alter table categories
    add column system_key text,
    add constraint categories_system_key_check check ((system_key is null) = (not is_system));

create unique index categories_system_key on categories (budget_id, system_key) where system_key is not null;

alter table transactions
    add column is_opening boolean not null default false;

-- +goose Down
alter table transactions drop column if exists is_opening;
drop index if exists categories_system_key;
alter table categories
    drop constraint if exists categories_system_key_check,
    drop column if exists system_key;
