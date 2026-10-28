-- Pair's suggestions: a few at once, in any of your buffers, each drawn as its own ghost diff (draw.suggestion) until
-- you accept it, dismiss it or edit its lines. A new one replaces one it overlaps, and the oldest goes beyond MAX.
-- A /gen piece (`gen`) is asked for: it does not count toward MAX, and it and the others never push each other out.
-- Only the list: init.lua maps the keys and tells the daemon.
local draw = require('pair.draw')

local M = {}

local MAX = 5
local list = {} -- oldest first: {buf, ids, old, new, remark, insert, action, target, gen, piece}

--- The rows (0-based, end exclusive) under `suggestion` now, which may have moved since it was shown. A suggestion
--- to insert lines is marked on the line they go under.
function M.range(suggestion)
  local first = draw.row(suggestion.buf, suggestion.ids[1], draw.suggest_ns)
  if not first then return nil end
  if suggestion.insert then first = first + 1 end
  return first, first + #suggestion.old
end

--- Whether the lines under `suggestion` are still the ones it would replace.
function M.still(suggestion)
  local first, last = M.range(suggestion)
  return first ~= nil and vim.deep_equal(vim.api.nvim_buf_get_lines(suggestion.buf, first, last, false), suggestion.old)
end

function M.all() return list end

--- Whether `buf` shows any suggestion.
function M.any_in(buf)
  for _, suggestion in ipairs(list) do
    if suggestion.buf == buf then return true end
  end
  return false
end

--- Takes `suggestion` off the list and out of its buffer; false when it was not there.
function M.remove(suggestion)
  for i, other in ipairs(list) do
    if other == suggestion then
      table.remove(list, i)
      draw.erase(suggestion.buf, suggestion.ids, draw.suggest_ns)
      return true
    end
  end
  return false
end

local function overlaps(a, b)
  if a.buf ~= b.buf or (a.gen ~= nil) ~= (b.gen ~= nil) then return false end
  local first, last = M.range(a)
  return first ~= nil and b.first < math.max(last, first + 1) and first < math.max(b.last, b.first + 1)
end

--- Adds `suggestion`, shown on rows `rows.first`..`rows.last` of `rows.buf` (0-based, end exclusive). Returns the
--- ones it pushes out, for the caller to drop: those on the same lines, and the oldest beyond MAX.
function M.add(suggestion, rows)
  rows.gen = suggestion.gen
  local gone = vim.tbl_filter(function(other) return overlaps(other, rows) end, list)
  table.insert(list, suggestion)
  if suggestion.gen then return gone end
  local kept = #vim.tbl_filter(function(other) return not other.gen end, list) - #gone
  for _, other in ipairs(list) do
    if kept <= MAX then break end
    if not other.gen and not vim.tbl_contains(gone, other) then
      table.insert(gone, other)
      kept = kept - 1
    end
  end
  return gone
end

--- The suggestion the accept key acts on in `buf` with the cursor on `row`: the one on that line, else the newest
--- in `buf`, else nil.
function M.at(buf, row)
  local newest
  for _, suggestion in ipairs(list) do
    if suggestion.buf == buf then
      local first, last = M.range(suggestion)
      if first and row >= first and row < math.max(last, first + 1) then return suggestion end
      newest = suggestion
    end
  end
  return newest
end

--- The one after `suggestion` in the list, round to the first: where the jump key goes next. Nil when it is alone.
function M.after(suggestion)
  if #list < 2 then return nil end
  for i, other in ipairs(list) do
    if other == suggestion then return list[i % #list + 1] end
  end
  return list[1]
end

--- The first shown for remark `remark`, or nil.
function M.of_remark(remark)
  for _, suggestion in ipairs(list) do
    if suggestion.remark == remark then return suggestion end
  end
end

--- Whether one of them inserts the first slice of :Pair new, for the statusline.
function M.inserting()
  for _, suggestion in ipairs(list) do
    if suggestion.insert and not suggestion.gen then return true end
  end
  return false
end

return M
