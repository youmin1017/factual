# web

TanStack Start(React、SPA 模式)。指令請從 repo 根目錄用 mise 執行,見根目錄的 `README.md`。

- 路由:`src/routes`(檔案式路由,`src/routeTree.gen.ts` 由外掛產生)。`_app` 底下的頁面都需要登入,`/login` 是唯一的公開頁面。
- API:`src/lib/api.ts` 的 `api`(openapi-fetch)與 `$api`(TanStack Query 綁定);型別由 `pnpm gen:api` 從 `../api/api/openapi.yaml` 產生。錯誤代碼的中文訊息在 `src/lib/apiError.ts`。
- 元件:shadcn/ui(Radix + Tailwind),放在 `src/components/ui`,用 `pnpm dlx shadcn@latest add <name>` 新增。這些檔案是外來的程式碼,不受 oxlint 檢查。
- 開發時 Vite 把 `/api` 轉給 Go API(`FACTUAL_API_PROXY_TARGET`,預設 `http://localhost:8080`)。
- 建置產物是純靜態檔(`dist/client`,入口為 `_shell.html`)。
- 檢查與格式:oxlint(`oxlint.config.ts`)、oxfmt(`oxfmt.config.ts`),皆延伸 TanStack 的共用設定。

不要用 `tanstack add <add-on>`:它會把整個範本重新產生一次,覆蓋 `package.json`、`vite.config.ts`、`README.md` 等已修改的檔案。
