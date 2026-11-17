-- +goose Up
-- 初始資料表(PostgreSQL 15+)。設計說明見各段註解。
--
-- 共通約定
--   * 金額一律是 bigint 的最小貨幣單位,不用浮點數。
--   * 分錄金額的正負以「帳戶餘額的變化」為準:正數 = 餘額增加,負數 = 餘額減少。
--     負債類帳戶(信用卡、貸款、欠朋友的錢)的餘額是負數。
--   * 主鍵用 uuid,允許前端先產生(建議 UUIDv7),方便 :w 批次提交時互相引用與重試。
--   * 帳本內的表都帶 budget_id,並用複合外鍵保證不會引用到別的帳本的資料。

-- ───────────────────────── 列舉型別 ─────────────────────────

create type budget_role       as enum ('owner', 'editor', 'viewer');
create type group_role        as enum ('admin', 'member');
create type friendship_status as enum ('pending', 'accepted');
create type account_kind      as enum ('cash', 'bank', 'credit_card', 'loan', 'investment', 'friend', 'suspense');
create type category_kind     as enum ('expense', 'income');
create type cleared_state     as enum ('uncleared', 'cleared', 'reconciled');
create type goal_kind         as enum ('target', 'target_by_date', 'maintain', 'monthly');
create type loan_method       as enum ('annuity', 'equal_principal');
create type prepay_mode       as enum ('shorten_term', 'reduce_payment');
create type schedule_kind     as enum ('template', 'loan');
create type holiday_shift     as enum ('none', 'next_workday', 'prev_workday');
create type shared_kind       as enum ('expense', 'settlement');
create type split_method      as enum ('equal', 'exact', 'percent', 'shares');

-- ───────────────────────── 使用者與登入 ─────────────────────────

create table users (
    id                uuid primary key default gen_random_uuid(),
    username          text,
    display_name      text not null,
    email             text,
    password_hash     text,                      -- null = 佔位成員(尚未註冊的朋友),無法登入
    is_admin          boolean not null default false,
    default_budget_id uuid,                      -- 分帳產生的交易要進哪個帳本;外鍵在 budgets 建立後補上
    created_by        uuid references users (id),-- 佔位成員是誰建的
    created_at        timestamptz not null default now(),
    disabled_at       timestamptz,
    check (password_hash is null or username is not null)
);
create unique index users_username_key on users (lower(username));
create unique index users_email_key    on users (lower(email));

create table sessions (
    token_hash   bytea primary key,              -- 只存雜湊,cookie 裡才是原始 token
    user_id      uuid not null references users (id) on delete cascade,
    created_at   timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    expires_at   timestamptz not null
);
create index sessions_user_idx on sessions (user_id);

create table invites (
    id             uuid primary key default gen_random_uuid(),
    token_hash     bytea not null unique,
    created_by     uuid not null references users (id),
    claims_user_id uuid references users (id),   -- 有值 = 這張邀請用來認領某個佔位成員
    expires_at     timestamptz not null,
    used_at        timestamptz
);

-- ───────────────────────── 帳本與成員 ─────────────────────────

create table budgets (
    id         uuid primary key default gen_random_uuid(),
    name       text not null,
    currency   text not null check (currency ~ '^[A-Z]{3}$'),
    created_at timestamptz not null default now()
);

alter table users
    add constraint users_default_budget_fk
    foreign key (default_budget_id) references budgets (id) on delete set null;

create table budget_members (
    budget_id uuid not null references budgets (id) on delete cascade,
    user_id   uuid not null references users (id) on delete cascade,
    role      budget_role not null,
    joined_at timestamptz not null default now(),
    primary key (budget_id, user_id)
);
create index budget_members_user_idx on budget_members (user_id);

-- ───────────────────────── 朋友與群組 ─────────────────────────

