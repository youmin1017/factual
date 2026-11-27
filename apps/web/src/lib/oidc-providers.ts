import type { Schemas } from './api'

// The identity providers page (ADR-126): the instance's login providers as
// a grid edited like the accounts page, saved with :w through
// POST /oidc-providers/batch. A new line starts from a template (Google,
// GitHub, Discord, self-hosted OIDC servers, ADR-125) that fills in what
// it can; the address, secret, scopes and remark are lines under the
// provider's line, folded with za. Scopes are picked as chips. The line
// order is the order of the login buttons. Pure, tested with node.

export type Provider = Schemas['OidcProvider']
export type ProviderKind = Schemas['OidcProviderKind']
export type ProviderBatch = Schemas['OidcProviderBatch']
export type ProviderUpsert = Schemas['OidcProviderUpsert']

export type ProviderColumn = 'name' | 'kind' | 'code' | 'icon' | 'enabled'

export const providerColumns: Array<ProviderColumn> = [
  'name',
  'kind',
  'code',
  'icon',
  'enabled',
]

export const providerLabels: Record<ProviderColumn, string> = {
  name: '名稱',
  kind: '類型',
  code: 'ID',
  icon: '圖示',
  enabled: '啟用',
}

/**
 * The settings under a provider's line, one to a line (ADR-110): the
 * client first, as the service gives it, then where the service is.
 */
export type SettingKey =
  | 'clientId'
  | 'clientSecret'
  | 'issuer'
  | 'scopes'
  | 'remark'

export const settingKeys: Array<SettingKey> = [
  'clientId',
  'clientSecret',
  'issuer',
  'scopes',
  'remark',
]

export const kindLabels: Record<ProviderKind, string> = {
  oidc: 'OIDC',
  github: 'GitHub',
  discord: 'Discord',
}

export interface ProviderRow {
  /** The provider's id; chosen here for a new line. */
  id: string
  /** The saved provider; null for a line never saved. */
  base: Provider | null
  deleted: boolean
  name: string
  kind: ProviderKind
  code: string
  /** A Simple Icons slug; '' for the default key. */
  icon: string
  clientId: string
  enabled: boolean
  /** The OIDC issuer, or GitHub's or Discord's address. */
  issuer: string
  /** A new client secret typed; '' keeps the stored one. Never kept in drafts. */
  secret: string
  scopes: Array<string>
  remark: string
  /** The template a new line was filled from; its values give way to the next one picked. */
  template: string | null
}

export type ProviderStatus = 'clean' | 'new' | 'changed' | 'deleted'

/** What is wrong with a line: every field at fault, and what to do about each. */
export interface ProviderProblem {
  fields: Array<ProviderColumn | SettingKey>
  message: string
}

// ---------- templates (ADR-125)

export interface Template {
  id: string
  /** As the completion list shows it. */
  label: string
  kind: ProviderKind
  name: string
  code: string
  icon: string
  issuer: string
  scopes: Array<string>
  /** Where the client is made and what goes where, for the status line. */
  help: string
}

const OIDC_SCOPES = ['openid', 'email', 'profile']

