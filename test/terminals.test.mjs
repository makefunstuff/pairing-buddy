import assert from 'node:assert/strict';
import {test} from 'node:test';
import {named, Terminals} from '../src/terminals.mjs';

/** Terminals with two Neovims (pids 7 and 8) and, with `herdr`, a PaneWatch that records what it types. */
function terminals({herdr = true} = {}) {
  const asked = [];
  const typed = [];
  const editors = [{pid: 7}, {pid: 8}];
  const watch = {terminals: () => ['w1:p1'], type: async (pane, text) => typed.push([pane, text])};
  const ask = async (editor, message) => {
    asked.push([editor.pid, message]);
    if (message.type === 'terminals') return {terminals: editor.pid === 7 ? [{pane: 'nvim:7:3', name: 'nvim:3'}] : []};
    return message.buf === 3 ? {ok: true} : {error: 'that is not one of your terminals here'};
  };
  return {asked, typed, terminals: new Terminals({editors: () => editors, ask, herdr: () => (herdr ? watch : null)})};
}

test('the user\'s terminals are herdr\'s panes and each Neovim\'s :terminal buffers', async () => {
  const {terminals: all} = terminals();
  assert.deepEqual(await all.list(), ['w1:p1', 'nvim:7:3']);
  assert.deepEqual(await terminals({herdr: false}).terminals.list(), ['nvim:7:3']);
});

test('a Neovim terminal is named by its buffer, and by its whole id where two Neovims share the buffer number', () => {
  assert.deepEqual(named(['w1:p1', 'nvim:7:3', 'nvim:7:4']).map(item => item.name), ['w1:p1', 'nvim:3', 'nvim:4']);
  assert.deepEqual(named(['nvim:7:3', 'nvim:8:3', 'nvim:8:2']).map(item => item.name), ['nvim:7:3', 'nvim:8:3', 'nvim:2']);
});

test('type goes to the Neovim the terminal is in, or to herdr; only one line of plain text', async () => {
  const {terminals: all, asked, typed} = terminals();
  await all.type('nvim:7:3', 'npm test');
  assert.deepEqual(asked.at(-1), [7, {type: 'type_text', buf: 3, text: 'npm test'}]);
  await all.type('w1:p1', 'make');
  assert.deepEqual(typed, [['w1:p1', 'make']]);
  await assert.rejects(all.type('nvim:7:3', 'npm test\r'), /one line of plain text/);
  await assert.rejects(all.type('nvim:9:3', 'npm test'), /The Neovim of terminal nvim:3 is gone/);
  await assert.rejects(all.type('nvim:7:4', 'npm test'), /not one of your terminals/);
  await assert.rejects(terminals({herdr: false}).terminals.type('w1:p1', 'make'), /in herdr, which Pair does not watch now/);
});
