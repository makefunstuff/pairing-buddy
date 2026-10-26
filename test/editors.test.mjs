// Which Neovim Pair shows things in, when a project has several.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {byUse, herdrFocus, noteEditor} from '../src/editors.mjs';

const editor = (name, pane = null) => ({name, pane, activeAt: 0, focused: null});
const names = editors => byUse(editors).map(each => each.name);

test('the Neovim with focus comes first, then the one used last; what a Neovim does by itself does not count', () => {
  const [a, b] = [editor('a'), editor('b')];
  noteEditor(a, {type: 'event', event: {kind: 'cursor'}}, 1);
  noteEditor(b, {type: 'event', event: {kind: 'edit'}}, 2);
  assert.deepEqual(names([a, b]), ['b', 'a'], 'neither reports focus: the one used last');
  noteEditor(a, {type: 'event', event: {kind: 'diagnostics'}}, 3);
  noteEditor(a, {type: 'accent', color: '#123456'}, 4);
  assert.deepEqual(names([a, b]), ['b', 'a'], 'diagnostics and colours are not the user at work');
  noteEditor(b, {type: 'focus', on: false}, 5);
  noteEditor(a, {type: 'focus', on: true}, 6);
  noteEditor(b, {type: 'event', event: {kind: 'change'}}, 7); // a file reloaded in the Neovim you left
  assert.deepEqual(names([a, b]), ['a', 'b'], 'the one with focus wins');
  noteEditor(a, {type: 'focus', on: false}, 8);
  assert.deepEqual(names([a, b]), ['a', 'b'], 'without focus anywhere, the one you were in last');
});

test('herdr\'s focused pane gives its Neovim the focus and takes it from the others in herdr', () => {
  const [a, b, outside] = [editor('a', 'w1:p1'), editor('b', 'w1:p3'), editor('outside')];
  noteEditor(a, {type: 'focus', on: true}, 1);
  noteEditor(outside, {type: 'focus', on: true}, 2);
  herdrFocus([a, b, outside], 'w1:p3', 3);
  assert.deepEqual([a.focused, b.focused, outside.focused], [false, true, true], 'a Neovim outside herdr keeps its own focus reports');
  herdrFocus([a, b, outside], 'w1:p9', 4); // no Neovim's pane: nothing changes
  assert.deepEqual([a.focused, b.focused, b.activeAt], [false, true, 3]);
});
