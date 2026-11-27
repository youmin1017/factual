-- +goose Up
-- A link's token, sealed with FACTUAL_ENCRYPTION_KEY, so the users page can
-- copy it again while it can be used (ADR-135); '' without a key. Lookups
-- still go by the hash.
alter table links add column token_sealed text not null default '';

-- +goose Down
alter table links drop column token_sealed;
