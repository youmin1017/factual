# Project Brief

## Goal
Factual is a self-hosted budgeting and expense-splitting app for a small circle of people (a household, friends, a travel group) on one instance. It combines:

- **Envelope budgeting without "income is this month's budget"**: income goes to a pool and the user decides how much of it each envelope gets per month (ADR-025).
- **Accounts that behave like the real thing**: credit cards with statements and payments that settle them, loans with amortization, savings goals whose progress is visible at a glance.
- **Splitting that writes into everyone's ledger**: recording "I paid 2,400 for three of us" creates the right transaction in each participant's own budget, in their own categories (ADR-034..041).
- **A Vim-style editor as the main way to enter data**: a register grid with normal, insert and visual modes where many transactions are written at once, completion for payees, categories, accounts and people, and `:w` to commit (ADR-042..045, ADR-063..077).

It replaces Actual Budget plus a separate splitting app for the owner, and is built so that friends on the same instance can split with each other.

## Phases
| Phase | Scope | Status |
|---|---|---|
| 1 | Foundations: monorepo and tooling, ledger schema, login with OIDC, visual design | done |
| 2 | Personal budgeting: budgets, accounts, categories, the editor, envelopes, deployment | in progress |
| 3 | The rest of the ledger: credit card statements, schedules, savings goals, loans | later |
| 4 | People and splitting: invites, friends, groups, shared expenses, settling up | later |
| 5 | Beyond v1: mobile quick entry, import, reports, shared budgets | later |

Phase 2 ends with something the owner can use every day on their own server. Phase 4 is what makes the app worth inviting other people to, so nobody else is invited before it.

### Phase 1 milestones (done)
- **M0 Foundations** *(done, ADR-001..013, ADR-019..041)*: monorepo with mise, dekit and lefthook; Go API with spec-first OpenAPI, sqlc and goose migrations applied on startup; TanStack Start SPA with a typed client; the full ledger schema with its invariants checked by the database and tested against PostgreSQL.
- **M1 Login** *(done, ADR-014, ADR-046..052)*: password login with server-side sessions, bootstrap admin from the environment, OpenID Connect providers managed in the web app, linking identities from the profile, `x-auth` on every operation, shadcn/ui.
- **M2 Visual design** *(done, ADR-053..055)*: the ledger theme (dark by default, light kept), Recursive with its mono axis, the editor-style frame with a status line.

### Phase 2 milestones
- **M3 Budget setup** *(done, ADR-056..060)*: a user without a budget is asked to create one (name, currency, starter categories), and the first becomes their default; accounts (cash, bank, credit card, loan, investment; on or off budget by kind) with opening balances, rename, reorder, close and delete; the category tree (three levels, rename, reorder, archive, pooled parents); the pool and account totals. The `ledger` domain, the role check of ADR-017 and `x-budget` on every operation inside a budget. Known gap: deleting a whole budget needs its transactions deleted first (entries reference categories without cascading); fix it with the delete-budget feature.
- **M4 Account register and `:w`** *(done, ADR-043..045, ADR-063..075)*: payees (created from the editor, renamed and merged later); the account register as a virtualized grid (ADR-045) with normal-mode navigation, insert editing of cells, row operations (`o`, `dd`, `yy`/`p`, `u`, `.`), cleared state, completion, and the `:w` batch endpoint that applies every change in one transaction and reports errors per row (ADR-044). Unsaved changes are kept locally (ADR-043) and shown in the status line. Splits and transfers are edited as transaction entries. Done when a month of real transactions can be entered and corrected from the keyboard alone.
- **M5 Slash blocks** *(skipped, ADR-077: the register already enters many transactions at once; moved to the Phase 5 candidates)*: `/add` draft blocks in CodeMirror 6 with its Vim mode (ADR-042): the DSL parser in the browser (dates like `t`, `-1`, `11/5`; amounts as expressions; `category/path`), live validation, completion sources shared with the grid, and commit through the same `:w`. Done when pasting or typing ten transactions as lines and saving them once works.
- **M6 Envelopes** *(done, ADR-078..082)*: the budget page: pool, monthly allocations, envelope balances carried forward (ADR-026), activity per month, pooled parents, the credit card reserve shown per card (ADR-028), `:fund` and copy-last-month; the category tree and the income categories edited on the same page. Done when the identity *on-budget accounts = pool + envelopes* is visible and holds for the owner's real data.
- **M7 Deployment** *(done, ADR-083)*: one container: the Go binary serving the built SPA and the API; `docker compose` example with PostgreSQL; documented environment variables, backups (`pg_dump`) and upgrades (migrations on startup); health check. Done when the owner runs it on their own server and uses it instead of Actual Budget.

