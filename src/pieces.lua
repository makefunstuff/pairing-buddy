-- Search by meaning's pieces: the functions, classes and methods of a file, each with the comments right above it
-- (its doc comment), found by Neovim's tree-sitter where it has a parser for the file's language. Pair's daemon runs
-- it as `nvim --headless -u NONE -i NONE -n -l pieces.lua` (see pieces.mjs): no plugins and no config, only the
-- parsers on Neovim's own runtimepath and those the user's Neovim told Pair of. Each line on stdin is
-- {"id": n, "path": "/abs/file"} or {"parsers": ["/…/parser/lua.so", …]}; each answer on stdout is
-- {"id": n, "lang": "lua", "pieces": [{"from": 1, "to": 9, "kind": "function_declaration", "name": "M.find", "whole": true}]}
-- (lines from 1), or {"id": n} when no parser reads the file. A piece longer than `MAX_LINES` with definitions
-- inside is cut into its head (the lines above its first one) and those definitions; one without is `whole: false`,
-- for the daemon to cut at its blank lines.
local MAX_LINES = 60
local MAX_BYTES = 512 * 1024

-- The node types that are a piece of their own, in the languages Neovim has parsers for.
local DEFINITIONS = {}
for name in ([[
  function_declaration function_definition function_item local_function method_definition method_declaration
  method singleton_method generator_function_declaration constructor_declaration function_signature
  class_declaration class_definition class class_specifier abstract_class_declaration struct_item struct_specifier
  struct_declaration union_specifier enum_item enum_declaration enum_specifier trait_item impl_item
  interface_declaration protocol_declaration object_declaration record_declaration type_declaration
  type_alias_declaration mod_item module namespace_definition decorated_definition macro_definition
  preproc_function_def section
]]):gmatch('%S+') do
  DEFINITIONS[name] = true
end
-- Declarations whose value is a function or a class: `const f = () => {}`, `M.f = function() end`.
local DECLARATIONS = {
  lexical_declaration = true, variable_declaration = true, assignment_statement = true, expression_statement = true,
  local_variable_declaration = true, field_declaration = true, public_field_definition = true, pair = true,
}
local VALUES = {arrow_function = true, function_expression = true, function_definition = true, class = true, generator_function = true}
-- The nodes that wrap a definition and belong to it: `export function f`, a template, a decorator.
local WRAPPERS = {export_statement = true, template_declaration = true, decorated_definition = true}

local function is_comment(node) return node:type():find('comment') ~= nil end

--- The function or class a declaration holds, searched a few levels down: `const f = async () => {}`.
local function holds(node, depth)
  for child in node:iter_children() do
    if child:named() then
      if VALUES[child:type()] then return child end
      if depth > 0 and not DEFINITIONS[child:type()] then
        local found = holds(child, depth - 1)
        if found then return found end
      end
    end
  end
end

local function is_definition(node)
  local kind = node:type()
  if DEFINITIONS[kind] then return true end
  if DECLARATIONS[kind] then
    local value = holds(node, 2)
    -- A callback passed to a call (`test('…', () => {})`) is no declaration; a long one is cut at its blank lines anyway.
    return value ~= nil and not (kind == 'expression_statement' and node:named_child(0) and node:named_child(0):type() == 'call_expression')
  end
  return false
end

local function text_of(node, source)
  local ok, text = pcall(vim.treesitter.get_node_text, node, source)
  return ok and text or nil
end

--- The definition's name: its `name` field, or its declarator's, one line at most.
local function name_of(node, source)
  for _, field in ipairs({'name', 'declarator', 'left', 'key'}) do
    local named = node:field(field)[1]
    if named then
      if named:named_child_count() > 0 and field == 'declarator' then
        local inner = named:field('name')[1] or named:field('declarator')[1]
        if inner then named = inner end
      end
      local text = text_of(named, source)
      if text and not text:find('\n') then return text end
    end
  end
  for child in node:iter_children() do
    if child:named() and (child:type():find('declarator') or child:type():find('heading')) then
      local name = name_of(child, source) or text_of(child, source)
      if name then return (name:gsub('\n.*', ''):gsub('^#+%s*', '')) end
    end
  end
end

local function unwrap(node)
  for child in node:iter_children() do
    if child:named() and is_definition(child) then return child end
  end
end

--- The first line of `node`, with the comments right above it: no blank line between them.
local function start_with_comments(node)
  local start = node:start()
  local above = node:prev_named_sibling()
  while above and is_comment(above) do
    local _, _, finish = above:range()
    if finish < start - 1 then break end
    start = above:start()
    above = above:prev_named_sibling()
  end
  return start
end

local collect

--- One definition as a piece, or, when longer than MAX_LINES, its head and the definitions inside it.
local function piece(node, outer, source, out)
  local first = start_with_comments(outer)
  local _, _, last, last_col = outer:range()
  if last_col == 0 and last > first then last = last - 1 end
  local name = name_of(node, source) or name_of(outer, source)
  local inside = {}
  if last - first + 1 > MAX_LINES then collect(node, source, inside, true) end
  if #inside == 0 then
    out[#out + 1] = {from = first + 1, to = last + 1, kind = node:type(), name = name, whole = last - first + 1 <= MAX_LINES}
    return
  end
  if inside[1].from > first + 1 then
    out[#out + 1] = {from = first + 1, to = inside[1].from - 1, kind = node:type(), name = name, whole = inside[1].from - 1 - first <= MAX_LINES}
  end
  for _, each in ipairs(inside) do out[#out + 1] = each end
end

--- The definitions under `node`, in order: those at its level, and those inside what is not one (a block, a body).
collect = function(node, source, out, nested)
  for child in node:iter_children() do
    if child:named() then
      if WRAPPERS[child:type()] and unwrap(child) then
        piece(unwrap(child), child, source, out)
      elseif is_definition(child) then
        piece(child, child, source, out)
      elseif not is_comment(child) and child:named_child_count() > 0 and (nested or child:type():find('body') or child:type():find('block') or child:type():find('program') or child:type():find('list')) then
        collect(child, source, out, nested)
      end
    end
  end
end

local parsers = {} -- language -> path of its parser, as the user's Neovim has it

local function language(path)
  local ft = vim.filetype.match({filename = path})
  if not ft then return nil end
  local lang = vim.treesitter.language.get_lang(ft) or ft
  if pcall(vim.treesitter.language.add, lang) then return lang end
  if parsers[lang] and pcall(vim.treesitter.language.add, lang, {path = parsers[lang]}) then return lang end
end

local function answer(request)
  local file = io.open(request.path, 'rb')
  if not file then return {id = request.id} end
  local source = file:read(MAX_BYTES + 1)
  file:close()
  if not source or #source > MAX_BYTES then return {id = request.id} end
  local lang = language(request.path)
  if not lang then return {id = request.id} end
  local ok, parser = pcall(vim.treesitter.get_string_parser, source, lang)
  if not ok then return {id = request.id} end
  local trees = parser:parse()
  if not trees or not trees[1] then return {id = request.id} end
  local out = {}
  collect(trees[1]:root(), source, out, false)
  return {id = request.id, lang = lang, pieces = out}
end

for line in io.lines() do
  local ok, request = pcall(vim.json.decode, line)
  if ok and type(request) == 'table' then
    if request.parsers then
      for _, path in ipairs(request.parsers) do
        local lang = path:match('([^/\\]+)%.%w+$')
        if lang and not parsers[lang] then parsers[lang] = path end
      end
    elseif request.id then
      local done, result = pcall(answer, request)
      io.stdout:write(vim.json.encode(done and result or {id = request.id}), '\n')
      io.stdout:flush()
    end
  end
end
