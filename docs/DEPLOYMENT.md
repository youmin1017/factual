# 部署

Factual 是一個容器：Go 執行檔同時提供網頁與 API（網頁在建置時嵌入執行檔），再加一個 PostgreSQL。以下用 `deploy/docker-compose.yml` 在一台伺服器上跑起來，前面放一個負責 HTTPS 的反向代理。

## 第一次啟動

需要 Docker（含 Compose）。映像檔由 GitHub Actions 建置並發布到 `ghcr.io/youmin1017/factual`（見下面的「映像檔」），伺服器上只需要 `deploy/` 這兩個檔案，不用建置。

```
git clone <repo 網址> factual && cd factual   # 或只下載 deploy/docker-compose.yml 和 deploy/.env.example
cp deploy/.env.example deploy/.env
# 編輯 deploy/.env：
#   POSTGRES_PASSWORD        openssl rand -hex 24
#   FACTUAL_PUBLIC_URL       例如 https://money.example.com
#   FACTUAL_ENCRYPTION_KEY   openssl rand -base64 32
#   FACTUAL_BOOTSTRAP_ADMIN_PASSWORD  第一位管理員的密碼（至少 8 個字元）
docker compose -f deploy/docker-compose.yml up -d
docker compose -f deploy/docker-compose.yml ps     # factual 顯示 healthy 即可
```

第一次啟動會建立資料表，並在還沒有人能登入時建立 `FACTUAL_BOOTSTRAP_ADMIN_*` 指定的管理員。登入後到「個人資料」改密碼；之後可以把 `.env` 裡的管理員密碼刪掉。

App 只聽 `127.0.0.1:8080`（`FACTUAL_LISTEN` 可改），對外由反向代理提供 HTTPS。`FACTUAL_PUBLIC_URL` 是 https 時 cookie 會加上 Secure，所以不要讓瀏覽器直接用 http 連 8080。

### 反向代理

Caddy（自動申請憑證）：

```
money.example.com {
	reverse_proxy 127.0.0.1:8080
}
```

nginx：

```
location / {
	proxy_pass http://127.0.0.1:8080;
	proxy_set_header Host $host;
	proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

App 用 `X-Forwarded-For` 中最後一個不是內網位址的項目當作用戶端 IP（登入次數限制、session 紀錄），所以代理要設這個標頭，而 8080 不要直接對外開放。

### 第三方登入（OIDC）

在身分提供者登記的回呼網址是 `<FACTUAL_PUBLIC_URL>/api/auth/oidc/callback`。提供者本身在網頁的「第三方登入」頁設定，不需要重新啟動。

## 環境變數

`deploy/docker-compose.yml` 會從 `deploy/.env` 讀取；不用 Compose 時直接設給容器或執行檔。

| 變數 | 說明 |
|---|---|
| `FACTUAL_DATABASE_URL` | PostgreSQL 連線字串（必填；Compose 會用 `POSTGRES_PASSWORD` 組出來） |
| `FACTUAL_PUBLIC_URL` | 瀏覽器連到本站的網址，例如 `https://money.example.com`。OIDC 回呼網址由它決定；是 https 時 cookie 會加上 Secure |
| `FACTUAL_ENCRYPTION_KEY` | 32 bytes 的 base64 金鑰（`openssl rand -base64 32`），用來加密 IdP 的 client secret 與登入流程 cookie。沒有設定就無法使用第三方登入；換掉它，已存的 client secret 就解不開，要重新輸入 |
| `FACTUAL_BOOTSTRAP_ADMIN_USERNAME`、`FACTUAL_BOOTSTRAP_ADMIN_PASSWORD` | 還沒有任何人能登入時，啟動時建立的第一位管理員（密碼至少 8 個字元） |
| `FACTUAL_PASSWORD_LOGIN` | 設為 `false` 可關閉密碼登入（確定每個人都能用第三方登入之後再關） |
| `FACTUAL_SESSION_IDLE_TIMEOUT`、`FACTUAL_SESSION_MAX_AGE` | session 閒置與最長有效時間，預設 `720h` 與 `2160h` |
| `FACTUAL_COOKIE_SECURE` | cookie 是否加上 Secure，預設看 `FACTUAL_PUBLIC_URL` 是不是 https |
| `FACTUAL_HTTP_ADDR` | 容器內的監聽位址，預設 `:8080` |
| `FACTUAL_DB_AUTO_MIGRATE` | 啟動時套用資料庫 migration，預設 `true` |

