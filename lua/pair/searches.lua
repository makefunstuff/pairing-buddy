-- Your searches in Telescope, snacks.picker and fzf-lua, for the search trail: the picker, your words, how many results,
-- and the file you opened from it. Read from the picker as it closes: no mapping or action of yours changes, and
-- nothing is written to the picker's history. A picker closed with an empty prompt is no search.
local M = {}

--- The file `path` names, as an absolute path; relative paths are to `cwd`, else Neovim's.
local function absolute(path, cwd)
  if not path or path == '' then return nil end
  if cwd and not path:find('^/') then path = cwd .. '/' .. path end
  return vim.fn.fnamemodify(path, ':p')
end

--- Where window `win` is: {win, file, line}, or nil when it is gone.
local function place(win)
  if not (win and vim.api.nvim_win_is_valid(win)) then return nil end
  local name = vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(win))
  return {win = win, file = name ~= '' and vim.fn.fnamemodify(name, ':p') or nil, line = vim.api.nvim_win_get_cursor(win)[1]}
end

--- Reports a search once the picker's own action is done: you opened `file` if the current window went there from
--- `before`, where you were before its action; a new split on the same place counts. Staying where you were is
--- closing with nothing opened.
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

-- snacks.picker: its input window closes however the picker ends, from the input or from its list, and only after
-- the picker's own action; where you were is taken as it opens, since that action may already have moved you.
local function snacks(buf, report)
  vim.schedule(function()
    local ok, pickers = pcall(function() return Snacks.picker.get({tab = false}) end)
    local picker
    for _, candidate in ipairs(ok and pickers or {}) do
      if candidate.input and candidate.input.win.buf == buf then picker = candidate end
    end
    if not picker then return end
    local before = place(picker.main)
    vim.api.nvim_create_autocmd('WinClosed', {pattern = tostring(picker.input.win.win), once = true, callback = function()
      local filter = picker.input.filter
      local item = picker:current({resolve = false})
      closed(report, {
        picker = picker.title or 'Snacks',
        query = filter.search ~= '' and filter.search or filter.pattern,
        results = picker.list:count(),
      }, item and absolute(item.file, item.cwd), before)
    end})
  end)
end

