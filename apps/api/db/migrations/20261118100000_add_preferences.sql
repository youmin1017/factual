-- +goose Up
-- Editor key mappings in vimrc form (ADR-070); parsed by the web app.
alter table users add column editor_keymap text not null default ''
    check (length(editor_keymap) <= 8000);

-- +goose Down
alter table users drop column editor_keymap;
