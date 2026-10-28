-- /gen file in Neovim: the new files a request drafted, as buffers to review (see docs/gen.md). Each is a buffer
-- named pair://gen/<n>/<path>, with buftype=acwrite, loaded but not opened: `:w` in it writes it to <path> and makes
-- it an ordinary buffer of that file, and that is taking it. A `:wa` from another buffer skips it and says so, and
-- since it stays modified until taken or dropped, quitting warns about it as about any change not written. Pair's
-- check on unsaved buffers (buffers.lua) counts it at its real path. `:Pair gen list` lists the file requests, with
-- the keys that open, take and drop their files. The daemon keeps each file's text until it is taken or dropped, so a
-- Neovim that restarted gets its buffers again when it connects. A file kept from a /gen try (:Pair keep) is one of
-- these buffers too, and it opens at once. The list shows a /gen scaffold's files too, those of its copy of the
-- project: `k` keeps one (a new file as one of these buffers, a change to a file of yours as suggestions in it), `d`
-- drops it, `Enter` opens it (a change, as a diff with your file), `r` checks the copy again, `t` opens a terminal
-- in it and `x` deletes it.
local style = require('pair.style')

local M = {}

M.ns = vim.api.nvim_create_namespace('pair_gen_files')
local list_ns = vim.api.nvim_create_namespace('pair_gen_list')

local MAX_HEIGHT = 16

-- What init.lua lends: send(message), redraw_status(), decide_key (the key that logs a decision), label(key).
local deps = {}
local proposals = {} -- buf -> {gen, action, piece, file, name}: the files to review
local entered = nil -- the buffer you went to last: a :wa writes the others from an autocommand window, not this one
local leaving = false -- Neovim quits: its buffers go, and nothing is dropped
local quiet = {} -- buf -> true: a buffer Pair itself takes away (taken, dropped, undone), which drops nothing more
local skipped = nil -- the proposals a :wa skipped, said once it is done
local view = {buf = nil, win = nil, from = nil, rows = {}, requests = {}}

local group = vim.api.nvim_create_augroup('pair_gen_files', {clear = true})

local function plural(n, noun) return ('%d %s%s'):format(n, noun, n == 1 and '' or 's') end

local function winbar(info)
  return ((' generated · gen #%d · :w takes it to %s '):format(info.gen, info.name):gsub('%%', '%%%%'))
end

--- The buffer of piece `piece` of ledger entry `action`, if Neovim has it.
local function find(action, piece)
  for buf, info in pairs(proposals) do
    if info.action == action and info.piece == piece and vim.api.nvim_buf_is_valid(buf) then return buf end
  end
end

--- Takes `buf` away, as Pair: it was taken, dropped, or its request undone.
local function remove(buf)
  proposals[buf] = nil
  if not vim.api.nvim_buf_is_valid(buf) then return end
  quiet[buf] = true
  pcall(vim.api.nvim_buf_delete, buf, {force = true})
  quiet[buf] = nil
end

--- The windows that showed proposal `buf` show `other` instead, else their alternate buffer, else an empty one.
local function swap_out(buf, other)
  for _, win in ipairs(vim.fn.win_findbuf(buf)) do
    vim.api.nvim_win_call(win, function()
      local alternate = vim.fn.bufnr('#')
      if other then vim.api.nvim_win_set_buf(win, other)
      elseif alternate > 0 and alternate ~= buf and vim.bo[alternate].buflisted then vim.api.nvim_win_set_buf(win, alternate)
      else vim.cmd('enew') end
    end)
  end
end

