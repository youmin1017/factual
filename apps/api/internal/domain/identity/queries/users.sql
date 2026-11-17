-- name: CountLoginUsers :one
-- Users who can log in: with a password or a linked identity. Placeholder
-- members (friends who have not registered) are not counted.
select count(*)
  from users u
 where u.password_hash is not null
    or exists (select 1 from user_identities i where i.user_id = u.id);

-- name: GetUserByUsername :one
select id,
       coalesce(username, '')::text      as username,
       display_name,
       coalesce(email, '')::text         as email,
       coalesce(password_hash, '')::text as password_hash,
       is_admin,
       (disabled_at is not null)::boolean as disabled
  from users
 where lower(username) = lower(sqlc.arg(username)::text);

-- name: GetUserByID :one
select id,
       coalesce(username, '')::text      as username,
       display_name,
       coalesce(email, '')::text         as email,
       coalesce(password_hash, '')::text as password_hash,
       is_admin,
       (disabled_at is not null)::boolean as disabled
  from users
 where id = $1;

-- name: CreateUser :one
insert into users (username, display_name, password_hash, is_admin)
values (sqlc.arg(username)::text, sqlc.arg(display_name), sqlc.arg(password_hash)::text, sqlc.arg(is_admin))
returning id;

-- name: SetUserLastLogin :exec
update users set last_login_at = sqlc.arg(last_login_at)::timestamptz where id = sqlc.arg(id);

-- name: UpdateUserPassword :exec
update users set password_hash = sqlc.arg(password_hash)::text where id = sqlc.arg(id);
