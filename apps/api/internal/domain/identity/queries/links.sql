-- name: ListRegisteredUsers :many
-- Users who can log in (a password or a linked identity), oldest first.
select u.id,
       coalesce(u.username, '')::text        as username,
       u.display_name,
       u.role,
       (u.disabled_at is null)::boolean      as active,
       (u.password_hash is not null)::boolean as has_password,
       (select count(*) from user_identities i where i.user_id = u.id)::int as identities,
       u.last_login_at,
       u.created_at
  from users u
 where u.password_hash is not null
    or exists (select 1 from user_identities i where i.user_id = u.id)
 order by u.created_at, u.id;

-- name: SetUserAccess :exec
update users
   set role = sqlc.arg(role),
       disabled_at = case when sqlc.arg(active)::boolean then null else coalesce(disabled_at, now()) end
 where id = sqlc.arg(id);

-- name: DeleteUserSessions :exec
delete from sessions where user_id = $1;

-- name: ListOpenLinks :many
-- Links not used, revoked or expired, newest first.
select l.id, l.purpose, l.user_id, l.note, l.created_at, l.expires_at, l.token_sealed,
       c.display_name as created_by
  from links l
  join users c on c.id = l.created_by
 where l.used_at is null and l.revoked_at is null and l.expires_at > sqlc.arg(now)::timestamptz
   and l.purpose = any(sqlc.arg(purposes)::text[])
 order by l.created_at desc, l.id;

-- name: CreateLink :exec
insert into links (id, token_hash, token_sealed, purpose, user_id, note, created_by, expires_at, created_at)
values ($1, $2, $3, $4, $5, $6, $7, $8, $9);

-- name: RevokeLink :execrows
update links set revoked_at = sqlc.arg(now)::timestamptz
 where id = sqlc.arg(id) and used_at is null and revoked_at is null;

-- name: GetOpenLink :one
-- A link that can still be used, by its token's hash, with the user it names.
select l.id, l.purpose, l.user_id, l.expires_at,
       coalesce(u.username, '')::text as username
  from links l
  left join users u on u.id = l.user_id
 where l.token_hash = sqlc.arg(token_hash) and l.used_at is null and l.revoked_at is null
   and l.expires_at > sqlc.arg(now)::timestamptz;

-- name: UseLink :execrows
-- Marks a link used; 0 rows when someone used or revoked it first.
update links set used_at = sqlc.arg(now)::timestamptz, used_by = sqlc.arg(used_by)
 where id = sqlc.arg(id) and used_at is null and revoked_at is null;