create table friendships (
    user_a       uuid not null references users (id) on delete cascade,
    user_b       uuid not null references users (id) on delete cascade,
    status       friendship_status not null default 'pending',
    requested_by uuid not null references users (id),
    created_at   timestamptz not null default now(),
    primary key (user_a, user_b),
    check (user_a < user_b)                      -- 一對朋友只存一列
);
create index friendships_user_b_idx on friendships (user_b);

create table groups (
    id          uuid primary key default gen_random_uuid(),
    name        text not null,
    currency    text not null check (currency ~ '^[A-Z]{3}$'),
    created_by  uuid not null references users (id),
    created_at  timestamptz not null default now(),
    archived_at timestamptz
);

create table group_members (
    group_id  uuid not null references groups (id) on delete cascade,
    user_id   uuid not null references users (id),
    role      group_role not null default 'member',
    joined_at timestamptz not null default now(),
    left_at   timestamptz,                       -- 離開後保留列,歷史分帳仍要能顯示
    primary key (group_id, user_id)
);
create index group_members_user_idx on group_members (user_id);

-- ───────────────────────── 類別(樹狀) ─────────────────────────

create table categories (
    id          uuid primary key default gen_random_uuid(),
    budget_id   uuid not null references budgets (id) on delete cascade,
    parent_id   uuid,
    name        text not null check (name <> '' and position('/' in name) = 0),
    kind        category_kind not null default 'expense',
    pooled      boolean not null default false,  -- true = 子類別共用本層的信封額度
    is_system   boolean not null default false,  -- 例如「期初餘額」
    sort_order  integer not null default 0,
    archived_at timestamptz,
    unique (budget_id, id),
    unique nulls not distinct (budget_id, parent_id, name),
    foreign key (budget_id, parent_id) references categories (budget_id, id)
);
-- 層數上限(建議 3 層)與「子類別的 kind 必須與父類別相同」由應用層檢查。

-- ───────────────────────── 帳戶 ─────────────────────────

create table accounts (
    id                  uuid primary key default gen_random_uuid(),
    budget_id           uuid not null references budgets (id) on delete cascade,
    name                text not null,
    kind                account_kind not null,
    on_budget           boolean not null,        -- false = 不計入預算的追蹤帳戶(貸款、投資)
    friend_user_id      uuid references users (id),   -- 往來帳戶:對象是某位朋友
    group_id            uuid references groups (id),  -- 往來帳戶:對象是某個群組
    default_category_id uuid,                    -- 往來帳戶:這個朋友或群組的分帳預設類別
    sort_order          integer not null default 0,
    closed_at           timestamptz,
    created_at          timestamptz not null default now(),
    unique (budget_id, id),
    unique (budget_id, name),
    foreign key (budget_id, default_category_id) references categories (budget_id, id),
    check (num_nonnulls(friend_user_id, group_id) = (kind = 'friend')::int),
    check (kind not in ('loan', 'investment') or not on_budget),
    check (kind not in ('friend', 'suspense', 'credit_card') or on_budget)
);
create unique index accounts_friend_key on accounts (budget_id, friend_user_id) where friend_user_id is not null;
create unique index accounts_group_key  on accounts (budget_id, group_id)       where group_id is not null;
-- on_budget 在帳戶已有分錄後不可更改(應用層檢查),否則會破壞下方的平衡不變式。

create table credit_cards (
    account_id         uuid primary key references accounts (id) on delete cascade,
    statement_day      smallint not null check (statement_day between 1 and 31),  -- 結帳日
    due_day            smallint not null check (due_day between 1 and 31),        -- 繳款截止日
    credit_limit       bigint,
    autopay_account_id uuid references accounts (id)                              -- 自動扣繳帳戶
);

create table statements (
    id           uuid primary key default gen_random_uuid(),
    budget_id    uuid not null,
    account_id   uuid not null,
    period_start date not null,
    period_end   date not null,                  -- 結帳日
    due_date     date not null,
    amount_due   bigint,                         -- 結帳時的快照,可手動對齊實際帳單;null = 尚未結帳
    minimum_due  bigint,
    unique (budget_id, id),
    unique (account_id, period_end),
    foreign key (budget_id, account_id) references accounts (budget_id, id) on delete cascade,
    check (period_start <= period_end and period_end <= due_date)
);

