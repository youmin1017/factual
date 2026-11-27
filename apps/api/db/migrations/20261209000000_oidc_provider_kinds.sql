-- +goose Up
-- Identity providers of three kinds (ADR-125): OpenID Connect by discovery,
-- and GitHub and Discord, which only speak OAuth2 and say who the user is
-- through their user API. For those two `issuer` is the site's address
-- (https://github.com, or a GitHub Enterprise Server). `icon` is a Simple
-- Icons slug shown on the login buttons ('' for the default key). Scopes
-- become a list.
alter table oidc_providers
    add column kind text not null default 'oidc' check (kind in ('oidc', 'github', 'discord')),
    add column icon text not null default '' check (icon ~ '^[a-z0-9_]{0,64}$');

alter table oidc_providers alter column scopes drop default;
alter table oidc_providers alter column scopes type text[]
    using array_remove(regexp_split_to_array(btrim(scopes), '\s+'), '');
alter table oidc_providers alter column scopes set default '{}';

-- +goose Down
alter table oidc_providers alter column scopes drop default;
alter table oidc_providers alter column scopes type text using array_to_string(scopes, ' ');
alter table oidc_providers alter column scopes set default 'openid email profile';
alter table oidc_providers drop column icon, drop column kind;
