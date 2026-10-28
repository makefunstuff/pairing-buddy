-- /gen in Neovim: you ask Pair for code (see docs/gen.md). :Pair gen, or the gen key (Alt-g) in Normal or Visual mode,
-- asks what to write through vim.ui.input, and the shape and Pair's questions through vim.ui.select and vim.ui.input.
-- Pair draws no dialog of its own: a plugin that replaces those hooks (snacks.nvim, dressing.nvim, noice.nvim) shows
-- them as floating dialogs, and without one Neovim's own prompt on the command line does, sent on Enter
-- (`gen_input = 'cmdline'` always uses that one). Those prompts are one line, so an empty Enter opens a small compose
-- window for a longer request. The place you asked at is marked, so you can keep typing: the code lands there, as a
-- suggestion of its own you take with the accept key, and a block taller than `gen_preview_lines` shows in a
-- preview window. A question of Pair's never opens while you type: it waits for your pause, in the statusline.
-- Only the dialogs, the marks and the preview: init.lua draws the suggestion and tells the daemon.
local M = {}

M.ns = vim.api.nvim_create_namespace('pair_gen')

local config = {input = 'ui', preview_lines = 30, key = '<M-g>'}
-- What init.lua lends: send(message), redraw_status(), typing() (you typed a moment ago), project_path(buf),
-- accept(suggestion), label(key).
local deps = {}
local requests = {} -- n -> {state, since, shape, mark}: the requests the daemon told of
local marks = {} -- token -> {token, buf, id, row, file, line, range}: where you asked, until the daemon numbers it
local next_token = 0
local current = nil -- the newest request, which the statusline shows
local waiting = nil -- Pair's question that waits for you: the daemon's gen_ask message
local ticking = nil -- the timer that keeps "generating · 21s" up to date
local FINAL = {done = true, failed = true, cancelled = true, undone = true}
local PAUSE_MS = 300 -- how often a waiting question looks for your pause

function M.setup(opts, lent)
  config = vim.tbl_extend('force', config, opts or {})
  deps = lent
end

-- The dialogs: Neovim's hooks, or with gen_input = 'cmdline' its own prompt and list, as the hooks' defaults are.

local function cmdline_input(opts, on_confirm)
  local ok, text = pcall(vim.fn.input, {prompt = opts.prompt or '', default = opts.default or '', completion = opts.completion, cancelreturn = vim.NIL})
  on_confirm((ok and text ~= vim.NIL) and text or nil)
end

local function cmdline_select(items, opts, on_choice)
  local lines = {opts.prompt or 'Select one of:'}
  for i, item in ipairs(items) do table.insert(lines, ('%d: %s'):format(i, (opts.format_item or tostring)(item))) end
  local choice = vim.fn.inputlist(lines)
  if choice < 1 or choice > #items then return on_choice(nil, nil) end
  on_choice(items[choice], choice)
end

local function input(opts, on_confirm)
  local ask = config.input == 'cmdline' and cmdline_input or vim.ui.input
  ask(opts, vim.schedule_wrap(on_confirm))
end

local function select(items, opts, on_choice)
  local ask = config.input == 'cmdline' and cmdline_select or vim.ui.select
  ask(items, opts, vim.schedule_wrap(on_choice))
end

