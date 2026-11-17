// zh-TW messages for the API's stable error codes. The API's own `message`
// is English and only used as a fallback.
const messages: Record<string, string> = {
  invalid_credentials: '帳號或密碼錯誤',
  account_disabled: '帳號已停用',
  password_login_disabled: '目前不開放密碼登入',
  wrong_password: '目前的密碼不正確',
  unauthorized: '請先登入',
  forbidden: '沒有執行此操作的權限',
  cross_site_request: '已拒絕跨站請求',
  bad_request: '輸入的資料有誤',
  not_found: '找不到資料',
  conflict: '資料已被變更或已存在',
  duplicate: '代碼已被使用',
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
  last_login_method: '這是你唯一的登入方式，請先設定密碼或連結其他帳號',
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