create table loans (
    account_id            uuid primary key references accounts (id) on delete cascade,
    principal             bigint not null check (principal > 0),
    term_months           integer not null check (term_months > 0),
    start_date            date not null,         -- 撥款日
    first_payment_date    date not null,
    method                loan_method not null default 'annuity',  -- 本息平均 / 本金平均
    grace_months          integer not null default 0 check (grace_months >= 0),  -- 寬限期(只繳息)
    prepay_mode           prepay_mode not null default 'shorten_term',
    pay_from_account_id   uuid references accounts (id),
    principal_category_id uuid references categories (id),
    interest_category_id  uuid references categories (id)
);

-- 利率分段:第一列是起始利率,之後每列是一次利率調整。攤還表由這些參數即時計算,不落表。
create table loan_rates (
    loan_account_id uuid not null references loans (account_id) on delete cascade,
    effective_from  date not null,
    annual_rate     numeric(7, 4) not null check (annual_rate >= 0),  -- 百分比,2.3500 = 2.35%
    primary key (loan_account_id, effective_from)
);

-- ───────────────────────── 收付款對象 ─────────────────────────

create table payees (
    id        uuid primary key default gen_random_uuid(),
    budget_id uuid not null references budgets (id) on delete cascade,
    name      text not null check (name <> ''),
    unique (budget_id, id),
    unique (budget_id, name)
);

-- ───────────────────────── 排程 ─────────────────────────

create table schedules (
    id                 uuid primary key default gen_random_uuid(),
    budget_id          uuid not null references budgets (id) on delete cascade,
    kind               schedule_kind not null default 'template',
    source             text not null default '', -- 使用者在編輯器寫的原始那一行,用來還原顯示
    rrule              text not null,            -- 由 DSL 編譯成的 iCalendar RRULE
    start_date         date not null,
    end_date           date,
    holiday_shift      holiday_shift not null default 'none',
    payee_id           uuid,
    note               text not null default '',
    amount_is_estimate boolean not null default false,  -- 金額前有 ~:產生的交易標記為待確認
    loan_account_id    uuid,                     -- kind = 'loan':金額由攤還計算決定
    next_occurrence    date,                     -- 背景工作掃描用;null = 已結束
    paused_at          timestamptz,
    created_by         uuid references users (id),
    created_at         timestamptz not null default now(),
    unique (budget_id, id),
    foreign key (budget_id, payee_id) references payees (budget_id, id),
    foreign key (budget_id, loan_account_id) references accounts (budget_id, id),
    check ((kind = 'loan') = (loan_account_id is not null))
);
create index schedules_due_idx on schedules (next_occurrence) where next_occurrence is not null and paused_at is null;

create table schedule_entries (
    id          uuid primary key default gen_random_uuid(),
    budget_id   uuid not null,
    schedule_id uuid not null,
    account_id  uuid not null,
    category_id uuid,
    amount      bigint not null,
    memo        text not null default '',
    foreign key (budget_id, schedule_id) references schedules (budget_id, id) on delete cascade,
    foreign key (budget_id, account_id)  references accounts (budget_id, id),
    foreign key (budget_id, category_id) references categories (budget_id, id)
);
create index schedule_entries_schedule_idx on schedule_entries (schedule_id);

create table schedule_skips (
    schedule_id     uuid not null references schedules (id) on delete cascade,
    occurrence_date date not null,
    primary key (schedule_id, occurrence_date)
);

-- ───────────────────────── 分帳(跨帳本,不帶 budget_id) ─────────────────────────

