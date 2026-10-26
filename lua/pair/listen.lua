-- Push-to-talk: hold the listen key and speak, let go, and Pair answers under your line. A terminal sends no
-- key-up, only the key again and again while it is held, so letting go is when that stops. A short press is a tap:
-- Pair listens until you press the key again. Under your line, a meter shows that it hears you, then the words it
-- heard, which Pair's answer replaces. The daemon records and transcribes (see src/listen.mjs).
local style = require('pair.style')

local M = {}

M.ns = vim.api.nvim_create_namespace('pair_listen')
-- Terminals start repeating a held key after 200 to 600 ms, then repeat every 30 to 50 ms.
local HOLD_MS = 650 -- no repeat within this long after the press: it was a tap
local RELEASE_MS = 220 -- no repeat for this long: the key is up
local TICK_MS = 40
local NOTHING_MS = 1500 -- how long "heard nothing" stays
local METER = {'▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'}
local BARS = 10

-- phase: 'listening' (recording), 'hearing' (whisper writes it down), 'heard' (Pair is asked), or nil.
-- mode while listening: nil until it is known, then 'hold' or 'tap'.
-- key: the listen key as its hint names it, like M-t.
local state = {phase = nil, mode = nil, pressed_at = 0, last_at = 0, buf = nil, mark = nil, levels = {}, text = nil, timer = nil, frame = 1, key = ''}

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
    local hint = state.mode == 'tap' and (state.key .. ' again to ask') or state.mode == 'hold' and 'let go to ask' or ''
    return {{g.listen .. ' ', 'PairAccent'}, {meter(), 'PairAccent'}, {'  listening', 'PairNote'}, {hint ~= '' and ('   ' .. hint) or '', 'PairKey'}}
  elseif state.phase == 'hearing' then
    return {{style.spinner[state.frame] .. ' ', 'PairAccent'}, {'hearing', 'PairNote'}}
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
  state.phase, state.mode, state.mark, state.text, state.levels = nil, nil, nil, nil, {}
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

--- The listen key, pressed or repeating while held. `key` is how its name reads in the hint, like M-t.
function M.press(send, key, selection)
  local now = now_ms()
  if state.phase == 'listening' then
    if state.mode == 'tap' then
      state.last_at = now
      return finish(send)
    end
    state.mode, state.last_at = 'hold', now -- a repeat: the key is held
    return draw()
  end
  -- The repeats of a key still held after it stopped the listening (a long second tap) start nothing.
  if now - state.last_at < RELEASE_MS then
    state.last_at = now
    return
  end
  clear()
  local row = vim.api.nvim_win_get_cursor(0)[1] - 1
  state.buf = vim.api.nvim_get_current_buf()
  state.mark = vim.api.nvim_buf_set_extmark(state.buf, M.ns, row, 0, {})
  state.phase, state.pressed_at, state.last_at, state.key = 'listening', now, now, key
  send({type = 'listen', action = 'start', selection = selection})
  draw()
  redraw_status()
  state.timer = vim.uv.new_timer()
  state.timer:start(TICK_MS, TICK_MS, vim.schedule_wrap(function()
    if state.phase ~= 'listening' then return end
    local t = now_ms()
    if state.mode == nil and t - state.pressed_at > HOLD_MS then
      state.mode = 'tap'
      draw()
    elseif state.mode == 'hold' and t - state.last_at > RELEASE_MS then
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
  table.insert(state.levels, level)
  if #state.levels > BARS then table.remove(state.levels, 1) end
  draw()
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
  if state.text == '' then
    local mark = state.mark
    vim.defer_fn(function() if state.mark == mark then clear() end end, NOTHING_MS)
  end
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