--- Takes the proposal in `buf`: writes it to its real path (`force` over a file there now) and opens that file in
--- its place. False, with why, when it is not written.
local function take(buf, force)
  local info = proposals[buf]
  if not info then return false end
  if vim.uv.fs_stat(info.file) and not force then
    vim.notify(('Pair: %s exists now; :w! writes over it'):format(info.name), vim.log.levels.WARN)
    return false
  end
  local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
  if not pcall(vim.fn.mkdir, vim.fs.dirname(info.file), 'p') or vim.fn.writefile(lines, info.file) ~= 0 then
    vim.notify(('Pair: could not write %s'):format(info.name), vim.log.levels.ERROR)
    return false
  end
  vim.bo[buf].modified = false
  local text = table.concat(lines, '\n') .. '\n'
  deps.send({type = 'gen_written', action = info.action, piece = info.piece, text = text})
  -- Not inside the write itself, where the buffer cannot go.
  vim.schedule(function()
    local file = vim.fn.bufadd(vim.fn.fnamemodify(info.file, ':.'))
    vim.fn.bufload(file)
    vim.bo[file].buflisted = true
    swap_out(buf, file)
    remove(buf)
    deps.redraw_status()
    if view.win and vim.api.nvim_win_is_valid(view.win) then M.refresh() end
  end)
  return true
end

--- `:w <other file>` in a proposal: a copy there, as :w would write one, and the proposal stays to review.
local function write_elsewhere(buf, file)
  if vim.uv.fs_stat(file) and vim.v.cmdbang ~= 1 then
    return vim.notify(('Pair: %s exists; :w! writes over it'):format(vim.fn.fnamemodify(file, ':.')), vim.log.levels.ERROR)
  end
  if vim.fn.writefile(vim.api.nvim_buf_get_lines(buf, 0, -1, false), file) ~= 0 then
    return vim.notify(('Pair: could not write %s'):format(vim.fn.fnamemodify(file, ':.')), vim.log.levels.ERROR)
  end
  vim.notify(('Pair: written to %s; the proposal is still to review, :w takes it'):format(vim.fn.fnamemodify(file, ':.')))
end

local function on_write(args)
  local buf = args.buf
  -- A write to another name (:w other.txt) is no take: it writes there, and nothing else.
  if args.file ~= '' and args.file ~= vim.api.nvim_buf_get_name(buf) then
    return write_elsewhere(buf, vim.fn.fnamemodify(args.file, ':p'))
  end
  -- Only the buffer you are in: a :wa from elsewhere writes the others from an autocommand window.
  if buf == entered and vim.api.nvim_get_current_buf() == buf and vim.fn.win_gettype() ~= 'autocmd' then
    take(buf, vim.v.cmdbang == 1) -- no value back: a callback that returns true deletes its autocommand
    return
  end
  local info = proposals[buf]
  if not info then return end
  if not skipped then
    skipped = {}
    vim.schedule(function()
      local by_gen, order = {}, {}
      for _, one in ipairs(skipped) do
        if not by_gen[one.gen] then table.insert(order, one.gen) end
        by_gen[one.gen] = (by_gen[one.gen] or 0) + 1
      end
      local parts = {}
      for _, n in ipairs(order) do table.insert(parts, ('gen #%d: %s not taken'):format(n, plural(by_gen[n], 'buffer'))) end
      skipped = nil
      vim.notify('Pair: ' .. table.concat(parts, '; ') .. '. :w in one takes it; :Pair gen list lists them')
    end)
  end
  table.insert(skipped, info)
end

