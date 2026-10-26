-- pairing-buddy for Neovim: sends what you do to the pair daemon and shows what Pair points at and suggests.
-- Pair never saves a buffer. It changes one only while you hand it the wheel (the Driver role): one edit,
-- as one undo step, refused here as soon as you press any key.
local M = {}

local ns = vim.api.nvim_create_namespace('pair')
local suggest_ns = vim.api.nvim_create_namespace('pair_suggest')
-- Alt-y: no built-in meaning in Normal mode. <Tab> would be the same byte as Ctrl-I, the jumplist's forward jump.
local config = {socket = nil, debounce_ms = 2000, max_points = 5, accept_key = '<M-y>'}
local state = {
  channel = nil, partial = '', attached = {}, pending = {}, points = {}, open_request = nil, level = nil, role = nil,
  suggestion = nil, -- the change Pair suggested: {buf, mark, old, new}
}

local function default_socket()
  if vim.env.PAIR_SOCKET then return vim.env.PAIR_SOCKET end
  if vim.env.XDG_RUNTIME_DIR then return vim.env.XDG_RUNTIME_DIR .. '/pairing-buddy.sock' end
  return '/tmp/pairing-buddy-' .. vim.uv.getuid() .. '.sock'
end

local function now_ms()
  return math.floor(vim.uv.now())
end

local function send(message)
  if not state.channel then return end
  pcall(vim.fn.chansend, state.channel, vim.json.encode(message) .. '\n')
end

local function event(fields)
  send({type = 'event', event = fields})
end

local function project_path(buf)
  local name = vim.api.nvim_buf_get_name(buf)
  if name == '' or vim.bo[buf].buftype ~= '' then return nil end
  return vim.fn.fnamemodify(name, ':p') -- the daemon makes it relative to the project root
end

-- Edits: collected per buffer, sent once typing has paused for debounce_ms.

local function flush(buf)
  local pending = state.pending[buf]
  state.pending[buf] = nil
  local file = vim.api.nvim_buf_is_valid(buf) and project_path(buf)
  if not pending or not file then return end
  local last = math.min(pending.to, vim.api.nvim_buf_line_count(buf))
  local lines = vim.api.nvim_buf_get_lines(buf, pending.from - 1, math.min(last, pending.from + 39), false)
  event({kind = 'edit', file = file, from = pending.from, to = last, text = table.concat(lines, '\n')})
  local cursor = vim.api.nvim_win_get_cursor(0)
  event({kind = 'cursor', file = file, line = cursor[1], col = cursor[2]})
end

-- Suggestions: an inline diff (the old lines highlighted, the new ones as ghost text below) until you accept or edit them.

local function text_lines(text)
  if text == '' then return {} end
  return vim.split((text:gsub('\n$', '')), '\n', {plain = true})
end

local function clear_suggestion()
  local suggestion = state.suggestion
  state.suggestion = nil
  if not suggestion or not vim.api.nvim_buf_is_valid(suggestion.buf) then return end
  vim.api.nvim_buf_clear_namespace(suggestion.buf, suggest_ns, 0, -1)
  if config.accept_key then pcall(vim.keymap.del, 'n', config.accept_key, {buffer = suggestion.buf}) end
end

-- The lines under the suggestion now, which may have moved since it was shown.
local function suggested_range(suggestion)
  local mark = vim.api.nvim_buf_get_extmark_by_id(suggestion.buf, suggest_ns, suggestion.mark, {})
  if not mark[1] then return nil end
  return mark[1], mark[1] + #suggestion.old
end

local function still_suggested(suggestion)
  local first, last = suggested_range(suggestion)
  return first and vim.deep_equal(vim.api.nvim_buf_get_lines(suggestion.buf, first, last, false), suggestion.old)
end

function M.accept()
  local suggestion = state.suggestion
  if not suggestion then return end
  local unchanged = still_suggested(suggestion)
  local first, last = suggested_range(suggestion)
  clear_suggestion()
  if not unchanged then return vim.notify('Pair: those lines changed, so the suggestion was dropped') end
  vim.api.nvim_buf_set_lines(suggestion.buf, first, last, false, suggestion.new)
end

