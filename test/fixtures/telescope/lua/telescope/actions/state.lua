-- A stand-in for Telescope's action state in the plugin test: the picker the test made for a prompt buffer.
return {get_current_picker = function(buf) return _G.fake_pickers[buf] end}