只有 Compose 用到的：`POSTGRES_PASSWORD`（只用英數字，它會放進連線網址）、`FACTUAL_LISTEN`（主機上的監聽位址，預設 `127.0.0.1:8080`）、`FACTUAL_IMAGE`（要跑的映像檔，預設 `ghcr.io/youmin1017/factual:latest`）。

## 健康檢查

`GET /api/healthz`：資料庫連得上回 200 `{"status":"ok"}`，連不上回 503 `{"status":"degraded"}`。映像檔內建 Docker 的 `HEALTHCHECK`（執行 `/factual healthcheck`，映像檔裡沒有 shell 或 curl），`docker compose ps` 會顯示 healthy 或 unhealthy；外部監控可以直接打這個網址。

## 備份

資料全在 PostgreSQL。用 `pg_dump` 的 custom 格式備份：

```
docker compose -f deploy/docker-compose.yml exec -T postgres \
  pg_dump -U factual -d factual -Fc > factual-$(date +%F).dump
```

`deploy/.env` 也要另外保存：沒有 `FACTUAL_ENCRYPTION_KEY`，備份裡的 OIDC client secret 就解不開。

每天自動備份、保留 30 天（crontab，路徑換成自己的）：

```
0 3 * * * cd /srv/factual && docker compose -f deploy/docker-compose.yml exec -T postgres pg_dump -U factual -d factual -Fc > /srv/backups/factual-$(date +\%F).dump && find /srv/backups -name 'factual-*.dump' -mtime +30 -delete
```

備份最好再複製到另一台機器或雲端儲存。

### 還原

```
docker compose -f deploy/docker-compose.yml stop factual
docker compose -f deploy/docker-compose.yml exec -T postgres \
  pg_restore -U factual -d factual --clean --if-exists --no-owner < factual-2026-11-23.dump
docker compose -f deploy/docker-compose.yml start factual
```

定期找一台別的機器還原一次，確認備份真的能用。

## 映像檔

`.github/workflows/image.yml` 在每次推到 `main` 和每個 `v*` 標籤時建置映像檔，推到 GitHub Container Registry；pull request 只建置不推送，用來確認還建得起來。

| 觸發 | 標籤 |
|---|---|
| 推到 `main` | `latest`、`sha-<commit 前 7 碼>` |
| 推標籤 `v1.2.3` | `1.2.3`、`1.2`、`sha-<commit 前 7 碼>` |

版本號（標籤名或 commit）會編進執行檔，啟動時記在 log 裡。想固定版本就在 `deploy/.env` 設 `FACTUAL_IMAGE=ghcr.io/youmin1017/factual:1.2.3`（或 `:sha-abc1234`），不設就跟著 `latest`。目前只建 `linux/amd64`。

第一次推上去之後，到 GitHub 的 Packages → factual → Package settings 確認 visibility 是 Public；設成 Private 的話，伺服器要先用有 `read:packages` 權限的 token `docker login ghcr.io`。

不想用發布的映像檔，也可以在伺服器上從原始碼建置：`mise run docker:build`（產生 `factual:latest`），再設 `FACTUAL_IMAGE=factual:latest`。

## 升級

```
# 先備份（見上面）
docker compose -f deploy/docker-compose.yml pull
docker compose -f deploy/docker-compose.yml up -d
```

新版啟動時會自動套用新的 migration（log 會出現 `applied migrations`）。Migration 只會往前：舊版程式不能用在已升級的資料庫上，要回到舊版就把升級前的備份還原到舊版。若想手動控制 migration，設 `FACTUAL_DB_AUTO_MIGRATE=false`，再用 goose 自行套用 `apps/api/db/migrations`。

### PostgreSQL 大版本升級

PostgreSQL 換大版本（例如 18 → 19）時，舊的資料目錄不能直接沿用：先備份，停掉服務，改 `deploy/docker-compose.yml` 的 `image`，刪掉 volume（`docker compose -f deploy/docker-compose.yml down -v`；請先確認備份可用），再 `up -d`，最後照「還原」把備份灌回去。

## 不用 Docker

`mise run build` 會建置網頁，並產生一個內嵌網頁的執行檔 `apps/api/bin/factual`（在 Linux 伺服器上用，就在 Linux 上建置）。設好上面的環境變數後直接執行它；健康檢查是 `factual healthcheck`。
