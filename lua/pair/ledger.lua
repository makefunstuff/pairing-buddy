-- The ledger in Neovim: `:Pair today` lists everything Pair did in this project today, one quiet line each, oldest
-- first, in a split at the bottom: the time, what it did in the accent, what it did it to, and on the right the key
-- that acts on it. <CR> goes where an entry points, or opens what it holds (a command's output, why Pair stayed
-- quiet, all it said); `u` undoes an edit of Pair's, also after your later edits, and `u` again makes it again; `+`
-- and `-` rate a remark; `q` closes. The list follows along while it is open. Its last line says how much code you
-- took from /gen is not yours yet (┊ in the sign column): <CR> there goes to it, `o` owns one file of it, `O` all.
local style = require('pair.style')

local M = {}

M.ns = vim.api.nvim_create_namespace('pair_ledger')

local LABEL_WIDTH = 14
local MAX_HEIGHT = 12

-- `send(message)` talks to the daemon, `rate(useful, remark)` rates a remark: set by the plugin's setup.
M.send = function() end
M.rate = function() end

local view = {
  buf = nil, win = nil, -- the list, and the window showing it or what an entry opens to
  rows = {}, summary = '',
  generated = nil, -- the code taken from /gen not yours yet: {files = {{file, name, lines, line, gens, from}}, lines}
  generated_line = nil, -- its line in the list
  from = nil, -- the window you opened the list from: where <CR> goes to a place
  refresh = nil, -- the timer that asks for the list again after a change
  opened = false, -- the list was just opened: its cursor goes to the newest entry
}

local function valid_win() return view.win and vim.api.nvim_win_is_valid(view.win) end

--- The key that acts on `row` and what it does, as the right-hand column shows it.
local function hint(row)
  if row.state == 'undone' then return 'undone · u again redoes' end
  if row.undo then return row.state == 'applied' and 'accepted · u undo' or 'u undo' end
  if row.verdict == 'useful' then return '+ useful' end
  if row.verdict == 'dismissed' then return '- noise' end
  if row.remark then return '+ useful  - noise' end
  if row.answer then return 'you said ' .. row.answer end
  if row.kind == 'quiet' then return '⏎ why' end
  if row.more and (row.kind == 'ran' or row.kind == 'searched') then return '⏎ output' end
  if row.place then return '⏎ go' end
  if row.more then return '⏎ all' end
  return ''
end

local function statusline(title, right)
  local escape = function(text) return (text:gsub('%%', '%%%%')) end
  return ('%%#PairStatus#%s %%#PairStatusDim#pair · %s%%=%s '):format(style.glyphs.voice, escape(title), escape(right or ''))
end

local function scratch(name, filetype)
  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_name(buf, name)
  vim.bo[buf].filetype = filetype
  vim.bo[buf].bufhidden = 'wipe'
  vim.bo[buf].modifiable = false
  return buf
end

local function set_lines(buf, lines)
  vim.bo[buf].modifiable = true
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.bo[buf].modifiable = false
end

--- The row the cursor is on in the list, if the list shows.
local function current_row()
  if not valid_win() or vim.api.nvim_win_get_buf(view.win) ~= view.buf then return nil end
  return view.rows[vim.api.nvim_win_get_cursor(view.win)[1]]
end

--- `text` cut to `width` columns, with an ellipsis when it is cut.
local function fit(text, width)
  if vim.fn.strdisplaywidth(text) <= width then return text end
  local chars = vim.fn.strchars(text)
  while chars > 0 and vim.fn.strdisplaywidth(vim.fn.strcharpart(text, 0, chars)) > width - 1 do chars = chars - 1 end
  return vim.fn.strcharpart(text, 0, chars) .. '…'
end

