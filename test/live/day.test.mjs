// The day's end and the morning pick-up against real models, through a real PairSession: the debrief keeps to its
// form and names a first step with a place in the project, and the next morning's line is one line about that place.
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, test} from 'node:test';
import {MemoryStorage} from '@earendil-works/pi-durable';
import {openPartner} from '../../src/partner.mjs';
import {PairSession} from '../../src/session.mjs';
import {openStore} from '../../src/store.mjs';
import {ROLE_TOOLS} from '../../src/tools.mjs';
import {FILES, project} from './project.mjs';
import {liveStacks, SKIP_REASON} from './stacks.mjs';

const GOAL = 'reconnect drops after the phone sleeps';
const stacks = liveStacks();

describe('The day\'s end and the morning pick-up on live models', {skip: stacks.length ? false : SKIP_REASON}, () => {
  for (const stack of stacks) {
    /** A Navigator session of `root` on `store`; `now` is its clock. */
    async function pairSession({root, store, clock}) {
      const sent = [];
      let session;
      const partner = await openPartner({
        storage: new MemoryStorage(), models: stack.models, model: stack.partner, thinking: stack.config.models.partner.thinking,
        hands: {
          ...Object.fromEntries(ROLE_TOOLS.navigator.map(name => [name, async (_conversation, args) => session[name](args)])),
          roleOf: () => 'navigator',
        },
      });
      const record = store.createSession({root, conversationId: await partner.createConversation(), goal: GOAL, level: 'normal', at: clock.now});
      session = new PairSession({
        record, store, partner,
        previousNote: store.previousNote(root, record.id), lastSession: store.lastSession(root, record.id),
        score: async () => ({value: 0, reason: ''}), typingPauseMs: 2000,
        notify: (target, message) => { sent.push({target, ...message}); return 1; },
        requestEditor: async () => null,
        now: () => clock.now,
      });
      await session.configurePartner('navigator');
      return {session, partner, sent};
    }

    test(`${stack.name}: the debrief keeps its form and names a place; the morning line is one line about it`, {timeout: 300_000}, async t => {
      const {root} = project();
      writeFileSync(join(root, 'src/ws.mjs'), FILES['src/ws.mjs'].replace('5000', '30000')); // the user's fix, not committed
      const store = openStore(':memory:');
      const clock = {now: Date.now()};
      const day = await pairSession({root, store, clock});
      day.session.receive({kind: 'cursor', file: join(root, 'src/ws.mjs'), line: 1, col: 0});
      day.session.wins.tests(['reconnect waits up to 30 s']);
      day.session.wins.tests([]);
      await day.session.ask('I set RECONNECT_TIMEOUT_MS to 30000 in src/ws.mjs and the reconnect test passes. Next I want to try it on a real phone; let us stop here for today.');
      await day.session.end();
      await day.partner.close();
      const debrief = day.sent.findLast(message => message.type === 'message' && message.sender === 'pair')?.text;
      t.diagnostic(`debrief: ${debrief?.replaceAll('\n', ' / ')}`);
      assert.ok(debrief, 'a debrief');
      const lines = debrief.split('\n');
      assert.match(lines[0], /^(Day|Session)'s end: /);
      assert.ok(lines.some(line => line.startsWith('✓')), 'a win');
      assert.ok(lines.some(line => /^Tomorrow, first: /.test(line)), 'a first step');
      assert.ok(lines.length <= 8, 'eight lines at most');
      const last = store.lastSession(root, Number.MAX_SAFE_INTEGER);
      t.diagnostic(`first: ${JSON.stringify(last.pickup.first)}`);
      assert.ok(last.pickup.first?.file, 'a place in the project to land on');

      clock.now += 15 * 60 * 60_000; // the next morning
      const morning = await pairSession({root, store, clock});
      await morning.session.pickUp();
      await morning.partner.close();
      const pickup = morning.sent.find(message => message.type === 'pickup');
      t.diagnostic(`pick-up: ${pickup?.text}`);
      assert.ok(pickup, 'the pick-up line');
      assert.ok(!pickup.text.startsWith('Where you stopped'), 'the model wrote it');
      assert.ok(!pickup.text.includes('\n') && pickup.text.split(/\s+/).length <= 40, 'one short line');
    });
  }
});
