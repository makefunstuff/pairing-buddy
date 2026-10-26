-- Notes in the margin of a Markdown note: at most five marks the daemon sends (see src/margin.mjs), each a glyph
-- in the sign column and a line of the pair's words under the line it is about. You change that line, or the
-- other line a contradiction names, and its mark goes. The decide key logs a decision in decisions.md next to
-- the note: the daemon writes the entry, this puts it in that file's buffer, unsaved, and shows it below.
local draw = require('pair.draw')
local style = require('pair.style')

local M = {}

local ns = vim.api.nvim_create_namespace('pair_margin')
local FLASH_MS = 6000 -- how long the statusline says a decision was logged
local NEAR = 20 -- a mark whose line moved this far or less still finds it

local config = {decide_key = '<M-d>', link_key = '<M-l>', send = function() end}
local marks = {} -- buf -> its marks: {kind, text, line_text, key, id, other, link}, `other` an extmark id
local mapped = {} -- buf -> the keys mapped there for its marks
local flash = nil -- {name, till}: the log a decision just went to

local function label(key) return key and (key:gsub('^<(.*)>$', '%1')) end

--- The row (0-based) of `buf` whose text is `text`, nearest to `row`; nil when it is gone.
local function find(buf, text, row)
  local count = vim.api.nvim_buf_line_count(buf)
  for d = 0, NEAR do
    for _, at in ipairs({row - d, row + d}) do
      if at >= 0 and at < count and vim.api.nvim_buf_get_lines(buf, at, at + 1, false)[1] == text then return at end
    end
  end
  return nil
end

--- What the dimmed key after a mark's words says: how to act on it, or where its other line is.
local function key_of(mark)
  if mark.kind == 'decision' then return config.decide_key and label(config.decide_key) .. ' logs it' or nil end
  if mark.kind == 'code' and mark.link then
    local name = vim.fn.fnamemodify(mark.link.name, ':t')
    return config.link_key and label(config.link_key) .. ' ' .. name or name
  end
  if mark.other then return 'line ' .. mark.other end
  return nil
end

local function erase(mark, buf)
  draw.erase(buf, {mark.id, mark.other_id}, ns)
end

local function sameness(mark) return mark.kind .. '\0' .. mark.text .. '\0' .. mark.line_text end

local function draw_mark(buf, mark, row, still)
  local glyph = style.glyphs[mark.kind] or style.glyphs.mark
  mark.id = draw.remark(buf, row, mark.text, mark.key, {ns = ns, glyph = glyph, sign = {glyph, 'PairSign'}, still = still})
end

--- Maps the decide and link keys in `buf` while it has marks they act on, where you have no mapping of your own.
local function map_keys(buf)
  for _, key in ipairs(mapped[buf] or {}) do pcall(vim.keymap.del, 'n', key, {buffer = buf}) end
  mapped[buf] = {}
  local wanted = {}
  for _, mark in ipairs(marks[buf] or {}) do
    if mark.kind == 'decision' then wanted[config.decide_key] = {M.decide, 'Log this decision (Pair)'} end
    if mark.link then wanted[config.link_key] = {M.link, 'Open the code this note names (Pair)'} end
  end
  for key, entry in pairs(wanted) do
    if key and key ~= '' and vim.fn.maparg(key, 'n') == '' then
      vim.keymap.set('n', key, entry[1], {buffer = buf, desc = entry[2]})
      table.insert(mapped[buf], key)
    end
  end
end

local function forget(buf, kept)
  for _, mark in ipairs(marks[buf] or {}) do
    if not vim.tbl_contains(kept, mark) then erase(mark, buf) end
  end
  marks[buf] = kept
  map_keys(buf)
end

--- The daemon's marks for a note: those already shown stay as they are, the others go, the new ones rise.
function M.show(message)
  local buf = vim.fn.bufnr(message.file)
  if buf == -1 or not vim.api.nvim_buf_is_loaded(buf) then return end
  local shown = {}
  for _, mark in ipairs(marks[buf] or {}) do
    if draw.row(buf, mark.id, ns) then shown[sameness(mark)] = mark end
  end
  local kept = {}
  for _, item in ipairs(message.marks or {}) do
    local row = find(buf, item.lineText, item.line - 1)
    local other_row = item.other and find(buf, item.otherText, item.other - 1)
    local link = type(item.link) == 'table' and item.link or nil
    local mark = {kind = item.kind, text = item.text, line_text = item.lineText, link = link, other = item.other}
    local old = shown[sameness(mark)]
    if old then
      table.insert(kept, old)
    elseif row and (not item.other or other_row) then
      mark.key = key_of(mark)
      draw_mark(buf, mark, row)
      if other_row then mark.other_id = vim.api.nvim_buf_set_extmark(buf, ns, other_row, 0, {}) end
      table.insert(kept, mark)
    end
  end
  forget(buf, kept)
  vim.cmd.redrawstatus()
