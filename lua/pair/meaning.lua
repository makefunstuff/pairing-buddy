-- Search by meaning: Alt-s (or :Pair find [words]) opens a live picker, used like live_grep: on every key the daemon's
-- word search answers (identifiers split, comments and strings too), and once you stop typing for `debounce_ms` the
-- pieces of code closest to what the words mean join the list below what it shows, so nothing you see moves (see
-- src/meaning.mjs). Telescope, else snacks.picker, else fzf-lua, else vim.ui.select. Enter opens a piece at its line;
-- in Telescope <C-q> sends the hits to the quickfix list. The words work without any model; meaning needs one:
-- :Pair find on installs LiteRT-LM and downloads EmbeddingGemma 2 once, or an "embedding" model in the config. :Pair
-- find off deletes them. With a "rerank" decision model in the config, a list that stays as it is for `rerank_delay_ms`
-- once meaning came is reordered once, its first pieces best first by the model; the title says so. The piece you are
-- on stays the one you are on, unless it was the first: then the new first one is.
local M = {}

local deps = {}
local picker = 'auto' -- or 'telescope', 'snacks', 'fzf-lua', 'select'
local debounce_ms = 150
local rerank_delay_ms = 400 -- after meaning came, how long the list must stay as it is before it is reranked
local next_id = 0
local waiting = {} -- request id -> what to do with the daemon's answer

function M.setup(opts, d)
  picker = opts.picker or picker
  debounce_ms = opts.debounce_ms or debounce_ms
  rerank_delay_ms = opts.rerank_delay_ms or rerank_delay_ms
  deps = d
end

--- Asks the daemon for one phase of a search, 'words', 'meaning' or 'rerank' (of `results`); `callback` gets its answer.
local function ask(query, phase, callback, results)
  next_id = next_id + 1
  waiting[next_id] = callback
  deps.send({type = 'find', id = next_id, query = query, phase = phase, results = results})
  return next_id
end

--- The daemon's answer to one phase of a search.
function M.on_found(message)
  local callback = message.id and waiting[message.id]
  if not callback then return end
  waiting[message.id] = nil
  callback(message)
end

--- The words selected in Visual mode, on one line, as a search.
function M.selected()
  local from, to = vim.fn.getpos('v'), vim.fn.getpos('.')
  local ok, lines = pcall(vim.fn.getregion, from, to, {type = vim.fn.mode()})
  return ok and vim.trim(table.concat(lines, ' ')) or ''
end

function M.on() deps.send({type = 'meaning_on'}) end

function M.off() deps.send({type = 'meaning_off'}) end

function M.rebuild() deps.send({type = 'index_rebuild'}) end

local function key(item) return item.file .. ':' .. item.from end

local function label(item)
  return ('%s:%d  %s'):format(item.file, item.line or item.from, item.head or '')
end

--- A live search: `set(query)` on every key; `changed()` is called each time its list grows or starts over.
local Live = {}
Live.__index = Live

function Live.new(changed)
  return setmetatable({query = nil, items = {}, info = {}, words_id = nil, meaning_id = nil, timer = nil, changed = changed, done = false}, Live)
end

