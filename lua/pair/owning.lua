-- Owning generated code (see docs/gen.md#owning-generated-code): code you took from a /gen request is marked with a
-- thin ┊ in the sign column, part by part (its lines between blank lines), until it is yours. A part is yours once
-- you change a line of it, or with :Pair own (a range, a file, or ! for all). Pair's own changes to it (the Driver,
-- another request) leave it Pair's. Deleting all of a part's lines makes it gone, neither yours nor Pair's.
--
-- The daemon keeps each part with its text and the line it was last seen on (src/owning.mjs). A part is an extmark
-- here; a buffer loaded again (:e, a restart of Neovim) finds it again by its text within NEAR lines of that line,
-- and one that is not there any more is gone.
local style = require('pair.style')

local M = {}

M.ns = vim.api.nvim_create_namespace('pair_generated')

local NEAR = 20 -- a part whose line moved this far or less is still found by its text (src/owning.mjs's NEAR)

-- `send(message)` talks to the daemon, `event(fields)` sends an event, `redraw_status()` redraws the statusline: set by setup.
-- `connected()` says whether the daemon hears what is sent.
local deps = {send = function() end, event = function() end, redraw_status = function() end, connected = function() return true end}

local known = {} -- absolute path -> id -> {id, gen, file, line, text}: the daemon's parts, where they were last seen
local placed = {} -- buf -> extmark id -> part: those shown in a loaded buffer
local changed = {} -- buf -> {user = true|nil}: a check of its parts is due, and whether you made a change in it
local unsent = {own = {}, gone = {}} -- ids that became yours or gone while the daemon was away: sent once it is back

--- Tells the daemon that the parts `ids` are yours (`kind` 'own') or gone; kept while it is away.
local function tell(kind, ids)
  if #ids == 0 then return end
  if not deps.connected() then return vim.list_extend(unsent[kind], ids) end
  deps.send(kind == 'own' and {type = 'gen_own', ids = ids, how = 'edit'} or {type = 'gen_gone', ids = ids})
end

function M.setup(given) deps = vim.tbl_extend('force', deps, given) end

local function buf_of(file)
  local buf = vim.fn.bufnr(file)
  return buf ~= -1 and vim.api.nvim_buf_is_loaded(buf) and buf or nil
end

--- The row (0-based) of `buf` where the lines `text` start, nearest to `line` (1-based) within NEAR lines; nil when gone.
local function find(buf, text, line)
  local count = vim.api.nvim_buf_line_count(buf)
  local from = math.max(0, line - 1 - NEAR)
  local lines = vim.api.nvim_buf_get_lines(buf, from, math.min(count, line - 1 + NEAR + #text), false)
  local function at(start)
    for i, one in ipairs(text) do
      if lines[start - from + i] ~= one then return false end
    end
    return true
  end
  for d = 0, NEAR do
    for _, start in ipairs(d == 0 and {line - 1} or {line - 1 - d, line - 1 + d}) do
      if start >= 0 and start + #text <= count and at(start) then return start end
    end
  end
end

--- The rows a part spans now: first and last (0-based), and its lines; nil once all of its lines are gone.
local function span(buf, extmark)
  local mark = vim.api.nvim_buf_get_extmark_by_id(buf, M.ns, extmark, {details = true})
  if not mark[1] then return nil end
  local row, col, details = mark[1], mark[2], mark[3]
  if details.end_row == row and details.end_col == col then return nil end
  return row, details.end_row, vim.api.nvim_buf_get_lines(buf, row, details.end_row + 1, false)
end

--- Where the parts of `buf` are now, for the Watcher: it says nothing about lines that are not yours yet.
local function report(buf)
  local file = vim.api.nvim_buf_get_name(buf)
  local marks = {}
  for extmark, part in pairs(placed[buf] or {}) do
    local first, last = span(buf, extmark)
    if first then table.insert(marks, {id = part.id, gen = part.gen, from = first + 1, to = last + 1}) end
  end
  deps.event({kind = 'generated', file = file, marks = marks})
end

--- Shows `part` in `buf`, found by its text near its line. False when it is not there any more.
local function place(buf, part)
  local row = find(buf, part.text, part.line)
  if not row then return false end
  local last = row + #part.text - 1
  local extmark = vim.api.nvim_buf_set_extmark(buf, M.ns, row, 0, {
    end_row = last, end_col = #part.text[#part.text],
    sign_text = style.glyphs.generated, sign_hl_group = 'PairGenerated', priority = 5, -- under any other sign of Pair's
  })
  placed[buf] = placed[buf] or {}
  placed[buf][extmark] = part
  part.line = row + 1
  return true
end

local function unplace(buf, extmark)
  pcall(vim.api.nvim_buf_del_extmark, buf, M.ns, extmark)
  if placed[buf] then placed[buf][extmark] = nil end
end

--- Shows the parts known for `buf`'s file that it does not show yet. With `read` (the buffer was just read from its
--- file), those not found are gone; else they wait for the next read: another Neovim may have them unsaved.
local function show(buf, read)
  local file = vim.api.nvim_buf_get_name(buf)
  local shown, gone = {}, {}
  for _, part in pairs(placed[buf] or {}) do shown[part.id] = true end
  for id, part in pairs(known[file] or {}) do
    if not shown[id] and not place(buf, part) and read then
      table.insert(gone, id)
      known[file][id] = nil
    end
  end
  tell('gone', gone)
  report(buf)
  deps.redraw_status()
end

--- The daemon's parts not yours yet (with `all`, all of them: the others are not Pair's any more), shown where loaded.
function M.on_marks(message)
  local held = {} -- yours or gone while the daemon was away: not Pair's to show again
  if message.all then
    for kind, ids in pairs(unsent) do
      for _, id in ipairs(ids) do held[id] = true end
      unsent[kind] = {}
      tell(kind, ids)
    end
    local ids = {}
    for _, part in ipairs(message.marks or {}) do ids[part.id] = true end
    for buf, parts in pairs(placed) do
      for extmark, part in pairs(parts) do
        if not ids[part.id] and vim.api.nvim_buf_is_valid(buf) then unplace(buf, extmark) end
      end
    end
    known = {}
  end
  local files = {}
  for _, part in ipairs(message.marks or {}) do
    if held[part.id] then goto continue end
    known[part.file] = known[part.file] or {}
    known[part.file][part.id] = {id = part.id, gen = part.gen, file = part.file, line = part.line, text = part.text}
    files[part.file] = true
    ::continue::
  end
  for file in pairs(files) do
    local buf = buf_of(file)
    if buf then show(buf) end
  end
  if message.all then
    for buf in pairs(placed) do
      if vim.api.nvim_buf_is_valid(buf) and not files[vim.api.nvim_buf_get_name(buf)] then report(buf) end
    end
  end
end

--- Parts that are yours now, or gone: their ┊ goes, in every buffer.
function M.on_unmark(message)
  local ids = {}
  for _, id in ipairs(message.ids or {}) do ids[id] = true end
  for _, parts in pairs(known) do
    for id in pairs(parts) do
      if ids[id] then parts[id] = nil end
    end
  end
  for buf, parts in pairs(placed) do
    local any = false
    for extmark, part in pairs(parts) do
      if ids[part.id] then
        unplace(buf, extmark)
        any = true
      end
    end
    if any and vim.api.nvim_buf_is_valid(buf) then report(buf) end
  end
  deps.redraw_status()
end

--- Compares each part of `buf` with its text: one you changed is yours now, one Pair changed is still Pair's.
local function check(buf)
  local due = changed[buf]
  changed[buf] = nil
  if not (due and vim.api.nvim_buf_is_valid(buf) and placed[buf]) then return end
  local owned, gone = {}, {}
  for extmark, part in pairs(placed[buf]) do
    local first, _, lines = span(buf, extmark)
    if not first then
      table.insert(gone, part.id)
    elseif not vim.deep_equal(lines, part.text) then
      if due.user then table.insert(owned, part.id) else part.text = lines end
    end
    if first then part.line = first + 1 end
  end
  local file = vim.api.nvim_buf_get_name(buf)
  for _, list in ipairs({owned, gone}) do
    for _, id in ipairs(list) do
      for extmark, part in pairs(placed[buf]) do
        if part.id == id then unplace(buf, extmark) end
      end
      if known[file] then known[file][id] = nil end
    end
  end
  tell('own', owned)
  tell('gone', gone)
  if #owned + #gone > 0 then
    report(buf)
    deps.redraw_status()
  end
end

--- A change to `buf` by `origin` ('user' for yours): its parts are checked once the change is in.
function M.changed(buf, origin)
  if not placed[buf] or next(placed[buf]) == nil then return end
  local due = changed[buf]
  changed[buf] = due or {}
  if origin == 'user' then changed[buf].user = true end
  if not due then vim.schedule(function() check(buf) end) end
end

--- The parts of `buf` as they are now, kept with the daemon (a save, an unload) and here, so a buffer loaded
--- again finds them by their text where they were.
function M.keep(buf)
  if changed[buf] then check(buf) end -- a change still to check (a formatter on save) is judged first
  if not placed[buf] or next(placed[buf]) == nil or not vim.api.nvim_buf_is_valid(buf) then return end
  local file = vim.api.nvim_buf_get_name(buf)
  local marks = {}
  for extmark, part in pairs(placed[buf]) do
    local first, _, lines = span(buf, extmark)
    if first then
      part.line, part.text = first + 1, lines
      known[file] = known[file] or {}
      known[file][part.id] = part
      table.insert(marks, {id = part.id, line = part.line, text = part.text})
    end
  end
  if #marks > 0 then deps.send({type = 'gen_marks_at', marks = marks}) end
end

--- `buf` was read (opened, or loaded again): its parts are shown again from where they were last seen.
function M.read(buf)
  if placed[buf] then
    for extmark in pairs(placed[buf]) do unplace(buf, extmark) end
    placed[buf] = nil
  end
  vim.api.nvim_buf_clear_namespace(buf, M.ns, 0, -1)
  if known[vim.api.nvim_buf_get_name(buf)] then show(buf, true) end
end

--- `buf` goes (unloaded or wiped): what it showed is kept, and shown again when it is read.
function M.unload(buf)
  M.keep(buf)
  placed[buf], changed[buf] = nil, nil
end

--- Where the Watcher's skip comes from after an edit: the parts of `buf` as they are now.
function M.report(buf)
  if placed[buf] and next(placed[buf]) ~= nil then report(buf) end
end

--- How many lines of `buf` are not yours yet.
function M.count(buf)
  local lines = 0
  for extmark in pairs(placed[buf] or {}) do
    local first, last = span(buf, extmark)
    if first then lines = lines + last - first + 1 end
  end
  return lines
end

--- The ids of the parts of `buf` on rows `from`..`to` (1-based).
function M.ids_in(buf, from, to)
  local ids = {}
  for extmark, part in pairs(placed[buf] or {}) do
    local first, last = span(buf, extmark)
    if first and first + 1 <= to and last + 1 >= from then table.insert(ids, part.id) end
  end
  return ids
end

--- The statusline part: `┊ 12 generated` in a buffer with code not yours yet, else nil.
function M.status()
  local lines = M.count(vim.api.nvim_get_current_buf())
  return lines > 0 and ('%s %d generated'):format(style.glyphs.generated, lines) or nil
end

--- Pair restarted its session or this Neovim disconnected: nothing is shown until the daemon says again.
function M.reset()
  for buf, parts in pairs(placed) do
    if vim.api.nvim_buf_is_valid(buf) then
      for extmark in pairs(parts) do unplace(buf, extmark) end
    end
  end
  placed, known, changed = {}, {}, {}
end

return M
