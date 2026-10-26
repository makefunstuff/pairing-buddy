-- Your searches in Telescope and snacks.picker, for the search trail: the picker, your words, how many results,
-- and the file you opened from it. Read from the picker as it closes: no mapping or action of yours changes, and
-- nothing is written to the picker's history. A picker closed with an empty prompt is no search.
local M = {}

--- The file `path` names, as an absolute path; relative paths are to `cwd`, else Neovim's.
local function absolute(path, cwd)
  if not path or path == '' then return nil end
  if cwd and not path:find('^/') then path = cwd .. '/' .. path end
  return vim.fn.fnamemodify(path, ':p')
end

--- Where window `win` is: {file, line}, or nil when it is gone.
local function place(win)
  if not (win and vim.api.nvim_win_is_valid(win)) then return nil end
  local name = vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(win))
  return {file = name ~= '' and vim.fn.fnamemodify(name, ':p') or nil, line = vim.api.nvim_win_get_cursor(win)[1]}
end

--- Reports a search once the picker's own action is done: you opened `file` if the current window went there from
--- `before`, where it was when the picker closed. Staying where you were is closing with nothing opened.
local function closed(report, search, file, before)
  if vim.trim(search.query or '') == '' then return end
  vim.schedule(function()
    local now = place(vim.api.nvim_get_current_win())
    if file and now and now.file == file and not (before and vim.deep_equal(before, now)) then
      search.file, search.line = file, now.line
    end
    report(search)
  end)
end

-- Telescope closes its picker when its prompt buffer is left, and clears the picker's state only after that.
local function telescope(buf, report)
  vim.api.nvim_create_autocmd('BufLeave', {buffer = buf, once = true, callback = function()
    local ok, picker = pcall(function() return require('telescope.actions.state').get_current_picker(buf) end)
    if not ok or not picker then return end
    local query = picker.prompt_win and vim.api.nvim_win_is_valid(picker.prompt_win) and picker:_get_prompt()
    local entry = picker:get_selection()
    local file = entry and absolute(entry.path or entry.filename, entry.cwd or picker.cwd)
    closed(report, {
      picker = picker.prompt_title or 'Telescope',
      query = query or '',
      results = picker.manager and picker.manager:num_results() or nil,
    }, file, place(picker.original_win_id))
  end})
end

-- snacks.picker leaves its input for its list window too: only a closed picker is a finished search.
local function snacks(buf, report)
  local picker
  vim.schedule(function()
    local ok, pickers = pcall(function() return Snacks.picker.get({tab = false}) end)
    for _, candidate in ipairs(ok and pickers or {}) do
      if candidate.input and candidate.input.win.buf == buf then picker = candidate end
    end
  end)
  vim.api.nvim_create_autocmd('BufLeave', {buffer = buf, callback = function()
    if not picker or not picker.closed then return end
    local filter = picker.input.filter
    local item = picker:current()
    closed(report, {
      picker = picker.title or 'Snacks',
      query = filter.search ~= '' and filter.search or filter.pattern,
      results = picker.list:count(),
    }, item and absolute(item.file, item.cwd), place(picker.main))
    return true -- done with this picker
  end})
end

--- Calls `report({picker, query, results, file, line})` for each search made in a picker; `file` and `line` are
--- where you went from it, if you opened something.
function M.watch(group, report)
  vim.api.nvim_create_autocmd('FileType', {group = group, pattern = 'TelescopePrompt', callback = function(args) telescope(args.buf, report) end})
  vim.api.nvim_create_autocmd('FileType', {group = group, pattern = 'snacks_picker_input', callback = function(args) snacks(args.buf, report) end})
end

return M
