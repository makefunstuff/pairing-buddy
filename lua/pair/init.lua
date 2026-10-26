-- pairing-buddy for Neovim: sends what you do to the pair daemon and shows what Pair says, points at and
-- suggests, in the visual language of style.lua, drawn by draw.lua.
-- Pair never saves a buffer, and never moves your cursor: its jump key does, when you press it. It changes a
-- buffer only while you hand it the wheel (the Driver role): one edit, typed while you watch (drive.lua) as one
-- undo step, and refused or undone as soon as you press any key. Once connected, it stays connected: when the
-- daemon restarts, it reconnects by itself.
local card = require('pair.card')
local draw = require('pair.draw')
local drive = require('pair.drive')
local listen = require('pair.listen')
local places = require('pair.places')
local style = require('pair.style')

local M = {}

local ns = draw.ns
-- Alt-y: no built-in meaning in Normal mode. <Tab> would be the same byte as Ctrl-I, the jumplist's forward jump.
-- Alt-j goes where Pair points. Alt-u and Alt-n rate Pair's last unasked remark: useful, or noise. Hold Alt-t to
-- speak to Pair (push-to-talk, see listen.lua).
local config = {
  socket = nil, debounce_ms = 2000, max_points = 5, motion = true, glyphs = {},
  accept_key = '<M-y>', jump_key = '<M-j>', useful_key = '<M-u>', noise_key = '<M-n>', listen_key = '<M-t>',
}
local state = {
  channel = nil, partial = '', attached = {}, pending = {}, open_request = nil, level = nil, role = nil,
  points = {}, -- the lines Pair points at: {buf, ids (see draw.point), note, code}, oldest first
  target = nil, -- where the jump key goes: {buf, ns, id, code} of Pair's last point, or of its suggestion
  words = nil, -- Pair's words under your line: {buf, row, id, remark, text, key, sign, span}, until your next edit
  reading = nil, -- the file Pair reads now, for the statusline: {name, till}
  suggestion = nil, -- the change Pair suggested: {buf, ids, old, new, remark}
  remark = nil, -- the id of Pair's last unasked remark, until you rate it
  held = nil, -- a remark Pair holds for your next break: {remark, buf, id} (buf and id: its dot in the margin)
  keys = {}, -- the keys this plugin mapped while something waits for them, by purpose
  wanted = false, -- connect was asked for (:Pair start or auto_connect) and not undone by :Pair stop
  retry = nil, -- the reconnect timer
  models = {}, -- why each model is down, per role: the daemon's health
  run = nil, -- the test run on save, for the statusline: {state = 'run'|'pass'|'fail'|'error'|'idle', label, text, till}
  thinking = false, -- a Partner turn that thinks is running, for the statusline
  results = {}, -- what the last finished run found: {name, file, line, ok, failure}, absolute paths
  typing = nil, -- while the Driver's edit is being typed: the function that stops it and undoes what it typed
}
local RETRY_MS = {1000, 2000, 5000, 10000, 30000} -- then every 30 s
local READING_MS = 2000 -- how long the statusline names the file Pair reads
local PASS_MS = 6000 -- how long the statusline shows a passing run; a failing one stays until the next run

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

local function redraw_status()
  pcall(vim.cmd, 'redrawstatus!')
end

--- The loaded buffer of `file` (an absolute path from the daemon), named relative to the working directory.
local function load(file)
  local buf = vim.fn.bufadd(vim.fn.fnamemodify(file, ':.'))
  vim.fn.bufload(buf)
  return buf
end

-- Keys that act on something Pair shows are mapped in Normal mode only while it shows, and only where you have
-- no mapping of your own. `purpose` names the set, to unmap it again.

local function map_keys(purpose, keys)
  for _, key in ipairs(state.keys[purpose] or {}) do pcall(vim.keymap.del, 'n', key) end
  state.keys[purpose] = {}
  for _, entry in ipairs(keys) do
    local key, run, desc = unpack(entry)
    if key and key ~= '' and vim.fn.maparg(key, 'n') == '' then
      vim.keymap.set('n', key, run, {desc = desc})
      table.insert(state.keys[purpose], key)
    end
  end
end

local function unmap_keys(purpose) map_keys(purpose, {}) end

