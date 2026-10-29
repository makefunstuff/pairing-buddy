-- pairing-buddy for Neovim: sends what you do to the pair daemon and shows what Pair says, points at and
-- suggests, in the visual language of style.lua, drawn by draw.lua.
-- Pair never saves a buffer, and never moves your cursor: its jump key does, when you press it (the one exception is
-- the morning pick-up, which opens an empty Neovim where you stopped; `land = false` turns it off). It changes a
-- buffer only while you hand it the wheel (the Driver role): a few edits, each typed while you watch (drive.lua) as
-- one undo step, and refused or undone as soon as you press any key. Once connected, it stays connected: when the
-- daemon restarts, it reconnects by itself.
local agents = require('pair.agents')
local buffers = require('pair.buffers')
local card = require('pair.card')
local debrief = require('pair.debrief')
local draw = require('pair.draw')
local drive = require('pair.drive')
local blank = require('pair.new')
local hints = require('pair.hints')
local ledger = require('pair.ledger')
local earcons = require('pair.earcons')
local gen = require('pair.gen')
local genfiles = require('pair.genfiles')
local gentry = require('pair.gentry')
local listen = require('pair.listen')
local margin = require('pair.margin')
local owning = require('pair.owning')
local pane = require('pair.pane')
local merge = require('pair.merge')
local places = require('pair.places')
local runs = require('pair.runs')
local searches = require('pair.searches')
local style = require('pair.style')
local suggestions = require('pair.suggestions')
local tasks = require('pair.tasks')
local trail = require('pair.trail')

local M = {}

