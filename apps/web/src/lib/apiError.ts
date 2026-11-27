// zh-TW messages for the API's stable error codes. The API's own `message`
// is English and only used as a fallback.
const messages: Record<string, string> = {
  invalid_credentials: '帳號或密碼錯誤',
  account_disabled: '帳號已停用',
  password_login_disabled: '目前不開放密碼登入',
  wrong_password: '目前的密碼不正確',
  invalid_username: '帳號要 1 到 64 個字，不能有空白',
  invalid_display_name: '顯示名稱要 1 到 64 個字',
  username_taken: '這個帳號已經有人用了',
  unauthorized: '請先登入',
  forbidden: '沒有執行此操作的權限',
  cross_site_request: '已拒絕跨站請求',
  bad_request: '輸入的資料有誤',
  not_found: '找不到資料',
  conflict: '資料已被變更或已存在',
  duplicate: '已經有相同名稱的項目',
  not_an_envelope: '這個類別沒有自己的預算：到它的上層或子類別分配',
  invalid_month: '月份格式不對',
  invalid_reference: '選擇的資料不存在或仍在使用中',
  rule_violated: '資料不符合規則',
  oidc_unavailable: '無法使用此第三方登入，請稍後再試或聯絡管理員',
  oidc_flow_invalid: '登入流程已逾時或無效，請重新操作',
  oidc_cancelled: '已取消第三方登入',
  oidc_failed: '第三方登入驗證失敗，請重新操作',
  oidc_not_linked:
    '此第三方帳號尚未連結到任何使用者，請先用密碼登入，再到個人資料連結',
  oidc_link_session: '登入狀態已變更，請重新連結',
  oidc_identity_taken: '此第三方帳號已連結到其他使用者',
  oidc_already_linked: '你已經連結過這個登入方式的另一個帳號，請先解除連結',
  invalid_issuer:
    'Issuer 無效：找不到 OpenID Connect 設定（/.well-known/openid-configuration）',
  encryption_key_missing:
    '伺服器尚未設定 FACTUAL_ENCRYPTION_KEY，無法儲存用戶端密鑰',
  invalid_provider_kind: '類型只有 OIDC、GitHub、Discord',
  kind_fixed: '建立後不能改類型；要換就新增一個',
  invalid_code: 'ID 是 2 到 32 個小寫英數字、_ 或 -，以英文字母開頭',
  duplicate_code: '已經有同樣 ID 的登入方式',
  invalid_icon: '圖示要是 Simple Icons 的名稱',
  invalid_site_url: '網址是 http 或 https 開頭',
  client_id_required: '請輸入 Client ID',
  secret_required: 'GitHub 要填 Client Secret',
  invalid_scope: 'scope 是一個字，不能有空白',
  last_login_method: '這是你唯一的登入方式，請先設定密碼或連結其他帳號',
  invalid_name: '請輸入名稱',
  not_a_card: '只有信用卡有結帳日和繳款日',
  invalid_card: '結帳日和繳款截止日是 1 到 31，信用額度不能是負的',
  invalid_autopay: '自動扣繳要從預算內的現金或銀行帳戶扣，而且不能是這張卡自己',
  invalid_amount: '金額不能是負的',
  autopay_schedule: '自動扣繳在信用卡的帳單設定裡改',
  nothing_due: '這期帳單已經繳清，沒有要扣繳的',
  no_statement: '這張卡還沒有結過帳',
  not_a_loan: '只有貸款帳戶有貸款條件',
  invalid_term: '期數是 1 到 600 個月',
  invalid_first_payment: '首期繳款日要在撥款日之後',
  invalid_grace: '寬限期要比期數短',
  rate_required: '請輸入利率',
  rate_after_start: '第一段利率要從撥款日開始',
  invalid_rate: '利率是 0% 到 100%',
  duplicate_rate_date: '兩段利率的生效日相同',
  invalid_pay_from: '還款要從預算內、沒有關閉的帳戶扣',
  category_required: '有扣款帳戶時，本金和利息都要選分類',
  invalid_category: '分類要是這個預算的支出分類',
  loan_schedule: '貸款的還款排程在貸款設定裡改',
  loan_nothing_due: '這一期貸款沒有要繳的金額',
  invalid_order: '排序資料有誤，請重新整理後再試',
  account_not_empty: '帳戶餘額不是 0，無法關閉',
  account_in_use: '帳戶已有交易，無法刪除；可以改為關閉帳戶',
  invalid_category_name: '類別名稱不能空白，也不能包含 /',
  category_too_deep: '類別最多三層',
  category_kind_mismatch: '支出類別和收入類別不能互相搬移',
  category_cycle: '類別不能搬到自己底下',
  invalid_pooled: '只有支出類別可以讓子類別共用預算',
  system_category: '這是系統類別，不能修改',
  category_in_use: '類別底下還有子類別，或已有交易、預算；可以改為封存',
  invalid_payee_name: '收付款對象的名稱是 1 到 64 個字',
  payee_exists: '已經有同名的收付款對象；要合併請用「合併」',
  payee_in_use: '還有交易或排程用到這個收付款對象；可以把它合併到別的對象',
  invalid_merge: '不能把收付款對象合併到自己',
  keymap_too_long: '自訂快捷鍵太長了',
  invalid_rule: '看不懂這個週期，例如：每月 5 日、每週一三五、每年 3/15',
  amount_required: '請輸入金額',
  name_required: '請輸入名稱',
  invalid_kind: '目標類型只有：目標金額、期限前存到、維持水位、每月固定',
  date_required: '期限前存到的目標要有期限',
  months_required: '維持水位是 1 到 120 個月的平均支出',
  same_account: '轉帳要轉到另一個帳戶',
  account_closed: '帳戶已關閉',
  already_posted: '這一期已經入帳了',
  already_saved: '只有新的交易可以做為排程的一期入帳',
  not_an_occurrence: '排程在這一天沒有任何一期',
  occurrence_skipped: '這一期已略過；要入帳請先取消略過',
  invalid_until: '最多只能查詢 400 天內的預定交易',
  invalid_range: '年份範圍有誤（最多十年）',
  invalid_import: '請輸入 CSV 的網址，或選擇 CSV 檔案',
  invalid_url: '網址要以 http:// 或 https:// 開頭',
  fetch_failed: '無法下載這個網址的檔案',
  invalid_calendar:
    '不是行政機關辦公日曆表的 CSV（西元日期,星期,是否放假,備註），或年份不完整；請用檔名結尾是 utf8bom.csv 的版本',
  no_default_budget: '分帳要記到帳本裡，請先建立帳本',
  name_taken: '帳本裡已經有同名的帳戶，換個名字',
  not_placeholder: '朋友已經有自己的帳號，名字由他自己改',
  friend_in_use: '還有和這位朋友的分帳，刪掉分帳後才能移除',
  friend_account: '這是和朋友的往來帳戶，請到分帳頁修改',
  shared_transaction:
    '這筆是分帳產生的交易：只能核對或改類別，其他的請到分帳頁修改',
  not_recorder: '只有記這筆分帳的人能修改',
  friend_in_group: '這位朋友還在群組裡',
  not_friend: '群組成員要是你的朋友',
  registered_member: '有帳號的朋友之後才能加入群組（和註冊使用者分帳完成後）',
  duplicate_member: '成員重複了，或把自己也加進去了',
  invalid_member: '成員要選朋友或輸入名字',
  member_in_use: '這位成員還有群組裡的分帳，刪掉那些分帳後才能移除',
  group_not_settled: '群組還沒結清，結清後才能封存',
  group_archived: '群組已封存，取消封存後才能修改',
  group_in_use: '群組還有分帳，不能刪除；可以改成封存',
  too_many_requests: '嘗試次數過多，請稍後再試',
  internal: '系統發生錯誤，請稍後再試',
}

/** A zh-TW message for an API error code (e.g. from `?error=<code>`). */
export function errorCodeMessage(code: string): string {
  return messages[code] ?? '發生未知錯誤'
}

/**
 * A zh-TW message for whatever a failed API call produced: the `Error`
 * envelope, or a thrown network/timeout error.
 */
export function apiErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const { code, message } = error as { code?: unknown; message?: unknown }
    if (typeof code === 'string') {
      const known = messages[code]
      if (known) return known
      if (typeof message === 'string' && message) return message
    }
    if (error instanceof DOMException || error instanceof TypeError) {
      return '無法連線至伺服器，請稍後再試'
    }
  }
  return '發生未知錯誤'
}
