// The context card's sources against real models, through a real PairSession: the Partner answers from the board
// task and the searches it is given, and a source the user hid is not there to answer from until it is back.
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {describe, test} from 'node:test';
import {MemoryStorage} from '@earendil-works/pi-durable';
import {openPartner} from '../../src/partner.mjs';
import {PairSession} from '../../src/session.mjs';
import {openStore} from '../../src/store.mjs';
import {ROLE_TOOLS} from '../../src/tools.mjs';
import {project} from './project.mjs';
import {liveStacks, SKIP_REASON} from './stacks.mjs';

const stacks = liveStacks();

describe('The context card on live models', {skip: stacks.length ? false : SKIP_REASON}, () => {
  for (const stack of stacks) {
    async function pairSession(root) {
      const shown = [];
      let session;
      const partner = await openPartner({
        storage: new MemoryStorage(),
        models: stack.models,
        model: stack.partner,
        thinking: stack.config.models.partner.thinking,
        hands: {
          ...Object.fromEntries(ROLE_TOOLS.navigator.map(name => [name, async (_conversation, args) => session[name](args)])),
          roleOf: () => 'navigator',
        },
      });
      const store = openStore(':memory:');
      const record = store.createSession({root, conversationId: await partner.createConversation(), goal: null, level: 'normal', at: Date.now()});
      session = new PairSession({
        record, store, partner,
        score: async () => ({value: 0, reason: ''}), typingPauseMs: 2000,
        notify: (to, message) => {
          if (to === 'chat' && message.type === 'message' && message.sender === 'pair') shown.push(message.text);
          return 1;
        },
        requestEditor: async () => null,
      });
      await session.configurePartner('navigator');
      return {session, partner, shown};
    }

    test(`${stack.name}: the Partner knows the board task and the last search, and nothing of a hidden source`, {timeout: 300_000}, async t => {
      const {root} = project();
      const {session, partner, shown} = await pairSession(root);
      try {
        session.receive({kind: 'context', branch: 'work/12-reconnect-after-sleep',
          git: {last: 'abc1234 ws: log each reconnect', changed: 1, pr: ''},
          board: {task: {id: 'ws-client/12', title: 'Reconnect after the phone sleeps', state: 'working', msg: '', pr: null}, working: 0, waiting: []}});
        session.setGoal('Reconnect after the phone sleeps', 'the board task ws-client/12');
        session.receive({kind: 'places', buffers: [join(root, 'src/ws.mjs'), join(root, 'test/ws.test.mjs')], jumps: [{file: join(root, 'src/ws.mjs'), line: 3}]});
        session.receive({kind: 'search', tool: 'Live Grep', query: 'RECONNECT_TIMEOUT', results: 3, file: join(root, 'src/config.mjs'), line: 3});

        // Hidden from the start: nothing of the editor reaches the conversation.
        session.receive({kind: 'hide', source: 'editor', hidden: true});
        await session.ask('Without reading any file and without guessing: which board task is this, and what did my last search look for? If you were not told, say so. One line.');
        const hidden = shown.join('\n');
        t.diagnostic(`answer with the editor hidden: ${hidden}`);
        assert.match(hidden, /ws-client\/12|Reconnect after the phone sleeps/i, 'the board task');
        assert.doesNotMatch(hidden.replace(/RECONNECT_TIMEOUT_MS/g, ''), /RECONNECT_TIMEOUT\b|Live Grep|config\.mjs/, 'no search reached it');

        // Brought back with x: the next question has it.
        shown.length = 0;
        session.receive({kind: 'hide', source: 'editor', hidden: false});
        await session.ask('Without reading any file: which file did my last search open? One line.');
        const answer = shown.join('\n');
        t.diagnostic(`answer with the editor back: ${answer}`);
        assert.match(answer, /src\/config\.mjs/, 'the file the search opened');
      } finally {
        await partner.close();
      }
    });
  }
});