export const templates: Array<Template> = [
  {
    id: 'google',
    label: 'Google',
    kind: 'oidc',
    name: 'Google',
    code: 'google',
    icon: 'google',
    issuer: 'https://accounts.google.com',
    scopes: OIDC_SCOPES,
    help: 'Google Cloud Console →「API 和服務」→「憑證」建立 OAuth 用戶端 ID（網頁應用程式），已授權的重新導向 URI 填上面的回呼網址',
  },
  {
    id: 'github',
    label: 'GitHub',
    kind: 'github',
    name: 'GitHub',
    code: 'github',
    icon: 'github',
    issuer: 'https://github.com',
    scopes: ['read:user', 'user:email'],
    help: 'GitHub → Settings → Developer settings → OAuth Apps 建立應用程式，Authorization callback URL 填上面的回呼網址；GitHub Enterprise 把網址改成自己的',
  },
  {
    id: 'discord',
    label: 'Discord',
    kind: 'discord',
    name: 'Discord',
    code: 'discord',
    icon: 'discord',
    issuer: 'https://discord.com',
    scopes: ['identify', 'email'],
    help: 'Discord Developer Portal 建立應用程式，OAuth2 → Redirects 加上面的回呼網址',
  },
  {
    id: 'authentik',
    label: 'Authentik',
    kind: 'oidc',
    name: 'Authentik',
    code: 'authentik',
    icon: 'authentik',
    issuer: '',
    scopes: OIDC_SCOPES,
    help: 'Issuer 是 https://你的網域/application/o/應用程式的 slug/',
  },
  {
    id: 'keycloak',
    label: 'Keycloak',
    kind: 'oidc',
    name: 'Keycloak',
    code: 'keycloak',
    icon: 'keycloak',
    issuer: '',
    scopes: OIDC_SCOPES,
    help: 'Issuer 是 https://你的網域/realms/realm 名稱',
  },
  {
    id: 'authelia',
    label: 'Authelia',
    kind: 'oidc',
    name: 'Authelia',
    code: 'authelia',
    icon: 'authelia',
    issuer: '',
    scopes: OIDC_SCOPES,
    help: 'Issuer 是 Authelia 的網址，例如 https://auth.example.com',
  },
  {
    id: 'pocketid',
    label: 'Pocket ID',
    kind: 'oidc',
    name: 'Pocket ID',
    code: 'pocketid',
    icon: '',
    issuer: '',
    scopes: OIDC_SCOPES,
    help: 'Issuer 是 Pocket ID 的網址，例如 https://id.example.com',
  },
  {
    id: 'oidc',
    label: '其他 OIDC',
    kind: 'oidc',
    name: '',
    code: '',
    icon: 'openid',
    issuer: '',
    scopes: OIDC_SCOPES,
    help: 'Issuer 是服務的網址（它的 /.well-known/openid-configuration 所在）',
  },
]

export function templateOf(id: string | null): Template | undefined {
  return templates.find((t) => t.id === id)
}

/**
 * A new line with a template picked: the kind is the template's, and each
 * value it fills is taken unless the line already has one of its own (not
 * the last template's).
 */
export function applyTemplate(row: ProviderRow, t: Template): ProviderRow {
  const before = templateOf(row.template)
  const take = <T>(mine: T, was: T | undefined, next: T, empty: boolean): T =>
    empty || JSON.stringify(mine) === JSON.stringify(was) ? next : mine
  return {
    ...row,
    kind: t.kind,
    template: t.id,
    name: take(row.name, before?.name, t.name, row.name.trim() === ''),
    code: take(row.code, before?.code, t.code, row.code === ''),
    icon: take(row.icon, before?.icon, t.icon, row.icon === ''),
    issuer: take(row.issuer, before?.issuer, t.issuer, row.issuer === ''),
    scopes: take(row.scopes, before?.scopes, t.scopes, row.scopes.length === 0),
  }
}

// ---------- lines

export function rowFromProvider(p: Provider): ProviderRow {
  return {
    id: p.id,
    base: p,
    deleted: false,
    name: p.name,
    kind: p.kind,
    code: p.code,
    icon: p.icon,
    clientId: p.clientId,
    enabled: p.enabled,
    issuer: p.issuer,
    secret: '',
    scopes: p.scopes,
    remark: p.remark,
    template: null,
  }
}

/** The providers in the order of their buttons. */
export function providerRows(list: Array<Provider>): Array<ProviderRow> {
  return list
    .toSorted((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))
    .map(rowFromProvider)
}

export function newProviderRow(id: string): ProviderRow {
  return {
    id,
    base: null,
    deleted: false,
    name: '',
    kind: 'oidc',
    code: '',
    icon: '',
    clientId: '',
    enabled: true,
    issuer: '',
    secret: '',
    scopes: [],
    remark: '',
    template: null,
  }
}

