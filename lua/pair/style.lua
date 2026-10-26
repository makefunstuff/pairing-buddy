-- The pair's visual language: a handful of glyphs and one accent, taken from your colorscheme.
-- The accent is the colorscheme's own colour whose hue is furthest from its syntax colours, so the pair is
-- never mistaken for code, and never near its error colour, so it is never mistaken for an error. A scheme
-- whose code is greys, perhaps with one signal colour, gets a quiet teal: the one other colour on screen. Every
-- highlight group is a default: a colorscheme that defines one keeps its own.
local M = {}

M.glyphs = {
  voice = '●', -- the pair speaks: one or two lines under the line they are about
  mark = '▎', -- in the sign column, where it points
  held = '•', -- in the sign column, where a thought waits for your next break
  away = '◌', -- not connected, or a model is down
  wheel = '◎', -- it has the wheel
  pass = '✓', -- a test passed, on its line and in the statusline
  fail = '✗', -- a test failed, a build failed, a run crashed
  warn = '△', -- a compiler warning
  listen = '◉', -- it listens while you hold the listen key
}

-- The statusline while Pair runs your tests or thinks.
M.spinner = {'⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'}

-- Colours are 0xRRGGBB numbers, as nvim_get_hl gives them.
local function channels(color)
  return math.floor(color / 65536) % 256, math.floor(color / 256) % 256, color % 256
end

local function from_channels(r, g, b)
  local function clamp(v) return math.max(0, math.min(255, math.floor(v + 0.5))) end
  return clamp(r) * 65536 + clamp(g) * 256 + clamp(b)
end

--- `a` moved toward `b` by `t` (0: a, 1: b).
function M.mix(a, b, t)
  local ar, ag, ab = channels(a)
  local br, bg, bb = channels(b)
  return from_channels(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t)
end

local function luminance(color)
  local function linear(c)
    c = c / 255
    return c <= 0.03928 and c / 12.92 or ((c + 0.055) / 1.055) ^ 2.4
  end
  local r, g, b = channels(color)
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
end

--- The WCAG contrast ratio of two colours, 1 to 21.
function M.contrast(a, b)
  local la, lb = luminance(a), luminance(b)
  return (math.max(la, lb) + 0.05) / (math.min(la, lb) + 0.05)
end

--- Hue in degrees and saturation 0..1.
local function hue_saturation(color)
  local r, g, b = channels(color)
  r, g, b = r / 255, g / 255, b / 255
  local max, min = math.max(r, g, b), math.min(r, g, b)
  local delta = max - min
  if delta == 0 then return 0, 0 end
  local light = (max + min) / 2
  local saturation = delta / (1 - math.abs(2 * light - 1))
  local hue
  if max == r then hue = ((g - b) / delta) % 6
  elseif max == g then hue = (b - r) / delta + 2
  else hue = (r - g) / delta + 4 end
  return hue * 60, saturation
end

--- `color` moved toward `toward` until it reads with at least `ratio` on `bg`.
local function readable(color, bg, toward, ratio)
  for t = 0, 1, 0.05 do
    local candidate = M.mix(color, toward, t)
    if M.contrast(candidate, bg) >= ratio then return candidate end
  end
  return toward
end

local function hl(name)
  return vim.api.nvim_get_hl(0, {name = name, link = false})
end

-- Groups whose colours are the code itself, and where the pair's accent may come from, in order of preference:
-- the regexp colour (a hue most code never shows), the terminal's cyan, then the colorscheme's own colours for
-- "a remark about your code".
local SYNTAX = {'String', 'Keyword', 'Statement', 'Function', 'Type', 'Constant', 'Number', 'Identifier', 'PreProc',
  'Operator', '@variable', '@keyword', '@function', '@string', '@type', '@constant', '@property'}
local CANDIDATES = {'@string.regexp', 'terminal_color_6', 'DiagnosticHint', 'SpecialChar', 'terminal_color_14',
  'DiagnosticInfo', 'Special', 'Title', 'Directory', 'DiagnosticOk', 'Question', 'MoreMsg'}

-- Neovim's own colours, which a group keeps when the colorscheme leaves it alone: not the colorscheme's choice.
local NVIM = {[0x004c73] = true, [0x007373] = true, [0x005523] = true, [0x470045] = true, [0x590008] = true,
  [0x6b5300] = true, [0xa6dbff] = true, [0x8cf8f7] = true, [0xb3f6c0] = true, [0xffcaff] = true, [0xffc0b9] = true,
  [0xfce094] = true}

--- The colour a candidate names: a highlight group's foreground, or a terminal colour of the colorscheme.
local function candidate(name)
  if name:find('^terminal_color_') then
    local hex = vim.g[name]
    return type(hex) == 'string' and tonumber(hex:match('^#(%x%x%x%x%x%x)$') or '', 16) or nil
  end
  local color = hl(name).fg
  local default = vim.g.colors_name == nil or vim.g.colors_name == 'default'
  if color and NVIM[color] and not default then return nil end
  return color