--- A proposal buffer for `file` ({piece, file, name, text, marks}) of request `gen` (ledger entry `action`).
local function make(gen, action, file)
  local name = ('pair://gen/%d/%s'):format(gen, file.name)
  local buf = vim.api.nvim_create_buf(true, false)
  if not pcall(vim.api.nvim_buf_set_name, buf, name) then
    -- A buffer of that name that Pair no longer knows: it goes, and this one takes its place.
    local old = vim.fn.bufnr(name)
    if old > 0 and not proposals[old] then
      remove(old)
      pcall(vim.api.nvim_buf_set_name, buf, name)
    end
  end
  vim.bo[buf].buftype = 'acwrite'
  vim.bo[buf].swapfile = false
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, vim.split(file.text or '', '\n', {plain = true}))
  local filetype = vim.filetype.match({filename = file.file, buf = buf})
  if filetype then vim.bo[buf].filetype = filetype end
  vim.bo[buf].modified = true -- not on disk: quitting warns, as for any change not written
  local info = {gen = gen, action = action, piece = file.piece, file = file.file, name = file.name, text = file.text or ''}
  proposals[buf] = info
  vim.b[buf].pair_gen = {gen = gen, action = action, piece = file.piece, file = file.file}
  for _, mark in ipairs(type(file.marks) == 'table' and file.marks or {}) do
    pcall(vim.api.nvim_buf_set_extmark, buf, M.ns, math.max(0, mark.line - 1), 0, {
      sign_text = style.glyphs.contradiction, sign_hl_group = 'PairSign',
      virt_lines = {{{'  ' .. mark.text, 'PairNote'}}},
    })
  end
  vim.api.nvim_create_autocmd('BufWriteCmd', {group = group, buffer = buf, callback = on_write})
  -- Like :setlocal, for this buffer in the window: another buffer there keeps the window's own winbar.
  vim.api.nvim_create_autocmd('BufWinEnter', {group = group, buffer = buf, callback = function()
    vim.api.nvim_set_option_value('winbar', winbar(info), {scope = 'local'})
  end})
  -- :e! reads it again: the draft as the request made it, still to review. There is no file to read.
  vim.api.nvim_create_autocmd('BufReadCmd', {group = group, buffer = buf, callback = function()
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, vim.split(info.text, '\n', {plain = true}))
    vim.bo[buf].modified = true
  end})
  vim.api.nvim_create_autocmd('BufUnload', {group = group, buffer = buf, callback = function()
    if quiet[buf] or leaving then
      proposals[buf] = nil
      return
    end
    -- You took it away (:bd!, :bw!): it is dropped. Not when Neovim quits, nor when Pair takes it away, nor a
    -- reload (:e!), after which the buffer is loaded again.
    vim.schedule(function()
      if not proposals[buf] or (vim.api.nvim_buf_is_valid(buf) and vim.api.nvim_buf_is_loaded(buf)) then return end
      proposals[buf] = nil
      deps.send({type = 'gen_dropped', action = info.action, piece = info.piece})
      deps.redraw_status()
    end)
  end})
  return buf
end

--- Shows `buf` where you asked for it: in the window of the try you kept it from, else in a split below yours.
local function show(buf)
  local win = vim.api.nvim_get_current_win()
  if vim.b[vim.api.nvim_win_get_buf(win)].pair_try then return vim.api.nvim_win_set_buf(win, buf) end
  vim.cmd('belowright split')
  vim.api.nvim_win_set_buf(0, buf)
  vim.api.nvim_set_current_win(win)
end

--- The daemon's gen_files: the files of request `message.gen` to review, as buffers. A file Neovim has already (after
--- a daemon restart) keeps its buffer, with your changes in it. With `message.open` (a file kept from a try), they
--- open too.
function M.on_files(message)
  local made = 0
  for _, file in ipairs(message.files or {}) do
    local buf = find(message.action, file.piece)
    if buf and message.open then
      -- Kept again, as the try has it now.
      vim.api.nvim_buf_set_lines(buf, 0, -1, false, vim.split(file.text or '', '\n', {plain = true}))
      proposals[buf].text = file.text or ''
    elseif not buf then
      buf = make(message.gen, message.action, file)
      made = made + 1
    end
    if message.open then show(buf) end
  end
  if made > 0 and not message.reopen and not message.open then
    vim.notify(('Pair · gen #%d: %s to review, as buffers: :Pair gen list'):format(message.gen, plural(made, 'file')))
  end
  deps.redraw_status()
  return {ok = true}
end

--- The daemon took request `n` back (/undo, cancelled): its files still to review go.
function M.drop_gen(n)
  for buf, info in pairs(proposals) do
    if info.gen == n then
      swap_out(buf)
      remove(buf)
    end
  end
  deps.redraw_status()
end

