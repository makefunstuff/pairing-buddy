-- One search in a stand-in for a Telescope picker: its prompt buffer in a float, closed as Telescope closes it, and
-- then, as its default action would, the selected file opened.
_G.fake_pickers = _G.fake_pickers or {}

return function(title, query, results, file)
  local original = vim.api.nvim_get_current_win()
  local buf = vim.api.nvim_create_buf(false, true)
  local win = vim.api.nvim_open_win(buf, true, {relative = 'editor', row = 1, col = 1, width = 30, height = 1})
  vim.bo[buf].filetype = 'TelescopePrompt'
  _G.fake_pickers[buf] = {
    prompt_title = title, prompt_win = win, original_win_id = original,
    _get_prompt = function() return query end,
    manager = {num_results = function() return results end},
    get_selection = function() return file and {filename = file, cwd = vim.fn.getcwd()} or nil end,
  }
  vim.api.nvim_win_close(win, true)
  if file then vim.cmd.edit(file) end
end
