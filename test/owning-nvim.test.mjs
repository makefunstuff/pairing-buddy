// The ┊ marks of generated code in Neovim (lua/pair/owning.lua), alone in a headless Neovim with a stand-in daemon:
// what is sent while the daemon is away, and what a Neovim that did not take the code says. Skips without nvim.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {realpathSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {scratch} from './temp.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const hasNvim = (() => { try { execFileSync('nvim', ['--version']); return true; } catch { return false; } })();

/** Runs `body` (Lua) in a headless Neovim editing a.js with the lines `lines`; what it writes to stdout, as JSON. */
function inNvim(lines, body) {
  const dir = realpathSync(scratch('pair-owning-'));
  const file = join(dir, 'a.js');
  writeFileSync(file, `${lines.join('\n')}\n`);
  const script = join(dir, 'run.lua');
  writeFileSync(script, `
local owning = require('pair.owning')
local sent, up = {}, true
owning.setup({send = function(m) table.insert(sent, m) end, event = function() end, connected = function() return up end})
vim.cmd('edit ${file}')
local buf = vim.api.nvim_get_current_buf()
local function rows()
  local out = {}
  for _, m in ipairs(vim.api.nvim_buf_get_extmarks(buf, owning.ns, 0, -1, {})) do table.insert(out, m[2]) end
  return out
end
local function settle() vim.wait(50, function() return false end) end
local file = '${file}'
${body}`);
  return JSON.parse(execFileSync('nvim', ['--headless', '--clean', '--cmd', `set rtp^=${REPO}`, '-l', script], {encoding: 'utf8'}));
}

test('a part you edit while the daemon is away is yours once it is back, not gone; another Neovim\'s take is not gone here', {skip: hasNvim ? false : 'nvim not installed'}, () => {
  const result = inNvim(['a', 'b', 'c'], `
owning.on_marks({marks = {{id = '1.0.0', gen = 1, file = file, line = 2, text = {'b'}}}})
local placed = rows()
up = false
vim.api.nvim_buf_set_lines(buf, 1, 2, false, {'b2'})
owning.changed(buf, 'user')
settle()
local away = #sent
up = true
owning.on_marks({all = true, marks = {{id = '1.0.0', gen = 1, file = file, line = 2, text = {'b'}}}})
local back = rows()
-- Code another Neovim took and has not saved: not in this buffer, so not shown, and not gone either.
owning.on_marks({marks = {{id = '2.0.0', gen = 2, file = file, line = 1, text = {'unsaved elsewhere'}}}})
io.stdout:write(vim.json.encode({placed = placed, away = away, back = back, sent = sent}))`);
  assert.deepEqual(result.placed, [1]);
  assert.equal(result.away, 0, 'nothing sent while away');
  assert.deepEqual(result.back, [], 'not shown again');
  assert.deepEqual(result.sent, [{type: 'gen_own', ids: ['1.0.0'], how: 'edit'}], 'yours once back; nothing gone');
});