create table shared_expenses (
    id            uuid primary key default gen_random_uuid(),
    kind          shared_kind not null default 'expense',  -- settlement = 還款,付款人付、收款人「分攤」全額
    group_id      uuid references groups (id),   -- null = 朋友之間直接分帳
    date          date not null,
    description   text not null,
    note          text not null default '',
    currency      text not null check (currency ~ '^[A-Z]{3}$'),  -- 結算幣別(群組幣別)
    total_amount  bigint not null check (total_amount > 0),       -- 結算幣別金額
    orig_currency text,                          -- 原始幣別,例如在日本刷的 JPY
    orig_amount   bigint,
    fx_rate       numeric(18, 8),                -- 記錄當下的匯率快照
    split_method  split_method not null default 'equal',
    category_hint text,                          -- 記錄者的類別路徑(如「食/外食」),供其他人對照到自己的類別
    created_by    uuid not null references users (id),
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now(),
    deleted_at    timestamptz,
    check (num_nonnulls(orig_currency, orig_amount, fx_rate) in (0, 3))
);
create index shared_expenses_group_idx on shared_expenses (group_id, date desc);

create table shared_expense_payers (
    expense_id uuid not null references shared_expenses (id) on delete cascade,
    user_id    uuid not null references users (id),
    amount     bigint not null check (amount > 0),
    primary key (expense_id, user_id)
);
create index shared_expense_payers_user_idx on shared_expense_payers (user_id);

create table shared_expense_shares (
    expense_id uuid not null references shared_expenses (id) on delete cascade,
    user_id    uuid not null references users (id),
    amount     bigint not null check (amount >= 0),  -- 算好的應分攤金額
    weight     numeric(12, 4),                       -- 百分比或份數的原始輸入,供重新計算
    primary key (expense_id, user_id)
);
create index shared_expense_shares_user_idx on shared_expense_shares (user_id);

-- 我的對照表:看到別人的類別提示時,對應到我自己的哪個類別(改過一次就記住)。
create table split_category_map (
    budget_id   uuid not null,
    hint        text not null,
    category_id uuid not null,
    primary key (budget_id, hint),
    foreign key (budget_id, category_id) references categories (budget_id, id) on delete cascade
);

-- ───────────────────────── 交易與分錄 ─────────────────────────

create table transactions (
    id                uuid primary key default gen_random_uuid(),
    budget_id         uuid not null references budgets (id) on delete cascade,
    date              date not null,
    payee_id          uuid,
    note              text not null default '',
    needs_review      boolean not null default false,  -- 估計金額的排程、別人記的分帳:等我確認
    schedule_id       uuid references schedules (id) on delete set null,
    occurrence_date   date,                      -- 與 schedule_id 一起保證同一期只產生一次
    shared_expense_id uuid references shared_expenses (id),
    created_by        uuid references users (id),
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now(),
    unique (budget_id, id),
    unique (schedule_id, occurrence_date),
    unique (budget_id, shared_expense_id),       -- 一筆分帳在每個帳本只對應一筆交易
    foreign key (budget_id, payee_id) references payees (budget_id, id)
);
create index transactions_budget_date_idx on transactions (budget_id, date desc);

-- 一筆交易有一到多列分錄。編輯器裡的一列 = 同一筆交易在目前帳戶上的分錄加總。
--   一般支出   (玉山卡, 食/雜貨, -1280)
--   拆分       (玉山卡, 食/雜貨, -800) + (玉山卡, 日用品, -480)
--   轉帳/繳卡費 (台新, null, -5000) + (玉山卡, null, +5000)
--   貸款還款   (台新, 車貸/本金, -8500) + (台新, 車貸/利息, -1500) + (車貸帳戶, null, +8500)
create table entries (
    id                uuid primary key default gen_random_uuid(),
    budget_id         uuid not null,
    transaction_id    uuid not null,
    account_id        uuid not null,
    category_id       uuid,                      -- null = 轉帳的一邊,或預算外帳戶的變動
    amount            bigint not null,
    memo              text not null default '',
    cleared           cleared_state not null default 'uncleared',
    statement_id      uuid,                      -- 這筆列在哪一期信用卡帳單
    pays_statement_id uuid,                      -- 這筆是繳哪一期帳單
    foreign key (budget_id, transaction_id)    references transactions (budget_id, id) on delete cascade,
    foreign key (budget_id, account_id)        references accounts (budget_id, id),
    foreign key (budget_id, category_id)       references categories (budget_id, id),
    foreign key (budget_id, statement_id)      references statements (budget_id, id) on delete set null (statement_id),
    foreign key (budget_id, pays_statement_id) references statements (budget_id, id) on delete set null (pays_statement_id)
);
create index entries_transaction_idx    on entries (transaction_id);
create index entries_account_idx        on entries (account_id);
create index entries_category_idx       on entries (category_id) where category_id is not null;
create index entries_statement_idx      on entries (statement_id) where statement_id is not null;
create index entries_pays_statement_idx on entries (pays_statement_id) where pays_statement_id is not null;

