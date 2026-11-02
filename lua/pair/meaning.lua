-- Search by meaning: Alt-s (or :Pair find [words]) opens a live picker, used like live_grep: on every key the daemon's
-- word search answers (identifiers split, comments and strings too), and once you stop typing for `debounce_ms` the
-- pieces of code closest to what the words mean join the list below what it shows, so nothing you see moves (see
-- src/meaning.mjs). Telescope, else snacks.picker, else fzf-lua, else vim.ui.select. Enter opens a piece at its line;
-- <C-q> sends the hits to the quickfix list. The words work without any model; meaning needs one:
-- :Pair find on installs LiteRT-LM and downloads EmbeddingGemma 2 once, or an "embedding" model in the config. :Pair
-- find off deletes them. With a "rerank" decision model in the config, as soon as meaning came (after
-- `rerank_delay_ms`, none by default) the fused ranking's first pieces (as /find's) are reranked in the background and
-- go first, in the model's order, once they come; the title says so. The piece you are on stays the one you are on. A
-- quickfix list sent while the rerank runs gets its order in place when it comes, unless you changed it meanwhile.
local M = {}

local deps = {}
local picker = 'auto' -- or 'telescope', 'snacks', 'fzf-lua', 'select'
local debounce_ms = 150
local rerank_delay_ms = 0 -- after meaning came, how long the list must stay as it is before it is reranked
local next_id = 0
local waiting = {} -- request id -> what to do with the daemon's answer

function M.setup(opts, d)
  picker = opts.picker or picker
  debounce_ms = opts.debounce_ms or debounce_ms
  rerank_delay_ms = opts.rerank_delay_ms or rerank_delay_ms
  deps = d
end

--- Asks the daemon for one phase of a search, 'words', 'meaning' or 'rerank'; `callback` gets its answer.
local function ask(query, phase, callback)
  next_id = next_id + 1
  waiting[next_id] = callback
  deps.send({type = 'find', id = next_id, query = query, phase = phase})
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

