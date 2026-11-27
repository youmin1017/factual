// Run with: node --experimental-strip-types src/lib/oidc-providers.test.ts
import assert from 'node:assert/strict'
import {
  applyTemplate,
  draftRows,
  dropScope,
  lockedReason,
  newProviderRow,
  providerPatch,
  providerRows,
  providerStatus,
  scopeOptions,
  settingKeys,
  settingPatch,
  startScopes,
  templateOf,
  toBatch,
  validateProvider,
} from './oidc-providers.ts'
import type { Provider, ProviderRow, Template } from './oidc-providers.ts'

const provider = (
  id: string,
  code: string,
  extra: Partial<Provider> = {},
): Provider => ({
  id,
  code,
  name: code.toUpperCase(),
  kind: 'oidc',
  issuer: `https://${code}.example.com`,
  clientId: 'factual',
  hasSecret: true,
  scopes: ['openid', 'email', 'profile'],
  icon: '',
  sort: 0,
  enabled: true,
  remark: '',
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
  ...extra,
})

const template = (id: string): Template => {
  const t = templateOf(id)
  assert.ok(t, id)
  return t
}

// Lines come in the order of the login buttons.
{
  const rows = providerRows([
    provider('b', 'beta', { sort: 1 }),
    provider('a', 'alpha', { sort: 0 }),
  ])
  assert.deepEqual(
    rows.map((r) => r.code),
    ['alpha', 'beta'],
  )
  assert.ok(rows.every((r) => providerStatus(r) === 'clean'))
}

// A template fills a new line; picking another replaces only what the
// first one filled, keeping what was typed.
{
  let row = applyTemplate(newProviderRow('n'), template('google'))
  assert.equal(row.kind, 'oidc')
  assert.equal(row.name, 'Google')
  assert.equal(row.code, 'google')
  assert.equal(row.icon, 'google')
  assert.equal(row.issuer, 'https://accounts.google.com')
  assert.deepEqual(row.scopes, ['openid', 'email', 'profile'])

  row = { ...row, name: '公司 Google' }
  row = applyTemplate(row, template('github'))
  assert.equal(row.kind, 'github')
  assert.equal(row.name, '公司 Google', 'a name typed stays')
  assert.equal(row.code, 'github')
  assert.equal(row.issuer, 'https://github.com')
  assert.deepEqual(row.scopes, ['read:user', 'user:email'])

  // A self-hosted server leaves the issuer to fill in.
  const keycloak = applyTemplate(newProviderRow('k'), template('keycloak'))
  assert.equal(keycloak.issuer, '')
  assert.deepEqual(validateProvider(keycloak, [keycloak])?.fields, [
    'clientId',
    'issuer',
  ])
}

// The 類型 cell takes a template by its label, or a kind's name.
{
  const row = newProviderRow('n')
  const discord = providerPatch(row, 'kind', 'Discord', null)
  assert.ok(typeof discord !== 'string')
  assert.equal(discord.kind, 'discord')
  const oidc = providerPatch(row, 'kind', 'OIDC', null)
  assert.ok(typeof oidc !== 'string')
  assert.equal(oidc.template, 'oidc')
  assert.equal(typeof providerPatch(row, 'kind', 'Facebook', null), 'string')
}

// A saved provider's kind is fixed.
{
  const [saved] = providerRows([provider('a', 'alpha')])
  assert.ok(lockedReason(saved, 'kind'))
  assert.equal(lockedReason(newProviderRow('n'), 'kind'), null)
}

// Codes and icons are checked as typed.
{
  const row = newProviderRow('n')
  const coded = providerPatch(row, 'code', ' Corp ', null)
  assert.ok(typeof coded !== 'string')
  assert.equal(coded.code, 'corp')
  assert.equal(typeof providerPatch(row, 'code', '1corp', null), 'string')
  const slugs = new Set(['github', 'google'])
  assert.equal(typeof providerPatch(row, 'icon', 'nope', slugs), 'string')
  const icon = providerPatch(row, 'icon', 'GitHub', slugs)
  assert.ok(typeof icon !== 'string')
  assert.equal(icon.icon, 'github')
  const none = providerPatch(row, 'icon', '', slugs)
  assert.ok(typeof none !== 'string')
  assert.equal(none.icon, '')
}

// Settings: GitHub's and Discord's address may be left to the default;
// an OIDC issuer may not.
{
  const github = applyTemplate(newProviderRow('g'), template('github'))
  const cleared = settingPatch(github, 'issuer', '')
  assert.ok(typeof cleared !== 'string')
  assert.equal(cleared.issuer, '')
  const google = applyTemplate(newProviderRow('o'), template('google'))
  assert.equal(typeof settingPatch(google, 'issuer', 'ftp://x'), 'string')
}

