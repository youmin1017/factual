-- +goose Up
-- 登入:session 記錄來源、使用者記錄最後登入時間,以及 OpenID Connect 提供者與已連結的身分。

alter table sessions
    add column ip         text not null default '',
    add column user_agent text not null default '';

alter table users
    add column last_login_at timestamptz;

-- 身分提供者(IdP)由站台管理員在網頁上設定;只要支援 OIDC discovery 的服務都可以。
create table oidc_providers (
    id            uuid primary key default gen_random_uuid(),
    code          text not null check (code ~ '^[a-z][a-z0-9_-]{1,31}$'),  -- 用在網址,例如 google
    name          text not null check (name <> ''),                        -- 顯示在登入按鈕上
    issuer        text not null,
    client_id     text not null,
    client_secret text not null default '',      -- AES-256-GCM 加密後的密鑰;'' = public client
    scopes        text not null default 'openid email profile',
    sort          integer not null default 0,
    enabled       boolean not null default true,
    remark        text not null default '',
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now(),
    created_by    uuid references users (id) on delete set null,
    updated_by    uuid references users (id) on delete set null,
    constraint oidc_providers_code_key unique (code)
);

-- 使用者連結的外部身分。只用 (provider, subject) 比對,不用 email。
create table user_identities (
    id            uuid primary key default gen_random_uuid(),
    user_id       uuid not null references users (id) on delete cascade,
    provider_id   uuid not null references oidc_providers (id) on delete cascade,
    subject       text not null,
    email         text not null default '',
    created_at    timestamptz not null default now(),
    last_login_at timestamptz,
    constraint user_identities_subject_key unique (provider_id, subject),  -- 一個外部身分只能連結一位使用者
    constraint user_identities_user_key unique (user_id, provider_id)      -- 一位使用者在同一提供者只連結一個身分
);

-- +goose Down
drop table if exists user_identities;
drop table if exists oidc_providers;
alter table users drop column if exists last_login_at;
alter table sessions drop column if exists user_agent, drop column if exists ip;
