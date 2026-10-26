-- The blank page (:Pair new [idea]): the note NOTES.md, opened unsaved, and Pair's questions in it, one at a time,
-- each under the last line you wrote. You answer on the lines under the question; the answer goes once you have
-- left Insert mode and changed nothing for a moment, so an Esc to fix a typo sends the fixed answer. After the last one the daemon suggests the first slice in the note (init.lua shows it like any suggestion).
local draw = require('pair.draw')
local style = require('pair.style')

local M = {}

local NOTE = 'NOTES.md'
local SETTLE_MS = 1500 -- after Insert mode, how long an answer stays unchanged before it goes

-- The question waiting for its answer: {buf, id (its extmark), n}; nil when none is.
local asking = nil
-- Where the next question goes: an extmark on the last line of the answer just sent, {buf, id}. You may be typing
-- on below it by the time the question comes.
local answered = nil
local group = vim.api.nvim_create_augroup('pair_new', {clear = true}) -- the autocommands of the waiting question
local settle = vim.uv.new_timer()

local function forget()
  if asking then draw.erase(asking.buf, {asking.id}) end
  asking = nil
  settle:stop()
  vim.api.nvim_clear_autocmds({group = group})
end

local function forget_answered()
  if answered then draw.erase(answered.buf, {answered.id}) end
  answered = nil
end

--- The last row of `buf` with text on it (0-based): the question goes under it.
local function last_text_row(buf)
  local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
  for row = #lines, 1, -1 do
    if lines[row]:find('%S') then return row - 1 end
  end
  return 0
end

--- What you wrote under the question: its lines, without list dashes. Empty when nothing yet.
local function answer_of(buf, row)
  local lines = vim.api.nvim_buf_get_lines(buf, row + 1, -1, false)
  return vim.trim(table.concat(lines, '\n'))
end

--- Opens the note in this window, with `idea` under a heading named after the folder; the buffer is not saved.
--- Returns its buffer and absolute path.
local function open_note(idea)
  local path = vim.fn.getcwd() .. '/' .. NOTE
  local ok = pcall(vim.cmd.edit, vim.fn.fnameescape(path))
  if not ok then vim.cmd.split(vim.fn.fnameescape(path)) end -- this window's buffer has unsaved changes
  local buf = vim.api.nvim_get_current_buf()
  local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
  local empty = #lines == 1 and lines[1] == ''
  local added = {}
  if empty then added = {'# ' .. vim.fn.fnamemodify(vim.fn.getcwd(), ':t'), ''} end
  if idea ~= '' then
    if not empty and lines[#lines] ~= '' then table.insert(added, '') end
    table.insert(added, idea)
  end
  if #added > 0 then vim.api.nvim_buf_set_lines(buf, empty and 0 or -1, -1, false, added) end
  vim.api.nvim_win_set_cursor(0, {vim.api.nvim_buf_line_count(buf), 0})
  return buf, path
end

--- :Pair new: `send` reaches the daemon (init.lua's).
function M.start(idea, send)
  forget()
  forget_answered()
  local _, path = open_note(vim.trim(idea))
  send({type = 'new', idea = vim.trim(idea), file = path})
end

--- The daemon's interview message: a question to show (`n`, `text`), or `done`.
function M.on_interview(message, send)
  forget()
  if message.done then return forget_answered() end
  local buf = vim.fn.bufnr(message.file)
  if buf == -1 or not vim.api.nvim_buf_is_loaded(buf) then return end
  local after = answered and answered.buf == buf and draw.row(buf, answered.id)
  local row = after or last_text_row(buf)
  asking = {buf = buf, n = message.n, id = draw.remark(buf, row, message.text, nil, {sign = {style.glyphs.voice, 'PairSign'}})}
  local question = asking
  local function answer()
    if asking ~= question or vim.fn.mode():find('^[iR]') then return end
    local at = draw.row(buf, question.id)
    local text = at and answer_of(buf, at) or ''
    if text == '' then return end
    vim.api.nvim_clear_autocmds({group = group}) -- one answer per question
    forget_answered()
    answered = {buf = buf, id = vim.api.nvim_buf_set_extmark(buf, draw.ns, last_text_row(buf), 0, {})}
    send({type = 'answer', text = text})
  end
  local function wait() settle:start(SETTLE_MS, 0, vim.schedule_wrap(answer)) end
  -- Leaving Insert mode starts the wait; going back in, or a change in Normal mode (a typo fixed with x), restarts it.
  vim.api.nvim_create_autocmd('InsertLeave', {group = group, buffer = buf, callback = wait})
  vim.api.nvim_create_autocmd('TextChanged', {group = group, buffer = buf, callback = function()
    if settle:is_active() then wait() end
  end})
  vim.api.nvim_create_autocmd('InsertEnter', {group = group, buffer = buf, callback = function() settle:stop() end})
end

--- For the statusline: `question 2 of a few` while a question waits, else nil.
function M.status()
  if not asking then return nil end
  if asking.n == 0 then return 'what are we making' end
  return ('question %d of a few'):format(asking.n)
end

return M