--- /undo of a request whose file you wrote: the file goes while it is as you wrote it, and its buffer with it.
function M.unwrite(message)
  local file = message.file
  local buf = -1
  for _, one in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_get_name(one) == file then buf = one end
  end
  if buf ~= -1 and vim.api.nvim_buf_is_loaded(buf) and vim.bo[buf].modified then return {error = 'it has changes you have not saved'} end
  if not vim.uv.fs_stat(file) then return {error = 'it is gone already'} end
  local now = table.concat(vim.fn.readfile(file, 'b'), '\n')
  if now ~= message.text then return {error = 'it changed since you wrote it'} end
  if buf ~= -1 then
    swap_out(buf)
    pcall(vim.api.nvim_buf_delete, buf, {force = true})
  end
  local ok, err = os.remove(file)
  if not ok then return {error = err} end
  return {ok = true}
end

--- The files to review now: {gen -> count}, and how many in all.
local function counts()
  local by_gen, all = {}, 0
  for buf, info in pairs(proposals) do
    if vim.api.nvim_buf_is_valid(buf) then
      by_gen[info.gen] = (by_gen[info.gen] or 0) + 1
      all = all + 1
    end
  end
  return by_gen, all
end

--- What the statusline says of the files to review: `gen #4 · 2 to review · :Pair gen list`, or nil. With `n`,
--- only request n's.
function M.status(n)
  local by_gen, all = counts()
  if all == 0 or (n and not by_gen[n]) then return nil end
  if n then return ('gen #%d · %d to review · :Pair gen list'):format(n, by_gen[n]) end
  local only = next(by_gen)
  if next(by_gen, only) == nil then return ('gen #%d · %d to review · :Pair gen list'):format(only, all) end
  return ('gen · %d to review · :Pair gen list'):format(all)
end

-- The review list: :Pair gen list, in a split at the bottom, as :Pair today.

local function valid_win() return view.win and vim.api.nvim_win_is_valid(view.win) end

local function current()
  if not valid_win() or vim.api.nvim_win_get_buf(view.win) ~= view.buf then return nil end
  return view.rows[vim.api.nvim_win_get_cursor(view.win)[1]]
end

local function work_window()
  if view.from and vim.api.nvim_win_is_valid(view.from) and view.from ~= view.win then return view.from end
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if win ~= view.win and vim.api.nvim_win_get_config(win).relative == '' then return win end
  end
end

--- The buffer of `file` in `request`, made again from the daemon's text when Neovim lost it.
local function buffer_of(request, file)
  return find(request.action, file.piece) or (file.text and make(request.gen, request.action, file))
end

--- Enter on a file of a scaffold's copy: a new one opens in the window you came from; a change opens your file there,
--- with the copy's beside it as a diff.
local function open_tree(row)
  local entry = row.tree
  if row.request.deleted or not vim.uv.fs_stat(entry.tree) then return vim.notify(('Pair: gen #%d: its copy is deleted'):format(row.request.gen)) end
  local win = work_window()
  if win then vim.api.nvim_set_current_win(win) else vim.cmd('aboveleft split') end
  if entry.isNew then return vim.cmd('edit ' .. vim.fn.fnameescape(entry.tree)) end
  vim.cmd('edit ' .. vim.fn.fnameescape(vim.fn.fnamemodify(entry.file, ':.')))
  vim.cmd('vertical diffsplit ' .. vim.fn.fnameescape(entry.tree))
end

--- t: a terminal of yours in the scaffold's copy, in a split above the list. Yours, not Pair's: no sandbox.
local function terminal(request)
  if request.deleted or not vim.uv.fs_stat(request.dir) then return vim.notify(('Pair: gen #%d: its copy is deleted'):format(request.gen)) end
  local win = work_window()
  if win then vim.api.nvim_set_current_win(win) end
  vim.cmd('belowright new')
  vim.fn.jobstart({vim.o.shell}, {term = true, cwd = request.dir})
  vim.cmd('startinsert')
end

local function open(row)
  if row.tree and not row.file then return open_tree(row) end
  local file, request = row.file, row.request
  local buf
  if file.state == 'proposed' then buf = buffer_of(request, file)
  elseif file.state == 'taken' then
    buf = vim.fn.bufadd(vim.fn.fnamemodify(file.file, ':.'))
    vim.bo[buf].buflisted = true
  end
  if not buf then return end
  local win = work_window()
  if win then vim.api.nvim_set_current_win(win) else vim.cmd('aboveleft split') end
  vim.api.nvim_win_set_buf(0, buf)
