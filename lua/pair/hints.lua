-- First-use hints: a key Pair offers says what it does until you have used it once (`M-j goes there`), and is
-- just the key after that (`M-j`). The keys you have used are kept in Neovim's state directory, so a hint shows
-- in your first sessions, not in every one.
local M = {}

local used = nil -- key label -> true, loaded on first need

local function path()
  return vim.fn.stdpath('state') .. '/pair/keys.json'
end

local function load()
  if used then return used end
  local ok, decoded = pcall(function() return vim.json.decode(table.concat(vim.fn.readfile(path()), '\n')) end)
  used = ok and type(decoded) == 'table' and decoded or {}
  return used
end

--- Whether you have used the key labelled `key` (for example M-j) before.
function M.known(key)
  return load()[key] == true
end

--- `key` with what it does, until you have used it: `M-j goes there`, then `M-j`.
function M.label(key, does)
  return M.known(key) and key or key .. ' ' .. does
end

--- You used the key labelled `key`: from now on its hint is the key alone.
function M.used(key)
  if not key or M.known(key) then return end
  used[key] = true
  pcall(function()
    vim.fn.mkdir(vim.fs.dirname(path()), 'p')
    vim.fn.writefile({vim.json.encode(used)}, path())
  end)
end

return M
