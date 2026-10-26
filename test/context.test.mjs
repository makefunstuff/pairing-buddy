// The context budget: in the smallest window Pair accepts, the instructions, the tools and the longest session note
// still leave room for a turn's conversation and the reply, and compaction keeps the reply's room free.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {estimateTextTokens} from '@earendil-works/pi-ai/utils/estimate';
import {parseConfig} from '../src/config.mjs';
import {compactionFor, MIN_CONTEXT} from '../src/context.mjs';
import {memoryPrompt} from '../src/partner.mjs';
import {cleanNote, NOTE_CHARS} from '../src/session.mjs';
import {pairExtension, ROLE_PROMPTS, ROLE_TOOLS} from '../src/tools.mjs';

const partnerAt = contextWindow => parseConfig({model: {api: 'openai', baseUrl: 'http://box/v1', model: 'm', contextWindow}}).models.partner;

test('compaction leaves the reply its room, and compacts only between turns when the server is shared', () => {
  for (const contextWindow of [MIN_CONTEXT, 32768, 131072]) {
    const {maxTokens} = partnerAt(contextWindow);
    const {reserveTokens, keepRecentTokens, backgroundTokens} = compactionFor(contextWindow, maxTokens);
    assert.ok(reserveTokens >= maxTokens + 4096, 'the reply and what pi-ai keeps free');
    assert.ok(keepRecentTokens < contextWindow - reserveTokens, 'a compaction can always cut something');
    assert.ok(backgroundTokens > 0);
  }
  assert.equal(compactionFor(32768, 10240, {background: false}).backgroundTokens, 0);
});

test('in the smallest window, each role\'s instructions, tools and the longest note leave room for a file read in full', () => {
  const {maxTokens, contextWindow} = partnerAt(MIN_CONTEXT);
  const {reserveTokens} = compactionFor(contextWindow, maxTokens);
  const note = cleanNote(Array(40).fill('Loose end: the reconnect test on a real phone, after sleep.').join('\n'));
  assert.ok(note.length <= NOTE_CHARS, 'a long note is cut to whole lines');
  const extension = pairExtension({});
  const READ_TOKENS = estimateTextTokens(`${'x'.repeat(40)}\n`.repeat(300)); // read's 300 lines, of 40 characters
  for (const role of Object.keys(ROLE_PROMPTS)) {
    const tools = extension.tools.filter(tool => ROLE_TOOLS[role].includes(tool.name)).map(({name, description, parameters}) => ({name, description, parameters}));
    const fixed = estimateTextTokens(`${ROLE_PROMPTS[role]}\n\n${memoryPrompt(note)}${JSON.stringify(tools)}`);
    const conversation = contextWindow - reserveTokens - fixed;
    assert.ok(conversation > READ_TOKENS + 1000, `${role}: ${conversation} tokens for the conversation`);
  }
});