--- The list in its buffer: one line a row, its words cut to leave room for the key on the right.
local function render()
  local buf = view.buf
  local width = valid_win() and vim.api.nvim_win_get_width(view.win) or vim.o.columns
  local lines, marks = {}, {}
  for i, row in ipairs(view.rows) do
    local head = row.time .. '  ' .. row.label .. string.rep(' ', math.max(1, LABEL_WIDTH - vim.fn.strdisplaywidth(row.label)))
    local glyph = row.result == 'pass' and style.glyphs.pass or row.result == 'fail' and style.glyphs.fail or nil
    local tail = (row.note or glyph) and '   ' .. (glyph and glyph .. ' ' or '') .. (row.note or '') or ''
    local key = hint(row)
    local room = width - vim.fn.strdisplaywidth(head .. tail .. key) - 2
    local line = head .. fit(row.text, math.max(12, room))
    local text_end = #line
    line = line .. tail
    lines[i] = line
    table.insert(marks, {i - 1, 0, {end_col = #row.time, hl_group = 'PairKey'}})
    table.insert(marks, {i - 1, #row.time + 2, {end_col = #row.time + 2 + #row.label, hl_group = 'PairAccent'}})
    if glyph then
      local at = text_end + 3
      table.insert(marks, {i - 1, at, {end_col = at + #glyph, hl_group = row.result == 'pass' and 'PairStatusPass' or 'PairFail'}})
    end
    if row.note then table.insert(marks, {i - 1, #line - #row.note, {end_col = #line, hl_group = 'PairKey'}}) end
    if row.state == 'undone' then table.insert(marks, {i - 1, #row.time + 2, {end_col = text_end, hl_group = 'PairSuggestDelete', priority = 210}}) end
    table.insert(marks, {i - 1, 0, {virt_text = {{key, 'PairKey'}}, virt_text_pos = 'right_align'}})
  end
  if #lines == 0 then
    lines = {'Pair has done nothing here today.'}
    table.insert(marks, {0, 0, {end_col = #lines[1], hl_group = 'PairKey'}})
  end
  view.generated_line = nil
  local generated = view.generated
  if generated and (generated.lines or 0) > 0 then
    local files = #generated.files
    local line = ('%s not yours yet: %d file%s · %d line%s'):format(style.glyphs.generated, files, files == 1 and '' or 's', generated.lines, generated.lines == 1 and '' or 's')
    table.insert(lines, line)
    view.generated_line = #lines
    table.insert(marks, {#lines - 1, 0, {end_col = #style.glyphs.generated, hl_group = 'PairGenerated'}})
    table.insert(marks, {#lines - 1, 0, {virt_text = {{'o owns one · O owns all · ⏎ goes there', 'PairKey'}}, virt_text_pos = 'right_align'}})
  end
  set_lines(buf, lines)
  vim.api.nvim_buf_clear_namespace(buf, M.ns, 0, -1)
  for _, mark in ipairs(marks) do vim.api.nvim_buf_set_extmark(buf, M.ns, mark[1], mark[2], mark[3]) end
end

--- A window to go to from the list: the one it was opened from, else another one in this tab page.
local function work_window()
  if view.from and vim.api.nvim_win_is_valid(view.from) and view.from ~= view.win then return view.from end
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if win ~= view.win and vim.api.nvim_win_get_config(win).relative == '' then return win end
  end
end

local function go(place)
  local win = work_window()
  if win then vim.api.nvim_set_current_win(win) else vim.cmd('aboveleft split') end
  vim.cmd('edit ' .. vim.fn.fnameescape(vim.fn.fnamemodify(place.file, ':.')))
  pcall(vim.api.nvim_win_set_cursor, 0, {place.line, 0})
  vim.cmd('normal! zz')
end

local function show_list()
  if not valid_win() then return end
  vim.api.nvim_win_set_buf(view.win, view.buf)
  vim.wo[view.win].statusline = statusline('today', view.summary)
end

--- Whether the cursor is on the line of code not yours yet.
local function on_generated()
  return view.generated_line and valid_win() and vim.api.nvim_win_get_buf(view.win) == view.buf
    and vim.api.nvim_win_get_cursor(view.win)[1] == view.generated_line
end

--- Picks one of the files with code not yours yet (the only one, without asking), then `run(file)`.
local function pick_generated(prompt, run)
  local files = view.generated and view.generated.files or {}
  if #files == 1 then return run(files[1]) end
  vim.ui.select(files, {
    prompt = prompt,
    format_item = function(file)
      -- Where it came from: gen #3, or the board task you kept it from in a review (BDY-80).
      local gens = table.concat(file.from or vim.tbl_map(function(n) return 'gen #' .. n end, file.gens or {}), ', ')
      return ('%s · %d line%s · %s'):format(file.name, file.lines, file.lines == 1 and '' or 's', gens)
    end,
  }, function(file) if file then run(file) end end)
end

--- `o` and `O` on the line of code not yours yet: one file of it is yours, or all of it.
local function own(all)
  if not on_generated() then return end
  if all then return M.send({type = 'gen_own', all = true}) end
  pick_generated('Make yours', function(file) M.send({type = 'gen_own', file = file.file}) end)
end

--- <CR> on a row: go where it points, or open what it holds.
local function act()
  if on_generated() then return pick_generated('Go to code not yours yet', go) end
  local row = current_row()
  if not row then return end
  local opens = row.kind == 'quiet' or ((row.kind == 'ran' or row.kind == 'searched') and row.more)
  if row.place and not opens then return go(row.place) end
  if row.more then M.send({type = 'ledger_detail', ids = row.ids}) end
end

local function undo()
  local row = current_row()
  if row and row.undo then M.send({type = 'undo', action = row.id}) end
end

local function rate(useful)
  local row = current_row()
  if not (row and row.remark) then return end
  M.rate(useful, row.remark)
  M.send({type = 'today'})
end

local function list_buffer()
  local buf = scratch('pair://today', 'pairledger')
  vim.bo[buf].bufhidden = 'hide' -- what an entry opens to shows in its window meanwhile
  local function map(key, run, desc) vim.keymap.set('n', key, run, {buffer = buf, nowait = true, desc = desc}) end
  map('<CR>', act, 'Go there, or open what Pair did')
  map('u', undo, 'Undo Pair\'s edit, or make it again')
  map('+', function() rate(true) end, 'Pair\'s remark was useful')
  map('-', function() rate(false) end, 'Pair\'s remark was noise')
  map('o', function() own(false) end, 'Make the generated code of one file yours')
  map('O', function() own(true) end, 'Make all generated code yours')
  map('q', function() M.close() end, 'Close the ledger')
  -- Each line is cut to the window's width.
  vim.api.nvim_create_autocmd({'WinResized', 'VimResized'}, {group = vim.api.nvim_create_augroup('pair_ledger', {clear = true}), callback = function()
    if valid_win() and vim.api.nvim_buf_is_valid(buf) then render() end
  end})
  return buf
end

--- Opens the list, or goes to it, and asks the daemon for today's entries.
function M.open()
  if not (view.buf and vim.api.nvim_buf_is_valid(view.buf)) then view.buf = list_buffer() end
  if valid_win() then
    show_list()
    vim.api.nvim_set_current_win(view.win)
  else
    view.from = vim.api.nvim_get_current_win()
    vim.cmd('botright ' .. math.min(MAX_HEIGHT, math.max(3, #view.rows + 1)) .. 'split')
    view.win = vim.api.nvim_get_current_win()
    vim.api.nvim_win_set_buf(view.win, view.buf)
    for option, value in pairs({number = false, relativenumber = false, signcolumn = 'no', foldcolumn = '0', cursorline = true, wrap = false, winfixheight = true, list = false, spell = false}) do
      vim.wo[view.win][option] = value
    end
    vim.wo[view.win].statusline = statusline('today', view.summary)
    view.opened = true
  end
  M.send({type = 'today'})
end

function M.close()
  if valid_win() and #vim.api.nvim_tabpage_list_wins(0) > 1 then vim.api.nvim_win_close(view.win, true) end
  view.win = nil
end

--- Today's list from the daemon: {rows, summary}. The cursor stays on its entry, or goes to the newest.
function M.show(message)
  if not (view.buf and vim.api.nvim_buf_is_valid(view.buf)) then return end
  local at = current_row()
  view.rows, view.summary = message.rows or {}, message.summary or ''
  view.generated = type(message.generated) == 'table' and message.generated or nil
  render()
  if not valid_win() then return end
  if vim.api.nvim_win_get_buf(view.win) == view.buf then vim.wo[view.win].statusline = statusline('today', view.summary) end
  local line = #view.rows
  for i, row in ipairs(view.rows) do
    if at and not view.opened and vim.tbl_contains(row.ids, at.id) then line = i end
  end
  view.opened = false
  -- A list that grew past its window gets the room it needs, up to MAX_HEIGHT.
  local height = math.min(MAX_HEIGHT, math.max(3, #view.rows + (view.generated_line and 1 or 0)))
  if vim.api.nvim_win_get_height(view.win) < height then pcall(vim.api.nvim_win_set_height, view.win, height) end
  -- On the label, where the eye reads what Pair did.
  if vim.api.nvim_win_get_buf(view.win) == view.buf then pcall(vim.api.nvim_win_set_cursor, view.win, {math.max(line, 1), 7}) end
end

--- What an entry opens to, in the list's window; `q` goes back to the list.
function M.detail(message)
  local detail = type(message.detail) == 'table' and message.detail or nil
  if not (detail and valid_win()) then return end
  local buf = scratch('pair://today/' .. table.concat(message.ids or {}, ','), 'pairledgerdetail')
  set_lines(buf, vim.split(detail.text, '\n', {plain = true}))
  for _, key in ipairs({'q', '<BS>'}) do vim.keymap.set('n', key, show_list, {buffer = buf, nowait = true, desc = 'Back to the ledger'}) end
  vim.api.nvim_win_set_buf(view.win, buf)
  vim.wo[view.win].statusline = statusline(detail.title, 'q back')
  vim.api.nvim_set_current_win(view.win)
end

--- The daemon booked something, or changed an entry: an open list asks for itself again, once for a burst.
function M.changed()
  if not valid_win() then return end
  view.refresh = view.refresh or vim.uv.new_timer()
  view.refresh:start(150, 0, vim.schedule_wrap(function() M.send({type = 'today'}) end))
end

return M
