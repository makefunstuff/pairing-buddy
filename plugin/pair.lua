vim.api.nvim_create_user_command('Pair', function(opts) require('pair').command(opts) end, {
  nargs = '*',
  range = true,
  complete = function() return require('pair').complete() end,
  desc = 'pairing-buddy: start [goal] | new [idea] | goal | ask | level | scout | navigate | drive | drive! | jump | trail | runs | gen | keep | own | own! | brief | review | agents | accept | dismiss | useful | noise | why | open | today | decide | tasks | clear | context | end | first | listen | chat | stop',
})