--- Whether fzf draws its prompt at the top (`--layout=reverse`, fzf-lua's default) rather than at the bottom, from
--- the picker's options, else from $FZF_DEFAULT_OPTS, else fzf's own default.
local function fzf_reversed(opts)
  local fzf_opts = opts.fzf_opts or {}
  if fzf_opts['--reverse'] then return true end
  local layout = fzf_opts['--layout']
  if not layout then
    local default = vim.env.FZF_DEFAULT_OPTS or ''
    layout = default:match('%-%-layout[= ](%S+)') or default:find('%-%-reverse') and 'reverse'
  end
  return layout == 'reverse'
end

--- What fzf shows in `lines`, its screen: the query typed after `prompt`, and the match count on the prompt line
--- (`--info=inline-right`, fzf-lua's default) or on the info line just inside it. The prompt line is the one
--- nearest the screen's top when `reversed`, else its bottom: a result under a `>` pointer starts like it too, but
--- lies beyond the info line. Nil when the prompt line is not there.
local function fzf_screen(lines, prompt, reversed)
  prompt = vim.trim((prompt:gsub('\27%[[%d;]*m', '')))
  if prompt == '' then return end
  local first, last, step = 1, #lines, 1
  if not reversed then first, last, step = #lines, 1, -1 end
  for i = first, last, step do
    if vim.startswith(lines[i], prompt) then
      local typed = lines[i]:sub(#prompt + 1)
      local count = typed:match('(%d+)/%d+[%s%d()]*$') or (lines[i + step] or ''):match('^[^%w]*(%d+)/%d+')
      local query = typed:match('^(.-)%s%s+%S*%s*%d+/%d+[%s%d()]*$') or typed
      return vim.trim(query), tonumber(count)
    end
  end
end

--- The words grepped for, as you gave them: fzf-lua keeps them as called, but escapes them for rg in the picker's
--- options, and grep_cword and grep_cWORD make them a regex of the word under the cursor.
local function grep_words(opts, cmd)
  local words = opts.__call_opts and opts.__call_opts.search
  if type(words) ~= 'string' or words == '' then words = opts.search end
  if cmd == 'grep_cword' or cmd == 'grep_cWORD' then
    words = words:gsub('^%(%^|\\s%)', ''):gsub('%(%$|\\s%)$', ''):gsub('^\\b', ''):gsub('\\b$', '')
    words = words:gsub('\\(.)', '%1')
  end
  return words
end

--- The picker's name: its command for fzf-lua's own pickers (live_grep is Live Grep), else its window title (a
--- string, or chunks of text and highlight), as for a picker of yours made with fzf_exec.
local function fzf_name(info, title)
  if info.cmd and info.mod and info.mod ~= 'fzf-lua.core' then
    return (info.cmd:gsub('_', ' '):gsub('%f[%w]%l', string.upper))
  end
  if type(title) == 'table' then title = title[1] and title[1][1] end
  return type(title) == 'string' and vim.trim(title) ~= '' and vim.trim(title) or 'fzf-lua'
end

-- fzf-lua: fzf runs in a terminal buffer in its own window, and that window closes once the query is saved, just
-- before the picker's action runs. By default fzf-lua only hides the picker (fzf keeps running, for a quick resume),
-- so the window closing is the search's end either way, and a resumed picker is a search again. fzf-lua does not
-- hand out what was selected, so what you opened is where its action took you: the window you came from, now on
-- another file or line. The grep words of `grep` and `grep_cword` are what you searched for; the fuzzy filter typed
-- over them only narrows the list. One window may run several pickers in turn (ctrl-g switches grep and
-- live_grep). The query and the match count are read off fzf's screen while it runs: closed with Esc, a hidden
-- picker hands fzf-lua its query only after its window has gone.
local fzf_windows = {}

--- Reports the search `this` once its window has closed and the picker's own action is done.
local function fzf_closed(this, report)
  local opts = this.opts
  local query = this.query or opts.last_query -- what fzf-lua saved only when its prompt line was not seen
  if not opts.is_live and type(opts.search) == 'string' and opts.search ~= '' then
    query = grep_words(opts, this.info.cmd)
  end
  if vim.trim(query or '') == '' then return end
  local search = {picker = fzf_name(this.info, opts.winopts and opts.winopts.title), query = query, results = this.results}
  local now = place(vim.api.nvim_get_current_win())
  if now and now.file and not (this.before and vim.deep_equal(this.before, now)) then
    search.file, search.line = now.file, now.line
  end
  report(search)
end

local function fzf_arm(win, this, report)
  fzf_windows[win] = this
  vim.api.nvim_create_autocmd('WinClosed', {pattern = tostring(win), once = true, callback = function()
    fzf_windows[win] = nil
    vim.schedule(function() fzf_closed(this, report) end)
  end})
end

local function fzflua(buf, report)
  local ok, info = pcall(function() return FzfLua.get_info({winobj = true}) end)
  local winobj = ok and info and info.winobj
  if not (winobj and winobj.fzf_bufnr == buf) then return end -- another fzf plugin's buffer
  local win = vim.api.nvim_get_current_win()
  local this = fzf_windows[win] or {before = place(winobj.src_winid)}
  this.buf, this.winobj, this.opts, this.info, this.query, this.results = buf, winobj, winobj._o or {}, {cmd = info.cmd, mod = info.mod}, nil, nil
  vim.api.nvim_create_autocmd('TextChangedT', {buffer = buf, callback = function()
    if this.buf ~= buf then return true end
    local prompt = this.opts.prompt or this.opts.fzf_opts and this.opts.fzf_opts['--prompt'] or '> '
    local query, count = fzf_screen(vim.api.nvim_buf_get_lines(buf, 0, -1, false), prompt, fzf_reversed(this.opts))
    if query then this.query, this.results = query, count or this.results end
  end})
  -- A hidden picker comes back in a window opened without autocommands, but always in Terminal mode.
  vim.api.nvim_create_autocmd('TermEnter', {buffer = buf, callback = function()
    if this.buf ~= buf then return true end
    local again = vim.api.nvim_get_current_win()
    if fzf_windows[again] then return end
    this.before = place(winobj.src_winid)
    fzf_arm(again, this, report)
  end})
  if not fzf_windows[win] then fzf_arm(win, this, report) end
end

--- Calls `report({picker, query, results, file, line})` for each search made in a picker; `file` and `line` are
--- where you went from it, if you opened something.
function M.watch(group, report)
  vim.api.nvim_create_autocmd('FileType', {group = group, pattern = 'TelescopePrompt', callback = function(args) telescope(args.buf, report) end})
  vim.api.nvim_create_autocmd('FileType', {group = group, pattern = 'snacks_picker_input', callback = function(args) snacks(args.buf, report) end})
  vim.api.nvim_create_autocmd('FileType', {group = group, pattern = 'fzf', callback = function(args) fzflua(args.buf, report) end})
end

return M
