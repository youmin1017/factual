-- name: CreateSession :exec
insert into sessions (token_hash, user_id, ip, user_agent, created_at, last_seen_at, expires_at)
values ($1, $2, $3, $4, $5, $6, $7);

-- name: GetSessionByTokenHash :one
select s.user_id,
       s.last_seen_at,
       s.expires_at,
       coalesce(u.username, '')::text       as username,
       u.display_name,
       u.role,
       (u.disabled_at is not null)::boolean as disabled
  from sessions s
  join users u on u.id = s.user_id
 where s.token_hash = $1;

-- name: TouchSession :exec
update sessions set last_seen_at = $2 where token_hash = $1;

-- name: DeleteSessionByTokenHash :exec
delete from sessions where token_hash = $1;

-- name: DeleteOtherUserSessions :exec
delete from sessions where user_id = $1 and token_hash <> $2;

-- name: DeleteExpiredSessions :execrows
-- Removes sessions past their absolute expiry or idle since before the second argument.
delete from sessions where expires_at < $1 or last_seen_at < $2;
