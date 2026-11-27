-- +goose Up
-- Instance roles (ADR-131): what a user may do on the instance comes from
-- their role through a fixed map in Go (internal/shared/roles), not from an
-- admin flag.
alter table users add column role text not null default 'member'
    check (role in ('admin', 'member'));
update users set role = 'admin' where is_admin;
alter table users drop column is_admin;

-- +goose Down
alter table users add column is_admin boolean not null default false;
update users set is_admin = (role = 'admin');
alter table users drop column role;
