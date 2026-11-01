-- Search by meaning: Alt-s (or :Pair find <words>) asks the daemon for the project's chunks of code closest to what
-- the words mean, and to the words themselves (see src/meaning.mjs), and shows them in your picker, best first:
-- Telescope, else snacks.picker, else fzf-lua, else vim.ui.select. Choosing one opens it at its line. Off until you
-- say yes to its model's one download; :Pair find on and :Pair find off turn it on and off.
local M = {}

local deps = {}
local picker = 'auto' -- or 'telescope', 'snacks', 'fzf-lua', 'select'

function M.setup(opts, d)
  picker = opts.picker or picker
  deps = d
end

--- Asks for a search; without words, asks for them first.
function M.find(query)
  query = vim.trim(query or '')
  if query == '' then
    return vim.ui.input({prompt = 'Find by meaning: '}, function(words)
      if words and vim.trim(words) ~= '' then M.find(words) end
    end)
  end
  deps.send({type = 'meaning', query = query})
end

--- The words selected in Visual mode, on one line, as a search.
function M.selected()
  local from, to = vim.fn.getpos('v'), vim.fn.getpos('.')
  local ok, lines = pcall(vim.fn.getregion, from, to, {type = vim.fn.mode()})
  return ok and table.concat(lines, ' ') or ''
end

function M.on()
  deps.send({type = 'meaning_on'})
end

function M.off()
  deps.send({type = 'meaning_off'})
end

--- The one download, offered at each search while search by meaning is off: nothing comes without your yes.
local function offer()
  local choice = vim.fn.confirm(
    'Search by meaning needs its model, EmbeddingGemma 2 (165 MB from Hugging Face, once, checked by its SHA-256).\n'
      .. 'Then Pair indexes the project in the background, in its own data folder. It runs on LiteRT-LM, which you\n'
      .. 'install with pip once (`pair doctor` says how). Download the model now?',
    '&Download\n&Not now', 2)
  if choice == 1 then M.on() end
end

local function open(item)
  vim.cmd.edit(vim.fn.fnameescape(item.path))
  pcall(vim.api.nvim_win_set_cursor, 0, {item.from, 0})
  vim.cmd('normal! zz')
end

local function label(item)
  return ('%s:%d  %s'):format(item.file, item.from, item.head or '')
end

local function telescope(title, items)
  local ok, pickers = pcall(require, 'telescope.pickers')
  if not ok then return false end
  local finders, conf = require('telescope.finders'), require('telescope.config').values
  pickers.new({}, {
    prompt_title = title,
    finder = finders.new_table({results = items, entry_maker = function(item)
      return {value = item, display = label(item), ordinal = item.file .. ' ' .. (item.head or ''), filename = item.path, lnum = item.from, col = 1}
    end}),
    sorter = conf.generic_sorter({}),
    previewer = conf.grep_previewer({}),
  }):find()
  return true
end

local function snacks(title, items)
  if not (rawget(_G, 'Snacks') and Snacks.picker) then return false end
  Snacks.picker({
    title = title,
    items = vim.tbl_map(function(item)
      return {text = item.file .. ' ' .. (item.head or ''), file = item.path, pos = {item.from, 0}, line = item.head}
    end, items),
    format = 'file',
    preview = 'file',
    sort = {fields = {'score:desc', 'idx'}}, -- the daemon's order until you type
    confirm = 'jump',
  })
  return true
end

local function fzflua(title, items, root)
  local ok, fzf = pcall(require, 'fzf-lua')
  if not ok then return false end
  local lines = vim.tbl_map(function(item) return ('%s:%d:1:%s'):format(item.file, item.from, item.head or '') end, items)
  fzf.fzf_exec(lines, {
    cwd = root, prompt = 'By meaning> ', previewer = 'builtin', file_icons = false, git_icons = false,
    winopts = {title = ' ' .. title .. ' '},
    fzf_opts = {['--no-sort'] = true}, -- the daemon's order
    actions = {['default'] = require('fzf-lua.actions').file_edit},
  })
  return true
end

local function ui_select(title, items)
  vim.ui.select(items, {prompt = title, format_item = label}, function(item)
    if item then open(item) end
  end)
  return true
end

local PICKERS = {telescope = telescope, snacks = snacks, ['fzf-lua'] = fzflua, select = ui_select}

--- The daemon's answer to a search: its chunks in your picker, or why there are none.
function M.on_results(message)
  if message.state == 'off' then return offer() end
  if message.state == 'disabled' then return vim.notify('Pair: search by meaning is off in the config ("meaning": false)') end
  if message.state == 'downloading' then return vim.notify('Pair: its model is still downloading; :Pair find again in a moment') end
  if message.capped then
    vim.notify(('Pair: the project has more than %d chunks; the files past them are left out of the index'):format(message.capped), vim.log.levels.WARN)
  end
  if message.problem then
    vim.notify('Pair: only the words ranked, not their meaning: ' .. message.problem .. ' (`pair doctor` says more)', vim.log.levels.WARN)
  end
  local items = message.results or {}
  if #items == 0 then return vim.notify(('Pair: nothing in the project for "%s"'):format(message.query)) end
  local title = ('By meaning: %s'):format(message.query)
  if message.chunks and message.embedded and message.embedded < message.chunks then
    title = ('%s (index %d%% built)'):format(title, math.floor(100 * message.embedded / message.chunks))
  end
  local order = picker == 'auto' and {'telescope', 'snacks', 'fzf-lua', 'select'} or {picker, 'select'}
  for _, name in ipairs(order) do
    if PICKERS[name] and PICKERS[name](title, items, message.root) then return end
  end
end

--- What the daemon says as search by meaning turns on or off.
function M.on_state(message)
  if message.text then vim.notify('Pair: ' .. message.text) end
end

return M
