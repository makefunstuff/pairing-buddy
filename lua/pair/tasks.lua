-- :Pair tasks, only when you ask: the work in a note as a list, in a panel over it. Nothing is added anywhere until
-- you press y: then the daemon runs your task command for each one, or, without one, they are copied as a Markdown
-- checklist for you to paste. e lets you edit the list first; q or Esc closes it.
local M = {}

local ns = vim.api.nvim_create_namespace('pair_tasks')

local panel = nil -- {buf, win, message}

local function close()
  if panel and vim.api.nvim_win_is_valid(panel.win) then vim.api.nvim_win_close(panel.win, true) end
  panel = nil
end

--- The tasks as the panel's lines say now: a number and a title, then the lines they come from, indented.
local function listed(buf)
  local tasks = {}
  for _, line in ipairs(vim.api.nvim_buf_get_lines(buf, 0, -1, false)) do
    local title = line:match('^%s*%d+%s+(.-)%s*$')
    local source = line:match('^%s%s%s+(%S.-)%s*$')
    if title and title ~= '' then
      table.insert(tasks, {title = title, lines = ''})
    elseif source and tasks[#tasks] then
      tasks[#tasks].lines = source
    end
  end
  return tasks
end

local function yes(send)
  local message = panel.message
  local tasks = listed(panel.buf)
  close()
  if #tasks == 0 then return vim.notify('Pair: no tasks left in the list') end
  if message.adds then
    send({type = 'tasks_add', file = message.file, tasks = tasks})
    return vim.notify(('Pair: adding %d task%s with %s'):format(#tasks, #tasks == 1 and '' or 's', message.adds))
  end
  local lines = {}
  for _, task in ipairs(tasks) do
    table.insert(lines, ('- [ ] %s%s'):format(task.title, task.lines ~= '' and (' (' .. task.lines .. ')') or ''))
  end
  vim.fn.setreg('"', lines, 'l')
  vim.notify(('Pair: %d task%s copied as a checklist; p pastes them'):format(#lines, #lines == 1 and '' or 's'))
end

--- Shows the daemon's tasks for a note; `send` sends the yes to the daemon.
function M.show(message, send)
  close()
  if type(message.adds) ~= 'string' then message.adds = nil end -- JSON null arrives as vim.NIL
  local lines, marks = {('From %s, as you asked. Nothing is added until you say so.'):format(message.name), ''}, {}
  table.insert(marks, {0, 'PairKey'})
  for i, task in ipairs(message.tasks or {}) do
    table.insert(lines, ('%-2d %s'):format(i, task.title))
    table.insert(marks, {#lines - 1, 'PairAccent', 0, 2})
    local source = task.open and ('open question, ' .. task.lines) or task.lines
    if source ~= '' then
      table.insert(lines, '   ' .. source)
      table.insert(marks, {#lines - 1, 'PairKey'})
    end
  end
  local adds = message.adds and ('y adds them (%s)'):format(message.adds) or 'y copies them as a checklist'
  vim.list_extend(lines, {'', adds .. ' · e edits the list · q cancels'})
  table.insert(marks, {#lines - 1, 'PairKey'})

  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  for _, mark in ipairs(marks) do
    local row, group, from, to = unpack(mark)
    vim.api.nvim_buf_set_extmark(buf, ns, row, from or 0, {end_col = to or #lines[row + 1], hl_group = group})
  end
  vim.bo[buf].modifiable = false
  vim.bo[buf].bufhidden = 'wipe'
  local width = 0
  for _, line in ipairs(lines) do width = math.max(width, vim.fn.strdisplaywidth(line)) end
  width = math.min(width + 1, vim.o.columns - 4)
  local win = vim.api.nvim_open_win(buf, true, {
    relative = 'editor', style = 'minimal', border = 'solid', title = ' :Pair tasks ', title_pos = 'left',
    width = width, height = #lines, row = math.max(0, math.floor((vim.o.lines - #lines) / 2) - 2), col = math.floor((vim.o.columns - width) / 2),
  })
  vim.wo[win].wrap = true
  panel = {buf = buf, win = win, message = message}
  local function map(key, run) vim.keymap.set('n', key, run, {buffer = buf, nowait = true}) end
  map('y', function() yes(send) end)
  map('e', function()
    vim.bo[buf].modifiable = true
    vim.notify('Pair: edit the titles, then y')
  end)
  map('q', close)
  map('<Esc>', close)
  vim.api.nvim_create_autocmd('WinLeave', {buffer = buf, once = true, callback = close})
end

return M
