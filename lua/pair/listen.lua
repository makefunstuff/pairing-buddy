-- Push-to-talk: hold the listen key and speak, let go, and Pair answers under your line. A terminal sends no
-- key-up, only the key again and again while it is held, so letting go is when that stops. A short press is a tap:
-- Pair listens until you press the key again. Neovim drops the key-release events of the kitty keyboard protocol
-- before a plugin sees them, so there is no real key-up to use. Where the repeats cannot be trusted, mode 'toggle'
-- does not use them to tell letting go: a press starts, the next press asks. A press another one follows within
-- release_ms is a repeat, however long the terminal waited before it began to repeat, so holding the key that
-- started it asks nothing. With silence_ms, a recording you do not hold also asks after
-- that long a pause in what you say. Under your line, a meter shows that it hears you, then the words it
-- heard, which Pair's answer replaces. The daemon records and transcribes (see src/listen.mjs).
local style = require('pair.style')

local M = {}

M.ns = vim.api.nvim_create_namespace('pair_listen')
-- Terminals start repeating a held key after 200 to 600 ms, then repeat every 30 to 50 ms.
-- hold_ms: no repeat within this long after the press, it was a tap. release_ms: no repeat for this long, the key is
-- up (in 'toggle', a press this soon before or after another is a repeat, and does nothing; after a press stopped
-- the listening, a press within hold_ms is that key's first repeat). silence_ms: false, or how long
-- a pause after you spoke asks, in a recording you do not hold.
local opts = {mode = 'hold', hold_ms = 650, release_ms = 220, silence_ms = false}
local SPEAKING = 0.35 -- a meter level (0 to 1, about -42 dB) at and above which you are speaking
local TICK_MS = 40
local NOTHING_MS = 1500 -- how long "heard nothing" stays
local METER = {'▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'}
local BARS = 10

-- phase: 'listening' (recording), 'hearing' (whisper writes it down), 'heard' (Pair is asked), 'unanswered' (it said
-- nothing), or nil.
-- mode while listening: nil until it is known, then 'hold' or 'tap' (a tap or 'toggle': until the next press).
-- key: the listen key as its hint names it, like M-t. spoke: you were heard speaking; quiet_at: since when you are
-- not. asking_at: in 'toggle', when the press that asks came, until no repeat follows it. stopped_at: when a press
-- last stopped the listening.
local state = {phase = nil, mode = nil, pressed_at = 0, last_at = 0, buf = nil, mark = nil, levels = {}, text = nil, timer = nil, frame = 1, key = '', spoke = false, quiet_at = nil, asking_at = nil, stopped_at = -math.huge}

local function now_ms() return math.floor(vim.uv.now()) end

local function redraw_status() pcall(vim.cmd, 'redrawstatus!') end

local function meter()
  local bars = {}
  for i = 1, BARS do
    local level = state.levels[#state.levels - BARS + i] or 0
    table.insert(bars, METER[math.max(1, math.min(#METER, math.floor(level * #METER + 0.5)))])
  end
  return table.concat(bars)
end

--- The line under yours: what Pair hears now, as chunks after the indent.
local function chunks()
  local g = style.glyphs
  if state.phase == 'listening' then
    local again = opts.silence_ms and (state.key .. ' again or pause to ask') or (state.key .. ' again to ask')
    local hint = state.mode == 'tap' and again or state.mode == 'hold' and 'let go to ask' or ''
    return {{g.listen .. ' ', 'PairAccent'}, {meter(), 'PairAccent'}, {'  listening', 'PairNote'}, {hint ~= '' and ('   ' .. hint) or '', 'PairKey'}}
  elseif state.phase == 'hearing' then
    return {{style.spinner[state.frame] .. ' ', 'PairAccent'}, {'hearing', 'PairNote'}}
  elseif state.phase == 'unanswered' then
    return {{style.glyphs.away .. ' ', 'PairKey'}, {'no answer · the chat says why', 'PairKey'}}
  elseif state.text == '' then
    return {{style.glyphs.away .. ' ', 'PairKey'}, {'heard nothing', 'PairKey'}}
  end
  return {{'› ', 'PairKey'}, {state.text, 'PairHeard'}}
end

local function draw()
  local buf = state.buf
  if not (buf and vim.api.nvim_buf_is_valid(buf)) then return end
  local row = state.mark and vim.api.nvim_buf_get_extmark_by_id(buf, M.ns, state.mark, {})[1]
  if not row then return end
  local line = chunks()
  local indent = vim.api.nvim_buf_call(buf, function() return vim.fn.indent(row + 1) end)
  table.insert(line, 1, {string.rep(' ', math.max(indent, 0))})
  vim.api.nvim_buf_set_extmark(buf, M.ns, row, 0, {id = state.mark, virt_lines = {line}, priority = 20})
end

local function stop_timer()
  if state.timer then state.timer:close() end
  state.timer = nil
end

local function clear()
  stop_timer()
  if state.buf and vim.api.nvim_buf_is_valid(state.buf) then vim.api.nvim_buf_clear_namespace(state.buf, M.ns, 0, -1) end
  state.phase, state.mode, state.mark, state.text, state.levels, state.spoke, state.quiet_at = nil, nil, nil, nil, {}, false, nil
  redraw_status()
end

local function finish(send)
  stop_timer()
  state.phase = 'hearing'
  send({type = 'listen', action = 'stop'})
  draw()
  redraw_status()
  -- The spinner turns until the words come back.
  state.timer = vim.uv.new_timer()
  state.timer:start(80, 80, vim.schedule_wrap(function()
    if state.phase ~= 'hearing' then return end
    state.frame = state.frame % #style.spinner + 1
    draw()
    redraw_status()
  end))
end

--- How the key works: `mode` 'hold' (hold it, or tap it twice) or 'toggle' (press, then press again), `hold_ms`,
--- `release_ms` and `silence_ms` (see above). What is wrong is said, and left as it was.
function M.setup(o)
  o = o or {}
  if o.mode ~= nil and o.mode ~= 'hold' and o.mode ~= 'toggle' then
    vim.notify(string.format("Pair: listen_mode is 'hold' or 'toggle', not %s", vim.inspect(o.mode)), vim.log.levels.WARN)
    o.mode = nil
  end
  for _, name in ipairs({'hold_ms', 'release_ms', 'silence_ms'}) do
    local v = o[name]
    if v ~= nil and not (type(v) == 'number' and v > 0) and not (name == 'silence_ms' and v == false) then
      vim.notify(string.format('Pair: listen_%s is a number of milliseconds%s, not %s', name, name == 'silence_ms' and ' or false' or '', vim.inspect(v)), vim.log.levels.WARN)
      o[name] = nil
    end
  end
  for _, name in ipairs({'mode', 'hold_ms', 'release_ms', 'silence_ms'}) do
    if o[name] ~= nil then opts[name] = o[name] end
  end
end

--- The listen key, pressed or repeating while held. `key` is how its name reads in the hint, like M-t.
function M.press(send, key, selection)
  local now = now_ms()
  if state.phase == 'listening' then
    if opts.mode == 'toggle' then
      -- A press right after another is a repeat: the key is held, and the press before it asks nothing either.
      -- Else it asks, once release_ms has passed without a repeat (see the timer).
      state.asking_at = now - state.last_at >= opts.release_ms and now or nil
      state.last_at = now
      return
    end
    if state.mode == 'tap' then
      state.last_at = now
      return finish(send)
    end
    state.mode, state.last_at = 'hold', now -- a repeat: the key is held
    return draw()
  end
  -- The repeats of a key still held after it stopped the listening (a long second tap) start nothing: the first
  -- comes a repeat delay after the press, the others right after each other.
  if now - state.last_at < opts.release_ms or (opts.mode == 'toggle' and now - state.stopped_at < opts.hold_ms) then
    state.last_at = now
    return
  end
  clear()
  local row = vim.api.nvim_win_get_cursor(0)[1] - 1
  state.buf = vim.api.nvim_get_current_buf()
  state.mark = vim.api.nvim_buf_set_extmark(state.buf, M.ns, row, 0, {})
  state.phase, state.pressed_at, state.last_at, state.key, state.asking_at = 'listening', now, now, key, nil
  if opts.mode == 'toggle' then state.mode = 'tap' end
  send({type = 'listen', action = 'start', selection = selection})
  draw()
  redraw_status()
  state.timer = vim.uv.new_timer()
  state.timer:start(TICK_MS, TICK_MS, vim.schedule_wrap(function()
    if state.phase ~= 'listening' then return end
    local t = now_ms()
    if state.mode == nil and t - state.pressed_at > opts.hold_ms then
      state.mode = 'tap'
      draw()
    elseif state.mode == 'hold' and t - state.last_at > opts.release_ms then
      finish(send)
    elseif state.asking_at and t - state.asking_at >= opts.release_ms then
      state.stopped_at, state.asking_at = state.asking_at, nil
      finish(send)
    elseif state.mode == 'tap' and opts.silence_ms and state.spoke and state.quiet_at and t - state.quiet_at > opts.silence_ms then
      finish(send)
    end
  end))
end

--- Drops what is being recorded or heard: nothing is asked.
function M.cancel(send)
  if state.phase == 'listening' then send({type = 'listen', action = 'cancel'}) end
  clear()
end

function M.listening() return state.phase == 'listening' end

--- One step of the meter: how loud the last tenth of a second was, 0 to 1.
function M.level(level)
  if state.phase ~= 'listening' then return end
  if level >= SPEAKING then
    state.spoke, state.quiet_at = true, nil
  elseif not state.quiet_at then
    state.quiet_at = now_ms()
  end
  table.insert(state.levels, level)
  if #state.levels > BARS then table.remove(state.levels, 1) end
  draw()
end

--- The line goes after a moment.
local function fade_out()
  local mark = state.mark
  vim.defer_fn(function() if state.mark == mark then clear() end end, NOTHING_MS)
end

--- What the daemon heard: `text` ('' for nothing), `error`, or `state = 'hearing'` while whisper works.
function M.heard(message)
  if message.state == 'hearing' then return end
  if type(message.error) == 'string' then
    clear()
    return vim.notify('Pair could not listen: ' .. message.error, vim.log.levels.WARN)
  end
  stop_timer()
  state.phase, state.text = 'heard', message.text or ''
  draw()
  redraw_status()
  if state.text == '' then fade_out() end
end

--- Pair said nothing to what was heard (its model failed, say): the line says so a moment, the chat says why.
function M.unanswered()
  if state.phase ~= 'heard' then return end
  state.phase = 'unanswered'
  draw()
  fade_out()
end

--- Where the answer to what was heard goes: the buffer and row of the line it was asked on; the heard line goes.
function M.answered()
  local buf, mark = state.buf, state.mark
  local row = mark and buf and vim.api.nvim_buf_is_valid(buf) and vim.api.nvim_buf_get_extmark_by_id(buf, M.ns, mark, {})[1]
  clear()
  if row then return buf, row end
end

--- The statusline while Pair listens or hears, else nil.
function M.status()
  if state.phase == 'listening' then
    return {glyph = style.glyphs.listen, text = 'pair · listening', hl = 'PairStatus', text_hl = 'PairStatusDim'}
  elseif state.phase == 'hearing' then
    return {glyph = style.spinner[state.frame], text = 'pair · hearing', hl = 'PairStatus', text_hl = 'PairStatusDim'}
  end
end

return M
