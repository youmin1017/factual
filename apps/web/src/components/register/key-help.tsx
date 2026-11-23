import { Link } from '@tanstack/react-router'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import type { Keymap, Pane } from '#/lib/keymap'

/** One line of the reference: the keys, and what they do. */
type Entry = [keys: string, does: string]

export type KeyGroup = { title: string; entries: Array<Entry> }

/** The account register and its split window. */
export const registerKeys: Array<KeyGroup> = [
  {
    title: '移動',
    entries: [
      ['h j k l', '左、下、上、右（方向鍵也可以）'],
      ['w b  Tab', '下一欄、上一欄'],
      ['0 $', '第一欄、最後一欄'],
      ['gg G', '第一列、最後一列；5G 到第 5 列'],
      ['Ctrl-d Ctrl-u', '往下、往上半頁'],
      ['Ctrl-f Ctrl-b', '往下、往上一頁'],
      ['5j', '數字加移動：往下 5 列'],
    ],
  },
  {
    title: '修改',
    entries: [
      ['i a Enter', '編輯這一格'],
      ['c s', '清空這一格再編輯'],
      ['o O', '在下面、上面新增一筆'],
      ['x', '核對 / 取消核對'],
      ['dd', '刪除並放進暫存，p 可以貼上（再按一次取消刪除）；3dd 刪三筆'],
      ['yy p P', '複製，貼在下面、上面'],
      ['u Ctrl-r', '復原、重做'],
      ['.', '重複上一個動作'],
    ],
  },
  {
    title: '選取多列',
    entries: [
      ['V', '開始選取（Shift-點擊也可以）'],
      ['o', '跳到選取的另一端'],
      ['d y x', '刪除（也可以 p 貼上）、複製、核對選取的交易'],
      ['c', '修改選取交易的這一欄'],
      ['gv', '選回上一次的範圍'],
      ['Esc', '取消選取'],
    ],
  },
  {
    title: '編輯中',
    entries: [
      ['Tab Shift-Tab', '存下這一格，到下一格、上一格'],
      ['↓ ↑', '在建議清單裡移動'],
      ['Ctrl-n Ctrl-p', '同上；Chrome 不讓網頁用 Ctrl-n，可以對應成別的鍵'],
      ['Enter', '採用建議的項目'],
      ['Esc', '回到一般模式'],
      ['Ctrl-c', '放棄這一格的修改'],
    ],
  },
  {
    title: '指令',
    entries: [
      [':w  Ctrl-s', '儲存'],
      [':q  :wq', '離開、儲存後離開'],
      [':e!', '放棄所有未儲存的變更'],
      [':sp', '把這筆交易拆分成多個類別'],
      [':12', '跳到第 12 列'],
    ],
  },
  {
    title: '排程',
    entries: [
      [
        '淡色列',
        '接下來 30 天還沒入帳的排程（預定）；直接改再 :w，就照改過的入帳',
      ],
      [':post', '預定列照原樣立刻入帳（V 選取可以一次多筆）'],
      [':skip', '略過這一期（到排程頁 :unskip 可以取消）'],
      ['?  ~', '排程用估計金額記的交易；改金額或 :review 確認'],
      [':review', '確認游標或選取的交易金額沒問題'],
      [':schedule', '用這筆交易建立每月的排程（從下個月的同一天開始）'],
    ],
  },
  {
    title: '信用卡帳單',
    entries: [
      ['狀態列', '游標所在的刷卡交易列在哪一期帳單'],
      [
        ':defer',
        '把最近一期帳單的交易移到下一期（銀行晚入帳時）；再按一次放回（V 選取可以一次多筆）',
      ],
      [
        ':installment 12',
        '分期：這筆改成第一期（餘數放這期），其餘建成每月的排程；已經過的期數當作繳過',
      ],
      [
        '自動扣繳',
        '在帳單設定選扣繳帳戶；結帳後截止日的繳款以預定列出現，到期自動記下還沒繳的',
      ],
    ],
  },
  {
    title: '拆分視窗',
    entries: [
      ['o O', '新增一行（帶入還沒分的金額）'],
      ['dd', '刪除這一行'],
      ['q Esc', '完成，回到明細'],
    ],
  },
  {
    title: '側欄',
    entries: [
      ['j k', '下一個、上一個帳戶'],
      ['gg G', '第一個、最後一個'],
      ['Enter', '打開'],
    ],
  },
]

