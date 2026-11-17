-- name: ListOIDCProviders :many
select * from oidc_providers order by sort, name;

-- name: ListEnabledOIDCProviders :many
select * from oidc_providers where enabled order by sort, name;

-- name: GetOIDCProvider :one
select * from oidc_providers where id = $1;

-- name: GetEnabledOIDCProviderByCode :one
select * from oidc_providers where code = $1 and enabled;

-- name: CreateOIDCProvider :one
insert into oidc_providers (code, name, issuer, client_id, client_secret, scopes, sort, enabled, remark, created_by, updated_by)
values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
returning *;

-- name: UpdateOIDCProvider :one
update oidc_providers
   set code = $2, name = $3, issuer = $4, client_id = $5, client_secret = $6, scopes = $7,
       sort = $8, enabled = $9, remark = $10, updated_by = $11, updated_at = now()
 where id = $1
returning *;

-- name: DeleteOIDCProvider :execrows
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
select i.id, i.email, i.created_at, i.last_login_at, p.code as provider_code, p.name as provider_name
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