--- Tab in the request dialog: the shape words, as the first word.
function M.complete(lead, line)
  if line:sub(1, #line - #lead):find('%S') then return {} end
  return vim.tbl_filter(function(shape) return vim.startswith(shape, lead) end, {'here', 'file', 'scaffold', 'try'})
end
_G.PairGenComplete = M.complete

-- Marks: where you asked, so the code lands there even after you typed on.

--- Marks the cursor's line in the current buffer, or the lines of `range` ({from, to}); nil outside the project.
local function mark_here(range)
  local buf = vim.api.nvim_get_current_buf()
  local file = deps.project_path(buf)
  if not file then return nil end
  local row = range and range.from - 1 or vim.api.nvim_win_get_cursor(0)[1] - 1
  local spec = range and {end_row = range.to - 1, end_col = 0} or {}
  next_token = next_token + 1
  local where = {token = next_token, buf = buf, id = vim.api.nvim_buf_set_extmark(buf, M.ns, row, 0, spec), row = row, file = file, line = row + 1, range = range}
  marks[where.token] = where
  return where
end

local function unmark(where)
  if not where then return end
  marks[where.token] = nil
  if vim.api.nvim_buf_is_valid(where.buf) then pcall(vim.api.nvim_buf_del_extmark, where.buf, M.ns, where.id) end
end

--- How many lines the place request `n` was asked at has moved since, in `buf`: where its code lands.
function M.moved(n, buf)
  local where = requests[n] and requests[n].mark
  if not where or where.buf ~= buf or not vim.api.nvim_buf_is_valid(buf) then return 0 end
  local pos = vim.api.nvim_buf_get_extmark_by_id(buf, M.ns, where.id, {})
  return pos[1] and pos[1] - where.row or 0
end

--- The daemon asks where a request from the chat goes: the cursor of `win`, or its last selection with `selection`.
--- It is marked for request `n` there.
function M.place_for(n, win, selection)
  local buf = vim.api.nvim_win_get_buf(win)
  local file = deps.project_path(buf)
  if not file then return vim.NIL end
  local range
  if selection then
    local from, to = vim.api.nvim_buf_get_mark(buf, '<')[1], vim.api.nvim_buf_get_mark(buf, '>')[1]
    if from > 0 and to > 0 then range = {from = math.min(from, to), to = math.max(from, to)} end
  end
  local line = vim.api.nvim_win_get_cursor(win)[1]
  local where = vim.api.nvim_win_call(win, function() return mark_here(range) end)
  if where then
    marks[where.token] = nil
    requests[n] = requests[n] or {}
    requests[n].mark = where
  end
  return range and {file = file, from = range.from, to = range.to} or {file = file, line = line}
end

--- Sends the request: `text`, with `shape` when it is known, and where you asked.
local function send(where, text, shape)
  deps.send({
    type = 'gen', text = text, shape = shape, token = where and where.token,
    place = where and not where.range and {file = where.file, line = where.line} or nil,
    selection = where and where.range and {file = where.file, from = where.range.from, to = where.range.to} or nil,
  })
end

-- The compose window: a small Markdown float for a request longer than one line. :w or Ctrl-S sends it, :q drops it.

function M.compose(where, shape, text)
  local buf = vim.api.nvim_create_buf(false, true)
  pcall(vim.api.nvim_buf_set_name, buf, 'pair://gen/compose')
  vim.bo[buf].buftype = 'acwrite'
  vim.bo[buf].bufhidden = 'wipe'
  vim.bo[buf].filetype = 'markdown'
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, text ~= '' and vim.split(text, '\n', {plain = true}) or {''})
  vim.bo[buf].modified = false
  local width = math.max(20, math.min(72, vim.o.columns - 4))
  local win = vim.api.nvim_open_win(buf, true, {
    relative = 'editor', row = 1, col = math.floor((vim.o.columns - width) / 2), width = width, height = 8,
    border = 'rounded', style = 'minimal', title = ' gen · the request · :w or Ctrl-S sends · :q drops ', title_pos = 'center',
  })
  vim.wo[win].wrap = true
  local sent = false
  local function go()
    local request = vim.trim(table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), '\n'))
    if request == '' then return vim.notify('Pair: the request is empty; :q drops it') end
    sent = true
    vim.cmd('stopinsert')
    pcall(vim.api.nvim_win_close, win, true)
    send(where, request, shape)
  end
  vim.api.nvim_create_autocmd('BufWriteCmd', {buffer = buf, callback = go})
  -- Never "no write since last change": :q drops it.
  vim.api.nvim_create_autocmd({'TextChanged', 'TextChangedI'}, {buffer = buf, callback = function() vim.bo[buf].modified = false end})
  vim.api.nvim_create_autocmd('BufWipeout', {buffer = buf, once = true, callback = function() if not sent then unmark(where) end end})
  for _, mode in ipairs({'n', 'i'}) do vim.keymap.set(mode, '<C-s>', go, {buffer = buf, desc = 'Send the request to Pair'}) end
  if text == '' then vim.cmd('startinsert') end
end

-- The request: the dialog, or the words given.

local function is_note(buf)
  return vim.bo[buf].filetype == 'markdown'
end

