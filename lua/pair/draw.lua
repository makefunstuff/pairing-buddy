-- Drawing the pair in your buffers, in its visual language (style.lua): its words under a line, the lines it
-- points at, the changes it suggests, and its gaze in the line numbers. Only extmarks: no windows, no boxes.
-- What it draws rises from the background in a quarter of a second, unless motion is off.
local style = require('pair.style')

local M = {}

M.ns = vim.api.nvim_create_namespace('pair')
M.suggest_ns = vim.api.nvim_create_namespace('pair_suggest')
M.tests_ns = vim.api.nvim_create_namespace('pair_tests')
local gaze_ns = vim.api.nvim_create_namespace('pair_gaze')

M.motion = true -- setup's `motion` option
local FADE_FRAMES, FRAME_MS = 10, 28 -- a fade-in of 280 ms
local MAX_LINES = 3 -- of the pair's words under a line; the chat has them all

--- The window showing `buf`: the current one if it does, else the first in this tab page, else the current
--- one, where it would show if you went there.
local function window_of(buf)
  local current = vim.api.nvim_get_current_win()
  if vim.api.nvim_win_get_buf(current) == buf then return current end
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if vim.api.nvim_win_get_buf(win) == buf then return win end
  end
  return current
end

--- How many columns of text `win` shows, after its number and sign columns.
local function text_width(win)
  local info = vim.fn.getwininfo(win)[1]
  return info.width - info.textoff
end

local function line_of(buf, row)
  return vim.api.nvim_buf_get_lines(buf, row, row + 1, false)[1] or ''
end

--- How many columns the indent of row `row` takes. Counted here: switching to the buffer to ask would run its
--- autocommands, and tell the daemon you went there.
local function indent_of(buf, row)
  local tabstop, width = vim.bo[buf].tabstop, 0
  for char in line_of(buf, row):match('^%s*'):gmatch('.') do
    width = char == '\t' and (math.floor(width / tabstop) + 1) * tabstop or width + 1
  end
  return width
end

-- Text: the pair writes Markdown-ish lines, where `code` is code. It shows in the accent, without the backticks.