local function suggest(message)
  clear_suggestion()
  local buf = vim.fn.bufadd(message.file)
  vim.fn.bufload(buf)
  local count = vim.api.nvim_buf_line_count(buf)
  -- The daemon checked the line against the buffer; it may have shrunk since. A wrong line marks nothing.
  if message.line > count then return vim.notify('Pair: its suggestion is past the end of the buffer, so it was dropped') end
  local first = message.line - 1
  local last = math.max(first, math.min(message.endLine or message.line, count) - 1)
  local old = vim.api.nvim_buf_get_lines(buf, first, last + 1, false)
  local new = text_lines(message.text)
  local ghost = {}
  for _, line in ipairs(new) do table.insert(ghost, {{line, 'PairSuggestAdd'}}) end
  local accept = config.accept_key and (' · ' .. config.accept_key .. ' accepts') or ''
  local mark = vim.api.nvim_buf_set_extmark(buf, suggest_ns, first, 0, {
    end_row = last,
    end_col = #old[#old],
    hl_group = 'PairSuggestDelete',
    virt_text = {{'  ◇ ' .. message.note .. accept, 'PairNote'}},
    virt_text_pos = 'eol',
  })
  vim.api.nvim_buf_set_extmark(buf, suggest_ns, last, 0, {virt_lines = ghost})
  state.suggestion = {buf = buf, mark = mark, old = old, new = new}
  if config.accept_key then
    vim.keymap.set('n', config.accept_key, M.accept, {buffer = buf, desc = 'Accept Pair\'s suggestion'})
  end
end

local typing_sent = 0
local function on_lines(_, buf, _, first, _, new_last)
  local pending = state.pending[buf] or {from = first + 1, to = new_last}
  pending.from = math.min(pending.from, first + 1)
  pending.to = math.max(pending.to, new_last)
  pending.timer = pending.timer or vim.uv.new_timer()
  state.pending[buf] = pending
  pending.timer:start(config.debounce_ms, 0, vim.schedule_wrap(function()
    pending.timer:close()
    flush(buf)
  end))
  -- Editing the suggested lines yourself is how you ignore a suggestion.
  local suggestion = state.suggestion
  if suggestion and suggestion.buf == buf then
    vim.schedule(function()
      if state.suggestion == suggestion and not still_suggested(suggestion) then clear_suggestion() end
    end)
  end
  -- A cheap "still typing" signal, at most every half second, so Pair never interrupts mid-thought.
  if now_ms() - typing_sent > 500 then
    typing_sent = now_ms()
    vim.schedule(function() event({kind = 'typing'}) end)
  end
end

local function attach(buf)
  if state.attached[buf] or not project_path(buf) then return end
  state.attached[buf] = true
  vim.api.nvim_buf_attach(buf, false, {
    on_lines = on_lines,
    on_detach = function() state.attached[buf] = nil end,
  })
end

local function send_diagnostics(buf)
  local file = project_path(buf)
  if not file then return end
  local items = {}
  for _, d in ipairs(vim.diagnostic.get(buf, {severity = {min = vim.diagnostic.severity.WARN}})) do
    table.insert(items, {
      line = d.lnum + 1,
      severity = d.severity == vim.diagnostic.severity.ERROR and 'error' or 'warning',
      message = d.message:gsub('\n.*', ''),
    })
  end
  event({kind = 'diagnostics', file = file, items = items})
end

local function visual()
  local mode = vim.fn.mode()
  return mode == 'v' or mode == 'V' or mode == '\22'
end

local function send_cursor()
  local file = project_path(0)
  if not file then return end
  local cursor = vim.api.nvim_win_get_cursor(0)
  local message = {kind = 'cursor', file = file, line = cursor[1], col = cursor[2]}
  if visual() then
    local from, to = vim.fn.line('v'), cursor[1]
    message.selection = {from = math.min(from, to), to = math.max(from, to)}
  end
  event(message)
end

-- What the daemon asks for.

local function clear_points()
  for _, point in ipairs(state.points) do
    if vim.api.nvim_buf_is_valid(point.buf) then pcall(vim.api.nvim_buf_del_extmark, point.buf, ns, point.id) end
  end
  state.points = {}
end