function inputOf(row: ProviderRow): string {
  return JSON.stringify({
    name: row.name.trim(),
    kind: row.kind,
    code: row.code,
    icon: row.icon,
    clientId: row.clientId.trim(),
    enabled: row.enabled,
    issuer: row.issuer.trim(),
    secret: row.secret,
    scopes: row.scopes,
    remark: row.remark.trim(),
  })
}

export function providerStatus(row: ProviderRow): ProviderStatus {
  if (row.deleted) return 'deleted'
  if (!row.base) return 'new'
  return inputOf(row) === inputOf(rowFromProvider(row.base))
    ? 'clean'
    : 'changed'
}

/** What a line saves as, `sort` being its place among the lines kept. */
export function toUpsert(row: ProviderRow, sort: number): ProviderUpsert {
  return {
    id: row.id,
    code: row.code,
    name: row.name.trim(),
    kind: row.kind,
    issuer: row.issuer.trim(),
    clientId: row.clientId.trim(),
    clientSecret: row.secret,
    scopes: row.scopes,
    icon: row.icon,
    sort,
    enabled: row.enabled,
    remark: row.remark.trim(),
  }
}

/**
 * What :w sends: the lines changed or new, and the saved lines whose place
 * changed (their sort), and the deleted ones by id.
 */
export function toBatch(rows: Array<ProviderRow>): ProviderBatch {
  const kept = rows.filter((r) => !r.deleted)
  return {
    upserts: kept
      .map((r, sort) => ({ r, sort }))
      .filter(
        ({ r, sort }) => providerStatus(r) !== 'clean' || r.base?.sort !== sort,
      )
      .map(({ r, sort }) => toUpsert(r, sort)),
    deletes: rows.filter((r) => r.deleted && r.base).map((r) => r.id),
  }
}

/** Drafts keep no secret (ADR-043 drafts live in localStorage). */
export function draftRows(rows: Array<ProviderRow>): Array<ProviderRow> {
  return rows.map((r) => (r.secret ? { ...r, secret: '' } : r))
}

const CODE = /^[a-z][a-z0-9_-]{1,31}$/
const CODE_RULE =
  'ID 用在網址裡：2 到 32 個小寫英數字、_ 或 -，以英文字母開頭，例如 google'
const SLUG = /^[a-z0-9_]{0,64}$/

function webAddress(s: string): boolean {
  try {
    const u = new URL(s)
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.host !== ''
  } catch {
    return false
  }
}

/** What the address setting is called for the kind. */
export function issuerLabel(kind: ProviderKind): string {
  return kind === 'oidc' ? 'Issuer' : `${kindLabels[kind]} 網址`
}

export function settingLabel(row: ProviderRow, key: SettingKey): string {
  switch (key) {
    case 'clientId':
      return 'Client ID'
    case 'issuer':
      return issuerLabel(row.kind)
    case 'clientSecret':
      return 'Client Secret'
    case 'scopes':
      return 'Scopes'
    case 'remark':
      return '備註'
  }
}

export function validateProvider(
  row: ProviderRow,
  rows: Array<ProviderRow>,
): ProviderProblem | null {
  if (row.deleted) return null
  const found: Array<[ProviderColumn | SettingKey, string]> = []
  const name = row.name.trim()
  if (!name) found.push(['name', '請輸入名稱（登入按鈕上的字）'])
  else if ([...name].length > 64) found.push(['name', '名稱最多 64 個字'])
  if (!CODE.test(row.code)) found.push(['code', CODE_RULE])
  else if (
    rows.some((r) => r.id !== row.id && !r.deleted && r.code === row.code)
  )
    found.push(['code', `已經有 ID 是「${row.code}」的登入方式`])
  if (!SLUG.test(row.icon)) found.push(['icon', '圖示不對'])
  if (!row.clientId.trim()) found.push(['clientId', '請輸入 Client ID'])
  if (row.kind === 'github' && !row.secret && !row.base?.hasSecret)
    found.push(['clientSecret', 'GitHub 要填 Client Secret'])
  const issuer = row.issuer.trim()
  if (row.kind === 'oidc' ? !webAddress(issuer) : issuer && !webAddress(issuer))
    found.push([
      'issuer',
      `請輸入${issuerLabel(row.kind)}，例如 https://auth.example.com`,
    ])
  if (found.length === 0) return null
  return {
    fields: found.map(([f]) => f),
    message: found.map(([, m]) => m).join('；'),
  }
}

