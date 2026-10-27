// The pair's accent (lua/pair/style.lua) on a few kinds of colorscheme, in a headless Neovim. Skips without nvim.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {scratch} from './temp.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const hasNvim = (() => { try { execFileSync('nvim', ['--version']); return true; } catch { return false; } })();

/** The accent style.lua picks after `setup` (Lua that sets a colorscheme's groups), as #rrggbb. */
function accentAfter(setup) {
  const script = join(scratch('pair-style-'), 'accent.lua');
  writeFileSync(script, `vim.o.termguicolors = true
vim.o.background = 'dark'
local function hi(name, fg) vim.api.nvim_set_hl(0, name, {fg = fg}) end
${setup}
local style = require('pair.style')
io.stdout:write(style.hex(style.accent()))`);
  return execFileSync('nvim', ['--headless', '--clean', '--cmd', `set rtp+=${REPO}`, '-l', script], {encoding: 'utf8'}).trim();
}

/** A scheme whose code is in greys: every syntax group, and the candidates, in `syntax` unless given. */
const greys = (extra = '') => `vim.g.colors_name = 'greys'
vim.api.nvim_set_hl(0, 'Normal', {fg = '#cacccc', bg = '#101315'})
for _, name in ipairs({'String', 'Keyword', 'Statement', 'Function', 'Type', 'Constant', 'Number', 'Identifier', 'PreProc'}) do hi(name, '#9fa5a9') end
for _, name in ipairs({'@string.regexp', 'DiagnosticHint', 'SpecialChar', 'DiagnosticInfo', 'Special', 'Title', 'Directory', 'DiagnosticOk', 'Question', 'MoreMsg'}) do hi(name, '#798186') end
${extra}`;

const hue = hex => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};

test('a grey scheme whose one colour is its red gets the quiet teal, not a red that reads as an error', {skip: hasNvim ? false : 'nvim not installed'}, () => {
  const accent = accentAfter(greys(`hi('DiagnosticError', '#de6145'); hi('DiagnosticHint', '#b14242'); hi('Number', '#de6145')`));
  assert.equal(accent, '#7fd1b9');
});

test('a scheme with code in greys gets the teal, also when it has another colour for hints', {skip: hasNvim ? false : 'nvim not installed'}, () => {
  assert.equal(accentAfter(greys(`hi('DiagnosticError', '#de6145'); hi('DiagnosticHint', '#5f87d7')`)), '#7fd1b9');
});

test('in a coloured scheme, the accent keeps away from the error colour, even when that hue is furthest from the code', {skip: hasNvim ? false : 'nvim not installed'}, () => {
  // Code in blue, green and yellow: a red regexp colour would be furthest from it, and is the error's own hue.
  const accent = accentAfter(`vim.g.colors_name = 'coloured'
vim.api.nvim_set_hl(0, 'Normal', {fg = '#c0caf5', bg = '#1a1b26'})
hi('String', '#9ece6a'); hi('Keyword', '#7aa2f7'); hi('Function', '#7aa2f7'); hi('Type', '#e0af68'); hi('Constant', '#e0af68')
hi('DiagnosticError', '#f7768e'); hi('@string.regexp', '#ff7a93'); hi('DiagnosticHint', '#1abc9c')`);
  assert.equal(accent, '#1abc9c');
  const distance = Math.abs(hue(accent) - hue('#f7768e')) % 360;
  assert.ok(Math.min(distance, 360 - distance) >= 30);
});

test('Neovim\'s own scheme keeps its cyan', {skip: hasNvim ? false : 'nvim not installed'}, () => {
  assert.equal(accentAfter(''), '#8cf8f7');
});

test('turning true colours on gives the groups their colours, where they were links before', {skip: hasNvim ? false : 'nvim not installed'}, () => {
  const script = join(scratch('pair-style-'), 'switch.lua');
  writeFileSync(script, `vim.o.termguicolors = false
local style = require('pair.style')
style.apply()
local before = vim.api.nvim_get_hl(0, {name = 'PairAccent'}).link
vim.o.termguicolors = true
style.apply()
local after = vim.api.nvim_get_hl(0, {name = 'PairAccent'}).fg
io.stdout:write(vim.json.encode({before = before, after = after and style.hex(after), accent = style.hex(style.accent())}))`);
  const out = JSON.parse(execFileSync('nvim', ['--headless', '--clean', '--cmd', `set rtp+=${REPO}`, '-l', script], {encoding: 'utf8'}));
  assert.deepEqual(out, {before: 'DiagnosticHint', after: out.accent, accent: out.accent});
});
