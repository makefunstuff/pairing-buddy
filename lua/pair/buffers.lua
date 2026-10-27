-- The unsaved buffers of a project, for the commands Pair runs on them (see src/unsaved.mjs): every loaded file
-- buffer with changes inside the project's root, with its text as writing it would put it on disk.
local M = {}

-- The real path, as the daemon names files; a file not written yet is real by its folder.
local function real(path)
  local folder = vim.fs.dirname(path)
  return vim.uv.fs_realpath(path) or ((vim.uv.fs_realpath(folder) or folder) .. '/' .. vim.fs.basename(path))
end

function M.unsaved(root)
  local buffers = {}
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    local name = vim.api.nvim_buf_get_name(buf)
    if name ~= '' and vim.api.nvim_buf_is_loaded(buf) and vim.bo[buf].modified and vim.bo[buf].buftype == '' then
      local file = real(vim.fn.fnamemodify(name, ':p'))
      if vim.startswith(file, root .. '/') then
        local text = table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), '\n')
        if vim.bo[buf].eol or vim.bo[buf].fixeol then text = text .. '\n' end
        table.insert(buffers, {file = file, text = text})
      end
    end
  end
  return buffers
end

return M