local function point(message)
  local buf = vim.fn.bufadd(message.file)
  vim.fn.bufload(buf)
  local count = vim.api.nvim_buf_line_count(buf)
  local line = math.min(message.line, count) - 1
  local end_line = math.min(message.endLine or message.line, count) - 1
  local id = vim.api.nvim_buf_set_extmark(buf, ns, line, 0, {
    end_row = end_line,
    end_col = #vim.api.nvim_buf_get_lines(buf, end_line, end_line + 1, false)[1],
    hl_group = 'PairPoint',
    virt_text = {{'  ◆ ' .. message.note, 'PairNote'}},
    virt_text_pos = 'eol',
  })
  table.insert(state.points, {buf = buf, id = id})
  while #state.points > config.max_points do
    local old = table.remove(state.points, 1)
    pcall(vim.api.nvim_buf_del_extmark, old.buf, ns, old.id)
  end
end

local function open_split(file, line)
  local window = vim.api.nvim_get_current_win()
  vim.cmd('belowright split ' .. vim.fn.fnameescape(file))
  pcall(vim.api.nvim_win_set_cursor, 0, {line, 0})
  vim.api.nvim_set_current_win(window) -- the split is for looking; your cursor stays where it was
end

local function open(message)
  if message.ask then
    state.open_request = message
    vim.notify(('Pair wants to show %s:%d. :Pair open to look'):format(vim.fn.fnamemodify(message.file, ':.'), message.line))
  else
    open_split(message.file, message.line)
  end
end

local function read(message)
  local buf = vim.fn.bufnr(message.file)
  local text = nil
  if buf ~= -1 and vim.api.nvim_buf_is_loaded(buf) then
    text = table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), '\n')
  end
  send({type = 'reply', id = message.id, result = {text = text}})
end

-- Driving: while Pair has the wheel, any key you press takes it back, here at once and then in the daemon.

-- Scrolling or clicking to watch Pair drive, and the terminal's focus reports, are not keys.
local function pressed(key)
  local name = vim.fn.keytrans(key)
  return not (name:find('Mouse') or name:find('ScrollWheel') or name:find('Drag') or name:find('Release') or name:find('Focus'))
end

local function watch_keys(on)
  vim.on_key(on and function(key)
    if state.role ~= 'driver' or not pressed(key) then return end -- a burst of keys takes the wheel back once
    state.role = 'navigator' -- edits on their way are refused from this key on
    vim.schedule(function()
      vim.on_key(nil, ns)
      send({type = 'take_back'})
      vim.cmd.redrawstatus()
    end)
  end or nil, ns)
end

local function set_role(role)
  state.role = role
  watch_keys(role == 'driver')
  vim.cmd.redrawstatus()
end

local function edit(message)
  local function reply(result) send({type = 'reply', id = message.id, result = result}) end
  if state.role ~= 'driver' then return reply({error = 'the user has taken the wheel back'}) end
  local buf = vim.fn.bufadd(message.file)
  vim.fn.bufload(buf)
  local count = vim.api.nvim_buf_line_count(buf)
  if message.line > count then return reply({error = ('line %d is past the end of the buffer (%d lines)'):format(message.line, count)}) end
  -- Setting 'undolevels' starts a new undo step, so `u` undoes Pair's change and nothing of yours.
  vim.api.nvim_buf_call(buf, function() vim.o.undolevels = vim.o.undolevels end)
  vim.api.nvim_buf_set_lines(buf, message.line - 1, math.min(message.endLine, count), false, text_lines(message.text))
  if vim.fn.bufwinid(buf) == -1 then open_split(message.file, message.line) end
  reply({ok = true})
end

local function hello()
  send({type = 'hello', role = 'editor', cwd = vim.fn.getcwd()})
end

local handlers = {
  point = point,
  open = open,
  read = read,
  suggest = suggest,
  edit = edit,
  clear = function()
    clear_points()
    clear_suggestion()
  end,
  welcome = function(message)
    state.level = message.level
    set_role(message.role)
  end,
  role = function(message) set_role(message.role) end,
  message = function(message)
    if message.sender == 'system' then vim.notify('Pair: ' .. message.text) end
  end,
  ended = hello,
}

