import assert from 'node:assert/strict';
import {test} from 'node:test';
import {allows, parseInput} from '../src/chat.mjs';

test('/scout and /navigate switch the role; other lines keep their meaning', () => {
  assert.deepEqual(parseInput('/scout'), {type: 'role', role: 'scout'});
  assert.deepEqual(parseInput('  /navigate '), {type: 'role', role: 'navigator'});
  assert.deepEqual(parseInput('/level chatty'), {type: 'level', level: 'chatty'});
  assert.deepEqual(parseInput('where else do we set that?'), {type: 'ask', text: 'where else do we set that?'});
  assert.deepEqual(parseInput('/drive'), {local: 'help'});
});

test('only y or yes allows a command', () => {
  for (const line of ['y', 'Y', 'yes', ' YES ']) assert.equal(allows(line), true, line);
  for (const line of ['', 'n', 'no', 'yes please', 'sure', 'yy']) assert.equal(allows(line), false, line);
});
