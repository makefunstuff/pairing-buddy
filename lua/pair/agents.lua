-- Your other agents, in one place: the daemon relays their news (one needs you, one is ready to merge, one is
-- done) at your next breakpoint, as one line after Pair's own in the statusline, with the keys that go there.
-- Nothing opens and nothing takes your cursor until you ask: the key, or `:Pair agents` and Enter on a line, brings the
-- agent's herdr pane to the front; o, d and t open what a board task left behind (its report or pull request, its
-- branch's diff, a terminal in its worktree); r, and Alt-r on the line of a task ready to merge, opens its branch as a
-- review (genfiles.lua). All of it is read only: nothing here changes the board.
local style = require('pair.style')
local hints = require('pair.hints')

local M = {}

local MAX_WIDTH = 56 -- of the relayed line in the statusline; `:Pair agents` has it all
local NAME_WIDTH = 24 -- of the name column in the list

local host -- what init.lua lends: send, map_keys, unmap_keys, key_label, redraw_status
local key = '<M-a>'
local open_key = '<M-o>'
local review_key = '<M-r>'
local line = nil -- the relayed line: {item, text, more}

-- What each status looks like: the ones that need you in the accent, a failure in red, done quietly green.
local LOOKS = {
  needs = {'needs you', 'PairStatus'}, ready = {'ready to merge', 'PairStatus'}, failed = {'failed', 'PairFail'},
  done = {'done', 'PairStatusPass'}, working = {'working', 'PairKey'}, waiting = {'waiting', 'PairKey'},
}

local function words(item)
  if item.kind == 'agent' and item.status == 'done' then return 'idle' end
  return LOOKS[item.status] and LOOKS[item.status][1] or item.status
end

local function cut(text, width)
  if vim.fn.strdisplaywidth(text) <= width then return text end
  return vim.fn.strcharpart(text, 0, width - 1) .. '…'
end

local function present(value) return value ~= nil and value ~= vim.NIL and value ~= '' end

--- `text` as a winbar shows it: a % in a title or a path is no statusline item.
local function bar(text) return (text:gsub('%%', '%%%%')) end

--- Brings the agent of `item` to the front in herdr.
local function go(item)
  host.send({type = 'agent_go', key = item.key})
end

--- Asks the daemon for what `item` left behind: 'open' (its report or pull request), 'diff' or 'term'.
local function ask_link(item, what)
  host.send({type = 'agent_link', key = item.key, what = what})
end

--- Goes to the relayed agent, or, when it has no pane any more, puts the line away.
function M.go()
  if line then go(line.item) end
end

--- Opens the relayed task's report or pull request.
function M.open()
  if not line then return end
  hints.used(host.key_label('agents', open_key))
  ask_link(line.item, 'open')
end

--- The relayed task ready to merge: its branch as a review in :Pair gen list.
function M.review()
  if not (line and line.item.kind == 'task') then return end
  hints.used(host.key_label('agents', review_key))
  host.send({type = 'review', task = line.item.id})
end

--- The id of the task the relayed line is about, or nil: what :Pair review alone reviews.
function M.relayed_task()
  return line and line.item.kind == 'task' and line.item.id or nil
end

--- Whether the relayed line is a board task's, ready to merge: Alt-r reviews it.
local function reviewable() return line and line.item.kind == 'task' and line.item.status == 'ready' end

--- The daemon relays one line, or takes it back (`item` null) once it is answered or no longer true.
function M.on_relay(message)
  line = message.item ~= vim.NIL and message.item and {item = message.item, text = message.text, more = message.more or 0} or nil
  if line then
    local keys = {{key, M.go, 'Go to the agent Pair told you about'}}
    if line.item.kind == 'task' then table.insert(keys, {open_key, M.open, 'Open the report or pull request of the task Pair told you about'}) end
    if reviewable() then table.insert(keys, {review_key, M.review, 'Review the branch of the task Pair told you about'}) end
    host.map_keys('agents', keys)
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
  local labels = {}
  local go_label = host.key_label('agents', key)
  if go_label then table.insert(labels, go_label) end
  local open_label = line.item.kind == 'task' and host.key_label('agents', open_key)
  if open_label then table.insert(labels, hints.label(open_label, 'opens')) end
  local review_label = reviewable() and host.key_label('agents', review_key)
  if review_label then table.insert(labels, hints.label(review_label, 'reviews')) end
  if #labels > 0 then text = text .. '  ' .. table.concat(labels, ' · ') end
  local look = LOOKS[line.item.status] or LOOKS.done
  return {glyph = style.glyphs.agents, text = text, hl = look[2], text_hl = 'PairStatusDim'}
end

-- What a task left behind, as the daemon found it: the report or pull request opens in the browser (a choice when
-- there are both), the branch's diff in a read-only split, the worktree in a terminal split.

local function open_url(link)
  local ok, err = pcall(vim.ui.open, link.url)
  if not ok then vim.notify('Pair: cannot open ' .. link.url .. ': ' .. tostring(err), vim.log.levels.WARN) end
end

