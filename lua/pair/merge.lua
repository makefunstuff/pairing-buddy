-- Undoing one of Pair's edits later, after other edits: a three-way merge of lines. Pair's edit took the buffer
-- from `other` to `base` (or back, to make it again), and the buffer is `base` with your changes since. Where yours
-- and Pair's touch different lines, the buffer gets Pair's undone and keeps yours; where they touch the same lines,
-- nothing changes.
local M = {}

--- What changed from lines `a` to lines `b`: hunks {from, to, lines}, each replacing rows from..to-1 (0-based) of
--- `a` with `lines`; from == to inserts before row `from`.
local function hunks(a, b)
  local out = {}
  local text = function(lines) return table.concat(lines, '\n') .. '\n' end
  for _, h in ipairs(vim.diff(text(a), text(b), {result_type = 'indices'})) do
    local a_start, a_count, b_start, b_count = unpack(h)
    -- A count of 0 puts the start on the line before the change, as in a unified diff.
    local from = a_count == 0 and a_start or a_start - 1
    local b_from = b_count == 0 and b_start or b_start - 1
    table.insert(out, {from = from, to = from + a_count, lines = vim.list_slice(b, b_from + 1, b_from + b_count)})
  end
  return out
end

local function same(x, y)
  return x.from == y.from and x.to == y.to and vim.deep_equal(x.lines, y.lines)
end

--- Whether two hunks of one text touch the same lines: they overlap, or both insert at one place.
local function clash(x, y)
  if x.from == x.to and y.from == y.to then return x.from == y.from end
  return x.from < y.to and y.from < x.to
end

--- `current` with the change from `base` to `other` merged in, or nil when it clashes with a change `current` made
--- to `base`. A change both made is made once.
function M.merge(base, current, other)
  local ours, all = hunks(base, current), {}
  for _, theirs in ipairs(hunks(base, other)) do
    local done = false
    for _, mine in ipairs(ours) do
      if same(mine, theirs) then done = true
      elseif clash(mine, theirs) then return nil end
    end
    if not done then table.insert(all, theirs) end
  end
  vim.list_extend(all, ours)
  -- In order; at one place an insertion comes before the lines a hunk replaces there.
  table.sort(all, function(x, y) return x.from < y.from or (x.from == y.from and x.to < y.to) end)
  local merged, at = {}, 0
  for _, h in ipairs(all) do
    vim.list_extend(merged, vim.list_slice(base, at + 1, h.from))
    vim.list_extend(merged, h.lines)
    at = h.to
  end
  vim.list_extend(merged, vim.list_slice(base, at + 1, #base))
  return merged
end

--- Merges the change from `base` to `other` into `buf` as one undo step, unsaved, touching only the lines it
--- changes. Returns nil, or why it could not.
function M.apply(buf, base, other)
  local current = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
  local merged = M.merge(base, current, other)
  if not merged then return 'you changed those lines since' end
  local changes = hunks(current, merged)
  vim.api.nvim_buf_call(buf, function()
    for i = #changes, 1, -1 do -- from the bottom, so the rows above stay where they are
      -- Setting 'undolevels' starts a new undo step; each change after the first joins it.
      if i == #changes then vim.o.undolevels = vim.o.undolevels else pcall(vim.cmd.undojoin) end
      vim.api.nvim_buf_set_lines(buf, changes[i].from, changes[i].to, false, changes[i].lines)
    end
  end)
end

return M