/** Why a cell cannot be edited, or null. */
export function lockedReason(
  row: ProviderRow,
  column: ProviderColumn | SettingKey,
): string | null {
  if (row.deleted) return '這一列已標記刪除，按 u 復原或 dd 取消'
  if (column === 'kind' && row.base)
    return '建立後不能改類型：已連結的帳號只屬於這種登入方式；要換就新增一個'
  return null
}

// ---------- cells

export function providerCellText(
  row: ProviderRow,
  column: ProviderColumn,
): string {
  switch (column) {
    case 'name':
      return row.name
    case 'kind':
      return kindLabels[row.kind]
    case 'code':
      return row.code
    case 'icon':
      return row.icon
    case 'enabled':
      return row.enabled ? '啟用' : '停用'
  }
}

/**
 * What a typed cell changes, or why it cannot. `slugs` are the icons there
 * are (an icon must be one of them when the list is known).
 */
export function providerPatch(
  row: ProviderRow,
  column: ProviderColumn,
  text: string,
  slugs: ReadonlySet<string> | null,
): ProviderRow | string {
  const value = text.trim()
  switch (column) {
    case 'name':
      // Left empty is fine while editing; :w says what is missing.
      if ([...value].length > 64) return '名稱最多 64 個字'
      return { ...row, name: value }
    case 'kind': {
      const t =
        templates.find((x) => x.label === value) ??
        templates.find(
          (x) =>
            x.id === value.toLowerCase() ||
            (kindLabels[x.kind] === value && x.kind !== 'oidc'),
        ) ??
        (value === kindLabels.oidc ? templateOf('oidc') : undefined)
      if (!t) return '請從清單選：Google、GitHub、Discord 或其他 OIDC'
      return applyTemplate(row, t)
    }
    case 'code': {
      const code = value.toLowerCase()
      if (code && !CODE.test(code)) return CODE_RULE
      return { ...row, code }
    }
    case 'icon': {
      const slug = value.toLowerCase()
      if (slug && (!SLUG.test(slug) || (slugs && !slugs.has(slug))))
        return `Simple Icons 沒有「${value}」：從清單選，或留空用預設的鑰匙`
      return { ...row, icon: slug }
    }
    case 'enabled':
      return { ...row, enabled: !row.enabled }
  }
}

/** A setting as its line shows it. */
export function settingText(row: ProviderRow, key: SettingKey): string {
  switch (key) {
    case 'clientId':
      return row.clientId
    case 'issuer':
      return row.issuer
    case 'clientSecret':
      return row.secret ? '•'.repeat(Math.min(row.secret.length, 12)) : ''
    case 'scopes':
      return row.scopes.join(' ')
    case 'remark':
      return row.remark
  }
}

/** What an empty setting says, muted. */
export function settingPlaceholder(row: ProviderRow, key: SettingKey): string {
  switch (key) {
    case 'clientId':
      return '必填：在服務那邊建立應用程式時拿到'
    case 'issuer':
      return row.kind === 'oidc'
        ? 'https://auth.example.com'
        : (templates.find((t) => t.kind === row.kind)?.issuer ?? '')
    case 'clientSecret':
      return row.base?.hasSecret
        ? '已儲存（不會顯示；輸入新的才會換掉）'
        : row.kind === 'github'
          ? '必填'
          : '沒有（public client）'
    case 'scopes':
      return '預設'
    case 'remark':
      return ''
  }
}

/**
 * A setting typed, or why it cannot be. Required values may be left empty
 * while editing, so insert mode is always left with Esc; :w finds them.
 */
