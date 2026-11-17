import { Link, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/')({
  staticData: { crumb: '總覽' },
  component: Home,
})

function Home() {
  const { user } = Route.useRouteContext()
  return (
    <div className="max-w-xl space-y-4">
      <h1 className="text-2xl font-semibold">
        {user.displayName || user.username}，歡迎回來
      </h1>
      <p className="leading-relaxed text-muted-foreground">
        帳戶、預算與分帳還在開發中，這裡之後會顯示資金池和各信封的餘額。
      </p>
      <p className="leading-relaxed text-muted-foreground">
        現在可以到
        <Link
          to="/profile"
          className="mx-1 text-foreground underline decoration-kraft decoration-2 underline-offset-4"
        >
          個人資料
        </Link>
        變更密碼，或連結第三方登入的帳號。
      </p>
    </div>
  )
}
