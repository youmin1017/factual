-- name: ListOIDCProviders :many
select * from oidc_providers order by sort, name;

-- name: ListEnabledOIDCProviders :many
select * from oidc_providers where enabled order by sort, name;

-- name: GetOIDCProvider :one
select * from oidc_providers where id = $1;

-- name: GetEnabledOIDCProviderByCode :one
select * from oidc_providers where code = $1 and enabled;

-- name: CreateOIDCProvider :exec
insert into oidc_providers (id, code, name, kind, issuer, client_id, client_secret, scopes, icon, sort, enabled, remark, created_by, updated_by)
values (sqlc.arg(id), sqlc.arg(code), sqlc.arg(name), sqlc.arg(kind), sqlc.arg(issuer), sqlc.arg(client_id),
        sqlc.arg(client_secret), sqlc.arg(scopes)::text[], sqlc.arg(icon), sqlc.arg(sort), sqlc.arg(enabled),
        sqlc.arg(remark), sqlc.arg(created_by), sqlc.arg(created_by));

-- name: UpdateOIDCProvider :exec
update oidc_providers
   set code = sqlc.arg(code), name = sqlc.arg(name), issuer = sqlc.arg(issuer), client_id = sqlc.arg(client_id),
       client_secret = sqlc.arg(client_secret), scopes = sqlc.arg(scopes)::text[], icon = sqlc.arg(icon),
       sort = sqlc.arg(sort), enabled = sqlc.arg(enabled), remark = sqlc.arg(remark),
       updated_by = sqlc.arg(updated_by), updated_at = now()
 where id = sqlc.arg(id);

-- name: DeleteOIDCProvider :exec
delete from oidc_providers where id = $1;

-- name: GetIdentityUser :one
select i.id                                as identity_id,
       u.id                                as user_id,
       coalesce(u.username, '')::text       as username,
       (u.disabled_at is not null)::boolean as disabled
  from user_identities i
  join users u on u.id = i.user_id
 where i.provider_id = $1 and i.subject = $2;

-- name: CreateIdentity :exec
insert into user_identities (user_id, provider_id, subject, email) values ($1, $2, $3, $4);

-- name: TouchIdentityLogin :exec
update user_identities set last_login_at = sqlc.arg(last_login_at)::timestamptz where id = sqlc.arg(id);

-- name: ListUserIdentities :many
select i.id, i.email, i.created_at, i.last_login_at, p.code as provider_code, p.name as provider_name,
       p.icon as provider_icon
  from user_identities i
  join oidc_providers p on p.id = i.provider_id
 where i.user_id = $1
 order by p.sort, p.name;

-- name: CountUserIdentities :one
-- Identities the user can still log in with (their provider is enabled).
select count(*)
  from user_identities i
  join oidc_providers p on p.id = i.provider_id
 where i.user_id = $1 and p.enabled;

-- name: DeleteUserIdentity :execrows
delete from user_identities where id = $1 and user_id = $2;