--- The words of `text`, each {text, code, space}: a `code` span is one word; `space` says a space came before it.
local function tokens(text)
  local out, i = {}, 1
  while i <= #text do
    local a, b = text:find('`[^`]+`', i)
    local plain = text:sub(i, a and a - 1 or #text)
    for space, word in plain:gmatch('(%s*)(%S+)') do table.insert(out, {text = word, space = space ~= ''}) end
    if not a then break end
    table.insert(out, {text = text:sub(a + 1, b - 1), code = true, space = plain:match('%s$') ~= nil})
    i = b + 1
  end
  return out
end

--- `text` as lines of chunks at most `width` wide: words in `base`, code in PairCode.
local function wrap(text, width, base)
  local lines = {}
  for paragraph in (text .. '\n'):gmatch('(.-)\n') do
    local line, used = {}, 0
    for _, token in ipairs(tokens(paragraph)) do
      local size = vim.fn.strdisplaywidth(token.text)
      local gap = (used > 0 and token.space) and 1 or 0
      if used > 0 and used + gap + size > width then
        table.insert(lines, line)
        line, used, gap = {}, 0, 0
      end
      if gap > 0 then table.insert(line, {' ', base}) end
      table.insert(line, {token.text, token.code and 'PairCode' or base})
      used = used + gap + size
    end
    if used > 0 then table.insert(lines, line) end
  end
  return lines
end

local function width_of(chunks)
  local width = 0
  for _, chunk in ipairs(chunks) do width = width + vim.fn.strdisplaywidth(chunk[1]) end
  return width
end

--- The pair's voice: `text` as virtual lines indented by `indent`, `glyph` (by default the voice glyph) before the
--- first line and `key` (the key that acts on it) dimmed after the last; at most MAX_LINES, cut with an ellipsis.
local function voice(text, indent, width, key, glyph)
  local lines = wrap(text, math.max(20, width - indent - 2), 'PairNote')
  if #lines > MAX_LINES then
    lines = vim.list_slice(lines, 1, MAX_LINES)
    table.insert(lines[MAX_LINES], {' …', 'PairNote'})
  end
  for i, line in ipairs(lines) do
    table.insert(line, 1, i == 1 and {(glyph or style.glyphs.voice) .. ' ', 'PairAccent'} or {'  '})
    table.insert(line, 1, {string.rep(' ', indent)})
  end
  if key and lines[1] then
    -- After the last line where it fits, else on a line of its own: a key cut off at the window's edge is no use.
    if width_of(lines[#lines]) + 3 + vim.fn.strdisplaywidth(key) <= width then
      table.insert(lines[#lines], {'   ' .. key, 'PairKey'})
    else
      table.insert(lines, {{string.rep(' ', indent + 2)}, {key, 'PairKey'}})
    end
  end
  return lines
end

-- The fade: each frame sets the extmark again with every group at its step of the way in.

--- Shows a frame now: Neovim does not repaint for changes made in a timer until something else happens.
local function show(buf)
  if vim.fn.bufwinid(buf) ~= -1 then vim.cmd.redraw() end
end

-- Slow at both ends: the words arrive without a jump at the start or a snap at the end.
local function ease(p) return p * p * (3 - 2 * p) end

local GROUP_FIELDS = {'hl_group', 'line_hl_group', 'sign_hl_group', 'number_hl_group'}

local function painted(opts, t)
  if t >= 1 then return opts end
  local out = vim.deepcopy(opts)
  local function paint(chunks)
    for _, chunk in ipairs(chunks) do
      if chunk[2] then chunk[2] = style.fade(chunk[2], t) end
    end
  end
  if out.virt_text then paint(out.virt_text) end
  for _, line in ipairs(out.virt_lines or {}) do paint(line) end
  for _, field in ipairs(GROUP_FIELDS) do
    if out[field] then out[field] = style.fade(out[field], t) end
  end
  return out
end

--- Sets an extmark that rises from the background; returns its id. One that is deleted meanwhile stays deleted.
local function place(buf, ns, row, col, opts)
  if not (M.motion and style.can_move()) then return vim.api.nvim_buf_set_extmark(buf, ns, row, col, opts) end
  local id = vim.api.nvim_buf_set_extmark(buf, ns, row, col, painted(opts, ease(1 / FADE_FRAMES)))
  local frame, timer = 1, vim.uv.new_timer()
  timer:start(FRAME_MS, FRAME_MS, vim.schedule_wrap(function()
    if timer:is_closing() then return end
    frame = frame + 1
    local at = vim.api.nvim_buf_is_valid(buf) and vim.api.nvim_buf_get_extmark_by_id(buf, ns, id, {}) or {}
    if at[1] then
      pcall(vim.api.nvim_buf_set_extmark, buf, ns, at[1], at[2], vim.tbl_extend('force', painted(opts, ease(frame / FADE_FRAMES)), {id = id}))
      show(buf)
    end
    if not at[1] or frame >= FADE_FRAMES then timer:close() end
  end))
  return id
end

--- Deletes extmarks `ids` of `buf` in namespace `ns`.
function M.erase(buf, ids, ns)
  if not vim.api.nvim_buf_is_valid(buf) then return end
  for _, id in ipairs(ids) do pcall(vim.api.nvim_buf_del_extmark, buf, ns or M.ns, id) end
end

--- The row extmark `id` is on now, or nil when it is gone.
function M.row(buf, id, ns)
  if not vim.api.nvim_buf_is_valid(buf) then return nil end
  return vim.api.nvim_buf_get_extmark_by_id(buf, ns or M.ns, id, {})[1]
end

--- The pair's words under row `row` of `buf`, indented with the code, the mark in the sign column or `opts.sign`
--- ({glyph, group}), and `opts.glyph` before them instead of the voice glyph. In namespace `opts.ns`, by default
--- the pair's. Returns the extmark id.
function M.remark(buf, row, text, key, opts)
  opts = opts or {}
  local lines = voice(text, indent_of(buf, row), text_width(window_of(buf)), key, opts.glyph)
  local sign = opts.sign or {style.glyphs.mark, 'PairSign'}
  local spec = {virt_lines = lines, sign_text = sign[1], sign_hl_group = sign[2], priority = 20}
  if opts.still then return vim.api.nvim_buf_set_extmark(buf, opts.ns or M.ns, row, 0, spec) end
  return place(buf, opts.ns or M.ns, row, 0, spec)
end

--- The mark in the sign column of rows `first`..`last`, under any other mark of the pair. Returns the extmark id.
function M.span(buf, first, last)
  return vim.api.nvim_buf_set_extmark(buf, M.ns, first, 0, {end_row = last, sign_text = style.glyphs.mark, sign_hl_group = 'PairSign', priority = 15})
end

--- The dot of a held thought in the sign column of row `row`, under the pair's other marks. Returns the extmark id.
function M.held(buf, row)
  return place(buf, M.ns, row, 0, {sign_text = style.glyphs.held, sign_hl_group = 'PairSign', priority = 18})
end

--- A note about row `row`: after the line when it fits in the window, else under it. Returns the extmark id.
function M.note(buf, row, note, opts)
  local after = {{'   ' .. style.glyphs.voice .. ' ', 'PairAccent'}}
  vim.list_extend(after, wrap(note, math.huge, 'PairNote')[1] or {})
  local spec
  if vim.fn.strdisplaywidth(line_of(buf, row)) + width_of(after) <= text_width(window_of(buf)) then
    spec = {virt_text = after, virt_text_pos = 'eol', priority = 20}
  else
    spec = {virt_lines = voice(note, indent_of(buf, row), text_width(window_of(buf))), priority = 20}
  end
  if opts and opts.still then return vim.api.nvim_buf_set_extmark(buf, M.ns, row, 0, spec) end
  return place(buf, M.ns, row, 0, spec)
end

--- Marks rows `first`..`last`: the sign, a tinted line, `code` underlined where the first row has it, and the
--- note. Returns {mark, note, span} extmark ids; `mark` follows the lines as the buffer changes.
function M.point(buf, first, last, note, code)
  local ids = {}
  ids.mark = place(buf, M.ns, first, 0, {
    end_row = last, sign_text = style.glyphs.mark, sign_hl_group = 'PairSign', line_hl_group = 'PairPoint', priority = 20,
  })
  ids.note = M.note(buf, last, note)
  local start = code and code ~= '' and line_of(buf, first):find(code, 1, true)
  if start then ids.span = place(buf, M.ns, first, start - 1, {end_col = start - 1 + #code, hl_group = 'PairSpan', priority = 200}) end
  return ids
end

--- Where `code` starts on row `row`, else its first non-blank: where a jump to a point lands.
function M.column(buf, row, code)
  local text = line_of(buf, row)
  local start = code and code ~= '' and text:find(code, 1, true)
  return start and start - 1 or #text:match('^%s*')
end

--- A suggested change of rows `first`.. (the `old` lines) into `new`: each old line struck through from its first
--- character, the new lines under them, then the note. Returns the extmark ids; the first follows the change.
function M.suggestion(buf, first, old, new, note, key)
  local ids = {place(buf, M.suggest_ns, first, 0, {sign_text = style.glyphs.mark, sign_hl_group = 'PairSign', priority = 20})}
  for i, text in ipairs(old) do
    local start = #text:match('^%s*')
    if start < #text then
      table.insert(ids, place(buf, M.suggest_ns, first + i - 1, start, {end_col = #text, hl_group = 'PairSuggestDelete', priority = 210}))
    end
  end
  local tab = string.rep(' ', vim.bo[buf].tabstop)
  local lines = {}
  for _, text in ipairs(new) do
    local indent, rest = text:gsub('\t', tab):match('^(%s*)(.*)$')
    table.insert(lines, rest == '' and {{indent}} or {{indent}, {rest, 'PairSuggestAdd'}})
  end
  local last = first + math.max(#old, 1) - 1
  vim.list_extend(lines, voice(note, indent_of(buf, last), text_width(window_of(buf)), key))
  table.insert(ids, place(buf, M.suggest_ns, last, 0, {virt_lines = lines}))
  return ids
end

-- Tests: what the run on save found, on the lines of the tests in `buf`.

--- What a test run found in `buf`: `signs` ({line, ok, changed}) put ✓ or ✗ in the sign column of each test,
--- `notes` ({line, text, changed}) say why a test failed there: after the line when it fits, else under it. What `changed` since the last run
--- rises from the background; with `stale` (the next run is on) everything shows half faded.
function M.tests(buf, signs, notes, opts)
  vim.api.nvim_buf_clear_namespace(buf, M.tests_ns, 0, -1)
  local count = vim.api.nvim_buf_line_count(buf)
  local stale = opts and opts.stale
  local function group(name) return stale and style.fade(name, 0.4) or name end
  local function set(mark, spec)
    if mark.line > count then return end
    local how = mark.changed and not stale and place or vim.api.nvim_buf_set_extmark
    how(buf, M.tests_ns, mark.line - 1, 0, spec)
  end
  for _, sign in ipairs(signs) do
    set(sign, {
      sign_text = sign.ok and style.glyphs.pass or style.glyphs.fail,
      sign_hl_group = group(sign.ok and 'PairPass' or 'PairFail'),
      priority = 15, -- under the pair's own mark
    })
  end
  local width = text_width(window_of(buf))
  for _, note in ipairs(notes) do
    local after = {{'   ' .. style.glyphs.fail .. ' ', group('PairFail')}, {note.text, group('PairFailNote')}}
    if note.line > count or vim.fn.strdisplaywidth(line_of(buf, note.line - 1)) + width_of(after) <= width then
      set(note, {virt_text = after, virt_text_pos = 'eol', priority = 15})
    else
      local indent = indent_of(buf, note.line - 1)
      local lines = wrap(note.text, math.max(20, width - indent - 2), group('PairFailNote'))
      for i, line in ipairs(lines) do
        table.insert(line, 1, i == 1 and {style.glyphs.fail .. ' ', group('PairFail')} or {'  '})
        table.insert(line, 1, {string.rep(' ', indent)})
      end
      set(note, {virt_lines = lines, priority = 15})
    end
  end
end

-- The gaze: the line numbers the pair reads light up one after another, a short trail fading behind.

local gazes = {} -- buf -> its running timer

--- Sweeps lines `from`..`to` (1-based) of `buf` where a window shows them; false when none does.
function M.gaze(buf, from, to)
  if gazes[buf] and not gazes[buf]:is_closing() then gazes[buf]:close() end
  vim.api.nvim_buf_clear_namespace(buf, gaze_ns, 0, -1)
  local top, bottom
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if vim.api.nvim_win_get_buf(win) == buf and (vim.wo[win].number or vim.wo[win].relativenumber) then
      top = math.min(top or math.huge, vim.fn.line('w0', win))
      bottom = math.max(bottom or 0, vim.fn.line('w$', win))
    end
  end
  local first, last = math.max(from, top or math.huge), math.min(to, bottom or 0)
  if first > last then return false end
  local trail = {'PairGaze', style.fade('PairGaze', 0.55), style.fade('PairGaze', 0.25)}
  if not (M.motion and style.can_move()) then trail = {'PairGaze'} end
  -- the whole sweep takes about 0.8 s, however many lines show
  local step = math.max(16, math.min(70, math.floor(800 / (last - first + 1))))
  local line, timer = first, vim.uv.new_timer()
  gazes[buf] = timer
  timer:start(0, step, vim.schedule_wrap(function()
    if timer:is_closing() or not vim.api.nvim_buf_is_valid(buf) then return end
    vim.api.nvim_buf_clear_namespace(buf, gaze_ns, 0, -1)
    if line > last + #trail - 1 then
      timer:close()
      return show(buf)
    end
    for k, group in ipairs(trail) do
      local row = line - k + 1
      if row >= first and row <= last then
        pcall(vim.api.nvim_buf_set_extmark, buf, gaze_ns, row - 1, 0, {number_hl_group = group, priority = 300})
      end
    end
    show(buf)
    line = line + 1
  end))
  return true
end

return M