local function show_diff(message)
  vim.cmd('botright new')
  local buf = vim.api.nvim_get_current_buf()
  vim.bo[buf].buftype, vim.bo[buf].bufhidden, vim.bo[buf].swapfile = 'nofile', 'wipe', false
  pcall(vim.api.nvim_buf_set_name, buf, ('pair://agents/%s/diff'):format((message.key:gsub('^%w+:', ''))))
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, vim.split((message.diff:gsub('\n$', '')), '\n', {plain = true}))
  vim.bo[buf].modifiable, vim.bo[buf].readonly = false, true
  vim.bo[buf].filetype = 'diff'
  vim.wo.winbar = bar(' ' .. (message.title or 'diff') .. ' · read only · q closes')
  vim.keymap.set('n', 'q', '<Cmd>close<CR>', {buffer = buf, desc = 'Close the diff'})
end

local function open_terminal(message)
  if vim.fn.isdirectory(message.where) == 0 then
    return vim.notify('Pair: ' .. message.where .. ' is not a folder here', vim.log.levels.WARN)
  end
  vim.cmd('botright new')
  if vim.fn.has('nvim-0.11') == 1 then
    vim.fn.jobstart(vim.o.shell, {term = true, cwd = message.where})
  else
    vim.fn.termopen(vim.o.shell, {cwd = message.where})
  end
  vim.wo.winbar = bar(' ' .. (message.title or '') .. ' · ' .. vim.fn.fnamemodify(message.where, ':~'))
  vim.cmd.startinsert()
end

function M.on_link(message)
  if present(message.error) then return vim.notify('Pair: ' .. message.error) end
  if message.what == 'open' then
    local links = message.links or {}
    if #links == 1 then return open_url(links[1]) end
    return vim.ui.select(links, {prompt = 'Open', format_item = function(link) return link.label .. '  ' .. link.url end, kind = 'pair_agents_open'}, function(link)
      if link then open_url(link) end
    end)
  end
  if message.what == 'diff' then return show_diff(message) end
  if message.what == 'term' then return open_terminal(message) end
end

-- `:Pair agents`: one list of every task and agent, the ones that need you first. Enter goes to the agent on the
-- line; o, d and t open what its task left behind; q closes it.

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
  if #items > 0 then vim.wo.winbar = ' Enter goes · o report or PR · d diff · t terminal · r review · q closes' end
  for i, mark in ipairs(marks) do
    local look = LOOKS[mark.item.status] or LOOKS.done
    vim.api.nvim_buf_set_extmark(buf, list_ns, i - 1, 2, {end_col = 2 + mark.status, hl_group = look[2] == 'PairStatus' and 'PairAccent' or look[2]})
    vim.api.nvim_buf_set_extmark(buf, list_ns, i - 1, mark.head, {end_col = #lines[i], hl_group = 'PairKey'})
    vim.api.nvim_buf_set_extmark(buf, list_ns, i - 1, mark.head, {end_col = mark.head + mark.about, hl_group = 'Normal', priority = 200})
  end
  -- The relayed line's task first under the cursor: its keys are one key away.
  for i, mark in ipairs(marks) do
    if line and mark.item.key == line.item.key then vim.api.nvim_win_set_cursor(0, {i, 0}) end
  end
  local function here() return marks[vim.api.nvim_win_get_cursor(0)[1]] end
  vim.keymap.set('n', 'q', '<Cmd>close<CR>', {buffer = buf, desc = 'Close the list'})
  vim.keymap.set('n', '<CR>', function()
    local mark = here()
    if not mark then return end
    if not mark.item.pane or mark.item.pane == vim.NIL then return vim.notify('Pair: ' .. mark.item.name .. ' has no agent pane open now') end
    vim.cmd.close()
    go(mark.item)
  end, {buffer = buf, desc = 'Go to this agent'})
  local function link(what, desc)
    vim.keymap.set('n', what:sub(1, 1), function()
      local mark = here()
      if mark then ask_link(mark.item, what) end
    end, {buffer = buf, desc = desc})
  end
  link('open', 'Open the report or pull request of this task')
  link('diff', 'Show the diff of this task\'s branch, read only')
  link('term', 'Open a terminal in this task\'s worktree')
  vim.keymap.set('n', 'r', function()
    local mark = here()
    if not mark then return end
    if mark.item.kind ~= 'task' then return vim.notify('Pair: ' .. mark.item.name .. ' is an agent of your own, with no branch of a task to review') end
    vim.cmd.close()
    host.send({type = 'review', task = mark.item.id})
  end, {buffer = buf, desc = 'Review this task\'s branch'})
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

--- `lent` is what init.lua shares; `agents_key` the key that goes to the relayed agent, `open_key` the one that
--- opens its task's report or pull request and `agents_review_key` the one that reviews a task ready to merge, each
--- false for none.
function M.setup(lent, agents_key, agents_open_key, agents_review_key)
  host = lent
  if agents_key ~= nil then key = agents_key end -- false: no key
  if agents_open_key ~= nil then open_key = agents_open_key end
  if agents_review_key ~= nil then review_key = agents_review_key end
end

return M
