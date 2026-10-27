-- :Pair runs: the lab notebook of exploratory coding. Every build and run of the session, newest last, each with the
-- change you made before it, the number it is known by, how long it said it took, how many lines your debug prints
-- printed in it, and what it showed next to the run before. ⏎ shows a run's output, d the change before it; x
-- removes the debug lines you added for the hunt that are still in the code (unsaved, u in each buffer brings them
-- back); q closes.
local M = {}

local ns = vim.api.nvim_create_namespace('pair_runs')
local panel = nil -- {win, buf, message, view} while it shows; view is 'list' or a run's output or change
local CHANGE_WIDTH = 44

local function plural(n, noun) return ('%d %s%s'):format(n, noun, n == 1 and '' or 's') end

--- Pads `text` with spaces to `width` display columns, cutting it with … when it is longer.
local function fit(text, width)
  if vim.fn.strdisplaywidth(text) > width then text = vim.fn.strcharpart(text, 0, width - 1) .. '…' end
  return text .. string.rep(' ', width - vim.fn.strdisplaywidth(text))
end

local function said_group(kind)
  if kind == 'crash' or kind == 'error' then return 'PairFail' end
  if kind == 'same' or kind == 'moved' then return 'PairAccent' end
  return 'PairKey'
end

--- The columns of one run, as {text, group} chunks.
local function columns(run)
  return {
    {tostring(run.n), 'PairKey'},
    {run.change}, -- in the panel's own colour: what you typed
    {run.number, 'PairNote'},
    {run.time, 'PairNote'},
    {run.printed > 0 and (run.printed .. ' printed') or '', 'PairKey'},
    {run.said, said_group(run.kind)},
  }
end