--- `:Pair gen` and the gen key. `words` given skip the dialog; `range` ({from, to}) is a selection: in code, the lines
--- the code replaces (here), in a note the request itself, with its first line in the dialog. `compose` (`:Pair gen +`)
--- opens the compose window at once.
function M.ask(words, range, compose)
  if waiting and words == '' and not compose then return M.show(waiting) end -- Alt-g answers the question that waits
  local buf = vim.api.nvim_get_current_buf()
  local note = range and is_note(buf)
  local lines = note and vim.api.nvim_buf_get_lines(buf, range.from - 1, range.to, false) or {}
  local where = mark_here(not note and range or nil)
  local shape = range and not note and 'here' or nil
  if compose then return M.compose(where, shape, words ~= '' and words or table.concat(lines, '\n')) end
  if words ~= '' then return send(where, words, shape) end
  local prompt = shape and ('gen here · what should Pair write over lines %d-%d? '):format(range.from, range.to) or 'gen · what should Pair write? '
  input({prompt = prompt, default = lines[1] or '', completion = 'customlist,v:lua.PairGenComplete'}, function(text)
    if text == nil then return unmark(where) end -- Esc: no request
    if text == '' then return M.compose(where, shape, '') end -- an empty Enter: a longer request
    local rest = note and table.concat(vim.list_slice(lines, 2), '\n') or ''
    send(where, rest ~= '' and (text .. '\n' .. rest) or text, shape)
  end)
end

-- Pair's questions: the shape it guessed, and at most two of the model's. Esc leaves one waiting; the gen key shows it again.

local function answer(message, text)
  if waiting == message then waiting = nil end
  deps.send({type = 'gen_answer', gen = message.gen, id = message.id, text = text})
  deps.redraw_status()
end

local function shape_line(choice)
  local why = choice.guessed and '  (guessed)' or (not choice.built and '  (not built yet)' or '')
  return ('%-9s %s%s'):format(choice.shape, choice.what, why)
end

--- Shows question `message` now.
function M.show(message)
  if message.kind == 'shape' then
    return select(message.choices or {}, {prompt = message.title, format_item = shape_line, kind = 'pair_gen_shape'}, function(choice)
      if choice and waiting == message then answer(message, choice.shape) end
    end)
  end
  input({prompt = message.title .. ' ', default = type(message.answer) == 'string' and message.answer or ''}, function(text)
    if text ~= nil and waiting == message then answer(message, text) end
  end)
end

--- Whether a dialog may open now: not while you are in Insert mode or typed a moment ago, since it would take your keys.
local function free()
  local mode = vim.api.nvim_get_mode().mode
  return not (mode:match('^[iRc]') or mode == 't') and not deps.typing()
end

function M.on_ask(message)
  waiting = message
  deps.redraw_status()
  -- The shape comes as the answer to your own request: at once. A question of the model's waits for your pause.
  if message.kind == 'shape' and free() then return M.show(message) end
  local timer = vim.uv.new_timer()
  timer:start(PAUSE_MS, PAUSE_MS, vim.schedule_wrap(function()
    if waiting ~= message then return timer:close() end
    if not free() then return end
    timer:close()
    M.show(message)
  end))
end

-- The statusline: the newest request while it runs, waits for you, or has code to take.

local function tick(on)
  if on and not ticking then
    ticking = vim.uv.new_timer()
    ticking:start(1000, 1000, vim.schedule_wrap(deps.redraw_status))
  elseif not on and ticking then
    ticking:close()
    ticking = nil
  end
end

function M.on_state(message)
  local n = message.gen
  local request = requests[n] or {}
  requests[n] = request
  local token = message.token ~= vim.NIL and message.token or nil
  if token and marks[token] then
    request.mark = marks[token]
    marks[token] = nil
  end
  request.state, request.shape = message.state, message.shape ~= vim.NIL and message.shape or nil
  request.since = vim.uv.now() - math.max(0, (os.time() * 1000) - (message.since or os.time() * 1000))
  current = request
  current.n = n
  if FINAL[message.state] then
    if waiting and waiting.gen == n then waiting = nil end
    unmark(request.mark)
  end
  tick(message.state == 'generating')
  deps.redraw_status()
end

