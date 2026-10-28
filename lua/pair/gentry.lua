-- /gen try in Neovim: a sample Pair wrote and ran in a folder of its own, outside the project (see docs/gen.md). It
-- opens in a split as the real file it is, with a winbar that says so. You read it, change it, and run it again with
-- the run key (`try_run_key`, <LocalLeader>r), which writes the sample's changed buffers first and runs the model's
-- last command in Pair's pane, in the sandbox. Its edits never reach the Watcher: the daemon drops edits outside the
-- project. `:Pair keep [path]` moves the file into the project as a buffer to review (genfiles.lua), which :w takes.
-- `:Pair gen tries` lists the try folders still kept, to open one.
local M = {}

-- What init.lua lends: send(message), run_key (the run key, '' for none).
local deps = {}
local tries = {} -- dir -> {gen, dir, command, words}: the tries this Neovim heard of
local group = vim.api.nvim_create_augroup('pair_gen_try', {clear = true})

--- The run key as the winbar shows it: <LocalLeader>r as \r, <M-r> as M-r.
local function shown(key)
  if not key or key == '' then return nil end
  local text = key:gsub('<[Ll]ocal[Ll]eader>', vim.g.maplocalleader or '\\'):gsub('<[Ll]eader>', vim.g.mapleader or '\\')
  return (text:gsub('^<(.*)>$', '%1'))
end

--- The try whose folder holds the buffer `buf` (its name, a path), or nil.
local function try_of(buf)
  local name = vim.api.nvim_buf_get_name(buf)
  if name == '' then return nil end
  for dir, try in pairs(tries) do
    if vim.startswith(name, dir .. '/') then return try end
  end
  -- A try this Neovim never heard of (it restarted): known by where /gen keeps its tries.
  local dir, n = name:match('^(.*/gen/[^/]+%-%x%x%x%x%x%x%x%x/try/(%d+))/')
  if dir then
    tries[dir] = {gen = tonumber(n), dir = dir}
    return tries[dir]
  end
end

local function winbar(try, mapped)
  local key = mapped and shown(deps.run_key)
  local run = key and (' · %s runs it'):format(key) or ' · :Pair gen run runs it'
  return ((' try · gen #%d · outside the project%s · :Pair keep moves it in '):format(try.gen, run):gsub('%%', '%%%%'))
end

--- Marks `buf` as a try's sample: the run key in it, and the winbar in each window that shows it.
local function mark(buf, try)
  if vim.b[buf].pair_try then return end
  vim.b[buf].pair_try = {gen = try.gen, dir = try.dir}
  -- Only where you have no mapping of your own, as Pair's other keys; the winbar names the key only when it is Pair's.
  local mapped = deps.run_key and deps.run_key ~= '' and vim.fn.maparg(deps.run_key, 'n') == ''
  if mapped then
    vim.keymap.set('n', deps.run_key, function() M.run(buf) end, {buffer = buf, desc = 'Run Pair\'s /gen try again'})
  end
  -- Like :setlocal, for this buffer in the window: another buffer there keeps the window's own winbar.
  vim.api.nvim_create_autocmd('BufWinEnter', {group = group, buffer = buf, callback = function()
    vim.api.nvim_set_option_value('winbar', winbar(try, mapped), {scope = 'local'})
  end})
  for _, win in ipairs(vim.fn.win_findbuf(buf)) do
    vim.api.nvim_win_call(win, function() vim.api.nvim_set_option_value('winbar', winbar(try, mapped), {scope = 'local'}) end)
  end
end

--- Opens `file` of `try` in a split below the window you are in, which keeps the cursor: it comes when Pair is done,
--- maybe while you type.
local function open(file, try)
  local window = vim.api.nvim_get_current_win()
  vim.cmd('belowright split ' .. vim.fn.fnameescape(file))
  mark(vim.api.nvim_get_current_buf(), try)
  vim.api.nvim_set_current_win(window)
end

--- The daemon's gen_try: the sample of request `message.gen` is done; its main file opens in a split.
function M.on_try(message)
  local try = {gen = message.gen, dir = message.dir, command = message.command ~= vim.NIL and message.command or nil, words = message.words}
  tries[message.dir] = try
  if type(message.open) == 'string' then open(message.open, try) end
end

--- The run key, :Pair gen run: the sample's changed buffers are written (its folder is Pair's, not the project), then
--- the try of `buf` (else the newest) runs again in Pair's pane.
function M.run(buf)
  buf = buf or vim.api.nvim_get_current_buf()
  local try = try_of(buf)
  if try then
    for _, other in ipairs(vim.api.nvim_list_bufs()) do
      if vim.api.nvim_buf_is_loaded(other) and vim.bo[other].modified and try_of(other) == try then
        vim.api.nvim_buf_call(other, function() vim.cmd('silent update') end)
      end
    end
  end
  deps.send({type = 'gen_try_run', gen = try and try.gen or nil, file = try and vim.api.nvim_buf_get_name(buf) or nil})
end

--- :Pair keep [path]: the try file you are in (else the newest try's) goes into the project at `path`, as a buffer
--- to review; without a path, at its path in the try's folder.
function M.keep(path)
  local buf = vim.api.nvim_get_current_buf()
  local try = try_of(buf)
  deps.send({type = 'keep', path = path or '', file = try and vim.api.nvim_buf_get_name(buf) or nil, gen = try and try.gen or nil})
end

--- Whether `buf` is a try's sample.
function M.is_try(buf) return try_of(buf) ~= nil end

--- The daemon's gen_tries, for :Pair gen tries: pick one, and its main file opens in a split.
function M.on_tries(message)
  local list = message.tries or {}
  if #list == 0 then return vim.notify('Pair: no /gen try folders for this project; :Pair gen try <what> makes one') end
  local function line(one)
    local left = one.left > 0 and ('%d day%s left'):format(one.left, one.left == 1 and '' or 's') or 'goes today'
    return ('gen #%d · %s · %s · %s'):format(one.gen, one.words ~= '' and (one.words:gsub('\n', ' ')) or '?', table.concat(one.files, ', '), left)
  end
  vim.ui.select(list, {prompt = 'Pair · the /gen tries', format_item = line, kind = 'pair_gen_tries'}, function(one)
    if not one then return end
    local try = tries[one.dir] or {gen = one.gen, dir = one.dir, command = one.command ~= vim.NIL and one.command or nil, words = one.words}
    tries[one.dir] = try
    open(one.main, try)
  end)
end

function M.setup(lent)
  deps = lent
  -- A try's file opened another way (:e, a restart) is one too.
  vim.api.nvim_create_autocmd('BufReadPost', {group = group, callback = function(args)
    local try = try_of(args.buf)
    if try then mark(args.buf, try) end
  end})
end

return M
