// Run with `pnpm test`; dependency-free like register.test.ts.
import assert from 'node:assert/strict'
import {
  InsertMapper,
  NormalMapper,
  TIMEOUT_MS,
  forPane,
  keyOf,
  parseKeymap,
  parseKeys,
} from './keymap.ts'

// ---------- key notation
assert.deepEqual(parseKeys(':w<CR>'), [':', 'w', '<CR>'])
assert.deepEqual(parseKeys('<c-D><s-tab><lt>'), ['<C-d>', '<S-Tab>', '<'])
assert.deepEqual(parseKeys('<Leader>w', ','), [',', 'w'])
assert.deepEqual(parseKeys('a<b'), ['a', '<', 'b'])
assert.throws(() => parseKeys('<Nope>'), /Nope/)

const ev = (
  key: string,
  mods: Partial<Record<'ctrl' | 'shift' | 'alt' | 'meta', boolean>> = {},
) => ({
  key,
  ctrlKey: mods.ctrl ?? false,
  shiftKey: mods.shift ?? false,
  altKey: mods.alt ?? false,
  metaKey: mods.meta ?? false,
})
assert.equal(keyOf(ev('j')), 'j')
assert.equal(keyOf(ev('J', { shift: true })), 'J')
assert.equal(keyOf(ev('d', { ctrl: true })), '<C-d>')
assert.equal(keyOf(ev('Escape')), '<Esc>')
assert.equal(keyOf(ev('Tab', { shift: true })), '<S-Tab>')
assert.equal(keyOf(ev('Enter', { ctrl: true })), '<C-CR>')
assert.equal(keyOf(ev('Shift', { shift: true })), null)

// ---------- parsing
const { keymap, errors } = parseKeymap(`
" my mappings
let mapleader = ","
inoremap jk <Esc>
inoremap <silent> kj <Esc>
nnoremap H 0
nnoremap <Leader>w :w<CR>
nmap ,, G
nnoremap H ^
foo bar
nnoremap x
nnoremap Q <Bogus>
inoremap j<C-x> <Esc>
`)
assert.deepEqual(
  errors.map((e) => e.line),
  [10, 11, 12, 13],
)
assert.deepEqual(
  keymap.insert.map((m) => m.lhs.join('')),
  ['jk', 'kj'],
)
// The later H replaces the earlier one.
assert.deepEqual(
  keymap.normal.map((m) => [m.lhs.join(''), m.rhs.join('')]),
  [
    [',w', ':w<CR>'],
    [',,', 'G'],
    ['H', '^'],
  ],
)
assert.equal(
  parseKeymap('let mapleader = "\\<Space>"\nnnoremap <Leader>q :q<CR>').keymap
    .normal[0].lhs[0],
  ' ',
)

// ---------- normal mode
const normal = new NormalMapper(keymap.normal)
assert.deepEqual(normal.feed('H'), ['^'])
assert.deepEqual(normal.feed('j'), ['j'])
// `,` could start `,w` or `,,`: it waits.
assert.deepEqual(normal.feed(','), [])
assert.equal(normal.waiting, true)
assert.deepEqual(normal.feed('w'), [':', 'w', '<CR>'])
assert.deepEqual(normal.feed(','), [])
assert.deepEqual(normal.feed('x'), [',', 'x'])
assert.deepEqual(normal.feed(','), [])
assert.deepEqual(normal.flush(), [','])
assert.equal(normal.waiting, false)
// The right-hand side is not mapped again.
const loop = new NormalMapper(
  parseKeymap('nnoremap j k\nnnoremap k j').keymap.normal,
)
assert.deepEqual(loop.feed('j'), ['k'])

// ---------- insert mode
const insert = new InsertMapper(keymap.insert)
assert.equal(insert.feed('j', 0), null)
assert.deepEqual(insert.feed('k', 100), { rhs: ['<Esc>'], erase: 1 })
// Too slow: the keys are typed.
assert.equal(insert.feed('j', 1000), null)
assert.equal(insert.feed('k', 1000 + TIMEOUT_MS + 1), null)
// A key in between breaks the sequence; `kj` still works after it.
assert.equal(insert.feed('j', 5000), null)
assert.equal(insert.feed('a', 5010), null)
assert.equal(insert.feed('k', 5020), null)
assert.deepEqual(insert.feed('j', 5030), { rhs: ['<Esc>'], erase: 1 })
// A single special key can be mapped too.
const ctrl = new InsertMapper(parseKeymap('inoremap <C-j> <Esc>').keymap.insert)
assert.deepEqual(ctrl.feed('<C-j>', 0), { rhs: ['<Esc>'], erase: 0 })

// ---------- visual mode
const modes = parseKeymap(
  'vnoremap D d\nxnoremap <C-c> <Esc>\nnoremap H 0\nnnoremap L $',
).keymap
assert.deepEqual(
  modes.visual.map((m) => m.lhs.join('')),
  ['D', '<C-c>', 'H'],
)
// `noremap` is normal and visual mode, as in Vim; `nnoremap` only normal.
assert.deepEqual(
  modes.normal.map((m) => m.lhs.join('')),
  ['H', 'L'],
)
assert.deepEqual(new NormalMapper(modes.visual).feed('D'), ['d'])

// ---------- mappings for one pane (autocmd FileType)
const local = parseKeymap(`nnoremap l <Right>
autocmd FileType sidebar nnoremap <buffer> l <CR>
au FileType register,split nnoremap Q :w<CR>
autocmd BufEnter * nnoremap x y
autocmd FileType nope nnoremap x y`)
assert.deepEqual(
  local.errors.map((e) => e.line),
  [4, 5],
)
assert.deepEqual(
  forPane(local.keymap.normal, 'sidebar').map((m) => [
    m.lhs.join(''),
    m.rhs.join(''),
  ]),
  [['l', '<CR>']],
)
assert.deepEqual(
  forPane(local.keymap.normal, 'register').map((m) => m.lhs.join('')),
  ['l', 'Q'],
)
assert.equal(forPane(local.keymap.normal, 'register')[0].rhs[0], '<Right>')
assert.equal(forPane(local.keymap.normal, 'main').length, 1)

// Window commands are only reached through mappings (ADR-072).
assert.deepEqual(parseKeymap('nnoremap <C-h> <C-w>h').keymap.normal[0], {
  lhs: ['<C-h>'],
  rhs: ['<C-w>', 'h'],
})

// `set timeoutlen`: how long `jk` may take, as in Vim.
const quick = parseKeymap('set timeoutlen=300\ninoremap jk <Esc>')
assert.equal(quick.keymap.timeoutlen, 300)
assert.deepEqual(quick.errors, [])
assert.equal(parseKeymap('set tm=800').keymap.timeoutlen, 800)
assert.equal(parseKeymap('nnoremap H 0').keymap.timeoutlen, undefined)
for (const bad of ['set timeoutlen=50', 'set timeoutlen=9000', 'set tm=abc']) {
  const parsed = parseKeymap(bad)
  assert.equal(parsed.errors.length, 1, bad)
  assert.equal(parsed.keymap.timeoutlen, undefined)
}
const fast = new InsertMapper(quick.keymap.insert, quick.keymap.timeoutlen)
assert.equal(fast.feed('j', 0), null)
assert.equal(fast.waiting, true)
// k after the timeout is just a k.
assert.equal(fast.feed('k', 400), null)
assert.equal(fast.feed('j', 1000), null)
assert.deepEqual(fast.feed('k', 1200), { rhs: ['<Esc>'], erase: 1 })

console.log('keymap: ok')
