// The thread on live models: the PB-6 goal comes back as two to four steps, and the done check marks a step done only
// when the session's facts show it (the cart tests green), not on a commit that says nothing of the bogo code.
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {factLines, Wins} from '../../src/debrief.mjs';
import {oneAnswer} from '../../src/note-reading.mjs';
import {DONE_PROMPT, parseDone, parseSteps, PLAN_PROMPT, Thread} from '../../src/thread.mjs';
import {liveStacks, SKIP_REASON} from './stacks.mjs';

const GOAL = 'make the cart tests pass, then add buy N get one free';
const stacks = liveStacks();

describe('The thread on live models', {skip: stacks.length ? false : SKIP_REASON}, () => {
  for (const stack of stacks) {
    const model = {models: stack.models, model: stack.partner};

    test(`${stack.name}: the goal as steps, and done only on the facts`, {timeout: 180_000}, async t => {
      const answer = await oneAnswer(model, PLAN_PROMPT, `Goal: ${GOAL}`);
      t.diagnostic(`steps: ${answer}`);
      const steps = parseSteps(answer);
      assert.ok(steps.length >= 2 && steps.length <= 4, answer);
      assert.match(steps[0], /test|pass|cart/i, 'the red tests first');

      const thread = new Thread();
      thread.set(steps);
      const wins = new Wins();
      wins.tests(['cart total', 'cart discount']);
      wins.tests([]);
      wins.command('npm test', true);
      wins.command('npm test', false);
      thread.land('`npm test` passes again', 0);
      const green = factLines({goal: GOAL, plan: thread.summary(), wins, changes: ' M cart.js'});
      const done = await oneAnswer(model, DONE_PROMPT, thread.doneInput(green));
      t.diagnostic(`green: ${done}`);
      const numbers = parseDone(done, steps.length);
      assert.ok(numbers.includes(1), done);
      assert.ok(!numbers.includes(steps.length), `the last step (${steps.at(-1)}) is not done: ${done}`);
      const line = thread.done(numbers);
      t.diagnostic(line);
      assert.match(line, /^done: .+; next: .+/);

      thread.land('a commit', 0);
      const commit = factLines({goal: GOAL, plan: thread.summary(), wins: new Wins(), commits: ['a1b2c3 tidy the README'], changes: ''});
      const after = await oneAnswer(model, DONE_PROMPT, thread.doneInput(commit));
      t.diagnostic(`commit: ${after}`);
      assert.ok(!parseDone(after, steps.length).includes(steps.length), `a README commit does not finish the bogo code: ${after}`);
    });
  }
});