local function on_data(_, data)
  -- Neovim splits channel data on newlines; the last item is the start of the next line.
  data[1] = state.partial .. data[1]
  state.partial = table.remove(data)
  for _, line in ipairs(data) do
    local ok, message = pcall(vim.json.decode, line)
    if ok and handlers[message.type] then handlers[message.type](message) end
  end
end

function M.connect()
  if state.channel then return true end
  local ok, channel = pcall(vim.fn.sockconnect, 'pipe', config.socket or default_socket(), {
    on_data = vim.schedule_wrap(on_data),
  })
  if not ok or channel == 0 then
    vim.notify('Pair: no daemon at ' .. (config.socket or default_socket()) .. ' (start it with `pair`)', vim.log.levels.WARN)
    return false
  end
  state.channel = channel
  hello()
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_loaded(buf) then attach(buf) end
  end
  return true
end

function M.disconnect()
  if state.channel then vim.fn.chanclose(state.channel) end
  state.channel = nil
  set_role(nil)
  clear_points()
  clear_suggestion()
end

function M.status()
  if not state.channel then return '' end
  return 'Pair: ' .. (state.role or 'navigator') .. (state.level and (' · ' .. state.level) or '')
end

local commands = {
  start = function(arg)
    if M.connect() and arg ~= '' then send({type = 'goal', text = arg}) end
  end,
  goal = function(arg) send({type = 'goal', text = arg}) end,
  ask = function(arg) send({type = 'ask', text = arg}) end,
  level = function(arg)
    state.level = arg
    send({type = 'level', level = arg})
  end,
  scout = function() send({type = 'role', role = 'scout'}) end,
  navigate = function() send({type = 'role', role = 'navigator'}) end,
  drive = function(arg) send({type = 'drive', text = arg}) end,
  accept = M.accept,
  dismiss = clear_suggestion,
  ['end'] = function() send({type = 'end'}) end,
  open = function()
    if state.open_request then open_split(state.open_request.file, state.open_request.line) end
    state.open_request = nil
  end,
  clear = clear_points,
  stop = M.disconnect,
}

function M.command(opts)
  local name, arg = opts.args:match('^(%S+)%s*(.*)$')
  local run = commands[name or 'start']
  if not run then return vim.notify('Pair: unknown command ' .. name, vim.log.levels.ERROR) end
  run(arg or '')
end

function M.complete()
  return vim.tbl_keys(commands)
end

function M.setup(opts)
  config = vim.tbl_extend('force', config, opts or {})
  vim.api.nvim_set_hl(0, 'PairPoint', {default = true, link = 'Visual'})
  vim.api.nvim_set_hl(0, 'PairNote', {default = true, link = 'DiagnosticVirtualTextInfo'})
  vim.api.nvim_set_hl(0, 'PairSuggestDelete', {default = true, link = 'DiffDelete'})
  vim.api.nvim_set_hl(0, 'PairSuggestAdd', {default = true, link = 'DiffAdd'})
  local group = vim.api.nvim_create_augroup('pair', {clear = true})
  vim.api.nvim_create_autocmd('BufEnter', {group = group, callback = function(args)
    if not state.channel then return end
    attach(args.buf)
    local file = project_path(args.buf)
    if file then event({kind = 'enter', file = file}) end
  end})
  vim.api.nvim_create_autocmd('CursorHold', {group = group, callback = send_cursor})
  -- CursorHold never fires in Visual mode, so a selection is sent once it stops changing.
  local selection_timer = vim.uv.new_timer()
  vim.api.nvim_create_autocmd({'CursorMoved', 'ModeChanged'}, {group = group, callback = function()
    if not state.channel or not visual() then return end
    selection_timer:start(300, 0, vim.schedule_wrap(function()
      if visual() then send_cursor() end
    end))
  end})
  local diagnostic_timers = {}
  vim.api.nvim_create_autocmd('DiagnosticChanged', {group = group, callback = function(args)
    if not state.channel then return end
    local timer = diagnostic_timers[args.buf] or vim.uv.new_timer()
    diagnostic_timers[args.buf] = timer
    timer:start(config.debounce_ms, 0, vim.schedule_wrap(function() send_diagnostics(args.buf) end))
  end})
  if config.auto_connect then M.connect() end
end

return M
