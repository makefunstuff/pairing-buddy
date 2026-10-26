-- Your other agents, in one place: the daemon relays their news (one needs you, one is ready to approve, one is
-- done) at your next breakpoint, as one line after Pair's own in the statusline, with the key that goes there.
-- Nothing opens and nothing takes your cursor: the key, or `:Pair agents` and Enter on a line, brings the agent's
-- herdr pane to the front.
local style = require('pair.style')

local M = {}

local MAX_WIDTH = 56 -- of the relayed line in the statusline; `:Pair agents` has it all
local NAME_WIDTH = 24 -- of the name column in the list

local host -- what init.lua lends: send, map_keys, unmap_keys, key_label, redraw_status
local key = '<M-a>'
local line = nil -- the relayed line: {item, text, more}

-- What each status looks like: the ones that need you in the accent, a failure in red, done quietly green.
local LOOKS = {
  needs = {'needs you', 'PairStatus'}, approve = {'ready to approve', 'PairStatus'}, failed = {'failed', 'PairFail'},
  done = {'done', 'PairStatusPass'}, working = {'working', 'PairKey'}, waiting = {'waiting', 'PairKey'},
}

local function words(item)
  if item.kind == 'agent' and item.status == 'done' then return 'idle' end
  return LOOKS[item.status][1]
end

local function cut(text, width)
  if vim.fn.strdisplaywidth(text) <= width then return text end
  return vim.fn.strcharpart(text, 0, width - 1) .. '…'
end

--- Brings the agent of `item` to the front in herdr.
local function go(item)
  host.send({type = 'agent_go', key = item.key})
end

--- Goes to the relayed agent, or, when it has no pane any more, puts the line away.
function M.go()
  if line then go(line.item) end
end

--- The daemon relays one line, or takes it back (`item` null) once it is answered or no longer true.
function M.on_relay(message)
  line = message.item ~= vim.NIL and message.item and {item = message.item, text = message.text, more = message.more or 0} or nil
  if line then
    host.map_keys('agents', {{key, M.go, 'Go to the agent Pair told you about'}})
  else
    host.unmap_keys('agents')
  end
  host.redraw_status()
end

--- The statusline part after Pair's own: {glyph, text, hl, text_hl}, or nil when nothing is relayed.
function M.status_parts()
  if not line then return nil end
  local text = cut(line.text, MAX_WIDTH)
  if line.more > 0 then text = text .. (' +%d'):format(line.more) end
  local label = host.key_label('agents', key)
  if label then text = text .. '  ' .. label end
  local look = LOOKS[line.item.status] or LOOKS.done
  return {glyph = style.glyphs.agents, text = text, hl = look[2], text_hl = 'PairStatusDim'}
end

-- `:Pair agents`: one list of every task and agent, the ones that need you first. Enter goes to the agent on the
-- line, q closes it.

local list_ns = vim.api.nvim_create_namespace('pair_agents')

local function show_list(items)
  local width, named = 0, 0
  for _, item in ipairs(items) do
    item.name = cut(item.name, NAME_WIDTH)
    width = math.max(width, #words(item))
    named = math.max(named, vim.fn.strdisplaywidth(item.name))
  end
  local lines, marks = {}, {}
  for i, item in ipairs(items) do
    local about = item.kind == 'task' and item.title or item.note
    local status = words(item)
    local head = ('  %s  %s  '):format(status .. string.rep(' ', width - #status), item.name .. string.rep(' ', named - vim.fn.strdisplaywidth(item.name)))
    local note = item.kind == 'task' and item.note ~= '' and ('  · ' .. item.note) or ''
    lines[i] = head .. about .. note
    marks[i] = {status = #status, head = #head, about = #about, item = item}
  end
  if #lines == 0 then lines = {'  no other agents or board tasks'} end
  vim.cmd(('botright %dnew'):format(math.min(math.max(#lines, 3), 12)))
  local buf = vim.api.nvim_get_current_buf()
  vim.bo[buf].buftype, vim.bo[buf].bufhidden, vim.bo[buf].swapfile = 'nofile', 'wipe', false
  pcall(vim.api.nvim_buf_set_name, buf, 'pair://agents')
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.bo[buf].modifiable = false
  vim.wo.number, vim.wo.relativenumber, vim.wo.signcolumn, vim.wo.cursorline = false, false, 'no', true
  for i, mark in ipairs(marks) do
    local look = LOOKS[mark.item.status] or LOOKS.done
    vim.api.nvim_buf_set_extmark(buf, list_ns, i - 1, 2, {end_col = 2 + mark.status, hl_group = look[2] == 'PairStatus' and 'PairAccent' or look[2]})
    vim.api.nvim_buf_set_extmark(buf, list_ns, i - 1, mark.head, {end_col = #lines[i], hl_group = 'PairKey'})
    vim.api.nvim_buf_set_extmark(buf, list_ns, i - 1, mark.head, {end_col = mark.head + mark.about, hl_group = 'Normal', priority = 200})
  end
  vim.keymap.set('n', 'q', '<Cmd>close<CR>', {buffer = buf, desc = 'Close the list'})
  vim.keymap.set('n', '<CR>', function()
    local mark = marks[vim.api.nvim_win_get_cursor(0)[1]]
    if not mark then return end
    if not mark.item.pane then return vim.notify('Pair: ' .. mark.item.name .. ' has no agent pane open now') end
    vim.cmd.close()
    go(mark.item)
  end, {buffer = buf, desc = 'Go to this agent'})
end

function M.on_list(message)
  if message.off then return vim.notify('Pair: the agent relay is off ("agents": false in the config)') end
  show_list(message.items or {})
end

function M.request()
  host.send({type = 'agents'})
end

function M.clear()
  line = nil
  host.unmap_keys('agents')
end

--- `lent` is what init.lua shares; `agents_key` the key that goes to the relayed agent, or false for none.
function M.setup(lent, agents_key)
  host = lent
  if agents_key ~= nil then key = agents_key end -- false: no key
end

return M