-- ───────────────────────── 預算分配與儲蓄目標 ─────────────────────────

-- 每個類別每個月一列:這個月從資金池撥了多少進這個信封(可為負,代表退回資金池)。
create table allocations (
    budget_id   uuid not null,
    category_id uuid not null,
    month       date not null check (extract(day from month) = 1),
    amount      bigint not null,
    updated_by  uuid references users (id),
    updated_at  timestamptz not null default now(),
    primary key (category_id, month),
    foreign key (budget_id, category_id) references categories (budget_id, id) on delete cascade
);
create index allocations_budget_month_idx on allocations (budget_id, month);

-- 儲蓄目標掛在一個類別上;「已存金額」就是那個類別的信封餘額,不另外存。
create table goals (
    id                uuid primary key default gen_random_uuid(),
    budget_id         uuid not null,
    category_id       uuid not null unique,
    kind              goal_kind not null,
    target_amount     bigint check (target_amount > 0),
    target_date       date,
    monthly_amount    bigint check (monthly_amount > 0),
    maintain_months   smallint check (maintain_months > 0),  -- 備用金 = 幾個月的平均支出
    linked_account_id uuid,                                   -- 選填:錢實際放在哪個帳戶,用來核對
    achieved_at       timestamptz,
    archived_at       timestamptz,
    created_at        timestamptz not null default now(),
    foreign key (budget_id, category_id)       references categories (budget_id, id) on delete cascade,
    foreign key (budget_id, linked_account_id) references accounts (budget_id, id),
    check (case kind
        when 'target'         then target_amount is not null
        when 'target_by_date' then target_amount is not null and target_date is not null
        when 'maintain'       then maintain_months is not null
        when 'monthly'        then monthly_amount is not null
    end)
);

-- ───────────────────────── 不變式(提交時檢查) ─────────────────────────

-- 每筆交易必須滿足:
--   1. 預算內帳戶上「沒有類別」的分錄加總為零(轉帳兩邊要平)。
--   2. 預算外帳戶的分錄不可帶類別。
-- 這保證:預算內帳戶總額 = 資金池 + 所有信封餘額。
-- +goose StatementBegin
create function check_transaction_balance() returns trigger
language plpgsql as $$
declare
    txn_ids   uuid[];
    txn_id    uuid;
    unbalanced bigint;
    off_budget_categorized integer;
begin
    if tg_op = 'INSERT' then
        txn_ids := array[new.transaction_id];
    elsif tg_op = 'DELETE' then
        txn_ids := array[old.transaction_id];
    else
        txn_ids := array[new.transaction_id, old.transaction_id];
    end if;

    foreach txn_id in array txn_ids loop
        select coalesce(sum(e.amount) filter (where e.category_id is null and a.on_budget), 0),
               count(*) filter (where e.category_id is not null and not a.on_budget)
          into unbalanced, off_budget_categorized
          from entries e
          join accounts a on a.id = e.account_id
         where e.transaction_id = txn_id;

        if off_budget_categorized > 0 then
            raise exception 'transaction %: off-budget entries cannot have a category', txn_id
                using errcode = 'check_violation';
        end if;
        if unbalanced <> 0 then
            raise exception 'transaction %: uncategorized on-budget entries sum to %, expected 0', txn_id, unbalanced
                using errcode = 'check_violation';
        end if;
    end loop;
    return null;
