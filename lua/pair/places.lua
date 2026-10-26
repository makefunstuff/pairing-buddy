-- Where you have been in Neovim, for the context card and the Partner: the listed buffers and the jumplist. (Your
-- searches come from searches.lua.)
local M = {}

local MAX = 10

-- Set by setup: sends one event to the daemon.
local emit = function() end
local sent = nil -- the last places event, to send only changes
local entered = {} -- when each buffer was last entered, in ms: getbufinfo's lastused has whole seconds only

local function file_of(buf)
  if not vim.api.nvim_buf_is_valid(buf) or vim.bo[buf].buftype ~= '' then return nil end
  local name = vim.api.nvim_buf_get_name(buf)
  return name ~= '' and vim.fn.fnamemodify(name, ':p') or nil
end

--- The listed file buffers, the one used last first.
local function buffers()
  local infos = vim.fn.getbufinfo({buflisted = 1})
  local function used(info) return entered[info.bufnr] or info.lastused * 1000 end
  table.sort(infos, function(a, b) return used(a) > used(b) end)
  local files = {}
  for _, info in ipairs(infos) do
    local file = file_of(info.bufnr)
    if file and #files < MAX then table.insert(files, file) end
  end
  return files
end

--- The jumplist up to where you are, newest first, each place once.
local function jumps()
  local list, pos = unpack(vim.fn.getjumplist())
  local places, seen = {}, {}
  for i = math.min(pos, #list), 1, -1 do
    local jump = list[i]
    local file = file_of(jump.bufnr)
    local key = file and (file .. ':' .. jump.lnum)
    if key and not seen[key] and #places < MAX then
      seen[key] = true
      table.insert(places, {file = file, line = jump.lnum})
    end
  end
  return places
end

--- Sends the buffers and jumps when they changed since the last time (or always, with `force`).
function M.send(force)
  local event = {kind = 'places', buffers = buffers(), jumps = jumps()}
  local encoded = vim.json.encode(event)
  if not force and encoded == sent then return end
  sent = encoded
  emit(event)
end

--- `send_event(event)` sends to the daemon; `group` is the plugin's autocommand group.
function M.setup(group, send_event)
  emit = send_event
  vim.api.nvim_create_autocmd({'BufEnter', 'CursorHold'}, {group = group, callback = function(args)
    if args.event == 'BufEnter' then
      local seconds, micros = vim.uv.gettimeofday()
      entered[args.buf] = seconds * 1000 + micros / 1000
    end
    M.send(false)
  end})
end

return M
