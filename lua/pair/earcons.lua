-- Earcons: four short sounds for what Pair does while you are away from Neovim, off unless you turn them on.
-- While Neovim has the focus there is no sound at all: the screen already says it. The sounds are in sounds/,
-- under a second and below -10 dB, and play with the first player found: pw-play, paplay, afplay or aplay.
local M = {}

M.enabled = false -- setup's `sounds`
M.volume = 0.5 -- setup's `sound_volume`, 0 to 1
M.focused = true -- Neovim has the terminal's focus; without focus events it keeps it

local SOUNDS = vim.fn.fnamemodify(debug.getinfo(1, 'S').source:sub(2), ':p:h:h:h') .. '/sounds/'

-- How each player is told the file and the volume.
local PLAYERS = {
  {'pw-play', function(file, volume) return {'pw-play', '--volume=' .. volume, file} end},
  {'paplay', function(file, volume) return {'paplay', '--volume=' .. math.floor(volume * 65536), file} end},
  {'afplay', function(file, volume) return {'afplay', '-v', tostring(volume), file} end},
  {'aplay', function(file) return {'aplay', '-q', file} end},
}

local player -- the command line for a file and a volume, once found; false when there is none

local function find_player()
  if player == nil then
    player = false
    for _, entry in ipairs(PLAYERS) do
      if vim.fn.executable(entry[1]) == 1 then
        player = entry[2]
        break
      end
    end
  end
  return player
end

--- The command that would play `sound` ('green', 'red', 'tick' or 'handback') now, or nil when it would not play.
function M.command(sound)
  if not M.enabled or M.focused or type(sound) ~= 'string' or not sound:match('^%l+$') then return nil end
  local file = SOUNDS .. sound .. '.wav'
  local play = find_player()
  if not play or vim.fn.filereadable(file) == 0 then return nil end
  return play(file, math.max(0, math.min(1, M.volume)))
end

--- Plays `sound` in the background, if you are away and sounds are on.
function M.play(sound)
  local command = M.command(sound)
  if command then pcall(vim.system, command, {stdout = false, stderr = false}) end
end

return M