// Client ID is the first setting; required values may be left empty while
// editing (Esc always leaves insert mode) and are found at :w.
{
  assert.deepEqual(settingKeys, [
    'clientId',
    'clientSecret',
    'issuer',
    'scopes',
    'remark',
  ])
  const row = applyTemplate(newProviderRow('n'), template('google'))
  const empty = settingPatch(row, 'clientId', '  ')
  assert.ok(typeof empty !== 'string')
  assert.equal(empty.clientId, '')
  const noIssuer = settingPatch(row, 'issuer', '')
  assert.ok(typeof noIssuer !== 'string')
  assert.equal(
    validateProvider({ ...noIssuer, clientId: 'x' }, [row])?.fields[0],
    'issuer',
  )
  for (const column of ['name', 'code'] as const) {
    const cleared = providerPatch(row, column, '', null)
    assert.ok(typeof cleared !== 'string', column)
    assert.equal(
      validateProvider({ ...cleared, clientId: 'x' }, [row])?.fields[0],
      column,
    )
  }
  const filled = settingPatch(row, 'clientId', ' abc.apps ')
  assert.ok(typeof filled !== 'string')
  assert.equal(filled.clientId, 'abc.apps')
  // A new line without one is found at :w, the cursor sent to its line.
  assert.equal(validateProvider(row, [row])?.fields[0], 'clientId')
}

// Validation: codes unique among the lines kept, GitHub needs a secret.
{
  const [saved] = providerRows([provider('a', 'google')])
  const google = {
    ...applyTemplate(newProviderRow('n'), template('google')),
    clientId: 'id',
  }
  assert.equal(validateProvider(google, [saved, google])?.fields[0], 'code')
  // Every field at fault is named, not only the first.
  const both = validateProvider({ ...google, clientId: '' }, [saved, google])
  assert.ok(both)
  assert.deepEqual(both.fields, ['code', 'clientId'])
  assert.match(both.message, /google.*Client ID/)
  assert.equal(
    validateProvider(google, [{ ...saved, deleted: true }, google]),
    null,
  )

  const github: ProviderRow = {
    ...applyTemplate(newProviderRow('g'), template('github')),
    clientId: 'id',
  }
  assert.equal(validateProvider(github, [github])?.fields[0], 'clientSecret')
  assert.equal(validateProvider({ ...github, secret: 's' }, [github]), null)
  assert.equal(
    validateProvider({ ...github, clientId: ' ' }, [github])?.fields[0],
    'clientId',
  )
}

// The batch: changed and new lines, saved lines whose place changed, and
// deletions; a typed secret is sent but never kept in a draft.
{
  const rows = providerRows([
    provider('a', 'alpha', { sort: 0 }),
    provider('b', 'beta', { sort: 1 }),
    provider('c', 'gamma', { sort: 2 }),
  ])
  const added: ProviderRow = {
    ...applyTemplate(newProviderRow('n'), template('discord')),
    clientId: 'id',
    secret: 'shh',
  }
  // alpha deleted, beta and gamma swapped, a new line last.
  const edited = [{ ...rows[0], deleted: true }, rows[2], rows[1], added]
  const batch = toBatch(edited)
  assert.deepEqual(batch.deletes, ['a'])
  // beta is still second (sort 1), so it is not sent.
  assert.deepEqual(
    batch.upserts.map((u) => [u.id, u.sort]),
    [
      ['c', 0],
      ['n', 2],
    ],
  )
  assert.equal(batch.upserts[1].clientSecret, 'shh')
  assert.equal(batch.upserts[0].clientSecret, '', 'a stored secret is kept')

  // Unchanged lines in their place are not sent.
  assert.deepEqual(toBatch(rows), { upserts: [], deletes: [] })

  assert.equal(draftRows(edited)[3].secret, '')
  assert.equal(providerStatus({ ...rows[0], secret: 'new' }), 'changed')
}

// The scopes picker: the kind's usual scopes, a scope of one's own, and
// openid staying with OIDC.
{
  const google = applyTemplate(newProviderRow('o'), template('google'))
  const picked = startScopes(google)
  assert.deepEqual(picked, ['openid', 'email', 'profile'])
  assert.deepEqual(
    scopeOptions('oidc', picked, '').map((o) => o.value),
    ['groups', 'offline_access'],
  )
  assert.deepEqual(
    scopeOptions('oidc', picked, 'off').map((o) => o.value),
    ['offline_access', 'off'],
  )
  assert.deepEqual(
    scopeOptions('oidc', picked, 'email').map((o) => o.value),
    [],
    'a scope picked is not offered again',
  )
  assert.deepEqual(scopeOptions('oidc', picked, 'two words'), [])
  assert.equal(typeof dropScope('oidc', picked, 'openid'), 'string')
  assert.deepEqual(dropScope('oidc', picked, 'email'), ['openid', 'profile'])

  // A line without scopes starts from the kind's defaults.
  const bare = { ...newProviderRow('d'), kind: 'discord' as const }
  assert.deepEqual(startScopes(bare), ['identify', 'email'])
  assert.deepEqual(
    scopeOptions('github', ['read:user'], 'read').map((o) => o.value),
    ['read:org', 'read'],
  )
}

console.log('oidc-providers: ok')
