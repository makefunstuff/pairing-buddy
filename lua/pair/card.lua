-- :Pair context: what the pair knows right now, on one card you can read and trim. The daemon sends the card
-- (see src/context-card.mjs): the goal and each source with the rows that go with a remark or a question. It is read
-- again every two seconds while it is open. `x` on a source hides it for this session, or brings it back.
local M = {}

local ns = vim.api.nvim_create_namespace('pair_card')
local REFRESH_MS = 2000
local LABEL = 10 -- the width of the labels column
local MAX_WIDTH = 100 -- a longer row is cut on the card with …, and sent whole

local card = {buf = nil, win = nil, timer = nil, sources = {}, sections = {}, wanted = false}
local request = function() end -- set by open: asks the daemon for the card

local function is_open()
  return card.win ~= nil and vim.api.nvim_win_is_valid(card.win)
end

function M.close()
  if card.timer then card.timer:stop() end
  card.timer = nil
  if is_open() then vim.api.nvim_win_close(card.win, true) end
  card.win, card.wanted = nil, false
end

--- The card as lines, each with its highlights ({group, from, to}) and the source it belongs to.
local function layout(message)
  local lines = {}
  local function add(chunks, source)
    local text, hls = ' ', {}
    for _, chunk in ipairs(chunks) do
      local piece, group = chunk[1], chunk[2]
      if group then table.insert(hls, {group, #text, #text + #piece}) end
      text = text .. piece
    end
    table.insert(lines, {text = text, hls = hls, source = source})
  end
  local function row(label, text, group, extra)
    local chunks = {{'  ' .. label .. string.rep(' ', math.max(1, LABEL - vim.fn.strdisplaywidth(label))), 'PairKey'}, {text, group}}
    if extra then table.insert(chunks, extra) end
    return chunks
  end

  add({{':Pair context', 'PairAccent'}})
  add({{'Everything below goes with a remark or a question. Nothing else does,'}})
  add({{'besides what you do now: the file, your edits, diagnostics and the last test run.', 'PairKey'}})
  add({})
  if message.goal ~= vim.NIL and message.goal then
    add(row('goal', message.goal, nil, message.goalFrom ~= vim.NIL and message.goalFrom and {' · from ' .. message.goalFrom, 'PairKey'} or nil))
    add({})
  end
  for _, section in ipairs(message.sections) do
    local source = section.source
    if section.hidden then
      add({{source, 'PairKey'}, {'  hidden for this session · x brings it back', 'PairKey'}}, source)
    else
      add({{source, 'PairAccent'}}, source)
    end
    if #section.rows == 0 and #section.notSent == 0 then add(row('', 'nothing yet', 'PairKey'), source) end
    for _, item in ipairs(section.rows) do
      local cut = (item.cut or 0) > 0 and {(item.text ~= '' and '   +' or '+') .. item.cut .. ' more, not sent', 'PairKey'} or nil
      add(row(item.label, item.text, section.hidden and 'PairSuggestDelete' or nil, cut), source)
    end
    for _, item in ipairs(section.notSent) do add(row(item.label, item.text, 'PairKey'), source) end
    add({}, source)
  end
  add({{'x hides a source for this session · q closes', 'PairKey'}})
  return lines
end

local function render(message)
  card.sections = message.sections
  local lines = layout(message)
  local most = math.min(MAX_WIDTH, vim.o.columns - 4)
  local texts, width = {}, 0
  for i, line in ipairs(lines) do
    texts[i] = line.text
    if vim.fn.strdisplaywidth(line.text) > most - 1 then
      texts[i] = vim.fn.strcharpart(line.text, 0, most - 2) .. '…'
      while vim.fn.strdisplaywidth(texts[i]) > most - 1 do texts[i] = vim.fn.strcharpart(texts[i], 0, vim.fn.strchars(texts[i]) - 2) .. '…' end
    end
    width = math.max(width, vim.fn.strdisplaywidth(texts[i]) + 1)
  end
  local height = math.min(#lines, vim.o.lines - 4)
  if not (card.buf and vim.api.nvim_buf_is_valid(card.buf)) then
    card.buf = vim.api.nvim_create_buf(false, true)
    vim.bo[card.buf].bufhidden = 'wipe'
    vim.bo[card.buf].filetype = 'paircard'
    vim.keymap.set('n', 'q', M.close, {buffer = card.buf, nowait = true, desc = 'Close the context card'})
    vim.keymap.set('n', '<Esc>', M.close, {buffer = card.buf, nowait = true, desc = 'Close the context card'})
    vim.keymap.set('n', 'x', M.toggle, {buffer = card.buf, nowait = true, desc = 'Hide this source, or bring it back'})
  end
  vim.bo[card.buf].modifiable = true
  vim.api.nvim_buf_set_lines(card.buf, 0, -1, false, texts)
  vim.bo[card.buf].modifiable = false
  vim.api.nvim_buf_clear_namespace(card.buf, ns, 0, -1)
  card.sources = {}
  for i, line in ipairs(lines) do
    card.sources[i] = line.source
    for _, hl in ipairs(line.hls) do
      local length = #texts[i]
      if hl[2] < length then vim.api.nvim_buf_set_extmark(card.buf, ns, i - 1, hl[2], {end_col = math.min(hl[3], length), hl_group = hl[1]}) end
    end
  end
  local placement = {relative = 'editor', row = 1, col = math.max(0, math.floor((vim.o.columns - width) / 2)), width = width, height = height}
  if is_open() then
    vim.api.nvim_win_set_config(card.win, placement)
  else
    card.win = vim.api.nvim_open_win(card.buf, true, vim.tbl_extend('force', placement, {style = 'minimal', border = 'none', zindex = 60}))
    vim.wo[card.win].wrap = false
    vim.wo[card.win].cursorline = true
    vim.api.nvim_win_set_cursor(card.win, {math.min(#lines, 5), 0})
    vim.api.nvim_create_autocmd('WinLeave', {buffer = card.buf, once = true, callback = M.close})
  end
end

--- `x`: hides the source under the cursor for this session, or brings it back.
function M.toggle()
  local source = card.sources[vim.api.nvim_win_get_cursor(0)[1]]
  if not source then return end
  for _, section in ipairs(card.sections) do
    if section.source == source then request({type = 'hide', source = source, hidden = not section.hidden}) end
  end
end

--- Opens the card; `send(message)` sends to the daemon, which answers with the card (see M.update).
function M.open(send)
  request = send
  card.wanted = true
  send({type = 'context'})
  card.timer = card.timer or vim.uv.new_timer()
  card.timer:start(REFRESH_MS, REFRESH_MS, vim.schedule_wrap(function()
    if is_open() then send({type = 'context'}) end
  end))
end

--- The daemon's card: shown when it was asked for, and redrawn while it is open.
function M.update(message)
  if card.wanted or is_open() then render(message) end
end

return M
