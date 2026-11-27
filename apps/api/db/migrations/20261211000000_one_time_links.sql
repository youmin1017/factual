-- +goose Up
-- One-time links (ADR-132): to join, to claim a placeholder and to reset a
-- password, each used once and for 7 days. Only the token's SHA-256 is kept.
alter table invites rename to links;
alter table links rename column claims_user_id to user_id;
alter table links
    add column purpose    text,
    add column note       text not null default '',
    add column created_at timestamptz not null default now(),
    add column revoked_at timestamptz,
    add column used_by    uuid references users (id) on delete set null;
update links set purpose = case when user_id is null then 'join' else 'claim' end;
alter table links
    alter column purpose set not null,
    add constraint links_purpose_check check (purpose in ('join', 'claim', 'reset')),
    -- A join link is for whoever comes; claim and reset links name the user.
    add constraint links_user_check check ((purpose = 'join') = (user_id is null));

-- +goose Down
alter table links drop constraint links_user_check, drop constraint links_purpose_check;
delete from links where purpose = 'reset';
alter table links drop column used_by, drop column revoked_at, drop column created_at,
    drop column note, drop column purpose;
alter table links rename column user_id to claims_user_id;
alter table links rename to invites;
