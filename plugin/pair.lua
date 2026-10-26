vim.api.nvim_create_user_command('Pair', function(opts) require('pair').command(opts) end, {
  nargs = '*',
  range = true,
  complete = function() return require('pair').complete() end,
  desc = 'pairing-buddy: start [goal] | goal | ask | level | scout | navigate | drive | jump | trail | accept | dismiss | useful | noise | context | end | first | open | clear | listen | stop',
})