export function settingPatch(
  row: ProviderRow,
  key: Exclude<SettingKey, 'scopes'>,
  text: string,
): ProviderRow | string {
  const value = text.trim()
  switch (key) {
    case 'clientId':
      if (value.length > 255) return 'Client ID 太長了'
      return { ...row, clientId: value }
    case 'issuer':
      // An empty OIDC issuer is found at :w; GitHub's and Discord's is the default.
      if (value === '') return { ...row, issuer: '' }
      if (!webAddress(value))
        return `${issuerLabel(row.kind)}是 http 或 https 開頭的網址`
      if (value.length > 255) return '網址太長了'
      return { ...row, issuer: value }
    case 'clientSecret':
      if (value.length > 2048) return 'Client Secret 太長了'
      return { ...row, secret: value }
    case 'remark':
      if (value.length > 255) return '備註最多 255 個字'
      return { ...row, remark: value }
  }
}

// ---------- the scopes picker

export interface ScopeOption {
  value: string
  label: string
  hint?: string
}

const knownScopes: Record<ProviderKind, Array<[string, string]>> = {
  oidc: [
    ['openid', '必要'],
    ['email', '電子郵件'],
    ['profile', '名稱、頭像'],
    ['groups', '群組（部分服務有）'],
    ['offline_access', '長期權杖（用不到）'],
  ],
  github: [
    ['read:user', '個人資料'],
    ['user:email', '電子郵件（包括不公開的）'],
    ['read:org', '組織'],
  ],
  discord: [
    ['identify', '必要：使用者'],
    ['email', '電子郵件'],
    ['guilds', '伺服器清單'],
  ],
}

/** A scope that stays: OIDC providers are always asked for openid. */
export function scopeLocked(kind: ProviderKind, scope: string): boolean {
  return kind === 'oidc' && scope === 'openid'
}

/**
 * The scopes the picker offers for what is typed: the kind's usual ones
 * not picked yet (those starting with it first), and what is typed as a
 * scope of its own when it is one word not listed.
 */
export function scopeOptions(
  kind: ProviderKind,
  picked: Array<string>,
  query: string,
): Array<ScopeOption> {
  const q = query.trim().toLowerCase()
  const options: Array<ScopeOption> = knownScopes[kind]
    .filter(([s]) => !picked.includes(s) && (!q || s.includes(q)))
    .toSorted(([a], [b]) => Number(!a.startsWith(q)) - Number(!b.startsWith(q)))
    .map(([s, hint]) => ({ value: s, label: s, hint }))
  const typed = query.trim()
  if (
    typed &&
    !/\s/.test(typed) &&
    !picked.includes(typed) &&
    !knownScopes[kind].some(([s]) => s === typed)
  )
    options.push({ value: typed, label: `加入「${typed}」`, hint: '自訂' })
  return options
}

/** The scopes with one taken off, or why it stays. */
export function dropScope(
  kind: ProviderKind,
  picked: Array<string>,
  scope: string,
): Array<string> | string {
  if (scopeLocked(kind, scope)) return 'OIDC 一定要有 openid'
  return picked.filter((s) => s !== scope)
}

/** The scopes a picker starts with: the line's, openid first for OIDC. */
export function startScopes(row: ProviderRow): Array<string> {
  const scopes = row.scopes.length > 0 ? row.scopes : defaultScopes(row.kind)
  return row.kind === 'oidc' && !scopes.includes('openid')
    ? ['openid', ...scopes]
    : [...scopes]
}

export function defaultScopes(kind: ProviderKind): Array<string> {
  return kind === 'oidc'
    ? OIDC_SCOPES
    : (templates.find((t) => t.kind === kind)?.scopes ?? [])
}

// ---------- problems from the server

export function problemField(
  field: string,
): ProviderColumn | SettingKey | null {
  return (providerColumns as Array<string>).includes(field) ||
    (settingKeys as Array<string>).includes(field)
    ? (field as ProviderColumn | SettingKey)
    : null
}

export function isSetting(
  field: ProviderColumn | SettingKey | null,
): field is SettingKey {
  return (settingKeys as Array<string | null>).includes(field)
}

/** Messages for problem codes whose global message says something else. */
export const providerProblemMessages: Record<string, string> = {
  invalid_name: '名稱是 1 到 64 個字',
  duplicate_id: '這一列重複出現',
}