### Phase 3 milestones
- **M8 Credit card statements** *(done, ADR-088..091)* (ADR-029, ADR-030): statement cycles from statement and due days, closing a statement, paying a statement (full, partial, autopay), what is due versus covered, instalments as schedules.
- **M9 Schedules** *(done, ADR-084..087; built before M8, whose instalments are schedules)* (ADR-033): a schedules page edited as a grid, rules written as short Chinese (`每月 5 日`) compiled to RRULE, days off from the government calendar imported by the admin, the background generator with one transaction per occurrence, 預定 rows in the register (post, skip or edit one occurrence; editing the schedule changes all following), estimated amounts marked for review, and budget targets: a base amount per envelope plus the schedules it covers (in full in their month, or spread over the months before), written with `:fill`. Done when the owner's subscriptions and bills post themselves and `:fill` budgets them.
- **M10 Savings goals** *(built: ADR-092..095; waiting for the owner's use to be done)* (ADR-031): the four goal kinds, several goals per envelope in one priority order (things to buy are goals with a link and a cooling-off date), what each has saved derived from its envelope's balance, the monthly amount each asks added to the envelope's target and `:fill` funding targets in priority order up to the pool, a goals page edited as a grid with progress, money free each month and projected completion, achieving and archiving; then the money in an envelope that is spoken for shown apart, with `:move` and `:cover`. Done when the owner's savings and the things they want to buy are goals that `:fill` budgets, and the page shows when each will be reached.
- **M11 Loans** *(built: ADR-096..098; waiting for the owner's use to be done)* (ADR-032): loan setup, the computed amortization table, payments generated as schedules split into principal and interest, extra principal, rate changes, remaining principal and interest paid to date.

### Phase 4 milestones
- **M12 Invites and people** (ADR-015, ADR-016): invite links created by the admin (later by any user), registration through an invite with a password or a linked identity, placeholder members and claiming them, a user list for the admin (disable, reset), friendships.
- **M13 Groups and shared expenses** (ADR-034..041): groups and their members, recording shared expenses (equal, exact, percent, shares; several payers), the transaction it creates in each participant's budget, category hints and per-user mapping, foreign currency on the expense, edits propagating while keeping each participant's own category and note.
- **M14 Settling up**: balances per friend and per group, simplified "who pays whom", recording a settlement, notifications to the people involved (server-sent events), items waiting for review in the editor.

### Phase 5 candidates
Mobile quick entry (a small form for recording on the go, splits included), CSV and Actual Budget import, reports (spending by category over time, net worth), shared budgets for a couple (the schema already allows it, ADR-018), multi-currency budgets, OIDC registration without an invite, slash blocks (`/add` text in CodeMirror 6, the old M5, ADR-077). Each is decided when Phase 4 is done.

- **Lua configuration and scripting** (ADR-076, planned): the editor settings written in Lua as well as the vimrc style, run by a Lua VM (wasmoon) in a Web Worker with a time limit and no DOM or network. A Neovim-flavoured subset (`vim.keymap.set`, `vim.g`, `vim.api.nvim_create_autocmd` for panes), loops and functions included, producing the same keymap as the vimrc parser. Then a read-only `factual.*` API for user commands (`:Report`), categorization and import rules, and reports whose charts are declared by the script (`factual.chart{...}`) and drawn by the app. Until then the settings stay vimrc-style (ADR-070, ADR-075).

### Out of scope for v1 (Phases 2–4)
Bank connections and automatic transaction import, native mobile apps, offline use or local-first sync (ADR-002), federation between instances, investment tracking beyond a balance, multi-currency budgets, public sign-up.

## Context
- One instance serves a few to a few dozen people who know each other. The owner is the instance admin and runs it on their own server.
- The UI is Traditional Chinese (ADR-013); code, the API and docs are English.
- Money is entered in TWD for now; amounts are minor units throughout (ADR-020).
- The template for tooling and conventions is the owner's `go-admin` project; differences are recorded in the ADRs (PostgreSQL and goose instead of MariaDB and Atlas, env-var config, no casbin, TanStack Start instead of Nuxt, oxlint).
- The repo is `github.com/youmin1017/factual`. Real secrets never go into it; the values in `apps/api/mise.toml` are for local development only.

## Risks
- **The editor is the product's reason to exist and its hardest part.** M4 came before anything else on the ledger beyond setup, so that problems with keyboard handling, focus and performance surfaced early; at its end the Vim-style register was kept rather than falling back to a conventional grid with shortcuts.
- **Splitting writes into other people's budgets.** Mistakes there are visible to others and hard to undo, which is why it comes last, on top of a ledger that has been in daily use.
- **One maintainer.** Milestones are sized so that each ends in something usable; nothing is started in parallel.

## Stack summary
| Area | Choice |
|---|---|
| Backend | Go, echo v4, oapi-codegen (spec-first OpenAPI), sqlc on pgx/v5, goose migrations, PostgreSQL 15+ |
| Auth | Server-side sessions (httpOnly cookie), argon2id passwords, OpenID Connect with PKCE (go-oidc, any provider configured in the app) |
| Frontend | TanStack Start (React 19, SPA mode, React Compiler), TanStack Query, shadcn/ui, Tailwind, Recursive |
| Tooling | mise (tools and tasks), dekit, lefthook, golangci-lint, oxlint, oxfmt, pnpm |
