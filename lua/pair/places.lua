-- Where you have been in Neovim, for the context card and the Partner: the listed buffers, the jumplist, and the
-- searches you made with Telescope or / and what you opened from them. Telescope is only watched (its prompt buffer
-- and the window you land in), never patched: a search counts once you go somewhere from it.
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

local function here()
  return {buf = vim.api.nvim_get_current_buf(), line = vim.fn.line('.')}
end

local function search(tool, query, results, from)
  local now = here()
  if query == '' or not file_of(now.buf) or (from and now.buf == from.buf and now.line == from.line) then return end -- nothing came of it
  emit({kind = 'search', tool = tool, query = query, results = results, file = file_of(now.buf), line = now.line})
end

-- Telescope: the picker's title, the prompt and the number of results as you leave it, then where you land.
local function watch_telescope(prompt_buf)
  local from = here()
  local seen = {}
  local function look()
    local ok, picker = pcall(function() return require('telescope.actions.state').get_current_picker(prompt_buf) end)
    if not ok or not picker then return end
    seen.tool = picker.prompt_title
    seen.query = picker:_get_prompt()
    seen.results = picker.manager and picker.manager:num_results() or nil
  end
  vim.api.nvim_create_autocmd({'TextChangedI', 'TextChanged', 'CursorMovedI'}, {buffer = prompt_buf, callback = look})
  vim.api.nvim_create_autocmd('BufLeave', {buffer = prompt_buf, once = true, callback = function()
    look()
    -- The selection opens its file after the picker has closed.
    vim.defer_fn(function()
      if seen.query then search(seen.tool or 'Telescope', seen.query, seen.results, from) end
    end, 50)
  end})
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
  vim.api.nvim_create_autocmd('FileType', {group = group, pattern = 'TelescopePrompt', callback = function(args)
    watch_telescope(args.buf)
  end})
  -- / and ?: the pattern, how many matches, and the line it took you to.
  vim.api.nvim_create_autocmd('CmdlineLeave', {group = group, callback = function()
    if vim.v.event.abort or (vim.v.event.cmdtype ~= '/' and vim.v.event.cmdtype ~= '?') then return end
    local query = vim.fn.getcmdline()
    vim.schedule(function() -- once the search has moved the cursor
      local ok, count = pcall(vim.fn.searchcount, {recompute = true, maxcount = 999})
      search('/', query, ok and count.total or nil, nil)
    end)
  end})
end

return M
