-- The board's working tasks and your files: the daemon reads every 30 s which files the branch of each working task
-- of this repo changes (git, read only), and a window that shows one of them says so in its winbar, `◇ BDY-71 is
-- changing this file`. The overlap itself, when you edit lines a task changes, is a remark like any other.
--
-- And `:Pair brief sync`'s pick: how the brief differs from the brief its board task has, and one offer, a tell to
-- its agent or the command copied. Nothing goes to the board but on the pick that names it.
local style = require('pair.style')

local M = {}

local deps = {} -- what init.lua lends: send, and `winbar` (false: no winbar note)
local files = {} -- absolute path -> the tasks that change it: {{id, title, branch}, …}
-- Every note says so and ends so: such a winbar is ours, also one Neovim brought back with its buffer or copied to a
-- split.
local SAYS, TAIL = ' changing this file', ' · :Pair agents '
local group = vim.api.nvim_create_augroup('pair_overlap', {clear = true})
local MAX_BRANCH = 40

local function present(value) return value ~= nil and value ~= vim.NIL and value ~= '' end

local function cut(text, width)
  if vim.fn.strdisplaywidth(text) <= width then return text end
  return vim.fn.strcharpart(text, 0, width - 1) .. '…'
end

--- The note for the tasks that change a file: one names its branch; more are named by their ids.
local function note(tasks)
  if #tasks == 1 then
    local task = tasks[1]
    local branch = present(task.branch) and (' · ' .. cut(task.branch, MAX_BRANCH)) or ''
    return (' %s %s is%s%s%s'):format(style.glyphs.agents, task.id, SAYS, branch, TAIL)
  end
  local ids = {}
  for _, task in ipairs(tasks) do table.insert(ids, task.id) end
  return (' %s %s and %s are%s%s'):format(style.glyphs.agents, table.concat(ids, ', ', 1, #ids - 1), ids[#ids], SAYS, TAIL)
end

local function ours(text) return text:find(SAYS, 1, true) ~= nil and text:sub(-#TAIL) == TAIL end

--- The winbar of window `win` for the buffer it shows: the note when a task changes its file, else none of ours.
local function show(win)
  if not vim.api.nvim_win_is_valid(win) then return end
  local buf = vim.api.nvim_win_get_buf(win)
  local name = vim.bo[buf].buftype == '' and vim.api.nvim_buf_get_name(buf) or ''
  local tasks = deps.winbar ~= false and name ~= '' and files[vim.fn.resolve(name)] or nil
  local current = vim.wo[win].winbar
  if tasks then
    -- A winbar of the window's own (a /gen try, your config's) stays: the note goes only where there is none, or ours.
    if current ~= '' and not ours(current) then return end
    local text = note(tasks):gsub('%%', '%%%%')
    if text ~= current then vim.api.nvim_win_call(win, function() vim.api.nvim_set_option_value('winbar', text, {scope = 'local'}) end) end
  elseif ours(current) then
    vim.api.nvim_win_call(win, function() vim.api.nvim_set_option_value('winbar', '', {scope = 'local'}) end)
  end
end

local function show_all()
  for _, win in ipairs(vim.api.nvim_list_wins()) do show(win) end
end

function M.setup(lent)
  deps = lent
  vim.api.nvim_create_autocmd({'BufWinEnter', 'WinEnter', 'BufFilePost'}, {group = group, callback = function()
    show(vim.api.nvim_get_current_win())
  end})
end

--- The daemon's task_files: each file a working task changes, with the tasks.
function M.on_files(message)
  files = {}
  for _, entry in ipairs(type(message.files) == 'table' and message.files or {}) do
    if type(entry.file) == 'string' and type(entry.tasks) == 'table' and #entry.tasks > 0 then files[vim.fn.resolve(entry.file)] = entry.tasks end
  end
  show_all()
end

--- The tasks that change `file` (an absolute path), for tests and the statusline; nil when none does.
function M.tasks(file) return files[vim.fn.resolve(file)] end

--- Another session, or none: its tasks are not this one's.
function M.clear()
  files = {}
  show_all()
end

--- The daemon's brief_sync: what the brief has that the task's brief lacks, then the pick.
function M.on_sync(message)
  if type(message.task) ~= 'string' or type(message.text) ~= 'string' then return end
  local lines = type(message.lines) == 'table' and message.lines or {}
  vim.notify(('Pair: %s\n%s'):format(message.title or '/brief sync', table.concat(lines, '\n')))
  local choices = {
    {key = 'y', what = message.does or ('tell ' .. message.task)},
    {key = 'c', what = 'copy the command, run nothing'},
    {key = 'n', what = 'nothing'},
  }
  vim.ui.select(choices, {prompt = ('%s\'s brief lacks %d line%s · tell it?'):format(message.task, #lines, #lines == 1 and '' or 's'), format_item = function(choice) return choice.what end, kind = 'pair_brief_sync'}, function(choice)
    if not choice or choice.key == 'n' then return end
    deps.send({type = 'board_do', task = message.task, verb = 'tell', text = message.text, run = choice.key == 'y'})
  end)
end

return M
