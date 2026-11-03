-- Search by meaning: Alt-s (or :Pair find [words]) opens semantic-grep.nvim's live picker (see its README), with Pair's
-- daemon as its source: the words on every key, meaning's pieces below them once typing stops, and with a "rerank"
-- decision model the first pieces reranked in place. Pair registers its daemon with
-- require('semantic-grep').register_source() while it is connected, so the daemon's index (one per repository, kept
-- up to date as you save) is the only one a project gets while Pair runs, and what you search and open goes in the
-- ledger; :SemanticGrep and :checkhealth semantic-grep ask it too. Once Pair disconnects, semantic-grep goes back to
-- its own server. :Pair find on installs LiteRT-LM and downloads EmbeddingGemma 2 once (or the config has an
-- "embedding" model); :Pair find off deletes them; :Pair index rebuild makes the index again. See docs/meaning.md.
local M = {}

local deps = {}
local options = {} -- the picker options Pair's setup() was given, for semantic-grep
local next_id = 0
local waiting = {} -- request id -> callback(err, result)
local registered = false

local MISSING = 'Pair: search by meaning needs semantic-grep.nvim (makefunstuff/semantic-grep.nvim): install it next to Pair (docs/install.md)'

local function sg()
  local ok, module = pcall(require, 'semantic-grep')
  return ok and module or nil
end

--- `opts`: picker, debounce_ms, rerank_delay_ms (Pair's meaning_* options); `d`: {send, connected}.
function M.setup(opts, d)
  options = opts or {}
  deps = d
end

--- Asks the daemon; `callback(err, result)` gets its answer, or why there is none.
local function ask(message, callback)
  if not deps.connected() then return callback('Pair is not connected: :Pair start connects') end
  next_id = next_id + 1
  waiting[next_id] = callback
  message.id = next_id
  deps.send(message)
end

-- Pair's daemon as semantic-grep's source (see semantic-grep's lua/semantic-grep/init.lua). The daemon searches the
-- project of this Neovim's session, whatever `root` the picker names.
local source = {name = "Pair's daemon: its index, models and ledger (:Pair find on|off, :Pair index rebuild)"}

function source.request(method, params, callback)
  params = params or {}
  if method == 'words' or method == 'meaning' or method == 'rerank' then
    return ask({type = 'find', query = params.query or '', phase = method}, callback)
  elseif method == 'search' then -- vim.ui.select's one list: booked once a piece is chosen
    return ask({type = 'find', query = params.query or '', select = true}, callback)
  elseif method == 'chosen' then
    if deps.connected() and params.query and params.query ~= '' then deps.send({type = 'find_chosen', query = params.query, results = params.results}) end
    return callback(nil, {})
  elseif method == 'saved' then -- the daemon hears of each save from Pair's own events
    return callback(nil, {})
  end
  ask({type = 'search_rpc', method = method}, callback) -- status, check, open, rebuild
end

function source.notify(method)
  if method == 'cancel' and deps.connected() then deps.send({type = 'find', query = '', phase = 'cancel'}) end
end

function source.running() return deps.connected() end

function source.health()
  return {'Pair indexes the project of its session; `pair doctor` checks its models too'}
end

--- `value` with JSON's nulls (vim.NIL, as Pair decodes the daemon's messages) left out, as semantic-grep expects.
local function denull(value)
  if value == vim.NIL then return nil end
  if type(value) ~= 'table' then return value end
  local out = {}
  for k, v in pairs(value) do out[k] = denull(v) end
  return out
end

--- The daemon's answer to one search (`found`) or another request (`search_rpc`).
function M.on_found(message)
  local callback = message.id and waiting[message.id]
  if not callback then return end
  waiting[message.id] = nil
  if message.error and message.error ~= vim.NIL then return callback(message.error) end
  callback(nil, denull(message.result or message))
end

M.on_rpc = M.on_found

--- Pair's daemon as semantic-grep's source, with the picker options Pair was given. False without semantic-grep.nvim.
function M.register()
  local module = sg()
  if not module then return false end
  -- semantic-grep's setup() drops the source it had: calling source() first makes sure it ran, with its defaults if
  -- nobody called it, before Pair registers. Its own server is only made here, not started.
  module.source()
  module.register_source(source)
  registered = true
  for from, to in pairs({picker = 'picker', debounce_ms = 'debounce_ms', rerank_delay_ms = 'rerank_delay_ms'}) do
    if options[from] ~= nil then module.config[to] = options[from] end
  end
  return true
end

--- Pair disconnected: what waits for an answer hears it will not come, and semantic-grep goes back to its own server.
function M.disconnected()
  local callbacks = waiting
  waiting = {}
  for _, callback in pairs(callbacks) do callback("Pair's daemon went away") end
  local module = registered and sg()
  if module then module.register_source(nil) end
  registered = false
end

--- The words selected in Visual mode, on one line, as a search.
function M.selected()
  local ok, lines = pcall(vim.fn.getregion, vim.fn.getpos('v'), vim.fn.getpos('.'), {type = vim.fn.mode()})
  return ok and vim.trim(table.concat(lines, ' ')) or ''
end

--- Opens semantic-grep's live picker over Pair's daemon, with `query` typed in it already.
function M.find(query)
  if not M.register() then return vim.notify(MISSING, vim.log.levels.WARN) end
  sg().find(vim.trim(query or ''))
end

function M.on() deps.send({type = 'meaning_on'}) end

function M.off() deps.send({type = 'meaning_off'}) end

function M.rebuild() deps.send({type = 'index_rebuild'}) end

--- How far a project's index is: semantic-grep's progress message (Neovim 0.12's, for a statusline or fidget).
function M.on_progress(message)
  local module = sg()
  if module then module.on_progress(message) end
end

--- What the daemon says as search by meaning turns on or off, or the index is rebuilt.
function M.on_state(message)
  if message.text then vim.notify('Pair: ' .. message.text) end
end

return M
