-- The captures' Neovim: the plugin from this repo, ayu (or with CAP_SCHEME=greys, mini.base16 on a grey palette
-- with one warm red), clangd for C, and nothing of your own config (record.sh also gives Neovim scratch XDG
-- directories). The :terminal's shell has the shell hook and stands for the herdr pane w1:p3.
local cap, repo = vim.env.CAP, vim.env.CAP_REPO
assert(cap and cap:find('^/tmp/paircap%.'), 'run this through record.sh')
vim.opt.rtp:prepend(repo)
vim.opt.rtp:append(cap .. '/ayu')
vim.opt.rtp:append(cap .. '/mini')
vim.o.termguicolors = true
vim.o.background = 'dark'
if vim.env.CAP_SCHEME == 'greys' then
  -- The editor on the desktop's palette, as many desktop themes ship it: greys, and one warm red.
  require('mini.base16').setup({palette = {
    base00 = '#131517', base01 = '#1b1e20', base02 = '#2a2f32', base03 = '#5a6064',
    base04 = '#7d8488', base05 = '#c8cacb', base06 = '#d6d7d8', base07 = '#e4e4e4',
    base08 = '#9aa1a5', base09 = '#d9694a', base0A = '#b5b9bb', base0B = '#a3a9ad',
    base0C = '#8f969a', base0D = '#bfc3c5', base0E = '#868d91', base0F = '#d9694a',
  }})
else
  vim.cmd.colorscheme('ayu')
end
vim.api.nvim_create_autocmd('FileType', {pattern = 'c', callback = function()
  vim.lsp.start({name = 'clangd', cmd = {'clangd'}, root_dir = vim.fn.getcwd()})
  vim.schedule(function() vim.opt_local.formatoptions:remove({'r', 'o'}) end) -- after the ftplugin: no comment leaders typed for you
end})
vim.diagnostic.config({signs = false, virtual_text = false}) -- an error shows as its underline
vim.o.number = true
vim.o.signcolumn = 'yes'
vim.o.cursorline = true
vim.o.laststatus = 3
vim.o.showmode = false
vim.o.ruler = false
vim.o.showcmd = false
vim.o.shortmess = vim.o.shortmess .. 'IF'
vim.o.swapfile = false
vim.o.tabstop = 4
vim.o.shiftwidth = 4
vim.o.statusline = " %{&buftype ==# 'terminal' ? 'shell' : expand('%:.')} %m%=%{%v:lua.require'pair'.statusline()%}   %l:%c "
vim.env.HERDR_PANE_ID = 'w1:p3'
vim.o.shell = 'bash --noprofile --rcfile ' .. vim.env.CAP_HERE .. '/bashrc'
vim.api.nvim_create_autocmd('TermOpen', {callback = function()
  vim.opt_local.number = false
  vim.opt_local.signcolumn = 'no'
  vim.opt_local.cursorline = false
end})
vim.keymap.set('t', '<Esc>', [[<C-\><C-n>]])
-- Telescope, where the scene fetched it (record.sh): <Space>g greps, <Space>f finds files.
if vim.uv.fs_stat(cap .. '/plugins/telescope.nvim') then
  vim.opt.rtp:append(cap .. '/plugins/plenary.nvim')
  vim.opt.rtp:append(cap .. '/plugins/telescope.nvim')
  require('telescope').setup({defaults = {layout_strategy = 'horizontal', layout_config = {height = 0.7}}})
  local builtin = require('telescope.builtin')
  vim.keymap.set('n', '<Space>g', builtin.live_grep)
  vim.keymap.set('n', '<Space>f', builtin.find_files)
end
require('pair').setup({socket = cap .. '/pair.sock', debounce_ms = 400})
require('pair').connect() -- asked for by name: auto_connect leaves out projects in the temp folder, as this one is
