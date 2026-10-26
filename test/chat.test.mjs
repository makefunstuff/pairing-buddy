import assert from 'node:assert/strict';
import {test} from 'node:test';
import {allows, parseInput} from '../src/chat.mjs';

test('/scout and /navigate switch the role; other lines keep their meaning', () => {
  assert.deepEqual(parseInput('/scout'), {type: 'role', role: 'scout'});
  assert.deepEqual(parseInput('  /navigate '), {type: 'role', role: 'navigator'});
  assert.deepEqual(parseInput('/level chatty'), {type: 'level', level: 'chatty'});
  assert.deepEqual(parseInput('where else do we set that?'), {type: 'ask', text: 'where else do we set that?'});
  assert.deepEqual(parseInput('/drivel'), {local: 'help'});
});

test('/drive, "you take it" and "your turn" hand Pair the wheel; the words go along', () => {
  assert.deepEqual(parseInput('/drive'), {type: 'drive', text: ''});
  assert.deepEqual(parseInput('/drive set the timeout to 30 s'), {type: 'drive', text: 'set the timeout to 30 s'});
  assert.deepEqual(parseInput('You take it'), {type: 'drive', text: 'You take it'});
  assert.deepEqual(parseInput('you take it: set the timeout to 30 s'), {type: 'drive', text: 'you take it: set the timeout to 30 s'});
  assert.deepEqual(parseInput('your turn'), {type: 'drive', text: 'your turn'});
  assert.deepEqual(parseInput('can you take it from here?'), {type: 'ask', text: 'can you take it from here?'});
  assert.deepEqual(parseInput('your turnout logic is off'), {type: 'ask', text: 'your turnout logic is off'});
  assert.deepEqual(parseInput('Your turn.'), {type: 'drive', text: 'Your turn.'});
  assert.deepEqual(parseInput('you take it, rename the flag'), {type: 'drive', text: 'you take it, rename the flag'});
  assert.deepEqual(parseInput('your turn to explain: why does this fail?'), {type: 'ask', text: 'your turn to explain: why does this fail?'});
  assert.deepEqual(parseInput('you take it from here or should I?'), {type: 'ask', text: 'you take it from here or should I?'});
});

test('only y or yes allows a command', () => {
  for (const line of ['y', 'Y', 'yes', ' YES ']) assert.equal(allows(line), true, line);
  for (const line of ['', 'n', 'no', 'yes please', 'sure', 'yy']) assert.equal(allows(line), false, line);
});