/** The budget page (M6). */
export const budgetKeys: Array<KeyGroup> = [
  {
    title: '移動',
    entries: [
      ['j k', '下一個、上一個類別（方向鍵也可以）'],
      ['h l', '名稱欄、各月的分配欄之間移動（0 到名稱欄，$ 到最後一個月）'],
      ['gg G', '第一個、最後一個'],
      ['Ctrl-d Ctrl-u', '往下、往上半頁'],
      ['5j', '數字加移動：往下 5 個'],
      ['gt gT', '往後、往前一個月'],
    ],
  },
  {
    title: '分配和改名',
    entries: [
      ['i a Enter', '在分配欄：修改本月分配；在名稱欄：改名'],
      ['c s', '清空再輸入'],
      ['u Ctrl-r', '復原、重做（會重新儲存，類別的修改也算）'],
    ],
  },
  {
    title: '類別',
    entries: [
      ['o O', '在下面、上面新增同一層的類別'],
      ['A', '新增子類別（最多三層）'],
      ['J K', '和下面、上面的類別交換位置'],
      ['>> <<', '放進上面那個類別底下、移出一層；3>> 三行'],
    ],
  },
  {
    title: '複製、刪除、貼上',
    entries: [
      ['yy', '複製這一行：類別連同子類別，和游標那個月的分配；3yy 三行'],
      [
        'dd',
        '分配欄：清除分配；名稱欄：刪除類別（連同子類別，有交易或預算的留著）',
      ],
      [
        'p P',
        '分配欄：金額從游標往下貼到各個預算；名稱欄：類別連同分配貼在下面、上面',
      ],
      ['dd 再 p', '分配：把錢搬到別的預算；類別：把類別搬到游標的位置'],
    ],
  },
  {
    title: '選取多行',
    entries: [
      ['V', '開始選取（Shift-點擊也可以）'],
      ['o', '跳到選取的另一端'],
      ['y d p', '複製、刪除、貼上選取的行'],
      ['c', '分配欄：選取的預算都改成同一個金額'],
      ['> <', '選取的類別放進上面的類別、移出一層'],
      [':', ':archive、:share 作用在選取的類別'],
      ['gv', '選回上一次的範圍'],
      ['Esc', '取消選取'],
    ],
  },
  {
    title: '輸入中',
    entries: [
      ['Enter Esc', '儲存'],
      ['Enter', '新增類別時：儲存，接著新增下一個'],
      ['Tab Shift-Tab', '儲存，到下一個、上一個預算'],
      ['Ctrl-c', '放棄這次輸入'],
      ['120*3', '可以打算式'],
    ],
  },
  {
    title: '指令',
    entries: [
      [':fund 3000', '從資金池再撥 3000 給這個預算；負數是退回'],
      [':copylast', '本月還沒分配、也沒有目標的預算，照上個月的金額分配'],
      [
        ':fill',
        '有目標的預算照目標分配（V 選取時只改選取的）；目標 ＝ 基本額 ＋ 涵蓋的排程',
      ],
      [':base 1000', '這個預算每個月的基本額；:base 0 移除，:base 看目前的'],
      [
        '●',
        '分配和目標不同（金色是還不夠）；游標停在上面，狀態列列出目標的組成',
      ],
      [':share', '切換子類別共用上層的預算，或各自有預算'],
      [':archive', '封存、取消封存這個類別'],
      [':archived', '顯示、隱藏已封存的類別'],
      [':months 3', '一次顯示 1 到 3 個月'],
      [':12', '跳到第 12 行'],
    ],
  },
  {
    title: '側欄',
    entries: [
      ['j k', '下一個、上一個帳戶'],
      ['gg G', '第一個、最後一個'],
      ['Enter', '打開'],
    ],
  },
]

