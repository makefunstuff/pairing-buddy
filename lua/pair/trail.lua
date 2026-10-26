-- :Pair trail: what the pair saw you look for since your last edit, oldest first, in its visual language. The same
-- lines go to the model with a trail remark, and nothing else of your searches does; x forgets them.
local M = {}

local ns = vim.api.nvim_create_namespace('pair_trail')
local panel = nil -- {win, buf} while it shows

local function plural(n, noun) return ('%d %s%s'):format(n, noun, n == 1 and '' or 's') end

--- Pads `text` with spaces to `width` display columns.
local function pad(text, width) return text .. string.rep(' ', width - vim.fn.strdisplaywidth(text)) end

--- The columns of one search, as {text, group} chunks; the file is relative to the project.
local function columns(search)
  local results = type(search.results) == 'number' and plural(search.results, 'result') or ''
  local where = type(search.file) == 'string' and {'→ ' .. search.file, 'PairAccent'}
    or {'closed, nothing opened', 'PairKey'}
  return {
    {('+ %2ds'):format(math.floor(search.after / 1000 + 0.5)), 'PairKey'},
    {search.picker, 'PairNote'},
    {('"%s"'):format(search.query)}, -- in the panel's own colour
    {results, 'PairKey'},
    where,
  }
end

--- Lines of {text, group} chunks for the panel; the search columns line up.
local function layout(message)
  local rows = vim.tbl_map(columns, message.searches or {})
  local widths = {}
  for _, row in ipairs(rows) do
    for i, chunk in ipairs(row) do widths[i] = math.max(widths[i] or 0, vim.fn.strdisplaywidth(chunk[1])) end
  end
  local lines = {{{'What the pair saw you look for, oldest first', 'PairNote'}}, {}}
  for _, row in ipairs(rows) do
    local line = {}
    for i, chunk in ipairs(row) do
      table.insert(line, {i < #row and pad(chunk[1], widths[i]) .. '  ' or chunk[1], chunk[2]})
    end
    table.insert(lines, line)
  end
  if #rows > 0 then table.insert(lines, {}) end
  table.insert(lines, {{message.summary or '', 'PairNote'}})
  if type(message.verdict) == 'string' then table.insert(lines, {{message.verdict, 'PairNote'}}) end
  table.insert(lines, {{#rows > 0 and 'q closes · x forgets this trail' or 'q closes', 'PairKey'}})
  return lines
end

function M.close()
  if panel and vim.api.nvim_win_is_valid(panel.win) then vim.api.nvim_win_close(panel.win, true) end
  panel = nil
end

--- Shows the daemon's answer to :Pair trail; `forget()` asks it to forget the trail.
function M.show(message, forget)
  M.close()
  local lines = layout(message)
  local texts, width = {}, 0
  for _, line in ipairs(lines) do
    local text = table.concat(vim.tbl_map(function(chunk) return chunk[1] end, line))
    table.insert(texts, text)
    width = math.max(width, vim.fn.strdisplaywidth(text))
  end
  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, texts)
  for row, line in ipairs(lines) do
    local col = 0
    for _, chunk in ipairs(line) do
      if chunk[2] then vim.api.nvim_buf_set_extmark(buf, ns, row - 1, col, {end_col = col + #chunk[1], hl_group = chunk[2]}) end
      col = col + #chunk[1]
    end
  end
  vim.bo[buf].modifiable = false
  vim.bo[buf].bufhidden = 'wipe'
  width = math.min(width, vim.o.columns - 6)
  local win = vim.api.nvim_open_win(buf, true, {
    relative = 'editor', row = math.max(1, math.floor((vim.o.lines - #texts) / 3)), col = math.floor((vim.o.columns - width) / 2) - 1,
    width = width, height = #texts, style = 'minimal', border = 'solid', title = {{' :Pair trail ', 'PairAccent'}}, title_pos = 'left',
  })
  panel = {win = win, buf = buf}
  local function key(lhs, run) vim.keymap.set('n', lhs, run, {buffer = buf, nowait = true}) end
  key('q', M.close)
  key('<Esc>', M.close)
  if #(message.searches or {}) > 0 then
    key('x', function()
      forget()
      M.close()
      vim.notify('Pair: forgot the trail')
    end)
  end
  vim.api.nvim_create_autocmd('WinLeave', {buffer = buf, once = true, callback = M.close})
end

return M
