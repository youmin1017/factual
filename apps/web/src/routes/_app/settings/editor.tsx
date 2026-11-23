import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import { PageHeader, Section } from '#/components/section'
import { Button } from '#/components/ui/button'
import { Textarea } from '#/components/ui/textarea'
import { $api } from '#/lib/api'
import { apiErrorMessage } from '#/lib/apiError'
import { parseKeymap } from '#/lib/keymap'
import { preferencesQuery } from '#/lib/preferences'

export const Route = createFileRoute('/_app/settings/editor')({
  staticData: { crumb: '編輯器', section: '設定' },
  component: EditorSettingsPage,
})

// Settings of the Vim-style editors (ADR-070): the register grid now, the
// CodeMirror slash blocks later. They are the user's own, on every device.

function EditorSettingsPage() {
  return (
    <div>
      <PageHeader title="編輯器" />
      <KeymapForm />
      <Section
        title="寫法"
        description="和 Vim 一樣；右邊的按鍵不會再被對應（全部視為 noremap）。"
      >
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          {reference.map(([code, text]) => (
            <div key={code} className="contents">
              <dt>
                <code className="font-mono">{code}</code>
              </dt>
              <dd className="text-muted-foreground">{text}</dd>
            </div>
          ))}
        </dl>
      </Section>
    </div>
  )
}

const reference: Array<[string, string]> = [
  ['nnoremap H 0', '一般模式：按 H 等於按 0'],
  ['inoremap jk <Esc>', '插入模式：一秒內連按 jk 回到一般模式'],
  [
    'inoremap <C-j> <C-n>',
    '插入模式：Ctrl-j 選下一個建議。Chrome 不讓網頁攔下 Ctrl-n（會開新視窗），可以這樣換成別的鍵',
  ],
  [
    'vnoremap D d',
    '選取模式（V 選取多列）：按 D 等於按 d；noremap 同時用在一般和選取模式',
  ],
  ['let mapleader = " "', '之後的 <Leader> 代表空白鍵（預設是反斜線 \\）'],
  ['nnoremap <Leader>w :w<CR>', '空白鍵再按 w：儲存'],
  [
    'nnoremap <C-h> <C-w>h',
    'Ctrl-h 移到左邊的窗格（側欄）；<C-w>j、<C-w>k、<C-w>l 是下、上、右。瀏覽器的 Ctrl-w 會關掉分頁，所以要這樣對應才能用',
  ],
  [
    'autocmd FileType sidebar nnoremap l <CR>',
    '只在某個窗格有效：在側欄按 l 打開帳戶。窗格有 sidebar（側欄）、register（明細）、split（拆分視窗）、budget（預算頁）、schedules（排程）、main（其他頁面），可用逗號列出多個',
  ],
  ['<Esc> <CR> <Tab> <BS>', 'Esc、Enter、Tab、Backspace'],
  ['<C-d> <S-Tab> <Up>', 'Ctrl-d、Shift-Tab、方向鍵'],
  ['" 註解', '以雙引號開頭的行會被略過'],
]

const keymapExample = `" 例如：在插入模式快速按 jk 回到一般模式
inoremap jk <Esc>
let mapleader = " "
nnoremap <Leader>w :w<CR>
" Ctrl-h/j/k/l 在側欄、明細和拆分視窗之間移動
nnoremap <C-h> <C-w>h
nnoremap <C-j> <C-w>j
nnoremap <C-k> <C-w>k
nnoremap <C-l> <C-w>l
" 在側欄按 l 打開帳戶
autocmd FileType sidebar nnoremap l <CR>`

/** The editors' key mappings, written like a vimrc (ADR-070). */
function KeymapForm() {
  const queryClient = useQueryClient()
  const prefs = useQuery(preferencesQuery())
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState('')

  const saved = prefs.data?.editorKeymap ?? ''
  const text = draft ?? saved
  const { keymap, errors } = parseKeymap(text)
  const count =
    keymap.normal.length + keymap.visual.length + keymap.insert.length

  const save = $api.useMutation('put', '/me/preferences', {
    onSuccess: (data) => {
      queryClient.setQueryData(preferencesQuery().queryKey, data)
      setDraft(null)
      toast.success('自訂快捷鍵已儲存')
    },
    onError: (e) => setError(apiErrorMessage(e)),
  })

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    save.mutate({ body: { editorKeymap: text } })
  }

  return (
    <Section
      title="自訂快捷鍵"
      description={
        <>
          用 vimrc 的寫法設定快捷鍵：
          <code className="font-mono">nnoremap</code>、
          <code className="font-mono">inoremap</code> 和{' '}
          <code className="font-mono">let mapleader</code>
          。帳戶明細和之後的指令區塊共用這份設定。
        </>
      }
    >
      <form className="space-y-3" onSubmit={onSubmit}>
        <Textarea
          aria-label="自訂快捷鍵"
          value={text}
          placeholder={keymapExample}
          rows={8}
          spellCheck={false}
          maxLength={8000}
          className="font-mono text-sm"
          onChange={(e) => setDraft(e.target.value)}
          disabled={prefs.isPending}
        />
        {errors.length > 0 ? (
          <ul className="space-y-1 text-sm text-destructive" role="alert">
            {errors.map((e) => (
              <li key={e.line}>
                第 {e.line} 行：{e.message}（這行會被略過）
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            {count > 0 ? `${count} 個自訂快捷鍵` : '目前沒有自訂快捷鍵'}
          </p>
        )}
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button
            type="submit"
            disabled={save.isPending || draft === null || draft === saved}
          >
            {save.isPending ? '儲存中…' : '儲存'}
          </Button>
          {!text.trim() && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setDraft(keymapExample)}
            >
              填入範例
            </Button>
          )}
        </div>
      </form>
    </Section>
  )
}
