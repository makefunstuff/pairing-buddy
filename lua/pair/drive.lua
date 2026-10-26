-- The Driver's edit, typed while you watch. The text it replaces is struck through for a moment, then the new text
-- arrives as ghost text at reading speed, with Pair's cursor at its end. A line enters the buffer only once it is
-- whole, so the buffer, and your language server, never see half a line. Every line it enters joins one undo step;
-- stopped halfway, that step is undone: the edit is one change, or none.
local style = require('pair.style')

local M = {}

M.ns = vim.api.nvim_create_namespace('pair_drive')
M.motion = true -- setup's `motion` option: without it, the edit lands at once

local FRAME_MS = 24 -- the slowest typing: a character a frame, about 40 a second
local TYPING_MS = 4000 -- a longer edit types faster, to take about this long
local MIN_FRAME_MS = 10 -- the fastest frame; after that, more characters a frame
local STRIKE_MS = 350 -- what goes shows struck through this long before the typing starts
local LINE_MS = 120 -- the pause after each line, unless there are many

--- The lines `old` and `new` keep at the start (a count) and the ones between that differ, in each.
local function hunk(old, new)
  local head, tail = 0, 0
  while head < #old and head < #new and old[head + 1] == new[head + 1] do head = head + 1 end
  while tail < #old - head and tail < #new - head and old[#old - tail] == new[#new - tail] do tail = tail + 1 end
  return head, vim.list_slice(old, head + 1, #old - tail), vim.list_slice(new, head + 1, #new - tail)
end

local function continuation(text, i)
  local byte = text:byte(i)
  return byte and byte >= 0x80 and byte < 0xc0
end

--- The bytes line `old` and line `new` keep at the start and at the end, never splitting a character.
local function kept(old, new)
  local head, tail = 0, 0
  while head < #old and head < #new and old:byte(head + 1) == new:byte(head + 1) do head = head + 1 end
  while head > 0 and continuation(new, head + 1) do head = head - 1 end
  while tail < #old - head and tail < #new - head and old:byte(#old - tail) == new:byte(#new - tail) do tail = tail + 1 end
  while tail > 0 and continuation(new, #new - tail + 1) do tail = tail - 1 end
  return head, tail
end

--- The ends (in bytes) of `text` as it is typed, `step` characters at a time, after the first `from` bytes.
local function typed(text, from, step)
  local ends, count, starts = {}, 0, vim.str_utf_pos(text)
  for i = 1, #starts do
    local stop = (starts[i + 1] or #text + 1) - 1
    if stop > from then
      count = count + 1
      if count % step == 0 or stop == #text then table.insert(ends, stop) end
    end
  end
  return ends
end

local function chars(lines)
  local count = 0
  for _, line in ipairs(lines) do count = count + vim.fn.strchars(vim.trim(line)) end
  return count
end

--- Shows a frame now: Neovim does not repaint for changes made in a timer until something else happens.
local function show(buf)
  if vim.fn.bufwinid(buf) ~= -1 then vim.cmd.redraw() end
end

local function undo_seq(buf)
  return vim.api.nvim_buf_call(buf, function() return vim.fn.undotree().seq_cur end)
end

--- Replaces rows `first`..`last` (0-based, inclusive) of `buf` with `new`, typed as ghost text, then calls
--- `done(true, from, to)` with the rows it changed (0-based; a deletion's is the row above it). Returns a function
--- that stops it halfway: it undoes what was entered and calls `done(false)`.
function M.type(buf, first, last, new, done)
  local old = vim.api.nvim_buf_get_lines(buf, first, last + 1, false)
  local head, gone, come = hunk(old, new)
  local before, after = undo_seq(buf), nil -- the undo states around Pair's change
  local tab = string.rep(' ', vim.bo[buf].tabstop)

  -- One whole-line change; each after the first joins the first's undo step.
  local function change(fn)
    vim.api.nvim_buf_call(buf, function()
      -- Setting 'undolevels' starts a new undo step, so `u` undoes Pair's change and nothing of yours.
      if after then pcall(vim.cmd.undojoin) else vim.o.undolevels = vim.o.undolevels end
      fn()
    end)
    after = undo_seq(buf)
  end

  local function mark(row, col, spec)
    return vim.api.nvim_buf_set_extmark(buf, M.ns, row, col, spec)
  end

  local from, to = nil, math.max(first + head - 1, 0) -- the rows it changed, so far
  local function edited(row)
    from, to = from or row, row
    vim.api.nvim_buf_clear_namespace(buf, M.ns, row, row + 1)
    mark(row, 0, {sign_text = style.glyphs.mark, sign_hl_group = 'PairSign', priority = 20})
  end

  local ghost -- the extmark of the text being typed
  local function ghost_at(row, col, spec)
    ghost = vim.api.nvim_buf_set_extmark(buf, M.ns, row, col, vim.tbl_extend('force', spec, {id = ghost, priority = 300}))
  end
  local function chunks(text)
    local indent, rest = text:gsub('\t', tab):match('^(%s*)(.*)$')
    return {{indent}, {rest, 'PairSuggestAdd'}, {' ', 'PairCursor'}}
  end

  local total = math.max(1, chars(come))
  local frame = math.max(MIN_FRAME_MS, math.min(FRAME_MS, math.floor(TYPING_MS / total)))
  local step = math.max(1, math.ceil(total * frame / TYPING_MS))
  local pause = #come > 12 and 1 or math.floor(LINE_MS / frame)

  local function script()
    local row = first + head
    -- What goes: the changed part of each line that becomes another, and whole lines that go.
    for i, text in ipairs(gone) do
      local strike_from, strike_to = #text:match('^%s*'), #text
      if come[i] then
        local keep_head, keep_tail = kept(text, come[i])
        strike_from, strike_to = keep_head, #text - keep_tail
      end
      mark(row + i - 1, 0, {sign_text = style.glyphs.mark, sign_hl_group = 'PairSign', line_hl_group = 'PairPoint', priority = 20})
      if strike_to > strike_from then mark(row + i - 1, strike_from, {end_col = strike_to, hl_group = 'PairSuggestDelete', priority = 210}) end
    end
    if #gone > 0 then coroutine.yield(math.floor(STRIKE_MS / frame)) end
    for i = 1, math.max(#gone, #come) do
      local old_line, new_line = gone[i], come[i]
      if old_line and new_line then
        -- A line that becomes another: the new text grows after the struck one, then replaces it.
        local keep_head, keep_tail = kept(old_line, new_line)
        local text = new_line:sub(keep_head + 1, #new_line - keep_tail)
        for _, stop in ipairs(typed(text, 0, step)) do
          ghost_at(row, #old_line - keep_tail, {virt_text = chunks(text:sub(1, stop)), virt_text_pos = 'inline'})
          coroutine.yield(0)
        end
        change(function() vim.api.nvim_buf_set_text(buf, row, keep_head, row, #old_line - keep_tail, {text}) end)
        edited(row)
        row = row + 1
      elseif old_line then
        vim.api.nvim_buf_clear_namespace(buf, M.ns, row, row + 1)
        change(function() vim.api.nvim_buf_set_lines(buf, row, row + 1, false, {}) end)
      else
        -- A new line: its indent at once, as a person's editor would, then the rest.
        local count = vim.api.nvim_buf_line_count(buf)
        local below = row >= count
        for _, stop in ipairs(typed(new_line, #new_line:match('^%s*'), step)) do
          ghost_at(below and count - 1 or row, 0, {virt_lines = {chunks(new_line:sub(1, stop))}, virt_lines_above = not below})
          coroutine.yield(0)
        end
        if ghost then vim.api.nvim_buf_del_extmark(buf, M.ns, ghost) end
        change(function() vim.api.nvim_buf_set_lines(buf, row, row, false, {new_line}) end)
        edited(row)
        row = row + 1
      end
      ghost = nil -- the next line's ghost is a new extmark
      coroutine.yield(pause)
    end
  end

  if not M.motion or (#gone == 0 and #come == 0) then
    if #gone + #come > 0 then change(function() vim.api.nvim_buf_set_lines(buf, first, last + 1, false, new) end) end
    if #come > 0 then from, to = first + head, first + head + #come - 1 end
    done(true, from or to, to)
    return function() end
  end

  local co, timer, wait = coroutine.create(script), vim.uv.new_timer(), 0
  local function finish(finished)
    if timer:is_closing() then return end
    timer:close()
    if not vim.api.nvim_buf_is_valid(buf) then return done(false) end
    vim.api.nvim_buf_clear_namespace(buf, M.ns, 0, -1)
    -- Halfway, Pair's lines are undone, if nothing changed the buffer since; your cursor stays where it was.
    if not finished and after and undo_seq(buf) == after then
      local cursors = {}
      for _, win in ipairs(vim.fn.win_findbuf(buf)) do cursors[win] = vim.api.nvim_win_get_cursor(win) end
      vim.api.nvim_buf_call(buf, function() vim.cmd('silent undo ' .. before) end)
      local count = vim.api.nvim_buf_line_count(buf)
      for win, cursor in pairs(cursors) do pcall(vim.api.nvim_win_set_cursor, win, {math.min(cursor[1], count), cursor[2]}) end
    end
    show(buf)
    done(finished, from or to, to)
  end
  timer:start(0, frame, vim.schedule_wrap(function()
    if timer:is_closing() then return end
    if wait > 0 then wait = wait - 1 return end
    if not vim.api.nvim_buf_is_valid(buf) then return finish(false) end
    local ok, frames = coroutine.resume(co)
    if not ok then
      finish(false)
      return vim.notify('Pair: its edit stopped: ' .. tostring(frames), vim.log.levels.ERROR)
    end
    show(buf)
    if coroutine.status(co) == 'dead' then return finish(true) end
    wait = frames or 0
  end))
  return function() finish(false) end
end

return M