--- What the statusline shows of /gen: {text, busy}, or nil when nothing runs, waits or is ready.
function M.status()
  local key = deps.label and deps.label(config.key)
  if waiting then return {text = ('gen #%d asks · %s'):format(waiting.gen, key or ':Pair gen')} end
  local request = current
  if not request or not request.state then return nil end
  if request.state == 'generating' or request.state == 'asks' then
    return {text = ('gen #%d · generating · %ds'):format(request.n, math.floor((vim.uv.now() - request.since) / 1000)), busy = true}
  end
  if request.state == 'queued' then return {text = ('gen #%d waits for the one before'):format(request.n)} end
  if request.state == 'asking' then return {text = ('gen #%d · asking'):format(request.n)} end
  if request.state == 'ready' then
    return {text = ('gen #%d ready · %s takes · :Pair dismiss'):format(request.n, deps.label(deps.accept_key()) or ':Pair accept')}
  end
  return nil
end

-- The preview: a block taller than gen_preview_lines, in a window of its own under the line it goes to.

--- Whether `lines` go to the preview: taller than preview_lines, or than the window that shows `buf` (Neovim
--- shows ghost lines at most a window less one at a time, and scrolls past the rest in one step).
function M.too_tall(lines, buf)
  local height = vim.o.lines
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if vim.api.nvim_win_get_buf(win) == buf and vim.api.nvim_win_get_config(win).relative == '' then
      height = vim.api.nvim_win_get_height(win)
      break
    end
  end
  return #lines > config.preview_lines or #lines > height - 2
end

function M.close_preview(suggestion)
  local win = suggestion.preview_win
  suggestion.preview_win = nil
  if win and vim.api.nvim_win_is_valid(win) then pcall(vim.api.nvim_win_close, win, true) end
end

--- Opens the preview of `suggestion` under row `row` in a window that shows it (`enter`: and goes there, to scroll;
--- else only when that row is in view); the block goes to `line`. q closes it, the accept key takes the block.
function M.preview(suggestion, row, line, enter)
  M.close_preview(suggestion)
  local win
  for _, w in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if vim.api.nvim_win_get_buf(w) == suggestion.buf and vim.api.nvim_win_get_config(w).relative == '' then
      if enter or (row + 1 >= vim.fn.line('w0', w) and row + 1 <= vim.fn.line('w$', w)) then win = w break end
    end
  end
  if not win then return end
  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].bufhidden = 'wipe'
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, suggestion.new)
  vim.bo[buf].filetype = vim.bo[suggestion.buf].filetype
  vim.bo[buf].modifiable = false
  pcall(vim.api.nvim_buf_set_name, buf, ('pair://gen/%d/preview'):format(suggestion.gen))
  local name = vim.fn.fnamemodify(vim.api.nvim_buf_get_name(suggestion.buf), ':.')
  local width = math.max(20, vim.api.nvim_win_get_width(win) - 6)
  local height = math.min(#suggestion.new, math.max(5, math.floor(vim.api.nvim_win_get_height(win) / 2)))
  local accept = deps.label(deps.accept_key())
  local spec = {
    relative = 'win', win = win, bufpos = {row, 0}, row = 1, col = 2, width = width, height = height, border = 'single', style = 'minimal',
    title = (' gen #%d · %s · %d lines → %s:%d '):format(suggestion.gen, vim.bo[buf].filetype ~= '' and vim.bo[buf].filetype or 'text', #suggestion.new, name, line),
    footer = (' %s takes all %d lines · q closes '):format(accept or ':Pair accept', #suggestion.new), footer_pos = 'right',
  }
  local ok, opened = pcall(vim.api.nvim_open_win, buf, enter, spec)
  if not ok then
    spec.footer, spec.footer_pos = nil, nil -- a Neovim before 0.10
    opened = vim.api.nvim_open_win(buf, enter, spec)
  end
  suggestion.preview_win = opened
  vim.keymap.set('n', 'q', function() M.close_preview(suggestion) end, {buffer = buf, desc = 'Close Pair\'s preview'})
  if deps.accept_key() then
    vim.keymap.set('n', deps.accept_key(), function()
      M.close_preview(suggestion)
      deps.accept(suggestion)
    end, {buffer = buf, desc = 'Take the block of Pair\'s /gen'})
  end
end

--- Forgets what the daemon said: it went away, or the session ended.
function M.reset()
  waiting, current = nil, nil
  requests = {}
  for _, where in pairs(marks) do unmark(where) end
  tick(false)
end

return M
