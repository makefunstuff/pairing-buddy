-- The day's end debrief in Neovim, when no chat pane shows it: a panel in the pair's visual language, the heading
-- dim, what is now true in the accent, what is left and tomorrow's first step in the note's colour. q closes it.
local M = {}

local ns = vim.api.nvim_create_namespace('pair_debrief')
local panel = nil -- {win, buf} while it shows

--- The highlight group of one line of the debrief.
local function group(line, first)
  if first then return 'PairKey' end
  if line:match('^✓') then return 'PairAccent' end
  return 'PairNote'
end

function M.close()
  if panel and vim.api.nvim_win_is_valid(panel.win) then vim.api.nvim_win_close(panel.win, true) end
  panel = nil
end

--- Shows the debrief `text`: its lines, then the keys.
function M.show(text)
  M.close()
  local lines = vim.split(text, '\n', {trimempty = true})
  table.insert(lines, '')
  table.insert(lines, 'q closes · :Pair first <step> changes tomorrow\'s first step')
  local width = 0
  for _, line in ipairs(lines) do width = math.max(width, vim.fn.strdisplaywidth(line)) end
  width = math.min(width, vim.o.columns - 6)
  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  for row, line in ipairs(lines) do
    local hl = row == #lines and 'PairKey' or group(line, row == 1)
    vim.api.nvim_buf_set_extmark(buf, ns, row - 1, 0, {end_col = #line, hl_group = hl})
  end
  vim.bo[buf].modifiable = false
  vim.bo[buf].bufhidden = 'wipe'
  local win = vim.api.nvim_open_win(buf, true, {
    relative = 'editor', row = math.max(1, math.floor((vim.o.lines - #lines) / 3)), col = math.floor((vim.o.columns - width) / 2) - 1,
    width = width, height = #lines, style = 'minimal', border = 'solid', title = {{' the day\'s end ', 'PairAccent'}}, title_pos = 'left',
  })
  vim.wo[win].wrap = true
  panel = {win = win, buf = buf}
  for _, lhs in ipairs({'q', '<Esc>'}) do vim.keymap.set('n', lhs, M.close, {buffer = buf, nowait = true}) end
  vim.api.nvim_create_autocmd('WinLeave', {buffer = buf, once = true, callback = M.close})
end

return M
