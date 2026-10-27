// The gaze (lua/pair/draw.lua) in a headless Neovim's screen: lit line numbers where a window has them, tinted
// lines where it has none. Skips without nvim.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {scratch} from './temp.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const hasNvim = (() => { try { execFileSync('nvim', ['--version']); return true; } catch { return false; } })();

/**
 * Sweeps a 20-line buffer shown in windows whose 'number' is each of `numbers`, side by side, and samples the
 * screen mid-sweep and after it: for each window, how many rows have a lit number column and how many a tinted
 * text column. `colors` is 'termguicolors'.
 */
function sweep(numbers, {colors = true} = {}) {
  const script = join(scratch('pair-gaze-'), 'gaze.lua');
  writeFileSync(script, `vim.o.columns, vim.o.lines = 120, 30
vim.o.termguicolors = ${colors}
local style, draw = require('pair.style'), require('pair.draw')
style.apply()
local buf = vim.api.nvim_get_current_buf()
local lines = {}
for i = 1, 20 do lines[i] = ('local x%d = %d'):format(i, i) end
vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
local numbers = vim.json.decode('${JSON.stringify(numbers)}')
for i = 2, #numbers do vim.cmd('vsplit') end
local wins = vim.api.nvim_tabpage_list_wins(0)
for i, win in ipairs(wins) do vim.wo[win].number = numbers[i] end
-- each window's number column and text past the end of the line (where only a line highlight colours the
-- screen), cell by cell: what they show, and how many rows differ from \`before\`
local function sample(before)
  vim.cmd('redraw!')
  local cells, out = {}, {}
  for i, win in ipairs(wins) do
    local pos, off = vim.fn.win_screenpos(win), vim.fn.getwininfo(win)[1].textoff
    local lit, tinted = 0, 0
    for row = 0, 19 do
      local number, text = vim.fn.screenattr(pos[1] + row, pos[2]), vim.fn.screenattr(pos[1] + row, pos[2] + off + 30)
      table.insert(cells, number)
      table.insert(cells, text)
      if before and off > 0 and number ~= before[#cells - 1] then lit = lit + 1 end
      if before and text ~= before[#cells] then tinted = tinted + 1 end
    end
    out[i] = {lit = lit, tinted = tinted}
  end
  return out, cells
end
local _, before = sample()
local shown = draw.gaze(buf, 1, 20)
vim.wait(300, function() return false end)
local during = sample(before)
vim.wait(1500, function() return false end)
io.stdout:write(vim.json.encode({shown = shown, during = during, after = sample(before)}))`);
  return JSON.parse(execFileSync('nvim', ['--headless', '--clean', '--cmd', `set rtp+=${REPO}`, '-l', script], {encoding: 'utf8'}));
}

const skip = hasNvim ? false : 'nvim not installed';

test('in a window with line numbers the gaze lights the numbers it reads, and leaves the lines alone', {skip}, () => {
  const {shown, during, after} = sweep([true]);
  assert.equal(shown, true);
  assert.ok(during[0].lit >= 1 && during[0].lit <= 3, `a lit number and its trail, not ${during[0].lit}`);
  assert.equal(during[0].tinted, 0);
  assert.deepEqual(after, [{lit: 0, tinted: 0}], 'gone once the sweep ends');
});

test('in a window without line numbers the gaze tints the lines it reads', {skip}, () => {
  const {shown, during, after} = sweep([false]);
  assert.equal(shown, true, 'a window without numbers shows the gaze too');
  assert.ok(during[0].tinted >= 1 && during[0].tinted <= 3, `a tinted line and its trail, not ${during[0].tinted}`);
  assert.deepEqual(after, [{lit: 0, tinted: 0}], 'gone once the sweep ends');
});

test('side by side, each window shows the gaze its own way', {skip}, () => {
  const {during: [numbered, plain]} = sweep([true, false]);
  assert.ok(numbered.lit >= 1, 'the numbers light up in the window with numbers');
  assert.equal(numbered.tinted, 0, 'no tint where the numbers show the gaze');
  assert.ok(plain.tinted >= 1, 'the lines are tinted in the window without');
});

test('without true colours the gaze still shows in a window without numbers, one line at a time', {skip}, () => {
  const {during} = sweep([false], {colors: false});
  assert.equal(during[0].tinted, 1);
});
