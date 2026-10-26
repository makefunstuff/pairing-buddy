// Session memory against real models, through a real PairSession: the note written at the end names the goal,
// the change and the loose end, and the next session answers from it without bringing it up unasked.
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, test} from 'node:test';
import {MemoryStorage} from '@earendil-works/pi-durable';
import {openPartner} from '../../src/partner.mjs';
import {PairSession, watchInput} from '../../src/session.mjs';
import {openStore} from '../../src/store.mjs';
import {ROLE_TOOLS} from '../../src/tools.mjs';
import {FILES, project} from './project.mjs';
import {liveStacks, SKIP_REASON} from './stacks.mjs';

const GOAL = 'reconnect drops after the phone sleeps';
const NOTE = `Goal: reconnect drops after the phone sleeps.
Changed: RECONNECT_TIMEOUT_MS in src/ws.mjs is now 30000.
Loose end: the backoff test for attempt 5 still fails; check the cap in backoff().`;

const stacks = liveStacks();

describe('Session memory on live models', {skip: stacks.length ? false : SKIP_REASON}, () => {
  for (const stack of stacks) {
    /** A Navigator session in a fresh project, on a store in memory; `previousNote` is what it starts from. */
    async function pairSession({root, store, previousNote = null}) {
      const shown = [];
      const tools = [];
      let session;
      const partner = await openPartner({
        storage: new MemoryStorage(),
        models: stack.models,
        model: stack.partner,
        thinking: stack.config.models.partner.thinking,
        hands: {
          ...Object.fromEntries(ROLE_TOOLS.navigator.map(name => [name, async (_conversation, args) => { tools.push(name); return session[name](args); }])),
          roleOf: () => 'navigator',
        },
      });
      const record = store.createSession({root, conversationId: await partner.createConversation(), goal: GOAL, level: 'normal', at: Date.now()});
      session = new PairSession({
        record, store, partner, previousNote,
        score: async () => ({value: 0, reason: ''}), typingPauseMs: 2000,
        notify: (to, message) => {
          if (to === 'chat' && message.type === 'message' && message.sender === 'pair') shown.push(message.text);
          return 1;
        },
        requestEditor: async () => null,
      });
      await session.configurePartner('navigator');
      return {session, partner, shown, tools};
    }

    test(`${stack.name}: the session note names the goal, the change and the loose end, in a few lines`, {timeout: 300_000}, async t => {
      const {root} = project();
      writeFileSync(join(root, 'src/ws.mjs'), FILES['src/ws.mjs'].replace('5000', '30000')); // the user's fix, not committed
      const store = openStore(':memory:');
      const {session, partner} = await pairSession({root, store});
      await session.ask('I set RECONNECT_TIMEOUT_MS to 30000 in src/ws.mjs. I still have to try it on a real phone; let us stop here for today.');
      await session.end();
      await partner.close();
      const note = store.previousNote(root, Number.MAX_SAFE_INTEGER);
      t.diagnostic(`note: ${note?.replaceAll('\n', ' / ')}`);
      assert.ok(note, 'a note was kept');
      assert.ok(note.split('\n').filter(line => line.trim()).length <= 8, 'a short note');
      assert.match(note, /reconnect|sleep/i, 'it names the goal');
      assert.match(note, /30000|30 ?s|30,000|ws\.mjs|RECONNECT_TIMEOUT/i, 'it names the change');
      assert.match(note, /phone/i, 'it names the loose end');
    });

    test(`${stack.name}: the next session answers "where were we" from the last note`, {timeout: 300_000}, async t => {
      const {root} = project();
      const {session, partner, shown} = await pairSession({root, store: openStore(':memory:'), previousNote: NOTE});
      await session.ask('What did we leave open last time?');
      await partner.close();
      t.diagnostic(`shown: ${shown.join(' | ')}`);
      assert.match(shown.join(' '), /backoff|attempt 5/i);
    });

    test(`${stack.name}: the last note does not make a noise moment worth a remark`, {timeout: 300_000}, async t => {
      const {root} = project();
      const {session, partner, shown, tools} = await pairSession({root, store: openStore(':memory:'), previousNote: NOTE});
      session.unasked = true; // as PairSession.remark runs it
      const spoke = await session.talk(watchInput(
        {kind: 'drift', detail: `Possible drift from the goal "${GOAL}": recently edited src/ws.mjs on branch fix/reconnect. A remark helps only if this work is unrelated to the goal.`},
        `Goal: ${GOAL}\nBranch: fix/reconnect\nCurrent file: src/ws.mjs, cursor at line 1\nRecent edits: src/ws.mjs:1-1 (20 s ago)`,
      ));
      await partner.close();
      t.diagnostic(`shown: ${shown.join(' | ') || 'nothing'} · tools: ${tools.join(', ') || 'none'}`);
      assert.equal(spoke, false, 'nothing reached the user');
    });
  }
});