end

--- The editor's background and foreground; a transparent background is taken as Neovim's own default one.
function M.ground()
  local normal = hl('Normal')
  local dark = vim.o.background == 'dark'
  return normal.bg or (dark and 0x14161b or 0xe0e2ea), normal.fg or (dark and 0xe0e2ea or 0x14161b)
end

--- The statusline's background and foreground.
local function status_ground()
  local bg, fg = M.ground()
  local status = hl('StatusLine')
  if status.reverse then return status.fg or fg, status.bg or bg end
  return status.bg or bg, status.fg or fg
end

local function hue_distance(a, b)
  local d = math.abs(a - b) % 360
  return d > 180 and 360 - d or d
end

local NEAR = 30 -- degrees of hue within which two colours read as one: the accent keeps this far from errors
local TEAL = {dark = 0x7fd1b9, light = 0x1e7a65}

--- Whether all of `hues` read as one colour (or there are none): code in greys, perhaps with one signal colour.
local function one_colour(hues)
  for _, hue in ipairs(hues) do
    if hue_distance(hue, hues[1]) >= NEAR then return false end
  end
  return true
end

--- The pair's accent, readable on the background: the teal for code in one colour at most, else the candidate
--- colour furthest in hue from every syntax colour and not near the error colour.
function M.accent()
  local bg, fg = M.ground()
  local syntax = {}
  for _, name in ipairs(SYNTAX) do
    local hue, saturation = hue_saturation(hl(name).fg or 0)
    if saturation > 0.2 then table.insert(syntax, hue) end
  end
  local teal = TEAL[vim.o.background] or TEAL.dark
  if one_colour(syntax) and (#syntax == 0 or hue_distance(hue_saturation(teal), syntax[1]) >= NEAR) then
    return readable(teal, bg, fg, 3)
  end
  local error_hue, error_saturation = hue_saturation(hl('DiagnosticError').fg or hl('ErrorMsg').fg or 0)
  local best, best_score
  for i, name in ipairs(CANDIDATES) do
    local color = candidate(name)
    local hue, saturation = hue_saturation(color or 0)
    if saturation >= 0.25 and (error_saturation < 0.2 or hue_distance(hue, error_hue) >= NEAR) then
      local distance = 180
      for _, other in ipairs(syntax) do distance = math.min(distance, hue_distance(hue, other)) end
      local score = distance - (i - 1) * 3 -- near-ties go to the earlier, more fitting candidate
      if not best_score or score > best_score then best, best_score = color, score end
    end
  end
  return readable(best or teal, bg, fg, 3) -- no colour of its own that is not the error's: the teal too
end

--- A colour as #rrggbb.
function M.hex(color)
  return ('#%06x'):format(color)
end

-- What each group looks like, from the background, the foreground and the accent.
local function palette()
  local bg, fg = M.ground()
  local accent = M.accent()
  local status_bg, status_fg = status_ground()
  local dim = readable(M.mix(bg, fg, 0.42), bg, fg, 2.2)
  local ok = readable(hl('DiagnosticOk').fg or accent, bg, fg, 3)
  local fail = readable(hl('DiagnosticError').fg or hl('ErrorMsg').fg or 0xe06c75, bg, fg, 3)
  local warn = readable(hl('DiagnosticWarn').fg or hl('WarningMsg').fg or 0xe5c07b, bg, fg, 3)
  return {
    PairAccent = {fg = accent},
    PairNote = {fg = readable(M.mix(fg, accent, 0.45), bg, fg, 4.5)}, -- the pair's words
    PairCode = {fg = accent}, -- `code` in its words
    PairKey = {fg = dim}, -- the key that acts on what it says
    PairSign = {fg = accent},
    PairPoint = {bg = M.mix(bg, accent, 0.07)}, -- a line it points at
    PairSpan = {bg = M.mix(bg, accent, 0.16), sp = accent, underline = true}, -- the code it means there
    PairGaze = {fg = accent, bold = true}, -- line numbers where it reads
    PairGazeLine = {bg = M.mix(bg, accent, 0.14)}, -- lines where it reads, in a window without numbers
    PairSuggestDelete = {fg = dim, strikethrough = true},
    PairSuggestAdd = {fg = fg, bg = M.mix(bg, accent, 0.1)}, -- also the text the Driver is typing
    PairCursor = {fg = bg, bg = accent}, -- the Driver's cursor
    PairStatus = {fg = accent},
    PairStatusDim = {fg = M.mix(status_bg, status_fg, 0.62)},
    PairStatusWarn = {fg = hl('DiagnosticWarn').fg or hl('WarningMsg').fg or accent},
    PairPass = {fg = readable(M.mix(bg, ok, 0.55), bg, ok, 2.2)}, -- quiet: a column of passing tests is no news
    PairFail = {fg = fail},
    PairStatusPass = {fg = ok}, -- a passing run, for a moment, in the statusline
    -- Delight: a green after a red lights up once, then settles (see M.between).
    PairGlow = {fg = readable(M.mix(ok, fg, 0.3), bg, fg, 4.5), bg = M.mix(bg, ok, 0.18), bold = true}, -- the sign that turned green
    PairGlowLine = {bg = M.mix(bg, ok, 0.18)}, -- and its line
    PairStatusGlow = {fg = readable(M.mix(ok, status_fg, 0.3), status_bg, status_fg, 4.5), bg = M.mix(status_bg, ok, 0.28), bold = true},
    PairFailNote = {fg = readable(M.mix(fg, fail, 0.35), bg, fg, 4.5)}, -- why a test failed, after the line it failed on
    PairHeard = {fg = readable(dim, bg, fg, 3), italic = true}, -- your words, as Pair heard them
    PairWarn = {fg = warn}, -- a compiler warning the builds before did not print
    PairWarnQuiet = {fg = readable(M.mix(bg, warn, 0.45), bg, warn, 1.6)}, -- one they did: no news
    PairWarnNote = {fg = readable(M.mix(fg, warn, 0.35), bg, fg, 4.5)}, -- a new warning's words, after its line
  }
end

-- Without 'termguicolors' there are no colours to derive from: plain links.
local LINKS = {
  PairAccent = 'DiagnosticHint', PairNote = 'DiagnosticHint', PairCode = 'Special', PairKey = 'Comment',
  PairSign = 'DiagnosticHint', PairPoint = 'CursorLine', PairSpan = 'Visual', PairGaze = 'DiagnosticHint',
  PairGazeLine = 'CursorLine', PairSuggestDelete = 'Comment', PairSuggestAdd = 'DiffAdd', PairCursor = 'Cursor',
  PairStatus = 'StatusLine', PairStatusDim = 'StatusLine', PairStatusWarn = 'StatusLine',
  PairPass = 'DiagnosticOk', PairStatusPass = 'DiagnosticOk', PairGlow = 'DiagnosticOk', PairGlowLine = 'CursorLine', PairStatusGlow = 'DiagnosticOk', PairFail = 'DiagnosticError', PairFailNote = 'DiagnosticError',
  PairHeard = 'Comment',
  PairWarn = 'DiagnosticWarn', PairWarnQuiet = 'Comment', PairWarnNote = 'DiagnosticWarn',
}

local ours = {} -- each group as this module last left it: a group that differs now was set by someone else
local faded = {} -- fade and settle steps made so far, by name

--- (Re)defines the groups for the current colorscheme, leaving alone any group the colorscheme defined itself.
function M.apply()
  faded = {}
  local specs = vim.o.termguicolors and palette() or vim.tbl_map(function(link) return {link = link} end, LINKS)
  for name, spec in pairs(specs) do
    local now = vim.api.nvim_get_hl(0, {name = name})
    if vim.tbl_isempty(now) or vim.deep_equal(now, ours[name]) then
      -- Ours, from the last colorscheme or mode: cleared, so the default below takes. (Setting it to {} would
      -- leave it defined, and the default ignored.)
      if not vim.tbl_isempty(now) then vim.cmd.highlight({'clear', name}) end
      vim.api.nvim_set_hl(0, name, vim.tbl_extend('force', spec, {default = true}))
      ours[name] = vim.api.nvim_get_hl(0, {name = name})
    end
  end
end

--- Whether the pair's colours can move: fades and the gaze need true colours.
function M.can_move()
  return vim.o.termguicolors
end

--- A group like `name` at `t` of its way in from the background (0: invisible, 1: itself).
function M.fade(name, t)
  if t >= 1 or not vim.o.termguicolors then return name end
  local step = ('PairFade%s%02d'):format(name, math.floor(t * 20 + 0.5))
  if faded[step] then return step end
  local bg = M.ground()
  local spec = hl(name)
  spec.fg = spec.fg and M.mix(bg, spec.fg, t)
  spec.bg = spec.bg and M.mix(bg, spec.bg, t)
  spec.sp = spec.sp and M.mix(bg, spec.sp, t)
  vim.api.nvim_set_hl(0, step, spec)
  faded[step] = true
  return step
end

--- A glow `from` settling into `to`, at `t` of the way (0: the glow, 1: `to` itself). A colour a group leaves
--- unset is the editor's, or the statusline's for `{statusline = true}`.
function M.between(from, to, t, opts)
  if t >= 1 or not vim.o.termguicolors then return to end
  local step = ('PairSettle%s%s%02d'):format(from, to, math.floor(t * 20 + 0.5))
  if faded[step] then return step end
  local bg, fg
  if opts and opts.statusline then bg, fg = status_ground() else bg, fg = M.ground() end
  local a, b = hl(from), hl(to)
  vim.api.nvim_set_hl(0, step, {
    fg = M.mix(a.fg or fg, b.fg or fg, t),
    bg = M.mix(a.bg or bg, b.bg or bg, t),
    bold = t < 0.5 and a.bold or b.bold,
  })
  faded[step] = true
  return step
end

return M
