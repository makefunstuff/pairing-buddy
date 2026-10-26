-- The captures' Neovim: the plugin from this repo, ayu, and nothing of your own config (record.sh also gives
-- Neovim scratch XDG directories). The :terminal's shell has the shell hook and stands for the herdr pane w1:p3.
local cap, repo = vim.env.CAP, vim.env.CAP_REPO
assert(cap and cap:find('^/tmp/paircap%.'), 'run this through record.sh')
vim.opt.rtp:prepend(repo)
vim.opt.rtp:append(cap .. '/ayu')
vim.o.termguicolors = true
vim.o.background = 'dark'
vim.cmd.colorscheme('ayu')
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
-- Telescope, when record.sh fetched it for the scene, on the usual keys: space s g greps, space s f finds files.
if vim.uv.fs_stat(cap .. '/telescope.nvim') then
  vim.opt.rtp:append(cap .. '/plenary.nvim')
  vim.opt.rtp:append(cap .. '/telescope.nvim')
  vim.g.mapleader = ' '
  require('telescope').setup({})
  vim.keymap.set('n', '<leader>sg', require('telescope.builtin').live_grep)
  vim.keymap.set('n', '<leader>sf', require('telescope.builtin').find_files)
end
require('pair').setup({socket = cap .. '/pair.sock', debounce_ms = 400, auto_connect = true})