--- Lines of {text, group} chunks for the list; the columns line up.
local function list_lines(message)
  local rows = vim.tbl_map(columns, message.runs or {})
  local widths = {}
  for _, row in ipairs(rows) do
    for i, chunk in ipairs(row) do widths[i] = math.max(widths[i] or 0, vim.fn.strdisplaywidth(chunk[1])) end
  end
  widths[2] = math.min(widths[2] or 0, CHANGE_WIDTH)
  local lines = {{{'This session, newest last. The pair keeps it; you keep coding.', 'PairNote'}}, {}}
  for _, row in ipairs(rows) do
    local line = {}
    for i, chunk in ipairs(row) do
      table.insert(line, {i < #row and fit(chunk[1], widths[i]) .. '  ' or chunk[1], chunk[2]})
    end
    table.insert(lines, line)
  end
  if #rows == 0 then table.insert(lines, {{'No build or run yet in this session.', 'PairKey'}}) end
  table.insert(lines, {})
  local keys = #rows > 0 and '⏎ shows a run\'s output · d its change · ' or ''
  local debug = #(message.debug or {})
  if debug > 0 then keys = keys .. ('x removes %s · '):format(plural(debug, 'debug line')) end
  table.insert(lines, {{keys .. 'q closes', 'PairKey'}})
  return lines
end

local function text_lines(text, empty)
  local lines = {}
  for line in ((text ~= '' and text or empty) .. '\n'):gmatch('(.-)\n') do table.insert(lines, {{line}}) end
  table.insert(lines, {})
  table.insert(lines, {{'⏎ or q back to the runs', 'PairKey'}})
  return lines
end

--- Fills the panel with `lines` of chunks, sized to them, titled `title`.
local function fill(lines, title)
  local texts, width = {}, 0
  for _, line in ipairs(lines) do
    local text = table.concat(vim.tbl_map(function(chunk) return chunk[1] end, line))
    table.insert(texts, text)
    width = math.max(width, vim.fn.strdisplaywidth(text))
  end
  local buf = panel.buf
  vim.bo[buf].modifiable = true
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, texts)
  vim.bo[buf].modifiable = false
  vim.api.nvim_buf_clear_namespace(buf, ns, 0, -1)
  for row, line in ipairs(lines) do
    local col = 0
    for _, chunk in ipairs(line) do
      if chunk[2] then vim.api.nvim_buf_set_extmark(buf, ns, row - 1, col, {end_col = col + #chunk[1], hl_group = chunk[2]}) end
      col = col + #chunk[1]
    end
  end
  width = math.min(math.max(width, 20), vim.o.columns - 6)
  local height = math.min(#texts, vim.o.lines - 6)
  vim.api.nvim_win_set_config(panel.win, {
    relative = 'editor', row = math.max(1, math.floor((vim.o.lines - height) / 3)), col = math.floor((vim.o.columns - width) / 2) - 1,
    width = width, height = height, title = {{' ' .. title .. ' ', 'PairAccent'}}, title_pos = 'left',
  })
end

local function show_list()
  panel.view = 'list'
  fill(list_lines(panel.message), ':Pair runs')
  local count = #(panel.message.runs or {})
  if count > 0 then vim.api.nvim_win_set_cursor(panel.win, {2 + count, 0}) end -- the newest run
end

--- The run on the cursor's line of the list, or nil.
local function run_at_cursor()
  local index = vim.api.nvim_win_get_cursor(panel.win)[1] - 2
  return (panel.message.runs or {})[index]
end

local function show_run(field)
  if panel.view ~= 'list' then return show_list() end
  local run = run_at_cursor()
  if not run then return end
  panel.view = field
  if field == 'output' then fill(text_lines(run.output, '(no output)'), (':Pair runs · run %d · %s'):format(run.n, run.cmd))
  else fill(text_lines(run.changes, '(no change before this run)'), (':Pair runs · run %d · the change before it'):format(run.n)) end
  vim.api.nvim_win_set_cursor(panel.win, {1, 0})
end

--- Removes each debug line ({file, line, text}) from its buffer, where it is now: one undo step per buffer, unsaved.
--- Returns how many it removed.
function M.remove(debug)
  local rows = {} -- buf -> rows to delete
  for _, item in ipairs(debug) do
    local buf = vim.fn.bufadd(item.file)
    vim.fn.bufload(buf)
    local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
    local best
    for i, line in ipairs(lines) do
      if vim.trim(line) == item.text and (not best or math.abs(i - item.line) < math.abs(best - item.line)) then best = i end
    end
    if best then
      vim.bo[buf].buflisted = true -- changed and unsaved: it shows in your buffer list
      rows[buf] = rows[buf] or {}
      table.insert(rows[buf], best)
    end
  end
  local removed = 0
  for buf, list in pairs(rows) do
    table.sort(list, function(a, b) return a > b end) -- from the bottom: the rows above stay where they are
    for _, row in ipairs(list) do
      vim.api.nvim_buf_set_lines(buf, row - 1, row, false, {})
      removed = removed + 1
    end
  end
  return removed
end

function M.close()
  if panel and vim.api.nvim_win_is_valid(panel.win) then vim.api.nvim_win_close(panel.win, true) end
  panel = nil
end

--- Shows the daemon's answer to :Pair runs. `removed(count)` hears of debug lines removed with x.
function M.show(message, removed)
  M.close()
  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].bufhidden = 'wipe'
  local win = vim.api.nvim_open_win(buf, true, {
    relative = 'editor', row = 1, col = 1, width = 20, height = 1, style = 'minimal', border = 'solid',
  })
  vim.wo[win].cursorline = true
  panel = {win = win, buf = buf, message = message, view = 'list'}
  show_list()
  local function key(lhs, run) vim.keymap.set('n', lhs, run, {buffer = buf, nowait = true}) end
  key('<CR>', function() show_run('output') end)
  key('d', function() show_run('changes') end)
  key('q', function() if panel.view == 'list' then M.close() else show_list() end end)
  key('<Esc>', M.close)
  key('x', function()
    local debug = panel.message.debug or {}
    if #debug == 0 then return end
    local count = M.remove(debug)
    panel.message.debug = {}
    show_list()
    removed(count)
  end)
  vim.api.nvim_create_autocmd('WinLeave', {buffer = buf, once = true, callback = M.close})
end

return M