end

--- Your edit of rows `first`..`last` of `buf`: a mark on them, or whose other line is there, goes.
function M.edited(buf, first, last)
  if not marks[buf] then return end
  local kept = {}
  for _, mark in ipairs(marks[buf]) do
    local rows = {draw.row(buf, mark.id, ns), mark.other_id and draw.row(buf, mark.other_id, ns)}
    local hit = false
    for _, row in pairs(rows) do
      if row and row >= first and row <= last then hit = true end
    end
    if not hit and rows[1] then table.insert(kept, mark) end
  end
  if #kept ~= #marks[buf] then forget(buf, kept) end
end

--- Places the marks again for the windows' new widths.
function M.relayout()
  for buf, list in pairs(marks) do
    for _, mark in ipairs(list) do
      local row = draw.row(buf, mark.id, ns)
      if row then
        draw.erase(buf, {mark.id}, ns)
        draw_mark(buf, mark, row, true)
      end
    end
  end
end

--- Takes every mark away, in every buffer.
function M.clear()
  for buf in pairs(marks) do
    if vim.api.nvim_buf_is_valid(buf) then forget(buf, {}) end
  end
  marks = {}
end

--- The statusline's words for the current buffer: "5 notes in the margin", or nil.
function M.status()
  local count = #(marks[vim.api.nvim_get_current_buf()] or {})
  if count == 0 then return nil end
  return ('%d note%s in the margin'):format(count, count == 1 and '' or 's')
end

--- The log a decision just went to, for the statusline a moment: its name, or nil.
function M.flash()
  return flash and vim.uv.now() < flash.till and flash.name or nil
end

--- The decide key: the decision on the cursor's line goes to the log.
function M.decide()
  local file = vim.api.nvim_buf_get_name(0)
  if file == '' then return end
  config.send({type = 'decision', file = vim.fn.fnamemodify(file, ':p'), line = vim.api.nvim_win_get_cursor(0)[1]})
end

--- The mark with a link on the cursor's line, else the nearest one: the link key opens its code in a split.
function M.link()
  local buf, row = vim.api.nvim_get_current_buf(), vim.api.nvim_win_get_cursor(0)[1] - 1
  local best, distance
  for _, mark in ipairs(marks[buf] or {}) do
    local at = draw.row(buf, mark.id, ns)
    if mark.link and at and (not distance or math.abs(at - row) < distance) then best, distance = mark, math.abs(at - row) end
  end
  if not best then return vim.notify('Pair: no mark here links to code') end
  vim.cmd('belowright split ' .. vim.fn.fnameescape(vim.fn.fnamemodify(best.link.file, ':.')))
  pcall(vim.api.nvim_win_set_cursor, 0, {best.link.line, 0})
  vim.cmd('normal! ^zz')
end

--- The daemon's next text of the decision log: into its buffer (you save it), shown at the new entry below the
--- note, which keeps your cursor.
function M.log(message)
  local buf = vim.fn.bufadd(vim.fn.fnamemodify(message.file, ':.'))
  vim.fn.bufload(buf)
  vim.bo[buf].buflisted = true
  local lines = vim.split(message.text, '\n', {plain = true})
  if lines[#lines] == '' then table.remove(lines) end
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  local win = vim.fn.bufwinid(buf)
  if win == -1 then
    local here = vim.api.nvim_get_current_win()
    vim.cmd('belowright 8split')
    win = vim.api.nvim_get_current_win()
    vim.api.nvim_win_set_buf(win, buf)
    vim.api.nvim_set_current_win(here)
  end
  pcall(vim.api.nvim_win_set_cursor, win, {message.line, 0})
  vim.api.nvim_win_call(win, function() vim.cmd('normal! zt') end)
  flash = {name = message.name, till = vim.uv.now() + FLASH_MS}
  vim.cmd.redrawstatus()
  vim.defer_fn(function() pcall(vim.cmd.redrawstatus) end, FLASH_MS + 50)
end

--- `opts`: decide_key, link_key, and `send`, which sends a message to the daemon.
function M.setup(opts)
  config = vim.tbl_extend('force', config, opts or {})
end

return M
