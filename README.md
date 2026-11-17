# Factual

多人記帳與分帳:信封式預算、信用卡帳單、儲蓄目標、貸款、分帳,以及 Vim 風格的交易編輯器。自架,Go API + PostgreSQL + TanStack Start(SPA)。

## 快速開始

需要 [mise](https://mise.jdx.dev) 與 Docker(本機資料庫)。mise 會安裝並鎖定 Go、Node、pnpm、lefthook、dekit、golangci-lint、air、sqlc、goose、oapi-codegen 的版本(見 `mise.toml`、`apps/api/mise.toml`)。

```
mise trust          # 第一次才需要
mise run setup      # 安裝工具與依賴、啟用 git hooks
mise run dev        # 在 dekit 主控台啟動 DB、API :8080、web :3000(q q 停止,d 分離)
```

API 啟動時會自動套用尚未執行的 migration。第一次啟動會建立管理員帳號,帳號密碼是 `apps/api/mise.toml` 裡的 `FACTUAL_BOOTSTRAP_ADMIN_*`(僅供本機開發),登入後請到「個人資料」變更密碼。

## 登入與第三方登入(OIDC)

- 內建帳號密碼登入;session 存在資料庫,瀏覽器只拿到 httpOnly cookie。
- 站台管理員可以在網頁的「第三方登入」頁新增任何支援 OpenID Connect discovery 的身分提供者(Google、Microsoft Entra ID、Keycloak、Authentik、Pocket ID 等),不需要改設定檔或重新啟動。
- 使用者先用密碼登入,到「個人資料」連結自己的第三方帳號,之後登入頁就能用它登入。尚未連結的第三方帳號無法登入,也不會自動建立使用者。

部署時需要設定的環境變數:

| 變數 | 說明 |
|---|---|
| `FACTUAL_DATABASE_URL` | PostgreSQL 連線字串(必填) |
| `FACTUAL_PUBLIC_URL` | 瀏覽器連到本站的網址,例如 `https://money.example.com`。OIDC 回呼網址由它決定;是 https 時 cookie 會自動加上 Secure |
| `FACTUAL_ENCRYPTION_KEY` | 32 bytes 的 base64 金鑰(`openssl rand -base64 32`),用來加密 IdP 的 client secret 與登入流程 cookie。沒有設定就無法使用第三方登入 |
| `FACTUAL_BOOTSTRAP_ADMIN_USERNAME`、`FACTUAL_BOOTSTRAP_ADMIN_PASSWORD` | 還沒有任何人能登入時,啟動時建立的第一位管理員(密碼至少 8 個字元) |
| `FACTUAL_PASSWORD_LOGIN` | 設為 `false` 可關閉密碼登入(確定每個人都能用第三方登入之後再關) |
| `FACTUAL_SESSION_IDLE_TIMEOUT`、`FACTUAL_SESSION_MAX_AGE` | session 閒置與最長有效時間,預設 `720h` 與 `2160h` |

## 常用指令

| 指令 | 用途 |
|---|---|
| `mise run dev` / `mise run dev:down` | 啟動/停止整套開發環境 |
| `mise run gen` | 由 OpenAPI 規格與 SQL 重新產生程式碼(Go server、sqlc、web 型別) |
| `mise run check` | lint、格式、型別檢查、測試、建置(等同 CI) |
| `mise run lint` / `mise run fmt` | 檢查/格式化 |
| `mise run db:up` / `db:down` / `db:reset` / `db:shell` | 本機 PostgreSQL |
| `mise run //apps/api:db:new <name>` | 新增一支 migration |
| `mise run //apps/api:test:db` 後 `//apps/api:test:integration` | 含資料庫的整合測試 |

`mise tasks ls --all` 可列出全部。

## 結構

- `apps/api`:Go API(echo、oapi-codegen、sqlc、pgx、goose)。
  - `api/openapi.yaml`:API 規格,唯一的真相來源。
  - `db/migrations`:SQL migration,同時是 sqlc 的 schema。
  - `internal/domain/<name>`:各領域的服務與 SQL。
- `apps/web`:TanStack Start(React、SPA 模式)、Tailwind、shadcn/ui、TanStack Query、oxlint、oxfmt。
  - `src/lib/api.gen.ts`:由規格產生的型別;一律透過 `src/lib/api.ts` 呼叫 API。

架構與帳務模型的決策紀錄在 `docs/DECISIONS.md`。

## 開發流程:新增一支 API

1. 修改 `apps/api/api/openapi.yaml`。
2. 需要新資料表就 `mise run //apps/api:db:new <name>` 並撰寫 SQL。
3. 在所屬領域的 `queries/*.sql` 寫查詢(新領域要在 `apps/api/sqlc.yaml` 加一段)。
4. `mise run gen`。
5. 在所屬領域的 `Handlers` 實作產生出來的方法(規格裡每個操作都要宣告 `x-auth`);web 端用 `$api.useQuery(...)` 呼叫。