--- `items` with the rerank's `results` first, in the model's order, and the rest as they were. With `only`, the
--- results not among `items` are left out: a quickfix list keeps the pieces it had.
local function reranked(items, results, only)
  local out, placed, has = {}, {}, {}
  for _, item in ipairs(items) do has[key(item)] = true end
  for _, item in ipairs(results) do
    if not placed[key(item)] and (not only or has[key(item)]) then
      out[#out + 1] = item
      placed[key(item)] = true
    end
  end
  for _, item in ipairs(items) do
    if not placed[key(item)] then out[#out + 1] = item end
  end
  return out
end

local function by(rerank) return rerank and rerank.applied and (' (reranked by %s)'):format(rerank.model) or '' end

--- Sends `items`, the list a search for `query` shows, to a new quickfix list and opens it. `rerank` is what the
--- picker's rerank said, if it came. Returns `later(message)`, for a rerank still to come: its order replaces that
--- same list in place, unless you changed it, or made another list, meanwhile; the title then says who reranked it.
local function to_quickfix(query, items, rerank)
  local function entry(item) return {filename = item.path, lnum = item.line or item.from, col = 1, text = item.head or '', user_data = key(item)} end
  local title = 'Find: ' .. query
  vim.api.nvim_exec_autocmds('QuickFixCmdPre', {})
  vim.fn.setqflist({}, ' ', {title = title .. by(rerank), items = vim.tbl_map(entry, items)})
  vim.api.nvim_exec_autocmds('QuickFixCmdPost', {})
  vim.cmd('botright copen')
  local list = vim.fn.getqflist({id = 0, changedtick = 0})
  return function(message)
    local results = message.results or {}
    if not (message.rerank and message.rerank.applied and #results > 0) then return end -- the order stays
    local now = vim.fn.getqflist({id = 0})
    local it = vim.fn.getqflist({id = list.id, changedtick = 0, idx = 0, items = 0})
    if now.id ~= list.id or it.id ~= list.id or it.changedtick ~= list.changedtick then return end -- yours now
    local on = it.items[it.idx] and it.items[it.idx].user_data -- the entry you are on stays the one you are on
    local order = reranked(items, results, true)
    local idx = 1
    for index, item in ipairs(order) do
      if key(item) == on then idx = index end
    end
    vim.fn.setqflist({}, 'r', {id = list.id, title = title .. by(message.rerank), items = vim.tbl_map(entry, order), idx = idx})
  end
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

--- Once meaning came (and the list stayed as it is `rerank_delay_ms`): the fused ranking's first pieces are reranked in
--- the background, and go first once they come. A key before then drops it.
function Live:settle(query)
  self:stop_timer()
  if rerank_delay_ms <= 0 then return self:rerank(query) end
  self.due = query -- <C-q> before the delay is over asks for it at once
  self.timer = vim.uv.new_timer()
  self.timer:start(rerank_delay_ms, 0, vim.schedule_wrap(function()
    self:stop_timer()
    self.due = nil
    if self.done or self.query ~= query then return end
    self:rerank(query)
  end))
end

function Live:rerank(query)
  local rerank_id
  self.reranking = true
  self.changed(self, 'reranking')
  rerank_id = ask(query, 'rerank', function(message)
    if self.rerank_id ~= rerank_id then return end
    self.reranking = false
    self.rerank_info = message.rerank
    local results = message.results or {}
    if message.rerank and message.rerank.applied and #results > 0 then self.items = reranked(self.items, results) end
    if self.sent then self.sent(message) end -- the quickfix list it was sent to while it ran
    self.sent = nil
    if not self.done then self.changed(self, 'rerank') end
  end)
  self.rerank_id = rerank_id
  -- An answer that never comes (the daemon restarted) leaves the title as it was, not "reranking".
  vim.defer_fn(function()
    if self.rerank_id ~= rerank_id or not self.reranking then return end
    self.reranking, self.rerank_id, self.sent = false, nil, nil -- an answer that comes later is not used
    if not self.done then self.changed(self, 'reranking') end
  end, 10000)
end

function Live:set(query)
  query = vim.trim(query or '')
  if query == self.query then return end
  if self.reranking then deps.send({type = 'find', query = '', phase = 'cancel'}) end -- an empty prompt asks no words
  self.query, self.items, self.words, self.meaning, self.meaning_info = query, {}, nil, nil, nil
  self.words_id, self.meaning_id, self.meaning_due, self.due = nil, nil, false, nil
  self.rerank_id, self.rerank_info, self.reranking = nil, nil, false
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
  elseif rerank and rerank.applied then
    -- The models before it in the config's list that did not answer: "reranked by d1-2B (2.4 s; d3-flash not answering)".
    local passed = {}
    for _, skip in ipairs(rerank.skipped or {}) do passed[#passed + 1] = skip.model end
    parts[#parts + 1] = ('reranked by %s (%.1f s%s)'):format(rerank.model, (rerank.ms or 0) / 1000,
      #passed > 0 and ('; %s not answering'):format(table.concat(passed, ', ')) or '')
  end
  return #parts > 0 and ('Find (%s)'):format(table.concat(parts, ' · ')) or 'Find by meaning and words'
end

function Live:close()
  self.done = true
  self:stop_timer()
  -- The model's answer is not wanted, unless the list went to quickfix meanwhile.
  if self.reranking and not self.sent then deps.send({type = 'find', query = '', phase = 'cancel'}) end
end

--- <C-q>: the list as the picker shows it to quickfix, in the reranked order if it came; if it is still running, its
--- order replaces that list in place when it comes. `items` are the ones you selected, if any; `close` closes the picker.
function Live:to_quickfix(items, close)
  local query = self.query or ''
  items = items and #items > 0 and items or (self.answered == self.query and self.items or {})
  if self.due and self.due == self.query and not self.done then -- meaning came, the delay is not over: ask now
    self:stop_timer()
    self.due = nil
    self:rerank(self.query)
  end
  local pending = self.reranking and #items > 1
  if pending then self.sent = function() end end -- so that closing the picker does not cancel the rerank
  close()
  local later = to_quickfix(query, items, self.rerank_info)
  if pending and self.sent then self.sent = later end
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
    attach_mappings = function(prompt_bufnr, map)
      actions.select_default:enhance({pre = function()
        local selected = action_state.get_selected_entry()
        if selected then chosen(live.query, {selected.value}) end
      end})
      actions.close:enhance({post = function() live:close() end})
      -- <C-q> sends the hits to quickfix, as in any picker, in the reranked order: now, or once the rerank comes.
      for _, mode in ipairs({'i', 'n'}) do
        map(mode, '<C-q>', function() live:to_quickfix(nil, function() actions.close(prompt_bufnr) end) end)
      end
      return true
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
    -- Its place in the new list, set before the list is drawn again, so the cursor never shows on another piece.
    for index, item in ipairs(live.items) do
      if want and key(item) == want then pcall(current.list.set_target, current.list, index, nil, {force = true}) end
    end
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
    actions = {
      -- <C-q>: the items you selected, else the list, to quickfix in the reranked order: now, or once the rerank comes.
      qflist = function(p)
        live:to_quickfix(vim.tbl_map(function(item) return item.value end, p:selected()), function() p:close() end)
      end,
    },
  })
  return true
end

local function fzflua(query)
  local ok, fzf = pcall(require, 'fzf-lua')
  if not ok then return false end
  local line = function(item) return ('%s:%d:1:%s'):format(vim.fn.fnamemodify(item.path, ':~:.'), item.line or item.from, item.head or '') end
  local latest, last_prompt = 0, query
  local pieces = {} -- each line shown -> its piece, for ctrl-q
  local function show(fzf_cb, item)
    pieces[line(item)] = item
    fzf_cb(line(item))
  end
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
        for _, item in ipairs(words) do show(fzf_cb, item) end
        vim.defer_fn(function()
          if mine ~= latest then return fzf_cb() end
          ask(prompt, 'meaning', function(answer)
            local shown = {}
            for _, each in ipairs(words) do shown[key(each)] = true end
            for _, item in ipairs(answer.results or {}) do
              if not shown[key(item)] then show(fzf_cb, item) end
            end
            fzf_cb()
          end)
        end, debounce_ms)
      end)
    end
  end, {
    prompt = 'Find> ', query = query, previewer = 'builtin', file_icons = false, git_icons = false,
    winopts = {title = ' Find by meaning and words '},
    fzf_opts = {['--multi'] = true}, -- fzf_live has it off: ctrl-q selects all
    exec_empty_query = false,
    actions = {
      ['default'] = function(selected, opts)
        local file, row = (selected[1] or ''):match('^(.-):(%d+):')
        if file then chosen(last_prompt, {{file = vim.fn.fnamemodify(file, ':.'), line = tonumber(row), head = selected[1]:match('^.-:%d+:%d+:(.*)$')}}) end
        require('fzf-lua.actions').file_edit(selected, opts)
      end,
      -- The list (all of it, as <C-q> in Telescope) to quickfix. It only grows here, so it is not reranked while fzf is
      -- open; the quickfix list is, in place, once the rerank comes.
      ['ctrl-q'] = {prefix = 'select-all', fn = function(selected, opts)
        local items = {}
        for _, each in ipairs(selected) do items[#items + 1] = pieces[each] end
        if #items ~= #selected then return require('fzf-lua.actions').file_sel_to_qf(selected, opts) end
        local later = to_quickfix(last_prompt, items)
        if #items > 1 then ask(last_prompt, 'rerank', later) end -- without a rerank model the daemon says so, and the order stays
      end},
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
  local reranked = message.rerank and message.rerank.applied and (' (reranked by %s)'):format(message.rerank.model) or ''
  vim.ui.select(items, {prompt = ('Find: %s%s'):format(message.query, reranked), format_item = label}, function(item)
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