/** The schedules page (ADR-084). */
export const scheduleKeys: Array<KeyGroup> = [
  {
    title: '移動',
    entries: [
      ['j k', '下一個、上一個排程（方向鍵也可以）'],
      ['h l', '左右一欄（0 到最左，$ 到最右）'],
      ['gg G', '第一個、最後一個'],
      ['Ctrl-d Ctrl-u', '往下、往上半頁'],
    ],
  },
  {
    title: '修改',
    entries: [
      ['i a Enter', '修改這一格'],
      ['c s', '清空再輸入'],
      ['o O', '在下面、上面新增排程'],
      ['dd', '刪除（標記，:w 才刪；已入帳的交易會保留）；3dd 三個'],
      ['yy p P', '複製、貼在下面、上面'],
      ['u Ctrl-r', '復原、重做'],
      ['.', '重複上一個 dd 或 p'],
    ],
  },
  {
    title: '選取多個',
    entries: [
      ['V', '開始選取（Shift-點擊也可以）'],
      ['y d', '複製、刪除選取的排程'],
      ['c', '選取的排程這一欄都改成同一個值'],
      [':', ':pause、:resume 作用在選取的排程'],
      ['gv', '選回上一次的範圍'],
    ],
  },
  {
    title: '週期的寫法',
    entries: [
      [
        '/',
        '在週期欄打 / 選範本（/每月、/每週、/monthly、/weekly，或 /every 篩選），Enter 開啟週期編輯器',
      ],
      ['i Enter', '在寫好的週期上開啟週期編輯器；c 清空改用打字'],
      ['每天 每 3 天', '每天、每三天'],
      ['每週一三五 每 2 週五', '每週的哪幾天、每兩週'],
      ['每月 5 日 每月最後一天', '每月幾號、月底'],
      ['每月第 2 個週三', '每月第幾個星期幾（最後一個週五也可以）'],
      ['每季 10 日 每 3 個月 10 日', '每幾個月'],
      ['每年 3/15', '每年哪一天'],
      ['到 2027/6/30 共 12 次', '加在後面：結束日、總共幾次'],
      ['遇假日延後 遇假日提前', '加在後面：遇到放假日改到下一個、上一個工作日'],
      [
        'monthly on the 5th',
        '英文也可以：every 2 weeks on fri、every month on the last day、quarterly on 10、yearly on mar 15',
      ],
      [
        'until 2027/6/30 12 times',
        '英文加在後面：結束日、總共幾次、next workday、prev workday',
      ],
    ],
  },
  {
    title: '週期編輯器',
    entries: [
      ['j k', '下一個、上一個欄位（Tab 也可以）'],
      ['h l', '選項：換一個；數字和日期：左右移動游標；星期：左右移動'],
      ['Ctrl-a Ctrl-x', '加一、減一；日期改游標所在的年、月或日'],
      ['0-9', '打在游標的位置（還沒移動游標時整個換掉）；選項用數字挑第幾個'],
      ['x Backspace', '刪除游標後、游標前的字；^ $ 到開頭、結尾'],
      ['1-7 x', '星期：切換週一到週日、切換游標上的那天'],
      ['Enter Esc', '完成，寫回週期欄（統一寫成「每月 5 日」這種格式）'],
      ['i /', '改用打字、回到範本清單'],
      ['Ctrl-c', '取消'],
    ],
  },
  {
    title: '輸入中',
    entries: [
      ['Enter Esc', '完成這一格'],
      ['Tab Shift-Tab', '完成，到下一格、上一格'],
      ['Ctrl-n Ctrl-p', '選建議'],
      ['~1200', '金額前加 ~：預估金額，入帳後要確認'],
      ['Ctrl-c', '放棄這次輸入'],
    ],
  },
  {
    title: '指令',
    entries: [
      [':w', '儲存；已經到期的會馬上入帳'],
      [':skip', '略過這個排程的下一期'],
      [':unskip 12/5', '恢復略過的一期（不寫日期就是最後略過的）'],
      [':pause :resume', '暫停、恢復排程'],
      [':e!', '放棄所有未儲存的變更'],
      [':q', '離開'],
    ],
  },
]

const modeNames: Record<keyof Keymap, string> = {
  normal: '一般',
  visual: '選取',
  insert: '插入',
}

const paneNames: Record<Pane, string> = {
  sidebar: '側欄',
  register: '明細',
  split: '拆分視窗',
  budget: '預算頁',
  schedules: '排程',
  main: '其他頁面',
}

/**
 * Every key of an editor (`?`): the register and its split window, or the
 * budget page, with the user's own mappings, so the status line only needs
 * the basics.
 */
export function KeyHelp({
  open,
  onClose,
  keymap,
  groups = registerKeys,
}: {
  open: boolean
  onClose: () => void
  keymap: Keymap
  groups?: Array<KeyGroup>
}) {
  const mappings = (Object.keys(modeNames) as Array<keyof Keymap>).flatMap(
    (mode) =>
      keymap[mode].map((m) => ({
        mode,
        pane: m.pane,
        lhs: m.lhs.join(''),
        rhs: m.rhs.join(''),
      })),
  )

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        className="max-h-[85dvh] overflow-y-auto sm:max-w-3xl"
        onKeyDown={(e) => {
          // `?` and `q` close it again, as Esc does.
          if (e.key === '?' || e.key === 'q') {
            e.preventDefault()
            onClose()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>快捷鍵</DialogTitle>
          <DialogDescription>
            和 Vim 一樣，數字可以放在動作前面。按 ? 或 Esc 關閉。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
          {groups.map((g) => (
            <section key={g.title}>
              <h3 className="mb-1.5 text-sm font-semibold">{g.title}</h3>
              <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-3 gap-y-1 text-sm">
                {g.entries.map(([keys, does]) => (
                  <div key={keys} className="contents">
                    <dt className="font-mono text-kraft">{keys}</dt>
                    <dd className="text-muted-foreground">{does}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
          <section className="sm:col-span-2">
            <h3 className="mb-1.5 text-sm font-semibold">你的自訂快捷鍵</h3>
            {mappings.length > 0 ? (
              <div className="grid grid-cols-[auto_minmax(7rem,auto)_1fr] gap-x-3 gap-y-1 text-sm">
                {mappings.map((m) => (
                  <div
                    key={`${m.mode}:${m.pane ?? ''}:${m.lhs}`}
                    className="contents"
                  >
                    <span className="text-muted-foreground">
                      {modeNames[m.mode]}
                      {m.pane && `（${paneNames[m.pane]}）`}
                    </span>
                    <span className="font-mono text-kraft">{m.lhs}</span>
                    <span className="font-mono text-muted-foreground">
                      {m.rhs}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                還沒有設定。可以在「設定 → 編輯器」用 vimrc 的寫法加上，例如{' '}
                <code className="font-mono">inoremap jk &lt;Esc&gt;</code>。
              </p>
            )}
            <Link
              to="/settings/editor"
              className="mt-2 inline-block text-sm text-kraft underline-offset-4 hover:underline"
            >
              編輯自訂快捷鍵
            </Link>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}
