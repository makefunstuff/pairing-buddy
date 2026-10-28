// The unsaved buffers Neovim reports for a project (lua/pair/buffers.lua), in a headless Neovim. Skips without nvim.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, realpathSync, symlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {scratch} from './temp.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const hasNvim = (() => { try { execFileSync('nvim', ['--version']); return true; } catch { return false; } })();

test('every changed file buffer inside the project, by its real path, with the newline a write would add', {skip: hasNvim ? false : 'nvim not installed'}, () => {
  const dir = realpathSync(scratch('pair-buffers-'));
  const root = join(dir, 'project');
  mkdirSync(join(root, 'src'), {recursive: true});
  for (const file of ['src/a.c', 'src/b.c', 'src/kept.c']) writeFileSync(join(root, file), 'int x;\n');
  writeFileSync(join(dir, 'outside.c'), 'int y;\n');
  symlinkSync(root, join(dir, 'link')); // opened through a link, still the project's file
  const script = join(dir, 'list.lua');
  writeFileSync(script, `
vim.cmd('edit ${join(dir, 'link/src/a.c')}') vim.api.nvim_buf_set_lines(0, 0, -1, false, {'int a = 1;'})
vim.cmd('edit! ${join(root, 'src/b.c')}') vim.api.nvim_buf_set_lines(0, 0, -1, false, {'int b;', 'int c;'}) vim.bo.fixeol = false vim.bo.eol = false
vim.cmd('edit! ${join(root, 'src/new.c')}') vim.api.nvim_buf_set_lines(0, 0, -1, false, {'int fresh;'})
vim.cmd('edit! ${join(root, 'src/kept.c')}')
vim.cmd('edit! ${join(dir, 'outside.c')}') vim.api.nvim_buf_set_lines(0, 0, -1, false, {'changed'})
vim.cmd('enew') vim.api.nvim_buf_set_lines(0, 0, -1, false, {'no name'})
local listed = require('pair.buffers').unsaved('${root}')
table.sort(listed, function(a, b) return a.file < b.file end)
io.stdout:write(vim.json.encode(listed))`);
  const listed = JSON.parse(execFileSync('nvim', ['--headless', '--clean', '-n', '--cmd', `set rtp+=${REPO} hidden`, '-l', script], {encoding: 'utf8'}));
  assert.deepEqual(listed, [
    {file: join(root, 'src/a.c'), text: 'int a = 1;\n'},
    {file: join(root, 'src/b.c'), text: 'int b;\nint c;'},
    {file: join(root, 'src/new.c'), text: 'int fresh;\n'},
  ]);
});

test('a /gen file waiting to be taken counts at its real path; another special buffer does not', {skip: hasNvim ? false : 'nvim not installed'}, () => {
  const root = realpathSync(scratch('pair-buffers-'));
  const script = join(root, 'list.lua');
  writeFileSync(script, `
local function special(name, lines, proposal)
  local buf = vim.api.nvim_create_buf(true, false)
  vim.api.nvim_buf_set_name(buf, name)
  vim.bo[buf].buftype = 'acwrite'
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.bo[buf].modified = true
  if proposal then vim.b[buf].pair_gen = proposal end
end
special('pair://gen/4/db/new.sql', {'CREATE TABLE t (x INT);'}, {gen = 4, action = 1, piece = 0, file = '${join(root, 'db/new.sql')}'})
special('pair://gen/compose', {'a request'})
io.stdout:write(vim.json.encode(require('pair.buffers').unsaved('${root}')))`);
  const listed = JSON.parse(execFileSync('nvim', ['--headless', '--clean', '-n', '--cmd', `set rtp+=${REPO} hidden`, '-l', script], {encoding: 'utf8'}));
  assert.deepEqual(listed, [{file: join(root, 'db/new.sql'), text: 'CREATE TABLE t (x INT);\n'}]);
});