end $$;
-- +goose StatementEnd

create constraint trigger entries_balance
    after insert or update or delete on entries
    deferrable initially deferred
    for each row execute function check_transaction_balance();

-- 每筆分帳必須滿足:付款金額加總 = 分攤金額加總 = 總額。
-- +goose StatementBegin
create function check_shared_expense_totals() returns trigger
language plpgsql as $$
declare
    exp_id uuid;
    total  bigint;
    paid   bigint;
    shared bigint;
begin
    if tg_table_name = 'shared_expenses' then
        exp_id := new.id;
    elsif tg_op = 'DELETE' then
        exp_id := old.expense_id;
    else
        exp_id := new.expense_id;
    end if;

    select total_amount into total from shared_expenses where id = exp_id;
    if not found then
        return null;  -- 整筆分帳已被刪除
    end if;

    select coalesce(sum(amount), 0) into paid   from shared_expense_payers where expense_id = exp_id;
    select coalesce(sum(amount), 0) into shared from shared_expense_shares where expense_id = exp_id;

    if paid <> total or shared <> total then
        raise exception 'shared expense %: total %, paid %, shares %', exp_id, total, paid, shared
            using errcode = 'check_violation';
    end if;
    return null;
end $$;
-- +goose StatementEnd

create constraint trigger shared_expenses_totals
    after insert or update on shared_expenses
    deferrable initially deferred
    for each row execute function check_shared_expense_totals();

create constraint trigger shared_expense_payers_totals
    after insert or update or delete on shared_expense_payers
    deferrable initially deferred
    for each row execute function check_shared_expense_totals();

create constraint trigger shared_expense_shares_totals
    after insert or update or delete on shared_expense_shares
    deferrable initially deferred
    for each row execute function check_shared_expense_totals();

-- ───────────────────────── 常用彙總(view) ─────────────────────────

create view account_balances as
select a.id as account_id,
       a.budget_id,
       coalesce(sum(e.amount), 0)::bigint as balance,
       coalesce(sum(e.amount) filter (where e.cleared <> 'uncleared'), 0)::bigint as cleared_balance
  from accounts a
  left join entries e on e.account_id = a.id
 group by a.id;

-- 每個類別每個月的實際收支(負數 = 支出)。
create view category_month_activity as
select e.budget_id,
       e.category_id,
       date_trunc('month', t.date)::date as month,
       sum(e.amount)::bigint as activity
  from entries e
  join transactions t on t.id = e.transaction_id
 where e.category_id is not null
 group by e.budget_id, e.category_id, date_trunc('month', t.date);

-- 資金池 = 所有收入類別的分錄 − 所有已撥出的分配。
create view budget_pool as
select b.id as budget_id,
       ( coalesce((select sum(e.amount)
                     from entries e
                     join categories c on c.id = e.category_id
                    where e.budget_id = b.id and c.kind = 'income'), 0)
       - coalesce((select sum(al.amount) from allocations al where al.budget_id = b.id), 0)
       )::bigint as pool
  from budgets b;

-- 信封餘額(截至某月)= 累計分配 + 累計收支,一路結轉,不需要月結作業。
-- 若祖先類別的 pooled = true,分配與收支都歸到那個祖先的信封;這段解析放在查詢或 Go 端。

-- +goose Down
drop view if exists budget_pool, category_month_activity, account_balances;
drop table if exists
    goals, allocations, entries, transactions, split_category_map,
    shared_expense_shares, shared_expense_payers, shared_expenses,
    schedule_skips, schedule_entries, schedules, payees,
    loan_rates, loans, statements, credit_cards, accounts, categories,
    group_members, groups, friendships, budget_members, budgets,
    invites, sessions, users
    cascade;
drop function if exists check_shared_expense_totals, check_transaction_balance;
drop type if exists
    split_method, shared_kind, holiday_shift, schedule_kind, prepay_mode,
    loan_method, goal_kind, cleared_state, category_kind, account_kind,
    friendship_status, group_role, budget_role;