--- How a mapped key reads in Pair's words: <M-j> as M-j. Nil when this plugin did not map it.
local function key_label(purpose, key)
  return key and vim.tbl_contains(state.keys[purpose] or {}, key) and (key:gsub('^<(.*)>$', '%1')) or nil
end

-- Pair's words under your line: they go with your next edit, which counts as having seen them.

local function forget_words(seen)
  local words = state.words
  state.words = nil
  if not words then return end
  draw.erase(words.buf, {words.id, words.span})
  if seen and words.remark then send({type = 'seen', remark = words.remark}) end
  redraw_status()
end

local function draw_words(words, still)
  words.id = draw.remark(words.buf, words.row, words.text, words.key, {still = still, sign = words.sign})
end

-- Points: the lines Pair points at. The last one is where the jump key goes, unless a suggestion is newer.

local function point_target(point)
  return point and {buf = point.buf, ns = ns, id = point.ids.mark, code = point.code, point = point}
end

--- The jump key goes to `target`, or to Pair's last point when it is nil, or nowhere when there is none (unless a
--- held thought waits for it).
local function aim(target)
  state.target = target or point_target(state.points[#state.points])
  if not state.target and not state.held then unmap_keys('jump') end -- a held thought keeps it: it shows the thought
end

local function forget_point(point)
  draw.erase(point.buf, vim.tbl_values(point.ids))
  for i, other in ipairs(state.points) do
    if other == point then table.remove(state.points, i) end
  end
  if state.target and state.target.point == point then aim(nil) end
end

local function clear_points()
  for _, point in ipairs(vim.list_slice(state.points)) do forget_point(point) end
end

--- Goes to the place Pair pointed at last, or to its suggestion, leaving a mark in the jumplist: Ctrl-O comes back.
--- While Pair holds a thought, shows that first: the place it is about comes with it.
function M.jump()
  if state.held then return send({type = 'release'}) end
  local target = state.target
  local row = target and draw.row(target.buf, target.id, target.ns)
  if not row then return vim.notify('Pair: it points at nothing now') end
  forget_words(true) -- going there answers what it said
  vim.cmd("normal! m'")
  local ok, err = pcall(vim.api.nvim_win_set_buf, 0, target.buf)
  if not ok then return vim.notify('Pair: ' .. err, vim.log.levels.ERROR) end
  vim.bo[target.buf].buflisted = true
  vim.api.nvim_win_set_cursor(0, {row + 1, draw.column(target.buf, row, target.code)})
  vim.cmd('normal! zz')
end

local function point(message)
  local buf = load(message.file)
  local count = vim.api.nvim_buf_line_count(buf)
  local first = math.min(message.line, count) - 1
  local last = math.max(first, math.min(message.endLine or message.line, count) - 1)
  local code = type(message.code) == 'string' and message.code or nil
  local new = {buf = buf, ids = draw.point(buf, first, last, message.note, code), note = message.note, code = code}
  state.reading = nil -- it has read what it needed
  table.insert(state.points, new)
  state.target = point_target(new)
  map_keys('jump', {{config.jump_key, M.jump, 'Go where Pair points'}})
  while #state.points > config.max_points do forget_point(state.points[1]) end
end

local show_all_tests -- defined with the tests below

--- Places notes and words again for the windows' new widths.
local function relayout()
  show_all_tests()
  for _, p in ipairs(state.points) do
    local mark = vim.api.nvim_buf_is_valid(p.buf) and vim.api.nvim_buf_get_extmark_by_id(p.buf, ns, p.ids.mark, {details = true})
    if mark and mark[1] then
      draw.erase(p.buf, {p.ids.note})
      p.ids.note = draw.note(p.buf, mark[3].end_row or mark[1], p.note, {still = true})
    end
  end
  local words = state.words
  local row = words and draw.row(words.buf, words.id)
  if row then
    draw.erase(words.buf, {words.id})
    words.row = row
    draw_words(words, true)
  end
end

-- Feedback: whether Pair's unasked remark was useful. Accepting or dismissing its suggestion says so too.

local function unmap_feedback() unmap_keys('feedback') end

-- `id` is the remark's, or nil for the last one; `implicit` feedback is not confirmed in the chat.
local function feedback(useful, id, implicit)
  send({type = 'feedback', useful = useful, remark = id, implicit = implicit})
  if not implicit and id then vim.notify(useful and 'Pair: noted, useful' or 'Pair: noted, not useful') end
  if id == nil or id == state.remark then
    state.remark = nil
    unmap_feedback()
  end
end

-- A held thought: a remark that can wait for your next break (a save, a run, a stop to look). Meanwhile a dot
-- in the margin says where it is about, and the jump key shows it now.

local function forget_held()
  local held = state.held
  state.held = nil
  if not held then return end
  if held.id then draw.erase(held.buf, {held.id}) end
  if not state.target then unmap_keys('jump') end
  redraw_status()
end

local function on_held(message)
  forget_held()
  local file = type(message.file) == 'string' and message.file or nil
  local buf = file and load(file) or vim.api.nvim_get_current_buf()
  state.held = {remark = message.id}
  if project_path(buf) then
    local here = buf == vim.api.nvim_get_current_buf() and vim.api.nvim_win_get_cursor(0)[1] or 1
    local line = type(message.line) == 'number' and message.line or here
    state.held.buf, state.held.id = buf, draw.held(buf, math.min(line, vim.api.nvim_buf_line_count(buf)) - 1)
  end
  map_keys('jump', {{config.jump_key, M.jump, 'Show what Pair holds'}})
  redraw_status()
end

-- An unasked remark: its words go under the line you are on, and the feedback keys wait for your verdict.
local function on_remark(message)
  if state.held and state.held.remark == message.id then forget_held() end -- another remark leaves a held one waiting
  state.remark = message.id
  map_keys('feedback', {
    {config.useful_key, function() feedback(true, state.remark) end, 'Pair\'s remark was useful'},
    {config.noise_key, function() feedback(false, state.remark) end, 'Pair\'s remark was noise'},
  })
  forget_words(false)
  -- The remark's target is its suggestion when it made one, else its last point.
  if type(message.target) == 'table' and message.target.suggestion and state.suggestion then aim(state.suggestion.target) end
  local target = type(message.target) == 'table' and state.target or nil
  local text = type(message.text) == 'string' and message.text or ''
  -- A remark that only pointed: its note, and where.
  if text == '' and target then text = ('`%s:%d` %s'):format(vim.fn.fnamemodify(message.target.file, ':.'), message.target.line, target.note) end
  local buf = vim.api.nvim_get_current_buf()
  if text == '' or not project_path(buf) then return end
  state.words = {buf = buf, row = vim.api.nvim_win_get_cursor(0)[1] - 1, text = text, remark = message.id, key = target and key_label('jump', config.jump_key)}
  draw_words(state.words)
  state.reading = nil
  redraw_status()
end

-- Suggestions: the old lines struck through, the new ones under them, until you accept or edit them.

local function text_lines(text)
  if text == '' then return {} end
  return vim.split((text:gsub('\n$', '')), '\n', {plain = true})
end

local function clear_suggestion()
  local suggestion = state.suggestion
  state.suggestion = nil
  if suggestion and state.target == suggestion.target then aim(nil) end
  if not suggestion or not vim.api.nvim_buf_is_valid(suggestion.buf) then return end
  draw.erase(suggestion.buf, suggestion.ids, draw.suggest_ns)
  if config.accept_key then pcall(vim.keymap.del, 'n', config.accept_key, {buffer = suggestion.buf}) end
end

-- The lines under the suggestion now, which may have moved since it was shown.
local function suggested_range(suggestion)
  local first = draw.row(suggestion.buf, suggestion.ids[1], draw.suggest_ns)
  if not first then return nil end
  return first, first + #suggestion.old
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
  if suggestion.remark then feedback(true, suggestion.remark, true) end
end

function M.dismiss()
  local suggestion = state.suggestion
  clear_suggestion()
  if suggestion and suggestion.remark then feedback(false, suggestion.remark, true) end
end

local function suggest(message)
  clear_suggestion()
  local buf = load(message.file)
  local count = vim.api.nvim_buf_line_count(buf)
  -- The daemon checked the line against the buffer; it may have shrunk since. A wrong line marks nothing.
  if message.line > count then return vim.notify('Pair: its suggestion is past the end of the buffer, so it was dropped') end
  local first = message.line - 1
  local last = math.max(first, math.min(message.endLine or message.line, count) - 1)
  local old = vim.api.nvim_buf_get_lines(buf, first, last + 1, false)
  local new = text_lines(message.text)
  local key = config.accept_key and (config.accept_key:gsub('^<(.*)>$', '%1'))
  if config.accept_key then
    vim.keymap.set('n', config.accept_key, M.accept, {buffer = buf, desc = 'Accept Pair\'s suggestion'})
  end
  -- JSON null arrives as vim.NIL: a suggestion in an answer to you is no remark.
  local remark = message.remark ~= vim.NIL and message.remark or nil
  local ids = draw.suggestion(buf, first, old, new, message.note, key)
  state.suggestion = {buf = buf, ids = ids, old = old, new = new, remark = remark, target = {buf = buf, ns = draw.suggest_ns, id = ids[1]}}
  aim(state.suggestion.target) -- the jump key goes there: where the accept key works
  map_keys('jump', {{config.jump_key, M.jump, 'Go where Pair points'}})
  state.reading = nil
  redraw_status()
end

--- Your edit of rows `first`..`last` answers what Pair said: its words go, and so does a point on those lines.
local function edited(buf, first, last)
  forget_words(true)
  for _, p in ipairs(vim.list_slice(state.points)) do
    local mark = p.buf == buf and vim.api.nvim_buf_get_extmark_by_id(buf, ns, p.ids.mark, {details = true})
    if mark and mark[1] and mark[1] <= last and (mark[3].end_row or mark[1]) >= first then forget_point(p) end
  end
end

local typing_sent = 0
local function on_lines(_, buf, _, first, last, new_last)
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
  vim.schedule(function()
    if suggestion and suggestion.buf == buf and state.suggestion == suggestion and not still_suggested(suggestion) then clear_suggestion() end
    edited(buf, first, math.max(last, new_last))
  end)
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

-- Pair reads a file: its gaze crosses the line numbers you see, and the statusline names the file a moment.
local function look(message)
  local buf = vim.fn.bufnr(message.file)
  if buf ~= -1 and vim.api.nvim_buf_is_loaded(buf) then draw.gaze(buf, message.from, message.to) end
  state.reading = {name = vim.fn.fnamemodify(message.file, ':t'), till = now_ms() + READING_MS}
  redraw_status()
  vim.defer_fn(redraw_status, READING_MS + 50)
end

-- Tests: the run on save, in the statusline while it runs and after, and on the lines of the tests it ran.

local spinner = {timer = nil, frame = 1}

-- The spinner turns while Pair runs your tests or thinks.
local function spin()
  local on = state.thinking or (state.run ~= nil and state.run.state == 'run')
  if on and not spinner.timer then
    spinner.timer = vim.uv.new_timer()
    spinner.timer:start(0, 80, vim.schedule_wrap(function()
      spinner.frame = spinner.frame % #style.spinner + 1
      redraw_status()
    end))
  elseif not on and spinner.timer then
    spinner.timer:close()
    spinner.timer = nil
  end
end

--- Shows what the last run found in `buf`: a sign on each test, and why one failed after the line it failed on.
local function show_tests(buf)
  if not vim.api.nvim_buf_is_loaded(buf) then return end
  local name = vim.api.nvim_buf_get_name(buf)
  local signs, notes, shown = {}, {}, {}
  for _, test in ipairs(state.results) do
    if test.file == name then table.insert(signs, {line = test.line, ok = test.ok, changed = test.changed}) end
    local failure = type(test.failure) == 'table' and test.failure -- JSON null arrives as vim.NIL
    if failure and failure.file == name then table.insert(notes, {line = failure.line, text = failure.text, changed = test.changed}) end
    if test.file == name or (failure and failure.file == name) then table.insert(shown, test) end
  end
  local stale = state.run and state.run.state == 'run'
  draw.tests(buf, signs, notes, {stale = stale})
  -- A change rises from the background once, where it first shows.
  if not stale then
    for _, test in ipairs(shown) do test.changed = false end
  end
end

show_all_tests = function()
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do show_tests(buf) end
end

local function on_tests(message)
  if message.state == 'pass' or message.state == 'fail' then
    -- A test whose result changed since the last run rises from the background; the others are just there.
    local before = {}
    for _, test in ipairs(state.results) do before[test.file .. ':' .. test.name] = test.ok end
    state.results = message.results or {}
    for _, test in ipairs(state.results) do test.changed = before[test.file .. ':' .. test.name] ~= test.ok end
  end
  state.run = {state = message.state, label = message.label, text = message.text, till = now_ms() + PASS_MS}
  if message.state == 'pass' then vim.defer_fn(redraw_status, PASS_MS + 50) end
  spin()
  show_all_tests()
  redraw_status()
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

-- Driving: while Pair has the wheel, any key you press takes it back, here at once and then in the daemon. While
-- its edit is being typed, that key and any after it until the half-typed edit is undone do nothing else: they
-- could change the buffer under it.

-- Scrolling or clicking to watch Pair drive, and the terminal's focus reports, are not keys.
local function pressed(key)
  local name = vim.fn.keytrans(key)
  return not (name:find('Mouse') or name:find('ScrollWheel') or name:find('Drag') or name:find('Release') or name:find('Focus'))
end

local function watch_keys(on)
  vim.on_key(on and function(key)
    if not pressed(key) then return end
    if state.role == 'driver' then -- a burst of keys takes the wheel back once
      state.role = 'navigator' -- edits on their way are refused from this key on
      vim.schedule(function()
        if state.typing then state.typing() end
        vim.on_key(nil, ns)
        send({type = 'take_back'})
        redraw_status()
      end)
    end
    if state.typing then return '' end
  end or nil, ns)
end

local function set_role(role)
  state.role = role
  watch_keys(role == 'driver')
  redraw_status()
end

--- Whether a window in this tab page shows line `line` of `buf`.
local function in_view(buf, line)
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if vim.api.nvim_win_get_buf(win) == buf and line >= vim.fn.line('w0', win) and line <= vim.fn.line('w$', win) then return true end
  end
  return false
end

-- The Driver's edit: typed where you can watch it, and answered once it is in the buffer, or undone.
local function edit(message)
  local function reply(result) send({type = 'reply', id = message.id, result = result}) end
  if state.role ~= 'driver' or state.typing then return reply({error = 'the user has taken the wheel back'}) end
  local buf = load(message.file)
  local count = vim.api.nvim_buf_line_count(buf)
  if message.line > count then return reply({error = ('line %d is past the end of the buffer (%d lines)'):format(message.line, count)}) end
  if not in_view(buf, message.line) then open_split(message.file, message.line) end
  state.typing = drive.type(buf, message.line - 1, math.min(message.endLine, count) - 1, text_lines(message.text), function(typed, from, to)
    state.typing = nil
    reply(typed and {ok = true, from = from + 1, to = to + 1} or {error = 'the user has taken the wheel back'})
  end)
end

-- The hand-back line: Pair's words under the lines it changed, which keep its mark, how the tests went on them in
-- the sign column, and the key that undoes it all. Like any words of Pair's, they go with your next edit.
local function handback(message)
  local buf = vim.fn.bufnr(message.file)
  if buf == -1 or not vim.api.nvim_buf_is_loaded(buf) then return end
  local signs = {pass = {style.glyphs.pass, 'PairStatusPass'}, fail = {style.glyphs.fail, 'PairFail'}}
  forget_words(false)
  local last = math.min(message.endLine, vim.api.nvim_buf_line_count(buf)) - 1
  state.words = {
    buf = buf, row = last, key = 'u undoes it',
    text = message.text ~= '' and message.text or ('changed lines %d to %d'):format(message.line, message.endLine),
    sign = signs[message.tests], span = draw.span(buf, math.min(message.line - 1, last), last),
  }
  draw_words(state.words)
  redraw_status()
end

-- The chat pane prints Pair in the same accent as here, once Neovim has true colours to give.
local function send_accent()
  local color = vim.o.termguicolors and vim.api.nvim_get_hl(0, {name = 'PairAccent', link = false}).fg
  if color then send({type = 'accent', color = style.hex(color)}) end
end

local function hello()
  send({type = 'hello', role = 'editor', cwd = vim.fn.getcwd()})
  send_accent()
end

-- `models` maps each role to why its model is down, or to null (vim.NIL here) when it answers.
local function set_models(models)
  state.models = {}
  for role, reason in pairs(models or {}) do
    if type(reason) == 'string' then state.models[role] = reason end
  end
  redraw_status()
end

local handlers = {
  look = look,
  point = point,
  open = open,
  read = read,
  suggest = suggest,
  edit = edit,
  handback = handback,
  remark = on_remark,
  held = on_held,
  unheld = forget_held,
  tests = on_tests,
  context = card.update,
  thinking = function(message)
    state.thinking = message.on
    spin()
    redraw_status()
  end,
  clear = function()
    forget_held()
    clear_points()
    clear_suggestion()
    forget_words(false)
    state.remark = nil
    unmap_feedback()
  end,
  welcome = function(message)
    state.level = message.level
    set_models(message.models)
    set_role(message.role)
  end,
  health = function(message) set_models(message.models) end,
  role = function(message) set_role(message.role) end,
  message = function(message)
    if message.sender == 'system' then vim.notify('Pair: ' .. message.text) end
  end,
  ended = hello,
  listening = function(message) listen.level(message.level) end,
  heard = listen.heard,
  -- The answer to what you said: Pair's words under the line you asked on, in place of yours.
  answer = function(message)
    if message.text == '' and not message.pointed then return listen.unanswered() end
    local buf, row = listen.answered()
    if not buf or type(message.text) ~= 'string' or message.text == '' then return end
    forget_words(false)
    state.words = {buf = buf, row = row, text = message.text, key = message.pointed and key_label('jump', config.jump_key) or nil}
    draw_words(state.words)
    redraw_status()
  end,
}

local disconnected

local function on_data(_, data)
  -- A lone empty item is the end of the stream: the daemon went away.
  if #data == 1 and data[1] == '' then return disconnected() end
  -- Neovim splits channel data on newlines; the last item is the start of the next line.
  data[1] = state.partial .. data[1]
  state.partial = table.remove(data)
  for _, line in ipairs(data) do
    local ok, message = pcall(vim.json.decode, line)
    if ok and handlers[message.type] then handlers[message.type](message) end
  end
end

local function try_connect()
  local ok, channel = pcall(vim.fn.sockconnect, 'pipe', config.socket or default_socket(), {
    on_data = vim.schedule_wrap(on_data),
  })
  if not ok or channel == 0 then return false end
  state.channel = channel
  state.partial = ''
  hello()
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_loaded(buf) then attach(buf) end
  end
  local file = project_path(0)
  if file then event({kind = 'enter', file = file}) end
  places.send(true)
  return true
end

-- Tries again after 1, 2, 5, 10 and then every 30 seconds, quietly: the statusline says "reconnecting".
local function schedule_retry(attempt)
  state.retry = state.retry or vim.uv.new_timer()
  state.retry:start(RETRY_MS[math.min(attempt, #RETRY_MS)], 0, vim.schedule_wrap(function()
    if not state.wanted or state.channel then return end
    if not try_connect() then schedule_retry(attempt + 1) end
  end))
end

disconnected = function()
  state.channel = nil
  if state.run and state.run.state == 'run' then on_tests({state = 'idle'}) end -- that run's end will not come
  if state.typing then state.typing() end -- no daemon waits for the edit any more
  state.thinking = false -- nor does any turn of its Partner
  listen.cancel(function() end) -- nor what you were saying
  spin()
  if state.role == 'driver' then set_role('navigator') end -- a restarted daemon has ended the hand-over
  redraw_status()
  if state.wanted then schedule_retry(1) end
end

function M.connect()
  if state.channel then return true end
  local first = not state.wanted
  state.wanted = true
  if try_connect() then return true end
  if first then
    vim.notify('Pair: no daemon at ' .. (config.socket or default_socket()) .. ' yet; it connects when one starts (see `pair doctor`)', vim.log.levels.WARN)
  end
  schedule_retry(1)
  return false
end

function M.disconnect()
  state.wanted = false
  if state.retry then state.retry:stop() end
  if state.channel then vim.fn.chanclose(state.channel) end
  state.channel = nil
  set_role(nil)
  forget_held()
  clear_points()
  clear_suggestion()
  forget_words(false)
  unmap_feedback()
  state.results, state.run, state.thinking = {}, nil, false
  spin()
  show_all_tests()
end

-- The statusline: one quiet segment. The voice glyph lights up in the accent while Pair's words show; the role
-- and talk level show only when they are not the usual ones. Nil when there is nothing to show.
local function status_parts()
  local g = style.glyphs
  if not state.channel then
    return state.wanted and {glyph = g.away, text = 'pair · reconnecting', hl = 'PairStatusDim', text_hl = 'PairStatusDim'} or nil
  end
  local down = vim.tbl_keys(state.models)
  table.sort(down)
  if #down > 0 then
    return {glyph = g.away, text = 'pair · ' .. (#down == 2 and 'models' or down[1]) .. ' down', hl = 'PairStatusWarn', text_hl = 'PairStatusWarn'}
  end
  local hearing = listen.status()
  if hearing then return hearing end
  local run = state.run
  if state.role == 'driver' and not (run and run.state == 'run') then
    local doing = state.thinking and 'thinking' or 'any key takes it back'
    return {glyph = g.wheel, text = 'pair has the wheel · ' .. doing, hl = 'PairStatus', text_hl = 'PairStatusDim'}
  end
  if state.reading and now_ms() < state.reading.till then
    return {glyph = g.voice, text = 'reading ' .. state.reading.name, hl = 'PairStatus', text_hl = 'PairStatusDim'}
  end
  if run and run.state == 'run' then
    return {glyph = style.spinner[spinner.frame], text = run.label, hl = 'PairStatus', text_hl = 'PairStatusDim'}
  elseif state.thinking then
    return {glyph = style.spinner[spinner.frame], text = 'pair · thinking', hl = 'PairStatus', text_hl = 'PairStatusDim'}
  elseif run and run.state == 'fail' then
    return {glyph = g.fail, text = run.text, hl = 'PairFail', text_hl = 'PairStatusDim'}
  elseif run and run.state == 'error' then
    return {glyph = g.away, text = run.label .. ' · ' .. run.text, hl = 'PairStatusWarn', text_hl = 'PairStatusDim'}
  elseif run and run.state == 'pass' and now_ms() < run.till then
    return {glyph = g.pass, text = run.label .. ' · ' .. run.text, hl = 'PairStatusPass', text_hl = 'PairStatusDim'}
  end
  local parts = {'pair'}
  if state.role and state.role ~= 'navigator' then table.insert(parts, state.role) end
  if state.level and state.level ~= 'normal' then table.insert(parts, state.level) end
  if state.held then table.insert(parts, 'held thought · ' .. (key_label('jump', config.jump_key) or ':Pair jump')) end
  local lit = state.words or state.held
  return {glyph = g.voice, text = table.concat(parts, ' · '), hl = lit and 'PairStatus' or 'PairStatusDim', text_hl = 'PairStatusDim'}
end

--- The statusline's text, for example `● pair`, `● reading worker.go`, `⠹ go test ./...`, `⠹ pair · thinking`, `✗ 1 failing · TestX` or
--- `◌ pair · partner down`.
function M.status()
  local parts = status_parts()
  return parts and (parts.glyph .. ' ' .. parts.text) or ''
end

--- The same with its highlight groups, for a 'statusline' expression or a statusline plugin's section.
function M.statusline()
  local parts = status_parts()
  if not parts then return '' end
  return ('%%#%s#%s %%#%s#%s%%*'):format(parts.hl, parts.glyph, parts.text_hl, (parts.text:gsub('%%', '%%%%')))
end

-- Each command gets the words after its name and, with a range (:'<,'>Pair ask ...), the lines it covers.
local commands = {
  start = function(arg)
    if M.connect() and arg ~= '' then send({type = 'goal', text = arg}) end
  end,
  goal = function(arg) send({type = 'goal', text = arg}) end,
  ask = function(arg, selection) send({type = 'ask', text = arg, selection = selection}) end,
  level = function(arg)
    state.level = arg
    send({type = 'level', level = arg})
  end,
  scout = function() send({type = 'role', role = 'scout'}) end,
  navigate = function() send({type = 'role', role = 'navigator'}) end,
  drive = function(arg, selection) send({type = 'drive', text = arg, selection = selection}) end,
  jump = function() M.jump() end,
  accept = M.accept,
  dismiss = M.dismiss,
  useful = function() feedback(true, state.remark) end,
  noise = function() feedback(false, state.remark) end,
  ['end'] = function() send({type = 'end'}) end,
  context = function() card.open(send) end,
  open = function()
    if state.open_request then open_split(state.open_request.file, state.open_request.line) end
    state.open_request = nil
  end,
  clear = function()
    clear_points()
    forget_words(false)
  end,
  stop = M.disconnect,
  -- Like a tap of the listen key: Pair listens until the next :Pair listen. `:Pair listen cancel` drops it.
  listen = function(arg, selection)
    if arg == 'cancel' then return listen.cancel(send) end
    listen.press(send, ':Pair listen', selection)
  end,
}

function M.command(opts)
  local name, arg = opts.args:match('^(%S+)%s*(.*)$')
  local run = commands[name or 'start']
  if not run then return vim.notify('Pair: unknown command ' .. name, vim.log.levels.ERROR) end
  local file = opts.range > 0 and project_path(0)
  run(arg or '', file and {file = file, from = opts.line1, to = opts.line2} or nil)
end

function M.complete()
  return vim.tbl_keys(commands)
end

function M.setup(opts)
  config = vim.tbl_extend('force', config, opts or {})
  style.glyphs = vim.tbl_extend('force', style.glyphs, config.glyphs)
  draw.motion = config.motion
  drive.motion = config.motion
  style.apply()
  local group = vim.api.nvim_create_augroup('pair', {clear = true})
  local function restyle()
    style.apply()
    send_accent()
  end
  vim.api.nvim_create_autocmd('ColorScheme', {group = group, callback = restyle})
  vim.api.nvim_create_autocmd('OptionSet', {group = group, pattern = {'termguicolors', 'background'}, callback = restyle})
  -- Leaving Insert mode for a while is a natural break, where a held thought shows.
  vim.api.nvim_create_autocmd({'InsertEnter', 'InsertLeave'}, {group = group, callback = function(args)
    if state.channel then event({kind = 'mode', insert = args.event == 'InsertEnter'}) end
  end})
  -- A note's place depends on the width of the window that shows it.
  vim.api.nvim_create_autocmd({'WinResized', 'VimResized', 'BufWinEnter'}, {group = group, callback = relayout})
  vim.api.nvim_create_autocmd('BufEnter', {group = group, callback = function(args)
    -- Loading a file Pair points at enters it in Neovim's hidden autocommand window: you did not go there.
    if not state.channel or vim.fn.win_gettype() == 'autocmd' then return end
    attach(args.buf)
    local file = project_path(args.buf)
    if file then event({kind = 'enter', file = file}) end
  end})
  vim.api.nvim_create_autocmd('CursorHold', {group = group, callback = send_cursor})
  -- Whether you are at the editor: an answer to what you said is read aloud only while you are away.
  vim.api.nvim_create_autocmd({'FocusGained', 'FocusLost'}, {group = group, callback = function(args)
    send({type = 'focus', on = args.event == 'FocusGained'})
  end})
  -- Push-to-talk, in Normal mode and, about the selected lines, in Visual mode; only where the key is free.
  for _, mode in ipairs({'n', 'x'}) do
    if config.listen_key and config.listen_key ~= '' and vim.fn.maparg(config.listen_key, mode) == '' then
      vim.keymap.set(mode, config.listen_key, function()
        if not state.channel then return vim.notify('Pair: not connected') end
        local file = mode == 'x' and project_path(0)
        local from, to = vim.fn.line('v'), vim.fn.line('.')
        local selection = file and {file = file, from = math.min(from, to), to = math.max(from, to)} or nil
        listen.press(send, (config.listen_key:gsub('^<(.*)>$', '%1')), selection)
      end, {desc = 'Hold to speak to Pair'})
    end
  end
  -- Saving is when Pair runs your tests, if you set a command for the project (see the README).
  vim.api.nvim_create_autocmd('BufWritePost', {group = group, callback = function(args)
    local file = state.channel and project_path(args.buf)
    if file then event({kind = 'save', file = file}) end
  end})
  -- A test file you open after a run shows its results too.
  vim.api.nvim_create_autocmd('BufReadPost', {group = group, callback = function(args) show_tests(args.buf) end})
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
  places.setup(group, event)
  -- Sessions only where you work: not for a Neovim without a screen (an agent's or a script's), nor in the temp folder.
  local scratch = vim.startswith(vim.fn.getcwd() .. '/', vim.fs.normalize(vim.uv.os_tmpdir()) .. '/')
  if config.auto_connect and #vim.api.nvim_list_uis() > 0 and not scratch then M.connect() end
end

return M
