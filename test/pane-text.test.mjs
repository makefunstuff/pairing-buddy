import assert from 'node:assert/strict';
import {test} from 'node:test';
import {commandLine, commandOutput, linesOf, promptChange} from '../src/pane-text.mjs';

test('commandOutput keeps the lines after the command, without the next prompt', () => {
  const text = '$ ls\nREADME.md\n$ node test.js\nAssertionError: expected 30000\n    at test.js:4\n$ \n\n';
  assert.equal(commandOutput(text, {cmd: 'node test.js'}).output, 'AssertionError: expected 30000\n    at test.js:4');
});

test('the line the command was typed on wins over output that names the command', () => {
  // npm prints the script it runs; an alias (`t`) is not what herdr names (the argv).
  const text = 'README.md\n~/p $ t\n> p@1.0.0 test\n> node --test\nnot ok 1 - adds\n~/p $ ';
  const before = 'README.md\n~/p $ t';
  assert.deepEqual(commandOutput(text, {before, cmd: 'node /usr/bin/npm test'}), {cmd: 'node /usr/bin/npm test', output: '> p@1.0.0 test\n> node --test\nnot ok 1 - adds'});
  // With the empty prompt known, the command is named as typed.
  assert.equal(commandOutput(text, {before, cmd: 'node /usr/bin/npm test', prompt: '~/p $'}).cmd, 't');
  // Without what was typed, the line that ends with the command beats an output line that only contains it.
  const echoed = '$ make test\nmake test: running\nFAIL\n$ ';
  assert.equal(commandLine(linesOf(echoed), {cmd: 'make test'}), 0);
});

test('what was typed by the last look is enough: the command line starts with it', () => {
  const text = 'old\n$ npm test\nok 1\n$ ';
  assert.equal(commandOutput(text, {before: 'old\n$ npm te', cmd: 'npm test'}).output, 'ok 1');
});

test('a command whose line is gone says so instead of passing the pane\'s text off as its output', () => {
  assert.match(commandOutput('line 1\nline 2\n$ ', {cmd: 'clear && make'}).output, /^\(the command's line was not found/);
});

test('promptChange: keys at the prompt are typing', () => {
  assert.deepEqual(promptChange('a\n$ ', 'a\n$ git st', '$'), {typed: true});
  assert.deepEqual(promptChange('$ git st', '$ git status', '$'), {typed: true});
  assert.equal(promptChange('a\n$ git', 'a\n$ git', '$'), null);
});

test('promptChange: a command too short to be seen running is still caught, with its output', () => {
  // Typed and entered between two looks: the last line is the same empty prompt as before.
  assert.deepEqual(promptChange('out\n$', 'out\n$ ls\na.js\nb.js\n$', '$'), {ran: {cmd: 'ls', output: 'a.js\nb.js'}});
  // Half typed at the last look.
  assert.deepEqual(promptChange('out\n$ git sta', 'out\n$ git status -s\n M a.js\n$', '$'), {ran: {cmd: 'git status -s', output: ' M a.js'}});
});

test('promptChange: Enter without a command to name, Tab, and a line pushed out of the read', () => {
  assert.deepEqual(promptChange('out\n$', 'out\n$\n$', '$'), {entered: true}, 'an empty line');
  assert.deepEqual(promptChange('out\n$ sleep 9', 'out\n$ sleep 9^C\n$', '$'), {entered: true}, 'Ctrl-C');
  assert.deepEqual(promptChange('out\n$ ls', 'out\n$ ls\na.js\n$', null), {entered: true}, 'no prompt known yet');
  // Tab completion lists candidates and shows the same line again: a key, no command.
  assert.deepEqual(promptChange('out\n$ git ch', 'out\n$ git ch\ncheckout  cherry\n$ git ch', '$'), {typed: true});
  assert.deepEqual(promptChange('x\ny\n$ make', '1\n2\n$', '$'), {lost: true});
});