local ns = draw.ns
-- Alt-y: no built-in meaning in Normal mode. <Tab> would be the same byte as Ctrl-I, the jumplist's forward jump.
-- Alt-j goes where Pair points. Alt-u and Alt-n rate Pair's last unasked remark: useful, or noise. Hold Alt-t to
-- speak to Pair (push-to-talk, see listen.lua). Alt-a goes to the agent whose news Pair relayed. Alt-? asks for the
-- idea behind Pair's words under your line, and then opens its link to the docs. In a note's margin, Alt-d logs a
-- decision and Alt-l opens the code a mark links to. Alt-g asks Pair for code (/gen, see gen.lua).
local config = {
  socket = nil, debounce_ms = 2000, max_points = 5, motion = true, glyphs = {},
  accept_key = '<M-y>', jump_key = '<M-j>', useful_key = '<M-u>', noise_key = '<M-n>', listen_key = '<M-t>',
  listen_mode = 'hold', -- or 'toggle': press to start, press again to ask (see listen.lua)
  listen_hold_ms = 650, listen_release_ms = 220, listen_silence_ms = false,
  sounds = false, sound_volume = 0.5,
  searches = true, -- your Telescope, snacks.picker and fzf-lua searches go to the daemon, for the search trail
  decide_key = '<M-d>', link_key = '<M-l>',
  teach_key = '<M-?>',
  agents_key = '<M-a>',
  gen_key = '<M-g>', -- asks Pair for code, in Normal and Visual mode
  gen_input = 'ui', -- or 'cmdline': the request and its questions always on Neovim's own prompt, not vim.ui's
  gen_preview_lines = 30, -- a /gen block taller than this shows in a preview window
  try_run_key = '<LocalLeader>r', -- in a /gen try's sample: runs it again in Pair's pane; in a scaffold's copy: checks it
  land = true, -- the morning pick-up opens an empty Neovim where the last session stopped
  answers = true, -- the start of Pair's answer to a question you typed shows under the line it was about, too
}
local state = {
  channel = nil, partial = '', attached = {}, pending = {}, open_request = nil, level = nil, role = nil,
  origins = {}, -- buf -> who makes the change going on in it now, while it is not you: 'pair' or 'gen:#n' (see as_pair)
  points = {}, -- the lines Pair points at: {buf, ids (see draw.point), note, code}, oldest first
  target = nil, -- where the jump key goes: {buf, ns, id, code, col} of Pair's last point, a suggestion, or a run's crash or error
  words = nil, -- Pair's words under your line: {buf, row, id, remark, text, key, undo, sign, spans, teaching, max, more}, until your next edit
  reading = nil, -- the file Pair reads now, for the statusline: {name, till}
  remark = nil, -- the id of Pair's last unasked remark, until you rate it
  held = nil, -- a remark Pair holds for your next break: {remark, buf, id} (buf and id: its dot in the margin)
  keys = {}, -- the keys this plugin mapped while something waits for them, by purpose
  wanted = false, -- connect was asked for (:Pair start or auto_connect) and not undone by :Pair stop
  retry = nil, -- the reconnect timer
  models = {}, -- why each model is down, per role: the daemon's health
  run = nil, -- the test run on save, for the statusline: {state = 'run'|'pass'|'fail'|'error'|'idle', label, text, at, till, red_since}
  pulse = nil, -- when the statusline last lit up for a green (see delight), until it settles
  thinking = false, -- a Partner turn that thinks is running, for the statusline
  catching_up = false, -- the morning pick-up reads where you stopped, for the statusline
  results = {}, -- what the last finished run found: {name, file, line, ok, failure}, absolute paths
  places = {}, -- where the last build or run crashed or printed errors and warnings: {file, line, col, kind, text, new}
  place_mark = nil, -- {buf, id}: the place of those the jump key goes to
  run_line = nil, -- what the last build or run showed, for the statusline: {n, kind, text, debug, at} (see run-log.mjs)
  typing = nil, -- while the Driver's edit is being typed: the function that stops it and undoes what it typed
  commanding = nil, -- true while you type a command line during a hand-over: only one that is not Pair's takes the wheel back
}
local RETRY_MS = {1000, 2000, 5000, 10000, 30000} -- then every 30 s
local READING_MS = 2000 -- how long the statusline names the file Pair reads
local PASS_MS = 6000 -- how long the statusline shows a passing run; a failing one stays until the next run
local PULSE_MS = 700 -- the statusline lights up once for a green, and settles
local DELIGHT_MS = 5000 -- how long the line about a green stays, from when you are at the editor
local RUN_LINE_MS = 15 * 60 * 1000 -- how long the statusline says what the last run showed
local LONG_RED_MIN = 10 -- a failing run says how long it has been red after this many minutes (delight.mjs's LONG_RED_MS)
local ANSWER_LINES = 2 -- of an answer to a typed question under its line; the chat has all of it
local SCROLL_EVERY_MS = 10000 -- scrolling while you read is sent at most this often: it only says you are there

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

-- Edits: collected per buffer, sent once typing has paused for debounce_ms. Each says who made it (its origin):
-- you, or Pair for you (the Driver's typing, a suggestion you took, an undo from the ledger), so the Watcher never
-- remarks on Pair's code as if you had written it. Yours and Pair's are never sent as one edit.

local function flush(buf)
  local pending = state.pending[buf]
  state.pending[buf] = nil
  if pending and pending.timer and not pending.timer:is_closing() then pending.timer:close() end
  local file = vim.api.nvim_buf_is_valid(buf) and project_path(buf)
  if not pending or not file then return end
  local last = math.min(pending.to, vim.api.nvim_buf_line_count(buf))
  local lines = vim.api.nvim_buf_get_lines(buf, pending.from - 1, math.min(last, pending.from + 39), false)
  event({kind = 'edit', file = file, from = pending.from, to = last, text = table.concat(lines, '\n'), origin = pending.origin})
  owning.report(buf) -- where the code not yours yet is now
  local cursor = vim.api.nvim_win_get_cursor(0)
  event({kind = 'cursor', file = file, line = cursor[1], col = cursor[2]})
end

--- Sends every edit still waiting for its debounce now, so it goes to the session it was made in; with `drop`,
--- forgets them instead, once that session has ended without them.
local function flush_all(drop)
  for buf, pending in pairs(state.pending) do
    if pending.timer and not pending.timer:is_closing() then pending.timer:close() end
    if drop then state.pending[buf] = nil else flush(buf) end
  end
end

--- Marks the changes to `buf` from now on as Pair's (`origin`: 'pair', or 'gen:#n' for a /gen request), until the
--- function it returns is called. Your edits still waiting go first, as your own; Pair's go as soon as it ends.
local function as_pair(buf, origin)
  flush(buf)
  state.origins[buf] = origin or 'pair'
  return function()
    state.origins[buf] = nil
    flush(buf)
  end
end

--- Runs `fn`, whose changes to `buf` are Pair's.
local function by_pair(buf, origin, fn)
  local done = as_pair(buf, origin)
  local ok, result = pcall(fn)
  done()
  if not ok then error(result, 0) end
  return result
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

--- How a key reads in Pair's words: <M-j> as M-j.
local function label(key)
  return key and (key:gsub('^<(.*)>$', '%1')) or nil
end

--- The same for a key this plugin mapped for `purpose`; nil when it did not.
local function key_label(purpose, key)
  return key and vim.tbl_contains(state.keys[purpose] or {}, key) and label(key) or nil
end

-- Pair's words under your line: they go with your next edit, which counts as having seen them.

local function forget_words(seen)
  local words = state.words
  state.words = nil
  if not words then return end
  unmap_keys('teach')
  draw.erase(words.buf, {words.id})
  for _, span in ipairs(words.spans or {}) do draw.erase(span.buf, {span.id}) end
  if seen and words.remark then send({type = 'seen', remark = words.remark}) end
  redraw_status()
end

--- The keys after Pair's words, each with what it does until you have used it once: `M-j goes there · M-? why`.
--- The teach key shows only until then, and not once it was asked: it works on any words of Pair's.
local function words_keys(words)
  local keys = {words.key} -- a key with where it goes, such as the pick-up's `M-j the failing test`
  local jump = words.jump and key_label('jump', config.jump_key)
  if jump then table.insert(keys, hints.label(jump, 'goes there')) end
  if words.undo then table.insert(keys, words.undo) end
  local teach = key_label('teach', config.teach_key)
  if teach and not hints.known(teach) and not words.teaching then table.insert(keys, hints.label(teach, 'why')) end
  return #keys > 0 and table.concat(keys, ' · ') or nil
end

-- `teaching` is the idea behind the words, once asked for (see M.teach): {text, link, key}, without text while it comes.
local function draw_words(words, still, teaching_rises)
  if words.id then draw.erase(words.buf, {words.id}) end
  words.id = draw.remark(words.buf, words.row, words.text, words_keys(words),
    {still = still, sign = words.sign, teaching = words.teaching, teaching_rises = teaching_rises, max = words.max, more = words.more})
end

local function map_teach()
  map_keys('teach', {{config.teach_key, function() M.teach() end, 'Why: the idea behind Pair\'s words'}})
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

--- Goes to the place Pair pointed at last, or to its suggestion (and from there to the next), leaving a mark in the
--- jumplist: Ctrl-O comes back.
--- While Pair holds a thought, shows that first: the place it is about comes with it.
function M.jump()
  if state.held then return send({type = 'release'}) end
  local target = state.target
  local row = target and draw.row(target.buf, target.id, target.ns)
  if not row then return vim.notify('Pair: it points at nothing now') end
  hints.used(label(config.jump_key))
  forget_words(true) -- going there answers what it said
  vim.cmd("normal! m'")
  local ok, err = pcall(vim.api.nvim_win_set_buf, 0, target.buf)
  if not ok then return vim.notify('Pair: ' .. err, vim.log.levels.ERROR) end
  vim.bo[target.buf].buflisted = true
  local col = target.col and math.min(target.col - 1, #vim.api.nvim_buf_get_lines(target.buf, row, row + 1, false)[1])
  vim.api.nvim_win_set_cursor(0, {row + 1, col or draw.column(target.buf, row, target.code)})
  vim.cmd('normal! zz')
  -- A /gen block too tall for ghost lines: the jump goes into its preview, to scroll there.
  local suggestion = target.suggestion
  if suggestion and suggestion.preview then return gen.preview(suggestion, row + suggestion.below, suggestion.line, true) end
  -- From one suggestion the jump key goes on to the next.
  local next = suggestion and suggestions.after(suggestion)
  if next then aim(next.target) end
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
local show_all_places -- and the builds and runs

--- Places notes and words again for the windows' new widths.
local function relayout()
  show_all_tests()
  margin.relayout()
  show_all_places()
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
  local suggested = type(message.target) == 'table' and message.target.suggestion and suggestions.of_remark(message.id)
  if suggested then aim(suggested.target) end
  local target = type(message.target) == 'table' and state.target or nil
  local text = type(message.text) == 'string' and message.text or ''
  -- A remark that only pointed: its note, and where.
  if text == '' and target then text = ('`%s:%d` %s'):format(vim.fn.fnamemodify(message.target.file, ':.'), message.target.line, target.note) end
  local buf = vim.api.nvim_get_current_buf()
  if text == '' or not project_path(buf) then return end
  map_teach()
  state.words = {buf = buf, row = vim.api.nvim_win_get_cursor(0)[1] - 1, text = text, remark = message.id, jump = target ~= nil}
  draw_words(state.words)
  state.reading = nil
  redraw_status()
end

-- Teaching on request: the teach key on Pair's words asks for the one idea worth keeping behind them, which shows
-- under them. Pressed again, it opens the link to the docs that came with it.

--- Asks for the idea behind Pair's words under your line, or opens its link once it has come.
function M.teach()
  local words = state.words
  if not words then return vim.notify('Pair: there are no words of Pair here to explain') end
  hints.used(label(config.teach_key))
  local teaching = words.teaching
  if teaching and teaching.link then return vim.ui.open(teaching.link) end
  if teaching then return end -- asked already
  words.teaching = {}
  draw_words(words, true) -- the hint goes, and the ellipsis shows it heard you
  send({type = 'teach', text = words.text, remark = words.remark})
end

-- The idea behind the words, or no text when there is none; when your edit took the words away, the chat has it.
local function on_teaching(message)
  local words = state.words
  local teaching = words and words.teaching
  if not teaching or teaching.text then return end
  local text = type(message.text) == 'string' and message.text or ''
  if text == '' then
    if type(message.note) == 'string' then vim.notify('Pair: ' .. message.note) end -- busy, say, or nothing to explain
    words.teaching = nil
    return draw_words(words, true)
  end
  local link = type(message.link) == 'string' and message.link or nil
  teaching.text, teaching.link = text, link
  teaching.key = link and ('%s opens %s'):format(label(config.teach_key), link:match('^https?://([^/]+)') or 'the docs') or nil
  draw_words(words, false, true)
end

-- Suggestions: the old lines struck through, the new ones under them, until you accept, dismiss or edit them. Several
-- can show at once (suggestions.lua); the accept key takes the one your cursor is on, else the newest in that buffer,
-- and the jump key goes from one to the next.

local function text_lines(text)
  if text == '' then return {} end
  return vim.split((text:gsub('\n$', '')), '\n', {plain = true})
end

local function drop_suggestion(suggestion)
  if not suggestions.remove(suggestion) then return end
  gen.close_preview(suggestion)
  -- A /gen piece you dismissed or edited away is dropped; one you took, or the daemon took back, is not.
  if suggestion.gen and not suggestion.taken and not suggestion.quiet then
    send({type = 'gen_dropped', action = suggestion.action, piece = suggestion.piece})
  end
  local next = suggestions.all()[1]
  if state.target == suggestion.target then aim(next and next.target) end
  if config.accept_key and vim.api.nvim_buf_is_valid(suggestion.buf) and not suggestions.any_in(suggestion.buf) then
    pcall(vim.keymap.del, 'n', config.accept_key, {buffer = suggestion.buf})
  end
end

local function clear_suggestions()
  for _, suggestion in ipairs(vim.list_slice(suggestions.all())) do drop_suggestion(suggestion) end
end

--- The suggestion :Pair accept and :Pair dismiss act on: the one under your cursor, else the newest in this buffer,
--- else the one the jump key goes to, else the newest.
local function picked()
  local buf = vim.api.nvim_get_current_buf()
  local here = suggestions.at(buf, vim.api.nvim_win_get_cursor(0)[1] - 1)
  if here then return here end
  local target = state.target and state.target.suggestion
  return target or suggestions.all()[#suggestions.all()]
end

--- Takes `suggestion` into its buffer, unless its lines changed since it was shown.
local function accept(suggestion)
  local unchanged = suggestions.still(suggestion)
  local first, last = suggestions.range(suggestion)
  suggestion.taken = unchanged
  drop_suggestion(suggestion)
  hints.used(label(config.accept_key))
  if not unchanged then return vim.notify('Pair: those lines changed, so the suggestion was dropped') end
  local before = vim.api.nvim_buf_get_lines(suggestion.buf, 0, -1, false)
  by_pair(suggestion.buf, suggestion.origin, function() vim.api.nvim_buf_set_lines(suggestion.buf, first, last, false, suggestion.new) end)
  if suggestion.remark then feedback(true, suggestion.remark, true) end
  -- With the text before and after, the ledger can undo it later; a /gen piece also says which, and its lines.
  if suggestion.action then
    send({
      type = 'applied', action = suggestion.action, before = before, after = vim.api.nvim_buf_get_lines(suggestion.buf, 0, -1, false),
      piece = suggestion.piece, from = suggestion.gen and first + 1 or nil, to = suggestion.gen and first + math.max(#suggestion.new, 1) or nil,
    })
  end
end

function M.accept()
  local suggestion = picked()
  if suggestion then accept(suggestion) end
end

--- The chat pane's `a` on a suggestion: the one the daemon booked as ledger action `message.action`.
local function accept_action(message)
  for _, suggestion in ipairs(suggestions.all()) do
    if suggestion.action == message.action then return accept(suggestion) end
  end
  vim.notify('Pair: that suggestion is no longer shown (taken, dismissed or edited)')
end

function M.dismiss()
  local suggestion = picked()
  if not suggestion then return end
  drop_suggestion(suggestion)
  if suggestion.remark then feedback(false, suggestion.remark, true) end
end

local function suggest(message)
  local buf = load(message.file)
  local count = vim.api.nvim_buf_line_count(buf)
  -- A /gen piece lands where you asked, which moved with what you typed since.
  local n = type(message.gen) == 'number' and message.gen or nil
  if n then
    local moved = gen.moved(n, buf)
    message.line = math.max(1, math.min(message.line + moved, count))
    message.endLine = message.endLine and math.max(message.line, math.min(message.endLine + moved, count))
  end
  -- The daemon checked the line against the buffer; it may have shrunk since. A wrong line marks nothing.
  if message.line > count then return vim.notify('Pair: its suggestion is past the end of the buffer, so it was dropped') end
  local first = message.line - 1
  local last = math.max(first, math.min(message.endLine or message.line, count) - 1)
  -- With `insert`, the new lines go under `line` and nothing is struck through: the slice of :Pair new.
  local old = message.insert and {} or vim.api.nvim_buf_get_lines(buf, first, last + 1, false)
  local rows = message.insert and {buf = buf, first = first + 1, last = first + 1} or {buf = buf, first = first, last = last + 1}
  local new = text_lines(message.text)
  local does = type(message.keyNote) == 'string' and message.keyNote or 'takes it'
  local key = config.accept_key and hints.label(label(config.accept_key), does)
  -- A block taller than gen_preview_lines is one line here, and the block in a preview window under it.
  local preview = n and gen.too_tall(new, buf)
  local note = message.note
  if preview then
    note = ('%d lines: %s'):format(#new, (message.note:gsub('^gen #%d+ · ', '')))
    note = ('gen #%d · %s'):format(n, note)
    key = table.concat(vim.tbl_filter(function(part) return part ~= nil end, {label(config.accept_key) and (label(config.accept_key) .. ' takes'), label(config.jump_key) and (label(config.jump_key) .. ' preview')}), ' · ')
  end
  if config.accept_key then
    vim.keymap.set('n', config.accept_key, M.accept, {buffer = buf, desc = 'Accept Pair\'s suggestion'})
  end
  -- JSON null arrives as vim.NIL: a suggestion in an answer to you is no remark.
  local remark = message.remark ~= vim.NIL and message.remark or nil
  local ids = draw.suggestion(buf, first, old, preview and {} or new, note, key)
  local suggestion = {buf = buf, ids = ids, old = old, new = new, remark = remark, insert = message.insert == true, action = message.action}
  suggestion.origin = type(message.origin) == 'string' and message.origin or 'pair' -- whose code it is once taken
  suggestion.gen, suggestion.piece, suggestion.preview = n, n and message.piece or nil, preview
  suggestion.line = message.insert and message.line + 1 or message.line
  suggestion.target = {buf = buf, ns = draw.suggest_ns, id = ids[1], suggestion = suggestion}
  for _, gone in ipairs(suggestions.add(suggestion, rows)) do drop_suggestion(gone) end
  -- The jump key goes to the first suggestion of an answer: where the accept key works. The next press goes on to
  -- the next one.
  if message.aim ~= false or not (state.target and state.target.suggestion) then aim(suggestion.target) end
  map_keys('jump', {{config.jump_key, M.jump, 'Go where Pair points'}})
  suggestion.below = message.insert and 0 or last - first -- its hint is under its last row, and the preview below that
  if preview then gen.preview(suggestion, first + suggestion.below, suggestion.line, false) end
  state.reading = nil
  redraw_status()
end

--- The daemon took back /gen request `message.gen` (/undo, or it was cancelled): its code still showing goes, and
--- so do its files still to review.
local function gen_drop(message)
  for _, suggestion in ipairs(vim.list_slice(suggestions.all())) do
    if suggestion.gen == message.gen then
      suggestion.quiet = true
      drop_suggestion(suggestion)
    end
  end
  genfiles.drop_gen(message.gen)
end

--- Your edit of rows `first`..`last` answers what Pair said: its words go, and so does a point on those lines.
local function edited(buf, first, last)
  forget_words(true)
  margin.edited(buf, first, last)
  for _, p in ipairs(vim.list_slice(state.points)) do
    local mark = p.buf == buf and vim.api.nvim_buf_get_extmark_by_id(buf, ns, p.ids.mark, {details = true})
    if mark and mark[1] and mark[1] <= last and (mark[3].end_row or mark[1]) >= first then forget_point(p) end
  end
end

local typing_sent = 0
local typing_at = 0 -- when you last changed a buffer: a dialog of /gen never opens right then
local function on_lines(_, buf, _, first, last, new_last)
  local origin = state.origins[buf] or 'user'
  if origin == 'user' then typing_at = now_ms() end
  -- A change by someone else than the one before it: what came before goes first, as its own edit.
  if state.pending[buf] and state.pending[buf].origin ~= origin then flush(buf) end
  local pending = state.pending[buf] or {from = first + 1, to = new_last, origin = origin}
  pending.from = math.min(pending.from, first + 1)
  pending.to = math.max(pending.to, new_last)
  pending.timer = pending.timer or vim.uv.new_timer()
  state.pending[buf] = pending
  owning.changed(buf, origin) -- generated code you change is yours
  pending.timer:start(config.debounce_ms, 0, vim.schedule_wrap(function()
    if state.pending[buf] ~= pending then return end -- flushed already (see flush_all)
    pending.timer:close()
    flush(buf)
  end))
  -- Editing the suggested lines yourself is how you ignore a suggestion.
  vim.schedule(function()
    for _, suggestion in ipairs(vim.list_slice(suggestions.all())) do
      if suggestion.buf == buf and not suggestions.still(suggestion) then drop_suggestion(suggestion) end
    end
    edited(buf, first, math.max(last, new_last))
  end)
  -- A cheap "still typing" signal, at most every half second, so Pair never interrupts mid-thought. Pair's own
  -- changes are no typing of yours.
  if origin == 'user' and now_ms() - typing_sent > 500 then
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

-- Pair reads a file: its gaze crosses the lines you see, and the statusline names the file a moment.
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
    if test.file == name then table.insert(signs, {line = test.line, ok = test.ok, changed = test.changed, glow = test.glow}) end
    local failure = type(test.failure) == 'table' and test.failure -- JSON null arrives as vim.NIL
    if failure and failure.file == name then table.insert(notes, {line = failure.line, text = failure.text, changed = test.changed}) end
    if test.file == name or (failure and failure.file == name) then table.insert(shown, test) end
  end
  local stale = state.run and state.run.state == 'run'
  draw.tests(buf, signs, notes, {stale = stale})
  -- A change rises from the background once, where it first shows.
  if not stale then
    for _, test in ipairs(shown) do test.changed, test.glow = false, false end
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
    for _, test in ipairs(state.results) do
      local was = before[test.file .. ':' .. test.name]
      test.changed = was ~= test.ok
      test.glow = test.ok and was == false -- it turned green
    end
  end
  state.run = {state = message.state, label = message.label, text = message.text, at = now_ms(), till = now_ms() + PASS_MS, red_since = message.redSince}
  if message.state == 'pass' then vim.defer_fn(redraw_status, PASS_MS + 50) end
  spin()
  show_all_tests()
  redraw_status()
end

-- Builds and runs: where the last one that crashed or printed compiler errors or warnings says (yours in the
-- terminal, or Pair's on save), until the next run of the same command. The jump key goes to the crash, else the
-- first error, else the first new warning.

local function show_places(buf)
  if not vim.api.nvim_buf_is_loaded(buf) then return end
  local name = vim.api.nvim_buf_get_name(buf)
  local here = vim.tbl_filter(function(place) return place.file == name end, state.places)
  draw.runs(buf, here)
  for _, place in ipairs(here) do place.changed = false end -- it rises once, where it first shows
end

show_all_places = function()
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do show_places(buf) end
end

--- The jump key goes to `place`, which an invisible mark follows through your edits. Nil: back to Pair's last
--- point, if the jump key went to the last run's place.
local function aim_at_place(place)
  local old = state.place_mark
  state.place_mark = nil
  if old then draw.erase(old.buf, {old.id}) end
  if state.target and state.target.place then aim(nil) end
  if not place then return end
  local buf = load(place.file)
  local row = math.min(place.line, vim.api.nvim_buf_line_count(buf)) - 1
  state.place_mark = {buf = buf, id = vim.api.nvim_buf_set_extmark(buf, ns, row, 0, {})}
  state.target = {buf = buf, ns = ns, id = state.place_mark.id, col = place.col ~= vim.NIL and place.col or nil, place = true}
  map_keys('jump', {{config.jump_key, M.jump, 'Go where Pair points'}})
end

local function on_run(message)
  local before = {}
  for _, place in ipairs(state.places) do before[place.file .. ':' .. place.line .. ':' .. place.text] = true end
  state.places = message.places or {}
  local news
  for _, place in ipairs(state.places) do
    place.changed = not before[place.file .. ':' .. place.line .. ':' .. place.text]
    if not news and (place.kind ~= 'warning' or place.new) then news = place end
  end
  aim_at_place(news)
  show_all_places()
end

-- The exploration loop: what the last build or run showed next to the one before, in the statusline. Once the hunt
-- is over, the debug lines you added for it are counted there, and the jump key goes to the first.
local function on_run_line(message)
  local debug = type(message.debug) == 'table' and message.debug or nil
  local before = state.run_line and state.run_line.debug
  state.run_line = {n = message.n, kind = message.kind, text = message.text, debug = debug, at = now_ms()}
  if debug and not (before and before.file == debug.file and before.line == debug.line) and not state.place_mark then
    aim_at_place({file = debug.file, line = debug.line})
  end
  redraw_status()
end

local function open_split(file, line)
  local window = vim.api.nvim_get_current_win()
  vim.cmd('belowright split ' .. vim.fn.fnameescape(file))
  pcall(vim.api.nvim_win_set_cursor, 0, {line, 0})
  vim.api.nvim_set_current_win(window) -- the split is for looking; your cursor stays where it was
end

--- The window the chat pane's jumps land in: the current one, unless it is a terminal (`:Pair chat` runs in one),
--- else the first window with a file.
local function work_window()
  local current = vim.api.nvim_get_current_win()
  if vim.bo[vim.api.nvim_win_get_buf(current)].buftype == '' then return current end
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if vim.bo[vim.api.nvim_win_get_buf(win)].buftype == '' then return win end
  end
  return current
end

--- The chat pane's `j`: goes to `message.file`:`message.line`, leaving a mark in the jumplist (Ctrl-O comes back).
local function go(message)
  local win = work_window()
  vim.api.nvim_set_current_win(win)
  vim.cmd("normal! m'")
  local buf = load(message.file)
  vim.bo[buf].buflisted = true
  vim.api.nvim_win_set_buf(win, buf)
  pcall(vim.api.nvim_win_set_cursor, win, {math.min(message.line, vim.api.nvim_buf_line_count(buf)), 0})
  vim.cmd('normal! zz')
end

--- Where a /gen request from the chat goes: the cursor, or the selection, in the window you work in.
local function gen_place(message)
  send({type = 'reply', id = message.id, result = gen.place_for(message.gen, work_window(), message.selection == true)})
end

--- The lines `@here` in the chat asks about: the last visual selection in the buffer you work in, else your line.
local function selection(message)
  local win = work_window()
  local buf = vim.api.nvim_win_get_buf(win)
  local file = vim.api.nvim_buf_get_name(buf)
  local result = vim.NIL
  if file ~= '' then
    local from, to = vim.api.nvim_buf_get_mark(buf, '<')[1], vim.api.nvim_buf_get_mark(buf, '>')[1]
    if from == 0 or to == 0 then
      local line = vim.api.nvim_win_get_cursor(win)[1]
      from, to = line, line
    end
    result = {file = file, from = math.min(from, to), to = math.max(from, to)}
  end
  send({type = 'reply', id = message.id, result = result})
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

local function take_back()
  state.role = 'navigator' -- edits on their way are refused from this key on
  vim.schedule(function()
    -- The take-back first: undoing a half-typed edit answers it with a refusal, which must not end the turn
    -- before the daemon knows the wheel is back.
    send({type = 'take_back'})
    if state.typing then state.typing() end
    vim.on_key(nil, ns)
    redraw_status()
  end)
end

-- While Pair keeps the wheel between its answers, a `:Pair` command (`:Pair ask and y to 20`) is how you talk to it
-- from here: the keys of a command line wait for it to end, and only one that is not Pair's takes the wheel back.
local COMMAND_MODES = {n = true, v = true, V = true, ['\22'] = true}
local PAIR_COMMAND = "^[%s%d,'<>%.%$%%]*Pair!?%s"

local function command_ended()
  local ended = state.commanding and not vim.v.event.abort and vim.fn.getcmdline():match(PAIR_COMMAND)
  state.commanding = nil
  if state.role == 'driver' and not ended then take_back() end
end

local function watch_keys(on)
  vim.on_key(on and function(key)
    if not pressed(key) then return end
    if state.role == 'driver' and not state.typing then
      if state.commanding then return end
      if key == ':' and COMMAND_MODES[vim.api.nvim_get_mode().mode] then
        state.commanding = true
        vim.api.nvim_create_autocmd('CmdlineLeave', {once = true, callback = command_ended})
        return
      end
    end
    if state.role == 'driver' then take_back() end -- a burst of keys takes the wheel back once
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
  -- The buffer before and after goes to the ledger, which can undo the edit later.
  local before = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
  local pair_done = as_pair(buf, 'pair') -- every line it types, and the undo of a half-typed edit, is Pair's
  state.typing = drive.type(buf, message.line - 1, math.min(message.endLine, count) - 1, text_lines(message.text), function(typed, from, to)
    state.typing = nil
    pair_done()
    local after = typed and vim.api.nvim_buf_get_lines(buf, 0, -1, false)
    reply(typed and {ok = true, from = from + 1, to = to + 1, before = before, after = after} or {error = 'the user has taken the wheel back'})
  end)
end

-- The hand-back line: Pair's words under the lines of its last edit, the mark on the lines of every edit it made,
-- how the check went in the sign column, and the key that undoes each edit. A check the run printed a line for comes
-- first: "✓ avg probe 1.3 · …". Like any words of Pair's, they go with your next edit.
local function handback(message)
  local buf = vim.fn.bufnr(message.file)
  if buf == -1 or not vim.api.nvim_buf_is_loaded(buf) then return end
  local signs = {pass = {style.glyphs.pass, 'PairStatusPass'}, fail = {style.glyphs.fail, 'PairFail'}}
  forget_words(false)
  map_teach()
  local last = math.min(message.endLine, vim.api.nvim_buf_line_count(buf)) - 1
  local text = message.text ~= '' and message.text or ('changed lines %d to %d'):format(message.line, message.endLine)
  if type(message.check) == 'string' and signs[message.tests] then
    text = ('%s %s · %s'):format(signs[message.tests][1], message.check, text)
  end
  local changes = type(message.changes) == 'table' and message.changes or {message}
  local spans = {}
  for _, change in ipairs(changes) do
    local at = vim.fn.bufnr(change.file)
    if at ~= -1 and vim.api.nvim_buf_is_loaded(at) then
      local to = math.min(change.endLine, vim.api.nvim_buf_line_count(at)) - 1
      table.insert(spans, {buf = at, id = draw.span(at, math.min(change.line - 1, to), to)})
    end
  end
  state.words = {
    buf = buf, row = last, undo = #changes > 1 and 'u undoes each edit' or 'u undoes it',
    text = text, sign = signs[message.tests], spans = spans,
  }
  draw_words(state.words)
  redraw_status()
end

-- The ledger undoes one of Pair's edits, or makes it again: merged into the buffer as it is now.
local function revert(message)
  local buf = load(message.file)
  local origin = type(message.origin) == 'string' and message.origin or 'pair' -- a /gen request's own: gen:#n
  local why = by_pair(buf, origin, function() return merge.apply(buf, message.base, message.other) end)
  if vim.fn.bufwinid(buf) ~= -1 then vim.cmd.redraw() end -- a change made here shows only at the next event
  send({type = 'reply', id = message.id, result = why and {error = why} or {ok = true}})
end

-- The chat pane prints Pair in the same accent as here, once Neovim has true colours to give.
local function send_accent()
  local color = vim.o.termguicolors and vim.api.nvim_get_hl(0, {name = 'PairAccent', link = false}).fg
  if color then send({type = 'accent', color = style.hex(color)}) end
end

local function hello()
  -- herdr's socket lets the daemon see your other agents, also when no chat pane runs; the herdr pane this Neovim
  -- runs in, if any, lets Pair show things in the Neovim whose pane has focus.
  local herdr = vim.env.HERDR_SOCKET_PATH and {socket = vim.env.HERDR_SOCKET_PATH} or nil
  -- The tmux pane it runs in, if any, lets Pair watch that tmux session's panes (src/tmux.mjs). Its pid names its
  -- own terminals, where the Driver's `type` may go (pane.lua).
  local tmux = vim.env.TMUX and vim.env.TMUX_PANE and {socket = vim.env.TMUX:match('^[^,]*'), pane = vim.env.TMUX_PANE} or nil
  send({
    type = 'hello', role = 'editor', cwd = vim.fn.getcwd(), herdr = herdr, pane = vim.env.HERDR_PANE_ID, tmux = tmux, pid = vim.fn.getpid(),
    buffers = true,
  })
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

-- Delight: a green after a red lights the statusline up once; when it is worth words, one line under yours says
-- what is now true, and goes after a few seconds, counted from when you are at the editor.

local pulse_timer

local function pulse()
  if not (config.motion and style.can_move()) then return end
  state.pulse = now_ms()
  pulse_timer = pulse_timer or vim.uv.new_timer()
  pulse_timer:start(0, 35, vim.schedule_wrap(function()
    if state.pulse and now_ms() - state.pulse > PULSE_MS then
      state.pulse = nil
      pulse_timer:stop()
    end
    redraw_status()
  end))
end

local function on_delight(message)
  if not message.calm then pulse() end -- a break hint after a commit says its line without the glow
  local text = type(message.text) == 'string' and message.text or ''
  local buf = vim.api.nvim_get_current_buf()
  if text == '' or state.words or not project_path(buf) then return end -- Pair's own words stay
  local words = {buf = buf, row = vim.api.nvim_win_get_cursor(0)[1] - 1, text = text}
  state.words = words
  draw_words(words)
  local function fade() vim.defer_fn(function() if state.words == words then forget_words(false) end end, DELIGHT_MS) end
  if earcons.focused then fade() else vim.api.nvim_create_autocmd('FocusGained', {once = true, callback = fade}) end
  redraw_status()
end

-- The morning pick-up: an empty Neovim (or a start screen) lands where the last session stopped, the statusline says
-- Pair catches up while its gaze reads there again, and one line under that line says what is left. The jump key
-- goes to the test that was failing then, or to that place when you had opened something else.

local START_SCREENS = {alpha = true, dashboard = true, snacks_dashboard = true, ministarter = true, starter = true}

local function empty_start()
  local buf = vim.api.nvim_get_current_buf()
  if START_SCREENS[vim.bo[buf].filetype] then return true end
  return vim.api.nvim_buf_get_name(buf) == '' and vim.bo[buf].buftype == '' and not vim.bo[buf].modified
    and vim.api.nvim_buf_line_count(buf) == 1 and vim.api.nvim_buf_get_lines(buf, 0, 1, false)[1] == ''
end

local function land(message)
  state.catching_up = true
  redraw_status()
  if not (config.land and empty_start()) then return end
  local buf = load(message.file)
  vim.api.nvim_win_set_buf(0, buf)
  vim.bo[buf].buflisted = true
  local row = math.min(message.line, vim.api.nvim_buf_line_count(buf)) - 1
  vim.api.nvim_win_set_cursor(0, {row + 1, draw.column(buf, row)})
  vim.cmd('normal! zz')
end

--- A place the jump key goes to, without a point drawn there.
local function aim_at(file, line)
  local buf = load(file)
  local row = math.min(line, vim.api.nvim_buf_line_count(buf)) - 1
  aim({buf = buf, ns = ns, id = vim.api.nvim_buf_set_extmark(buf, ns, row, 0, {})})
  map_keys('jump', {{config.jump_key, M.jump, 'Go where Pair points'}})
  return key_label('jump', config.jump_key)
end

local function pickup(message)
  state.catching_up = false
  local buf = vim.api.nvim_get_current_buf()
  local here = vim.api.nvim_buf_get_name(buf) == message.file
  local jump = type(message.jump) == 'table' and message.jump or nil
  local key
  if jump then
    key = aim_at(jump.file, jump.line)
    if key then key = key .. ' ' .. jump.what end
  elseif not here then
    key = aim_at(message.file, message.line)
    if key then key = key .. ' where you stopped' end
  end
  if not project_path(buf) then return redraw_status() end
  local row = here and math.min(message.line, vim.api.nvim_buf_line_count(buf)) - 1 or vim.api.nvim_win_get_cursor(0)[1] - 1
  forget_words(false)
  state.words = {buf = buf, row = row, text = message.text, key = key}
  draw_words(state.words)
  local span = here and type(message.code) == 'string' and draw.code(buf, row, message.code)
  if span then state.words.spans = {{buf = buf, id = span}} end
  redraw_status()
end

local handlers = {
  land = land,
  pickup = pickup,
  debrief = function(message) debrief.show(message.text) end,
  delight = on_delight,
  earcon = function(message) earcons.play(message.sound) end,
  look = look,
  point = point,
  open = open,
  read = read,
  buffers = function(message) send({type = 'reply', id = message.id, result = {buffers = buffers.unsaved(message.root)}}) end,
  suggest = suggest,
  accept = accept_action,
  go = go,
  selection = selection,
  edit = edit,
  handback = handback,
  interview = function(message)
    blank.on_interview(message, send)
    redraw_status()
  end,
  revert = revert,
  gen = gen.on_state,
  gen_ask = gen.on_ask,
  gen_debrief = gen.on_debrief,
  gen_drop = gen_drop,
  -- Code taken from /gen that is not yours yet: ┊ on its lines, until you edit them or :Pair own them.
  gen_marks = owning.on_marks,
  gen_unmark = owning.on_unmark,
  gen_place = gen_place,
  gen_where = function(message) send({type = 'reply', id = message.id, result = gen.where(message.gen) or vim.NIL}) end,
  -- /gen file: the files to review as pair://gen/<n>/<path> buffers, the list, and /undo of a file you wrote.
  gen_files = function(message)
    local result = genfiles.on_files(message)
    if message.id then send({type = 'reply', id = message.id, result = result}) end
  end,
  gen_review = genfiles.on_review,
  -- /gen try: the sample opens in a split; :Pair gen tries picks one of those still kept.
  gen_try = gentry.on_try,
  gen_tries = gentry.on_tries,
  -- /gen scaffold: done in its copy; its copy deleted; a file of it kept elsewhere (the chat's /keep).
  gen_scaffold = function(message)
    gentry.on_scaffold(message)
    genfiles.refresh_open()
  end,
  gen_copy_gone = function(message)
    gentry.on_copy_gone(message)
    genfiles.refresh_open()
  end,
  gen_kept = function() genfiles.refresh_open() end,
  gen_unwrite = function(message) send({type = 'reply', id = message.id, result = genfiles.unwrite(message)}) end,
  -- Without herdr: Pair's pane, your terminals and typing into one of them, all in this Neovim (pane.lua).
  pane = function(message) pane.request(message, function(result) send({type = 'reply', id = message.id, result = result}) end) end,
  terminals = function(message) send({type = 'reply', id = message.id, result = pane.listing()}) end,
  terminal_text = function(message) send({type = 'reply', id = message.id, result = pane.text(message.buf, message.lines)}) end,
  type_text = function(message) send({type = 'reply', id = message.id, result = pane.type(message.buf, message.text)}) end,
  ledger = ledger.show,
  ledger_detail = ledger.detail,
  ledger_changed = ledger.changed,
  remark = on_remark,
  held = on_held,
  unheld = forget_held,
  teaching = on_teaching,
  tests = on_tests,
  run = on_run,
  run_line = on_run_line,
  runs = function(message)
    runs.show(message, function(count)
      if state.run_line then state.run_line.debug = nil end
      redraw_status()
      vim.notify(('Pair: removed %d debug line%s, unsaved; u in each buffer brings them back'):format(count, count == 1 and '' or 's'))
    end)
  end,
  context = card.update,
  trail = function(message) trail.show(message, function() send({type = 'forget_trail'}) end) end,
  margin = margin.show,
  decision_log = margin.log,
  tasks = function(message) tasks.show(message, send) end,
  agents = agents.on_relay,
  agent_list = agents.on_list,
  thinking = function(message)
    state.thinking = message.on
    spin()
    redraw_status()
  end,
  clear = function()
    forget_held()
    clear_points()
    clear_suggestions()
    gen.reset()
    forget_words(false)
    blank.on_interview({done = true})
    margin.clear()
    state.remark = nil
    state.run_line = nil
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
  -- The session ended (/end in the chat, or by itself): edits still waiting were made in it, not in the next one.
  ended = function()
    flush_all(true)
    hello()
  end,
  listening = function(message) listen.level(message.level) end,
  heard = listen.heard,
  -- The answer to what you said: Pair's words under the line you asked on, in place of yours.
  answer = function(message)
    if message.text == '' and not message.pointed then return listen.unanswered() end
    local buf, row = listen.answered()
    if not buf or type(message.text) ~= 'string' or message.text == '' then return end
    forget_words(false)
    map_teach()
    state.words = {buf = buf, row = row, text = message.text, jump = message.pointed == true}
    draw_words(state.words)
    redraw_status()
  end,
  -- The answer to a question you typed (:Pair ask, the chat): its first lines under the line it was about, the
  -- whole of it in the chat.
  answered = function(message)
    if not config.answers or type(message.text) ~= 'string' or message.text == '' then return end
    local buf = vim.fn.bufnr(message.file)
    if buf == -1 or not vim.api.nvim_buf_is_loaded(buf) then return end
    forget_words(false)
    map_teach()
    local row = math.min(message.line, vim.api.nvim_buf_line_count(buf)) - 1
    state.words = {buf = buf, row = row, text = message.text, jump = message.pointed == true, max = ANSWER_LINES, more = 'the chat has the rest'}
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
  send_cursor()
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
  gen.reset() -- a restarted daemon has stopped its /gen requests, and asks nothing
  if state.role == 'driver' then set_role('navigator') end -- a restarted daemon has ended the hand-over
  if blank.status() then -- nor does its :Pair new: an answer now would reach no one
    blank.on_interview({done = true})
    vim.notify('Pair: the daemon went away, so the questions of :Pair new stop here; :Pair new starts again', vim.log.levels.WARN)
  end
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
  clear_suggestions()
  forget_words(false)
  margin.clear()
  unmap_feedback()
  agents.clear()
  state.results, state.run, state.thinking, state.run_line = {}, nil, false, nil
  spin()
  show_all_tests()
  on_run({places = {}})
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
  local generating = gen.status()
  if run and run.state == 'run' then
    return {glyph = style.spinner[spinner.frame], text = run.label, hl = 'PairStatus', text_hl = 'PairStatusDim'}
  elseif generating then
    return {glyph = g.voice, text = 'pair · ' .. generating.text, hl = 'PairStatus', text_hl = 'PairStatusDim'}
  elseif state.thinking then
    return {glyph = style.spinner[spinner.frame], text = 'pair · thinking', hl = 'PairStatus', text_hl = 'PairStatusDim'}
  elseif state.catching_up then
    return {glyph = g.away, text = 'pair · catching up', hl = 'PairStatusDim', text_hl = 'PairStatusDim'}
  elseif run and run.state == 'fail' then
    local red = type(run.red_since) == 'number' and math.floor((os.time() * 1000 - run.red_since) / 60000) or 0
    return {glyph = g.fail, text = run.text .. (red >= LONG_RED_MIN and (' · red %d min'):format(red) or ''), hl = 'PairFail', text_hl = 'PairStatusDim'}
  elseif run and run.state == 'error' then
    return {glyph = g.away, text = run.label .. ' · ' .. run.text, hl = 'PairStatusWarn', text_hl = 'PairStatusDim'}
  elseif run and run.state == 'pass' and now_ms() < run.till and not (state.run_line and state.run_line.at >= run.at) then
    return {glyph = g.pass, text = run.label .. ' · ' .. run.text, hl = 'PairStatusPass', text_hl = 'PairStatusDim'}
  elseif margin.flash() then
    return {glyph = g.decision, text = 'logged · ' .. margin.flash(), hl = 'PairStatus', text_hl = 'PairStatusDim'}
  end
  local asking = blank.status() or (suggestions.inserting() and 'a suggestion')
  if asking then return {glyph = g.voice, text = 'pair · ' .. asking, hl = 'PairStatus', text_hl = 'PairStatusDim'} end
  local line = state.run_line and now_ms() - state.run_line.at < RUN_LINE_MS and state.run_line
  local parts = {line and line.text or 'pair'}
  if line and line.debug then
    local key = key_label('jump', config.jump_key)
    table.insert(parts, ('%d debug line%s from run %d left'):format(line.debug.count, line.debug.count == 1 and '' or 's', line.debug.run) .. (key and (' · ' .. key) or ''))
  end
  if state.role and state.role ~= 'navigator' then table.insert(parts, state.role) end
  if state.level and state.level ~= 'normal' then table.insert(parts, state.level) end
  if state.held then table.insert(parts, 'held thought · ' .. (key_label('jump', config.jump_key) or ':Pair jump')) end
  local notes = margin.status()
  if notes then table.insert(parts, notes) end
  local generated = owning.status()
  if generated then table.insert(parts, generated) end
  local lit = state.words or state.held or (line and (line.kind == 'same' or line.kind == 'moved'))
  if line and (line.kind == 'crash' or line.kind == 'error') then
    return {glyph = g.fail, text = table.concat(parts, ' · '), hl = 'PairFail', text_hl = 'PairStatusDim'}
  end
  return {glyph = g.voice, text = table.concat(parts, ' · '), hl = lit and 'PairStatus' or 'PairStatusDim', text_hl = 'PairStatusDim'}
end

--- The statusline's text, for example `● pair`, `● reading worker.go`, `⠹ go test ./...`, `⠹ pair · thinking`, `✗ 1 failing · TestX`,
--- `● pair · 5 notes in the margin`, `◆ logged · docs/decisions.md` or `◌ pair · partner down`.
function M.status()
  local parts = status_parts()
  if not parts then return '' end
  local relayed = agents.status_parts()
  return parts.glyph .. ' ' .. parts.text .. (relayed and ('  ' .. relayed.glyph .. ' ' .. relayed.text) or '')
end

--- The same with its highlight groups, for a 'statusline' expression or a statusline plugin's section.
function M.statusline()
  local parts = status_parts()
  if not parts then return '' end
  if state.pulse then
    local t = math.min(1, (now_ms() - state.pulse) / PULSE_MS)
    parts.hl = style.between('PairStatusGlow', parts.hl, t, {statusline = true})
    parts.text_hl = style.between('PairStatusGlow', parts.text_hl, t, {statusline = true})
  end
  local function part(p) return ('%%#%s#%s %%#%s#%s'):format(p.hl, p.glyph, p.text_hl, (p.text:gsub('%%', '%%%%'))) end
  local relayed = agents.status_parts()
  return part(parts) .. (relayed and ('  ' .. part(relayed)) or '') .. '%*'
end

-- Each command gets the words after its name and, with a range (:'<,'>Pair ask ...), the lines it covers.
local commands = {
  start = function(arg)
    if M.connect() and arg ~= '' then send({type = 'goal', text = arg}) end
  end,
  goal = function(arg) send({type = 'goal', text = arg}) end,
  ask = function(arg, selection)
    -- The answer starts under the line you are on: Pair knows it before the cursor has moved even once.
    if not selection then send_cursor() end
    send({type = 'ask', text = arg, selection = selection})
  end,
  level = function(arg)
    state.level = arg
    send({type = 'level', level = arg})
  end,
  scout = function() send({type = 'role', role = 'scout'}) end,
  navigate = function() send({type = 'role', role = 'navigator'}) end,
  drive = function(arg, selection) send({type = 'drive', text = arg, selection = selection}) end,
  -- Pair keeps the wheel for each request until you take it back.
  ['drive!'] = function(arg, selection) send({type = 'drive', text = arg, selection = selection, keep = true}) end,
  new = function(arg)
    if not M.connect() then return vim.notify('Pair: not connected, so no questions yet; :Pair new again once it is', vim.log.levels.WARN) end
    blank.start(arg, send)
  end,
  jump = function() M.jump() end,
  trail = function() send({type = 'trail'}) end,
  runs = function() send({type = 'runs'}) end,
  accept = M.accept,
  dismiss = M.dismiss,
  today = function() if M.connect() then ledger.open() end end,
  useful = function() feedback(true, state.remark) end,
  noise = function() feedback(false, state.remark) end,
  why = function() M.teach() end,
  agents = agents.request,
  -- /gen: `:Pair gen` asks in a dialog, `:Pair gen [here|file] <what>` asks at once, `:Pair gen +` opens the compose
  -- window; with a range, over those lines (in a note, the lines are the request). `:Pair gen cancel` stops it,
  -- `:Pair gen list` lists the files of /gen file requests to review and of scaffolds to keep, `:Pair gen run` runs
  -- the try you are in (else the newest) again, `:Pair gen tries` picks a try folder to open, and `:Pair gen drop`
  -- deletes the newest scaffold's copy.
  gen = function(arg, selection)
    if not M.connect() then return vim.notify('Pair: not connected, so no /gen yet; :Pair gen again once it is', vim.log.levels.WARN) end
    if arg == 'cancel' then return send({type = 'gen_cancel'}) end
    if arg == 'list' then return genfiles.open() end
    if arg == 'run' then return gentry.run() end
    if arg == 'tries' then return send({type = 'gen_tries'}) end
    if arg == 'drop' then return send({type = 'gen_copy_delete'}) end
    local compose = arg == '+' or vim.startswith(arg, '+ ')
    gen.ask(compose and vim.trim(arg:sub(2)) or arg, selection, compose)
  end,
  -- `:Pair keep [path]`: the /gen try file you are in (else the newest try's) moves into the project, as a buffer
  -- to review that :w takes; in a file of a scaffold's copy (or with the path of one), that file is kept.
  keep = function(arg)
    if not M.connect() then return vim.notify('Pair: not connected; :Pair keep again once it is', vim.log.levels.WARN) end
    gentry.keep(arg)
  end,
  -- Generated code you took becomes yours: `:Pair own` all of it in this file, `:'<,'>Pair own` that of the lines,
  -- `:Pair own <path>` that of a file, `:Pair own!` all of it in the project.
  own = function(arg, selection)
    if not M.connect() then return vim.notify('Pair: not connected; :Pair own again once it is', vim.log.levels.WARN) end
    if selection then return send({type = 'gen_own', ids = owning.ids_in(vim.api.nvim_get_current_buf(), selection.from, selection.to)}) end
    local file = arg ~= '' and vim.fn.fnamemodify(vim.fn.expand(arg), ':p') or project_path(0)
    if not file then return vim.notify('Pair: :Pair own works in a file of the project; :Pair own! owns all of it') end
    send({type = 'gen_own', file = file})
  end,
  ['own!'] = function()
    if not M.connect() then return vim.notify('Pair: not connected; :Pair own! again once it is', vim.log.levels.WARN) end
    send({type = 'gen_own', all = true})
  end,
  -- The brief /gen runs against: `:Pair brief` in a note pins it (elsewhere shows the brief), `:Pair brief <path>`
  -- pins that note, `:Pair brief off` leaves the note out.
  brief = function(arg)
    if not M.connect() then return vim.notify('Pair: not connected; :Pair brief again once it is', vim.log.levels.WARN) end
    if arg == 'off' then return send({type = 'brief', off = true}) end
    if arg ~= '' then return send({type = 'brief', file = vim.fn.fnamemodify(vim.fn.expand(arg), ':p')}) end
    local file = vim.bo.filetype == 'markdown' and project_path(0)
    send(file and {type = 'brief', file = file} or {type = 'brief'})
  end,
  -- Your last edits belong to the session that ends: its debrief counts them, and the next one starts empty.
  ['end'] = function()
    flush_all()
    send({type = 'end'})
  end,
  first = function(arg) send({type = 'first', text = arg}) end,
  context = function()
    if not state.channel then return vim.notify('Pair: not connected, so there is no card; :Pair start connects', vim.log.levels.WARN) end
    card.open(send)
  end,
  open = function()
    if state.open_request then open_split(state.open_request.file, state.open_request.line) end
    state.open_request = nil
  end,
  clear = function()
    clear_points()
    forget_words(false)
    margin.clear()
    if blank.status() then
      blank.on_interview({done = true})
      send({type = 'new_stop'})
    end
  end,
  decide = function() margin.decide() end,
  tasks = function()
    local file = project_path(0)
    if not file then return vim.notify('Pair: :Pair tasks reads the note in this buffer; open one first') end
    send({type = 'tasks', file = file})
  end,
  stop = M.disconnect,
  -- The chat in a terminal buffer on the right, for Neovim without herdr (or beside it).
  chat = function()
    M.connect()
    pane.chat(config.socket or default_socket())
  end,
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
  margin.setup({decide_key = config.decide_key, link_key = config.link_key, send = send})
  earcons.enabled, earcons.volume = config.sounds, config.sound_volume
  ledger.send = send
  ledger.rate = feedback
  listen.setup({mode = config.listen_mode, hold_ms = config.listen_hold_ms, release_ms = config.listen_release_ms, silence_ms = config.listen_silence_ms})
  agents.setup({send = send, map_keys = map_keys, unmap_keys = unmap_keys, key_label = key_label, redraw_status = redraw_status}, config.agents_key)
  gen.setup({input = config.gen_input, preview_lines = config.gen_preview_lines, key = config.gen_key}, {
    send = send, redraw_status = redraw_status, project_path = project_path, label = label,
    typing = function() return now_ms() - typing_at < 1500 end,
    accept_key = function() return config.accept_key end,
    accept = function(suggestion) accept(suggestion) end,
    files_status = genfiles.status,
  })
  genfiles.setup({send = send, redraw_status = redraw_status, label = label, decide_key = config.decide_key})
  owning.setup({send = send, event = event, redraw_status = redraw_status, connected = function() return state.channel ~= nil end})
  gentry.setup({send = send, run_key = config.try_run_key})
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
  -- Going to one of your :terminal buffers makes it the one the Driver's `type` goes to, as herdr's focus does.
  vim.api.nvim_create_autocmd({'TermOpen', 'BufEnter', 'TermEnter'}, {group = group, callback = function(args)
    if state.channel and pane.is_yours(args.buf) then event({kind = 'terminal', pane = pane.id(args.buf)}) end
  end})
  -- Going into a terminal, out of it or to another buffer moves the focus Pair knows (src/nvim-panes.mjs), and
  -- a terminal closing ends the one it watched.
  vim.api.nvim_create_autocmd({'BufEnter', 'TermEnter', 'TermLeave', 'TermClose'}, {group = group, callback = function()
    if state.channel then send({type = 'panes'}) end
  end})
  vim.api.nvim_create_autocmd('CursorHold', {group = group, callback = send_cursor})
  -- Scrolling the window you are in is reading, which counts as active time like the cursor moving.
  local scrolled_at = 0
  vim.api.nvim_create_autocmd('WinScrolled', {group = group, callback = function()
    local delta = vim.v.event[tostring(vim.api.nvim_get_current_win())]
    if not state.channel or not delta or (delta.topline == 0 and delta.leftcol == 0) then return end
    local file = project_path(0)
    if not file or now_ms() - scrolled_at < SCROLL_EVERY_MS then return end
    scrolled_at = now_ms()
    event({kind = 'scroll', file = file})
  end})
  -- Whether you are at the editor: an answer to what you said is read aloud only while you are away.
  -- And whether Pair's sounds may play (earcons.lua).
  vim.api.nvim_create_autocmd({'FocusGained', 'FocusLost'}, {group = group, callback = function(args)
    earcons.focused = args.event == 'FocusGained'
    send({type = 'focus', on = earcons.focused})
  end})
  -- Alt-g asks Pair for code (/gen), at the cursor or, in Visual mode, over the selected lines; only where it is free.
  for _, mode in ipairs({'n', 'x'}) do
    if config.gen_key and config.gen_key ~= '' and vim.fn.maparg(config.gen_key, mode) == '' then
      vim.keymap.set(mode, config.gen_key, function()
        if not state.channel then return vim.notify('Pair: not connected, so no /gen yet; :Pair start connects') end
        local range
        if mode == 'x' then
          local from, to = vim.fn.line('v'), vim.fn.line('.')
          range = project_path(0) and {from = math.min(from, to), to = math.max(from, to)} or nil
          vim.cmd('normal! \27') -- out of Visual mode first: the dialog takes the keys
        end
        gen.ask('', range, false)
      end, {desc = 'Ask Pair for code (/gen)'})
    end
  end
  -- Push-to-talk, in Normal mode and, about the selected lines, in Visual mode; only where the key is free.
  for _, mode in ipairs({'n', 'x'}) do
    if config.listen_key and config.listen_key ~= '' and vim.fn.maparg(config.listen_key, mode) == '' then
      vim.keymap.set(mode, config.listen_key, function()
        if not state.channel then return vim.notify('Pair: not connected') end
        local file = mode == 'x' and project_path(0)
        local from, to = vim.fn.line('v'), vim.fn.line('.')
        local selection = file and {file = file, from = math.min(from, to), to = math.max(from, to)} or nil
        listen.press(send, (config.listen_key:gsub('^<(.*)>$', '%1')), selection)
      end, {desc = config.listen_mode == 'toggle' and 'Press to speak to Pair, again to ask' or 'Hold to speak to Pair'})
    end
  end
  -- Saving is when Pair runs your tests, if you set a command for the project (see docs/tests-on-save.md).
  vim.api.nvim_create_autocmd('BufWritePost', {group = group, callback = function(args)
    local file = state.channel and project_path(args.buf)
    if file then event({kind = 'save', file = file}) end
    owning.keep(args.buf) -- where its generated code is, as saved
  end})
  -- A file you open after a run shows its results too, and its generated code not yours yet, found by its text.
  vim.api.nvim_create_autocmd('BufReadPost', {group = group, callback = function(args)
    show_tests(args.buf)
    show_places(args.buf)
    owning.read(args.buf)
  end})
  -- Before a buffer is read again (:e) or goes, where its generated code is now is kept.
  vim.api.nvim_create_autocmd('BufReadPre', {group = group, callback = function(args) owning.keep(args.buf) end})
  vim.api.nvim_create_autocmd('BufUnload', {group = group, callback = function(args) owning.unload(args.buf) end})
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
  if config.searches then searches.watch(group, function(search) event(vim.tbl_extend('force', {kind = 'search'}, search)) end) end
  places.setup(group, event)
  -- Sessions only where you work: not for a Neovim without a screen (an agent's or a script's), nor in the temp folder.
  local scratch = vim.startswith(vim.fn.getcwd() .. '/', vim.fs.normalize(vim.uv.os_tmpdir()) .. '/')
  if config.auto_connect and #vim.api.nvim_list_uis() > 0 and not scratch then M.connect() end
end

return M