end

local function take_row(row)
  if row.file.state ~= 'proposed' then return end
  local buf = buffer_of(row.request, row.file)
  if buf then take(buf, false) end
end

local function drop_row(row)
  if row.file.state ~= 'proposed' then return end
  local buf = find(row.request.action, row.file.piece)
  if buf then
    swap_out(buf)
    remove(buf)
  end
  deps.send({type = 'gen_dropped', action = row.request.action, piece = row.file.piece})
  M.refresh()
end

--- Asks `prompt` with a yes (`yes`, what it does) and a no; runs `run` on the yes.
local function confirm(prompt, yes, run)
  local choices = {{key = 'y', what = yes}, {key = 'n', what = 'no'}}
  vim.ui.select(choices, {prompt = prompt, format_item = function(choice) return choice.what end, kind = 'pair_gen_all'}, function(choice)
    if choice and choice.key == 'y' then run() end
  end)
end

--- W and D: every file of the request still to review, once you said yes.
local function all(row, verb)
  local request = row and row.request
  if not request then return end
  local left = vim.tbl_filter(function(file) return file.state == 'proposed' end, request.files)
  if #left == 0 then return end
  local choices = {{key = 'y', what = ('yes, %s all %s'):format(verb, plural(#left, 'file'))}, {key = 'n', what = 'no'}}
  local prompt = ('%s all %s of gen #%d? Read them first.'):format(verb == 'take' and 'Take' or 'Drop', plural(#left, 'file'), request.gen)
  vim.ui.select(choices, {prompt = prompt, format_item = function(choice) return choice.what end, kind = 'pair_gen_all'}, function(choice)
    if not choice or choice.key ~= 'y' then return end
    for _, file in ipairs(left) do
      local one = {request = request, file = file}
      if verb == 'take' then take_row(one) else drop_row(one) end
    end
  end)
end

local function act(key)
  local row = current()
  if key == 'u' then
    if row and row.request then deps.send({type = 'undo', action = row.request.action}) M.refresh() end
    return
  end
  local scaffold = row and row.request and row.request.shape == 'scaffold' and row.request or nil
  if key == 'k' then
    if row and row.tree and row.tree.state ~= 'kept' and not scaffold.deleted then
      deps.send({type = 'keep', action = scaffold.action, piece = row.tree.piece})
      M.refresh()
    end
    return
  end
  if key == 'x' or key == 'r' or key == 't' then
    if not scaffold or scaffold.deleted then return end
    if key == 'r' then return deps.send({type = 'gen_check', action = scaffold.action}) end
    if key == 't' then return terminal(scaffold) end
    local left = #vim.tbl_filter(function(entry) return entry.state == 'proposed' end, scaffold.tree)
    local what = scaffold.mode == 'worktree' and 'worktree' or 'copy'
    local prompt = ('Delete gen #%d\'s %s?%s'):format(scaffold.gen, what, left > 0 and (' The %s not kept go with it.'):format(plural(left, 'file')) or '')
    return confirm(prompt, ('yes, delete the %s'):format(what), function()
      deps.send({type = 'gen_copy_delete', action = scaffold.action})
      M.refresh()
    end)
  end
  if key == 'd' and row and row.tree and not row.file then
    if row.tree.state == 'proposed' then deps.send({type = 'gen_tree_drop', action = scaffold.action, piece = row.tree.piece}) M.refresh() end
    return
  end
  if key == 'open' and row and row.tree then return open(row) end
  if key == 'W' or key == 'D' then return all(row, key == 'W' and 'take' or 'drop') end
  if key == 'decide' then
    if row and row.guess then deps.send({type = 'gen_decide', action = row.request.action, guess = row.guess - 1}) end
    return
  end
  if not (row and row.file) then return end
  if key == 'open' then return open(row) end
  if key == 'w' then return take_row(row) end
  if key == 'd' then return drop_row(row) end
end

local function hhmm(at) return os.date('%H:%M', math.floor(at / 1000)) end

--- A scaffold's files, those of its copy, under its head: what each is (+ new, ~ a change to a file of yours), and
--- what was done with it. A file kept as a buffer to review is that buffer's row too: Enter opens it, w takes it.
local function render_tree(request, add)
  local width = 0
  for _, entry in ipairs(request.tree) do width = math.max(width, vim.fn.strdisplaywidth(entry.name)) end
  local files = {}
  for _, file in ipairs(request.files) do files[file.piece] = file end
  for _, entry in ipairs(request.tree) do
    local size = entry.isNew and ('+%d'):format(entry.added) or ('+%d -%d'):format(entry.added, entry.removed)
    local file = entry.kept and files[entry.kept] or nil
    local what
    if entry.state == 'proposed' then
      what = entry.isNew and ('%-8s ⏎ open  k keep  d drop'):format(size) or ('%-8s ⏎ diff  k as suggestions  d drop'):format(size)
    elseif entry.state == 'kept' and file then
      what = file.state == 'proposed' and 'kept · unsaved · ⏎ open  w take' or file.state == 'taken' and 'kept · written · ⏎ open' or ('kept · %s'):format(file.state)
    elseif entry.state == 'kept' then
      what = entry.hunks and ('kept · %d of %s taken'):format(entry.taken or 0, plural(entry.hunks, 'change')) or 'kept · nothing to change'
    else
      what = request.deleted and 'dropped' or ('%-8s dropped · k keeps it after all'):format(size)
    end
    local glyph = ({proposed = style.glyphs.away, kept = style.glyphs.pass})[entry.state] or '·'
    local mark = entry.isNew and '+' or '~'
    local text = ('  %s %s %s%s   %s'):format(glyph, mark, entry.name, string.rep(' ', width - vim.fn.strdisplaywidth(entry.name)), what)
    local hls = {{#text - #what, -1, 'PairKey'}}
    if entry.state == 'dropped' then table.insert(hls, {2, #text - #what, 'PairSuggestDelete'}) end
    add(text, {request = request, tree = entry, file = file and (file.state == 'proposed' or file.state == 'taken') and file or nil}, hls)
  end
  if not request.deleted then
    local what = request.mode == 'worktree' and 'worktree' or 'copy'
    add(('  t terminal in the %s · r run the check again · x delete the %s'):format(what, what), {request = request}, {{0, -1, 'PairKey'}})
  end
end

local function render()
  local lines, marks, rows = {}, {}, {}
  -- `hls`: {from, to, group}, `to` -1 for the end of the line.
  local function add(text, row, hls)
    table.insert(lines, text)
    rows[#lines] = row
    for _, hl in pairs(hls or {}) do table.insert(marks, {#lines - 1, hl[1], hl[2], hl[3]}) end
  end
  local decide = deps.label and deps.label(deps.decide_key) or nil
  for i, request in ipairs(view.requests) do
    if i > 1 then add('', nil) end
    local head = ('gen #%d · %s · %s · %s'):format(request.gen, request.shape or 'file', (request.words:gsub('\n', ' ')), hhmm(request.at))
    add(head, {request = request}, {{0, #('gen #' .. request.gen), 'PairAccent'}})
    local about = {}
    if request.brief and request.brief ~= vim.NIL then table.insert(about, 'brief ' .. request.brief) end
    if request.check and request.check ~= vim.NIL then
      table.insert(about, ('%s %s (unsaved) · %s'):format(request.check.mark == 'pass' and style.glyphs.pass or style.glyphs.fail, request.check.label, request.check.text))
    end
    if request.running then table.insert(about, 'generating') end
    if request.state == 'undone' then table.insert(about, 'undone · u again makes it again') end
    if request.shape == 'scaffold' then
      local kept = #vim.tbl_filter(function(entry) return entry.state == 'kept' end, request.tree)
      local where = request.deleted and (request.mode == 'worktree' and 'worktree deleted' or 'copy deleted')
        or request.mode == 'worktree' and ('worktree %s · branch %s'):format(vim.fn.fnamemodify(request.dir, ':~'), request.branch)
        or ('copy %s'):format(vim.fn.fnamemodify(request.dir, ':~'))
      table.insert(about, 1, ('%s · %d of %d kept'):format(where, kept, #request.tree))
    end
    if #about > 0 then add('  ' .. table.concat(about, '   '), {request = request}, {{0, -1, 'PairKey'}}) end
    if request.shape == 'scaffold' then
      render_tree(request, add)
    else
      local width = 0
      for _, file in ipairs(request.files) do width = math.max(width, vim.fn.strdisplaywidth(file.name)) end
      for _, file in ipairs(request.files) do
        local glyph = ({proposed = style.glyphs.away, taken = style.glyphs.pass, dropped = '·', undone = '·'})[file.state] or '·'
        local what = file.state == 'proposed' and ('+%-4d ⏎ open  w take  d drop'):format(file.lines)
          or file.state == 'taken' and 'taken · ⏎ open' or file.state
        local text = ('  %s %s%s   %s'):format(glyph, file.name, string.rep(' ', width - vim.fn.strdisplaywidth(file.name)), what)
        local hls = {{#text - #what, -1, 'PairKey'}}
        if file.state ~= 'proposed' and file.state ~= 'taken' then table.insert(hls, {2, #text - #what, 'PairSuggestDelete'}) end
        add(text, {request = request, file = file}, hls)
      end
      for _, change in ipairs(request.changes or {}) do
        add(('  ~ %s:%d   a suggestion there · %s'):format(change.name, change.line, change.state), {request = request}, {{0, -1, 'PairKey'}})
      end
    end
    for _, line in ipairs(request.contradicts or {}) do add('  ' .. line, {request = request}, {{2, 2 + #'≠', 'PairSign'}}) end
    for g, guess in ipairs(request.guessed or {}) do
      local tail = decide and ('   %s logs it as a decision'):format(decide) or ''
      local text = '  ? guessed ' .. guess
      add(text .. tail, {request = request, guess = g}, {{2, 3, 'PairSign'}, {#text, -1, 'PairKey'}})
    end
  end
  if #view.requests == 0 then add('No /gen file or scaffold request, nor a file kept from a try, in the last days. :Pair gen file <what> asks for one.', nil, {{0, -1, 'PairKey'}}) end
  add('', nil)
  local any_scaffold = vim.iter(view.requests):any(function(request) return request.shape == 'scaffold' end)
  add(('⏎ open · w take · %sd drop · W take all · D drop all · u undo the request · q close'):format(any_scaffold and 'k keep · ' or ''), nil, {{0, -1, 'PairKey'}})
  view.rows = rows
  vim.bo[view.buf].modifiable = true
  vim.api.nvim_buf_set_lines(view.buf, 0, -1, false, lines)
  vim.bo[view.buf].modifiable = false
  vim.api.nvim_buf_clear_namespace(view.buf, list_ns, 0, -1)
  for _, mark in ipairs(marks) do
    local row, from, to, hl = unpack(mark)
    local last = #lines[row + 1]
    pcall(vim.api.nvim_buf_set_extmark, view.buf, list_ns, row, math.min(from, last), {end_col = to < 0 and last or math.min(to, last), hl_group = hl})
  end
end

local function list_buffer()
  local buf = vim.api.nvim_create_buf(false, true)
  pcall(vim.api.nvim_buf_set_name, buf, 'pair://gen/list')
  vim.bo[buf].bufhidden = 'hide'
  vim.bo[buf].filetype = 'pairgenlist'
  vim.bo[buf].modifiable = false
  local function map(key, run, desc) vim.keymap.set('n', key, run, {buffer = buf, nowait = true, desc = desc}) end
  map('<CR>', function() act('open') end, 'Open the file Pair generated')
  map('w', function() act('w') end, 'Take the file: write it to its path')
  map('d', function() act('d') end, 'Drop the file')
  map('W', function() act('W') end, 'Take every file of the request')
  map('D', function() act('D') end, 'Drop every file of the request')
  map('u', function() act('u') end, 'Undo the request, or make it again')
  map('k', function() act('k') end, 'Keep the file of the scaffold\'s copy')
  map('x', function() act('x') end, 'Delete the scaffold\'s copy')
  map('r', function() act('r') end, 'Run the check again in the scaffold\'s copy')
  map('t', function() act('t') end, 'A terminal in the scaffold\'s copy')
  map('q', function() M.close() end, 'Close the list')
  if deps.decide_key and deps.decide_key ~= '' then map(deps.decide_key, function() act('decide') end, 'Log the guess as a decision') end
  return buf
end

--- :Pair gen list: opens the list, or goes to it, and asks the daemon for the file requests.
function M.open()
  if not (view.buf and vim.api.nvim_buf_is_valid(view.buf)) then view.buf = list_buffer() end
  if not valid_win() then
    view.from = vim.api.nvim_get_current_win()
    vim.cmd('botright ' .. math.min(MAX_HEIGHT, math.max(4, #vim.api.nvim_buf_get_lines(view.buf, 0, -1, false))) .. 'split')
    view.win = vim.api.nvim_get_current_win()
    vim.api.nvim_win_set_buf(view.win, view.buf)
    for option, value in pairs({number = false, relativenumber = false, signcolumn = 'no', foldcolumn = '0', cursorline = true, wrap = false, winfixheight = true, list = false, spell = false}) do
      vim.wo[view.win][option] = value
    end
    vim.wo[view.win].statusline = ('%%#PairStatus#%s %%#PairStatusDim#pair · gen list'):format(style.glyphs.voice)
  else
    vim.api.nvim_set_current_win(view.win)
  end
  M.refresh()
end

function M.refresh()
  view.refresh = view.refresh or vim.uv.new_timer()
  view.refresh:start(100, 0, vim.schedule_wrap(function() deps.send({type = 'gen_review'}) end))
end

--- Asks the daemon for the list again, when it is open: something in it changed elsewhere (/keep in the chat).
function M.refresh_open()
  if valid_win() then M.refresh() end
end

function M.close()
  if valid_win() and #vim.api.nvim_tabpage_list_wins(0) > 1 then vim.api.nvim_win_close(view.win, true) end
  view.win = nil
end

--- The daemon's gen_review: the file requests, newest first.
function M.on_review(message)
  if not (view.buf and vim.api.nvim_buf_is_valid(view.buf)) then return end
  local at = current()
  view.requests = message.requests or {}
  render()
  if not valid_win() then return end
  local height = math.min(MAX_HEIGHT, math.max(4, vim.api.nvim_buf_line_count(view.buf)))
  if vim.api.nvim_win_get_height(view.win) < height then pcall(vim.api.nvim_win_set_height, view.win, height) end
  -- The cursor stays on its file while it is to review, else goes to the first file that is.
  -- A row to act on: a file to review, or a file of a scaffold's copy not kept yet (once kept, the next one is).
  local function todo(row)
    if not row then return false end
    if row.tree then return row.tree.state == 'proposed' end
    return row.file ~= nil and row.file.state == 'proposed'
  end
  local function same(row)
    if not (at and row and row.request.action == at.request.action) then return false end
    if at.tree and row.tree then return row.tree.piece == at.tree.piece end
    return at.file and row.file and not at.tree and not row.tree and row.file.piece == at.file.piece
  end
  local line
  for i, row in pairs(view.rows) do
    if same(row) and todo(row) then line = i end
  end
  if not line then
    for i = 1, vim.api.nvim_buf_line_count(view.buf) do
      if todo(view.rows[i]) then line = i break end
    end
  end
  if line and vim.api.nvim_win_get_buf(view.win) == view.buf then pcall(vim.api.nvim_win_set_cursor, view.win, {line, 0}) end
end

function M.setup(lent)
  deps = lent
  vim.api.nvim_create_autocmd('BufEnter', {group = group, callback = function(args) entered = args.buf end})
  vim.api.nvim_create_autocmd('VimLeavePre', {group = group, callback = function() leaving = true end})
end

return M