--- The list now: the word hits as they came, then meaning's that are not among them, best first.
function Live:merge(words, meaning)
  local items, seen = {}, {}
  for _, item in ipairs(words or {}) do
    seen[key(item)] = item
    items[#items + 1] = item
  end
  for _, item in ipairs(meaning or {}) do
    if seen[key(item)] then
      seen[key(item)].meaning = item.meaning
    else
      seen[key(item)] = item
      items[#items + 1] = item
    end
  end
  return items
end

function Live:stop_timer()
  if self.timer then
    self.timer:stop()
    self.timer:close()
    self.timer = nil
  end
end

--- Asks for meaning's hits, once the words are in: they come first, so meaning's only ever go below them.
function Live:ask_meaning(query)
  local meaning_id
  meaning_id = ask(query, 'meaning', function(message)
    if self.done or self.meaning_id ~= meaning_id then return end
    self.meaning, self.meaning_info = message.results or {}, message
    self.items = self:merge(self.words or {}, self.meaning)
    self.changed(self, 'meaning')
    if message.reranker and #self.items > 1 then self:settle(query) end
  end)
  self.meaning_id = meaning_id
end

--- Once the list has stayed as it is a while, its first pieces reranked: they come back in the model's order, once.
function Live:settle(query)
  self:stop_timer()
  self.timer = vim.uv.new_timer()
  self.timer:start(rerank_delay_ms, 0, vim.schedule_wrap(function()
    self:stop_timer()
    if self.done or self.query ~= query then return end
    local shown = {}
    for index = 1, math.min(#self.items, 30) do
      local item = self.items[index]
      shown[index] = {file = item.file, line = item.line, from = item.from, to = item.to, head = item.head, kind = item.kind, name = item.name, meaning = item.meaning, words = item.words}
    end
    local rerank_id
    self.reranking = true
    self.changed(self, 'reranking')
    rerank_id = ask(query, 'rerank', function(message)
      if self.done or self.rerank_id ~= rerank_id then return end
      self.reranking = false
      self.rerank_info = message.rerank
      local results = message.results or {}
      if message.rerank and message.rerank.applied and #results > 0 then
        self.first_before = self.items[1] and key(self.items[1])
        local items, placed = {}, {}
        for _, item in ipairs(results) do
          items[#items + 1] = item
          placed[key(item)] = true
        end
        for _, item in ipairs(self.items) do
          if not placed[key(item)] then items[#items + 1] = item end
        end
        self.items = items
      end
      self.changed(self, 'rerank')
    end, shown)
    self.rerank_id = rerank_id
  end))
end

function Live:set(query)
  query = vim.trim(query or '')
  if query == self.query then return end
  self.query, self.items, self.words, self.meaning, self.meaning_info = query, {}, nil, nil, nil
  self.words_id, self.meaning_id, self.meaning_due = nil, nil, false
  self.rerank_id, self.rerank_info, self.reranking, self.first_before = nil, nil, false, nil
  self:stop_timer()
  if query == '' then return end
  local words_id
  words_id = ask(query, 'words', function(message)
    if self.done or self.words_id ~= words_id then return end
    self.words, self.info = message.results or {}, message
    self.items = self:merge(self.words, self.meaning)
    self.changed(self, 'words')
    if self.meaning_due then self:ask_meaning(query) end
  end)
  self.words_id = words_id
  -- Once typing stops: a key before then starts over, and asks nothing of the embedder.
  self.timer = vim.uv.new_timer()
  self.timer:start(debounce_ms, 0, vim.schedule_wrap(function()
    self:stop_timer()
    if self.done or self.query ~= query then return end
    if self.words then self:ask_meaning(query) else self.meaning_due = true end
  end))
end

--- The picker's title: your words, and what is missing from the ranking or still being built.
function Live:title()
  local info = self.meaning_info or self.info or {}
  local parts = {}
  if info.state == 'off' then parts[#parts + 1] = 'words only: :Pair find on adds meaning'
  elseif info.state == 'disabled' then parts[#parts + 1] = 'off in the config: "meaning": false'
  elseif info.state == 'downloading' then parts[#parts + 1] = 'words only while its model downloads'
  elseif info.state == 'installing' then parts[#parts + 1] = 'words only while LiteRT-LM installs'
  elseif info.problem then parts[#parts + 1] = 'words only: ' .. info.problem
  end
  if info.reading then
    parts[#parts + 1] = 'reading the project'
  elseif info.state == 'on' and info.chunks and info.embedded and info.embedded < info.chunks and info.chunks > 0 then
    parts[#parts + 1] = ('index %d%% built'):format(math.floor(100 * info.embedded / info.chunks))
  end
  if info.capped then parts[#parts + 1] = ('over %d pieces: some files left out'):format(info.capped) end
  if self.meaning_info and self.meaning_info.ms then parts[#parts + 1] = ('%d ms'):format(self.meaning_info.ms) end
  local rerank = self.rerank_info
  if self.reranking then parts[#parts + 1] = 'reranking'
  elseif rerank and rerank.applied then parts[#parts + 1] = ('reranked by %s (%.1f s)'):format(rerank.model, (rerank.ms or 0) / 1000)
  end
  return #parts > 0 and ('Find (%s)'):format(table.concat(parts, ' · ')) or 'Find by meaning and words'
end

function Live:close()
  self.done = true
  self:stop_timer()
end

--- The ledger hears what you chose, with what the search showed.
local function chosen(query, items)
  if query and query ~= '' then deps.send({type = 'find_chosen', query = query, results = items}) end
end

local function open(item)
  vim.cmd.edit(vim.fn.fnameescape(item.path))
  pcall(vim.api.nvim_win_set_cursor, 0, {item.line or item.from, 0})
  vim.cmd('normal! zz')
end

local function telescope(query)
  local ok, pickers = pcall(require, 'telescope.pickers')
  if not ok then return false end
  local finders, conf, sorters = require('telescope.finders'), require('telescope.config').values, require('telescope.sorters')
  local actions, action_state = require('telescope.actions'), require('telescope.actions.state')
  local function entry(item)
    return {value = item, display = label(item), ordinal = item.file .. ' ' .. (item.head or ''), filename = item.path, lnum = item.line or item.from, col = 1, text = item.head}
  end
  local current -- the picker
  local restore -- the entry to keep selected once the list grows
  local live
  live = Live.new(function(_, phase)
    if not current or live.done then return end
    pcall(function() current.prompt_border:change_title(live:title()) end)
    if phase == 'reranking' then return end -- only the title: the list is as it was
    local selected = action_state.get_selected_entry()
    restore = selected and key(selected.value) or nil -- the list only grows below it, and it stays selected
    if phase == 'rerank' and restore == live.first_before then restore = nil end -- on the first: the new first
    live.answered = live.query
    current:refresh(nil, {reset_prompt = false})
  end)
  -- Each prompt: what the live search has for it, given at once once its words came; a new prompt starts a search.
  local finder = setmetatable({entry_maker = entry, results = {}, close = function() end}, {
    __call = function(self, prompt, process_result, process_complete)
      prompt = vim.trim(prompt or '')
      if prompt ~= live.query then live:set(prompt) end
      if live.answered == live.query or prompt == '' then
        self.results = live.items
        for _, item in ipairs(live.items) do
          if process_result(entry(item)) then break end
        end
      end
      process_complete()
    end,
  })
  current = pickers.new({}, {
    prompt_title = 'Find by meaning and words',
    results_title = 'Pair',
    default_text = query,
    finder = finder,
    sorter = sorters.highlighter_only({}), -- Pair's order, not Telescope's
    previewer = conf.grep_previewer({}),
    attach_mappings = function(prompt_bufnr)
      actions.select_default:enhance({pre = function()
        local selected = action_state.get_selected_entry()
        if selected then chosen(live.query, {selected.value}) end
      end})
      actions.close:enhance({post = function() live:close() end})
      return true -- <C-q> sends the hits to quickfix, as in any picker
    end,
  })
  current:register_completion_callback(function(self)
    if not restore then return end
    local want = restore
    restore = nil
    for row = 0, self.manager:num_results() - 1 do
      local each = self.manager:get_entry(row + 1)
      if each and key(each.value) == want then return self:set_selection(self:get_row(row + 1)) end
    end
  end)
  current:find()
  return true
end

local function snacks(query)
  if not (rawget(_G, 'Snacks') and Snacks.picker) then return false end
  local current
  local live
  live = Live.new(function(_, phase)
    live.answered = live.query
    if live.resume then return live.resume() end -- the finder waits for its words
    if not current or current.closed then return end
    pcall(function() current.title = live:title(); current:update_titles() end)
    if phase == 'reranking' then return end
    -- Meaning's hits, below what the list shows; the item you are on stays the one you are on.
    local on = current:current()
    local want = on and on.value and key(on.value)
    if phase == 'rerank' and want == live.first_before then want = live.items[1] and key(live.items[1]) end
    current:find({refresh = true, on_done = function()
      if not want or current.closed then return end
      for index, item in ipairs(current:items()) do
        if item.value and key(item.value) == want then return current.list:view(index) end
      end
    end})
  end)
  current = Snacks.picker({
    title = 'Find by meaning and words',
    search = query,
    live = true,
    supports_live = true,
    finder = function(_, ctx)
      local prompt = vim.trim(ctx.filter.search or '')
      return function(cb)
        local async = ctx.async
        -- snacks runs a finder off the main loop, where Neovim's channels cannot be written to.
        if prompt ~= live.query then async:schedule(function() live:set(prompt) end) end
        if prompt ~= '' and live.answered ~= prompt then
          live.resume = function()
            live.resume = nil
            pcall(async.resume, async) -- a finder snacks dropped meanwhile stays asleep
          end
          async:suspend()
        end
        if live.query ~= prompt or prompt == '' then return end
        for index, item in ipairs(live.items) do
          cb({idx = index, score = 0, text = label(item), file = item.path, pos = {item.line or item.from, 0}, line = item.head, value = item})
        end
      end
    end,
    format = 'file',
    preview = 'file',
    sort = {fields = {'idx'}}, -- Pair's order
    matcher = {sort_empty = false},
    confirm = function(p, item)
      if item then chosen(live.query, {item.value}) end
      p:close()
      if item then open(item.value) end
    end,
    on_close = function() live:close() end,
  })
  return true
end

local function fzflua(query)
  local ok, fzf = pcall(require, 'fzf-lua')
  if not ok then return false end
  local line = function(item) return ('%s:%d:1:%s'):format(vim.fn.fnamemodify(item.path, ':~:.'), item.line or item.from, item.head or '') end
  local latest, last_prompt = 0, query
  fzf.fzf_live(function(args)
    local prompt = vim.trim((type(args) == 'table' and args[1] or args) or '')
    last_prompt = prompt
    latest = latest + 1
    local mine = latest
    -- fzf reloads on every key: the words come at once, and meaning's hits after them once typing stops, in the same
    -- reload, so what fzf shows only grows.
    return function(fzf_cb)
      if prompt == '' then return fzf_cb() end
      local words = {}
      ask(prompt, 'words', function(message)
        if mine ~= latest then return fzf_cb() end -- fzf reloaded for newer words meanwhile
        words = message.results or {}
        for _, item in ipairs(words) do fzf_cb(line(item)) end
        vim.defer_fn(function()
          if mine ~= latest then return fzf_cb() end
          ask(prompt, 'meaning', function(answer)
            local shown = {}
            for _, each in ipairs(words) do shown[key(each)] = true end
            for _, item in ipairs(answer.results or {}) do
              if not shown[key(item)] then fzf_cb(line(item)) end
            end
            fzf_cb()
          end)
        end, debounce_ms)
      end)
    end
  end, {
    prompt = 'Find> ', query = query, previewer = 'builtin', file_icons = false, git_icons = false,
    winopts = {title = ' Find by meaning and words '},
    exec_empty_query = false,
    actions = {
      ['default'] = function(selected, opts)
        local file, row = (selected[1] or ''):match('^(.-):(%d+):')
        if file then chosen(last_prompt, {{file = vim.fn.fnamemodify(file, ':.'), line = tonumber(row), head = selected[1]:match('^.-:%d+:%d+:(.*)$')}}) end
        require('fzf-lua.actions').file_edit(selected, opts)
      end,
      ['ctrl-q'] = require('fzf-lua.actions').file_sel_to_qf,
    },
  })
  return true
end

local function ui_select(query)
  local function search(words)
    words = vim.trim(words or '')
    if words == '' then return end
    deps.send({type = 'find', query = words, select = true})
    M.pending_select = words
  end
  if query == '' then return vim.ui.input({prompt = 'Find by meaning: '}, search) or true end
  search(query)
  return true
end

--- vim.ui.select's answer: the daemon's fused ranking, all at once.
function M.on_select(message)
  if message.query ~= M.pending_select then return end
  M.pending_select = nil
  if message.state == 'on' and message.problem then
    vim.notify('Pair: only the words ranked, not their meaning: ' .. message.problem .. ' (`pair doctor` says more)', vim.log.levels.WARN)
  end
  local items = message.results or {}
  if #items == 0 then return vim.notify(('Pair: nothing in the project for "%s"'):format(message.query)) end
  vim.ui.select(items, {prompt = ('Find: %s'):format(message.query), format_item = label}, function(item)
    if item then
      chosen(message.query, {item})
      open(item)
    end
  end)
end

local PICKERS = {telescope = telescope, snacks = snacks, ['fzf-lua'] = fzflua, select = ui_select}

--- Opens the live picker, with `query` typed in it already (Visual mode's words, :Pair find's).
function M.find(query)
  query = vim.trim(query or '')
  local order = picker == 'auto' and {'telescope', 'snacks', 'fzf-lua', 'select'} or {picker, 'select'}
  for _, name in ipairs(order) do
    if PICKERS[name] and PICKERS[name](query) then return end
  end
end

-- How far a project's index is: Neovim's own progress message (0.12), which a statusline or fidget may show.
local progress_id = nil
function M.on_progress(message)
  local percent = message.total and message.total > 0 and math.floor(100 * (message.done or 0) / message.total) or nil
  local text = message.phase == 'reading' and 'reading the project for the word search'
    or message.phase == 'embedding' and ('embedding pieces of code: %d of %d'):format(message.done or 0, message.total or 0)
    or message.phase == 'failed' and ('stopped: %s'):format(message.text or '')
    or ('%d pieces indexed'):format(message.total or 0)
  local status = message.phase == 'done' and 'success' or message.phase == 'failed' and 'failed' or 'running'
  local ok, id = pcall(vim.api.nvim_echo, {{'Pair index: ' .. text}}, false, {kind = 'progress', id = progress_id, title = 'Pair index', status = status, percent = percent, source = 'pair'})
  if ok then
    progress_id = status == 'running' and id or nil
  elseif message.phase == 'done' or message.phase == 'failed' then
    vim.notify('Pair index: ' .. text) -- an older Neovim: only how it ended
  end
end

--- What the daemon says as search by meaning turns on or off, or the index is rebuilt.
function M.on_state(message)
  if message.text then vim.notify('Pair: ' .. message.text) end
end

return M
