-- Pair without herdr, inside Neovim (docs/neovim.md#without-herdr): Pair's own pane as a :terminal buffer along the
-- bottom, where Scout's commands and the tests on save run in plain sight (src/pane-hosts.mjs); your own :terminal
-- buffers, where the Driver's `type` can go after your yes; and the chat as a terminal buffer on the right.
-- Pair types only into its own pane, and into one of yours only what the daemon asks after your yes, never Enter.
local M = {}

local PANE_HEIGHT = 12
local CHAT_WIDTH = 60
local SCRIPT = vim.fs.joinpath(vim.fs.dirname(vim.fs.dirname(vim.fs.dirname(debug.getinfo(1, 'S').source:sub(2)))), 'bin', 'pair.mjs')

local function running(buf)
  if not vim.api.nvim_buf_is_valid(buf) or vim.bo[buf].buftype ~= 'terminal' then return false end
  local channel = vim.bo[buf].channel
  return channel > 0 and vim.fn.jobwait({channel}, 0)[1] == -1
end

local function is_pane(buf) return running(buf) and vim.b[buf].pair_pane == true end
local function is_chat(buf) return vim.api.nvim_buf_is_valid(buf) and vim.b[buf].pair_chat == true end

--- Whether `buf` is one of your own terminals: a running :terminal that is neither Pair's pane nor the chat.
function M.is_yours(buf)
  return running(buf) and not vim.b[buf].pair_pane and not is_chat(buf)
end

--- The name the daemon knows terminal `buf` of this Neovim by, and that the chat names it by after "nvim:".
function M.id(buf) return ('nvim:%d:%d'):format(vim.fn.getpid(), buf) end

--- Runs `cmd` in a new terminal buffer marked `mark`, in a window that `split` opens, and comes back to the window
--- you were in unless `stay`. The buffer, or nil and why not.
local function terminal(split, cmd, opts, mark, stay)
  local back = vim.api.nvim_get_current_win()
  vim.cmd(split)
  local buf = vim.api.nvim_get_current_buf()
  vim.b[buf][mark] = true -- before the job starts: its TermOpen is not one of your terminals opening
  local ok, job = pcall(vim.fn.jobstart, cmd, vim.tbl_extend('force', opts, {term = true}))
  if not stay then vim.api.nvim_set_current_win(back) end
  if not ok or job <= 0 then
    vim.api.nvim_buf_delete(buf, {force = true})
    return nil, ok and 'the shell did not start' or tostring(job)
  end
  vim.bo[buf].bufhidden = 'hide' -- closing its window leaves it running; the pane is gone only when Pair closes it
  vim.bo[buf].buflisted = false
  return buf
end

local actions = {
  open = function(message)
    local buf, why = terminal('botright ' .. PANE_HEIGHT .. 'new', {'sh', '-c', message.line}, {cwd = message.cwd}, 'pair_pane')
    return buf and {buf = buf} or {error = why}
  end,
  has = function(message) return {open = is_pane(message.buf)} end,
  find = function()
    for _, buf in ipairs(vim.api.nvim_list_bufs()) do
      if is_pane(buf) then return {buf = buf} end
    end
    return {}
  end,
  send = function(message)
    if not is_pane(message.buf) then return {ok = false} end
    vim.fn.chansend(vim.bo[message.buf].channel, message.text)
    return {ok = true}
  end,
  close = function(message)
    if vim.api.nvim_buf_is_valid(message.buf) and vim.b[message.buf].pair_pane then vim.api.nvim_buf_delete(message.buf, {force = true}) end
    return {ok = true}
  end,
}

--- The daemon's requests about Pair's pane in this Neovim; `reply(result)` answers.
function M.request(message, reply)
  local action = actions[message.action]
  reply(action and action(message) or {error = 'unknown pane action ' .. tostring(message.action)})
end

--- Your terminals in this Neovim, the one you were in last first: {pane, name}.
function M.terminals()
  local list = {}
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if M.is_yours(buf) then table.insert(list, {pane = M.id(buf), name = 'nvim:' .. buf, used = vim.fn.getbufinfo(buf)[1].lastused}) end
  end
  table.sort(list, function(a, b) return a.used > b.used end)
  for _, item in ipairs(list) do item.used = nil end
  return list
end

--- Types `text` (one line, without Enter, checked by the daemon) at the prompt of your terminal `buf`.
function M.type(buf, text)
  if not M.is_yours(buf) then return {error = 'that is not one of your terminals here'} end
  vim.fn.chansend(vim.bo[buf].channel, text)
  return {ok = true}
end

--- Opens the chat (`pair chat`) in a terminal buffer on the right, or goes to the one that is open, connected to
--- `socket` and outside herdr: its pane would be this Neovim's.
function M.chat(socket)
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if is_chat(buf) and running(buf) then
      local win = vim.fn.bufwinid(buf)
      if win ~= -1 then vim.api.nvim_set_current_win(win) else vim.cmd('botright vertical ' .. CHAT_WIDTH .. 'split | buffer ' .. buf) end
      return vim.cmd.startinsert()
    end
  end
  local env = {PAIR_SOCKET = socket, HERDR_ENV = '', HERDR_SOCKET_PATH = '', HERDR_PANE_ID = '', HERDR_WORKSPACE_ID = ''}
  local buf, why = terminal('botright vertical ' .. CHAT_WIDTH .. 'new', {SCRIPT, 'chat'}, {cwd = vim.fn.getcwd(), env = env}, 'pair_chat', true)
  if not buf then return vim.notify('Pair: the chat did not start: ' .. why, vim.log.levels.ERROR) end
  vim.cmd.startinsert()
end

return M
