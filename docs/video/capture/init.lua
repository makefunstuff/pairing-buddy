-- The Neovim of the captures: the plugin from this checkout, ayu, and the plugin on run.sh's scratch socket.
local here = vim.fn.fnamemodify(debug.getinfo(1, 'S').source:sub(2), ':p:h')
vim.opt.rtp:prepend(vim.fn.fnamemodify(here, ':h:h:h'))
vim.opt.rtp:append(here)
vim.o.termguicolors = true
vim.g.ayucolor = 'dark'
vim.cmd.colorscheme('ayu')
vim.o.number = true
vim.o.signcolumn = 'yes'
vim.o.tabstop = 4
vim.o.shiftwidth = 4
vim.o.cursorline = true
vim.o.laststatus = 2
vim.o.showmode = false
vim.o.swapfile = false
vim.o.scrolloff = 6 -- room under the cursor line for Pair's words
vim.o.shortmess = vim.o.shortmess .. 'IF'
vim.o.statusline = "  %t %m%=%{%v:lua.require'pair'.statusline()%}    %l:%c  "
require('pair').setup({socket = vim.env.PBCAP .. '/pair.sock', auto_connect = true})
