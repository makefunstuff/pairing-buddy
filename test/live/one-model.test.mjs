// One real model for both roles, behind a server that answers one request at a time (a local proxy in front of the
// stack's own server plays it): the daemon end to end. The user's question goes before a remark still being
// written, and while the Partner answers in one project the Watcher of another waits instead of queueing behind it.
// It prints when each request queued and ran, and what the Watcher waited.
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, test} from 'node:test';
import {parseConfig, sameModel} from '../../src/config.mjs';
import {startDaemon} from '../../src/daemon.mjs';
import {requestDaemon} from '../../src/protocol.mjs';
import {openStore} from '../../src/store.mjs';
import {client} from '../daemon-client.mjs';
import {oneSlot} from './one-slot.mjs';
import {project} from './project.mjs';
import {liveStacks, SKIP_REASON} from './stacks.mjs';

const stacks = liveStacks().filter(stack => sameModel(stack.config.models.watcher, stack.config.models.partner));

/** Resolves once `check()` holds, looking every 100 ms; fails after `ms`. */
async function until(check, ms = 120_000) {
  for (const started = Date.now(); !check(); await new Promise(resolve => setTimeout(resolve, 100))) {
    if (Date.now() - started > ms) throw new Error('timed out waiting');
  }
}

/** A chat pane in `root` with `goal` set, as the user would open one. */
async function chatIn(socket, root, goal) {
  const chat = client(socket, {type: 'hello', role: 'chat', cwd: root});
  await chat.next(message => message.type === 'welcome');
  chat.send({type: 'goal', text: goal});
  await chat.next(message => message.text === `Goal: ${goal}`);
  return chat;
}

const failTwice = (chat, root) => {
  for (let i = 0; i < 2; i++) chat.send({type: 'command', cwd: root, pane: null, cmd: 'npm test', exit: 1});
};

/** The next answer in `chat`, after the `seen` messages it had. */
async function answerFrom(chat, seen = chat.received.length) {
  const answer = () => chat.received.slice(seen).find(message => message.sender === 'pair');
  await until(answer);
  return answer();
}

describe('one model for both roles on a one-request-at-a-time server', {skip: stacks.length ? false : SKIP_REASON}, () => {
  for (const stack of stacks) {
    test(`${stack.name}: questions go first, and the Watcher waits instead of queueing`, {timeout: 600_000}, async t => {
      const entry = stack.raw.model ?? stack.raw.models.partner;
      const slot = await oneSlot(entry.baseUrl);
      const dataDir = mkdtempSync(join(tmpdir(), 'pair-live-one-'));
      const config = parseConfig({dataDir, socket: join(dataDir, 'pair.sock'), typingPauseMs: 50, keepWarm: false, model: {...entry, baseUrl: slot.url}});
      const daemon = await startDaemon(config, {log: line => t.diagnostic(`daemon: ${line}`)});
      const [blog, shop, docs] = [project().root, project().root, project().root];
      const chats = [];
      const started = Date.now();
      const at = time => `${((time - started) / 1000).toFixed(1).padStart(6)} s`;
      try {
        // A remark is being written when the user asks: it is cancelled, and the question is answered.
        const blogChat = await chatIn(config.socket, blog, 'reconnect should wait up to 30 s after the phone sleeps');
        chats.push(blogChat);
        await until(() => slot.requests.filter(request => request.role === 'partner').length >= 2); // the health probes
        const probes = slot.requests.length;
        failTwice(blogChat, blog);
        await until(() => slot.requests.slice(probes).some(request => request.role === 'partner'));
        const asked = Date.now();
        blogChat.send({type: 'ask', text: 'What timeout does the test expect? One sentence.'});
        const answer = await answerFrom(blogChat);
        const answerMs = Date.now() - asked;
        t.diagnostic(`question during a remark: answered in ${(answerMs / 1000).toFixed(1)} s: ${answer.text.replace(/\n/g, ' ')}`);
        let status = await requestDaemon(config.socket, {type: 'status'});
        assert.equal(status.slot.cancelled.remarks, 1, 'the remark was cancelled');
        assert.equal(blogChat.received.some(message => message.type === 'remark'), false);

        // While the Partner answers in the shop, a failure in the docs project waits for the model, then is scored.
        const shopChat = await chatIn(config.socket, shop, 'reconnect should wait up to 30 s after the phone sleeps');
        const docsChat = await chatIn(config.socket, docs, 'reconnect should wait up to 30 s after the phone sleeps');
        chats.push(shopChat, docsChat);
        const before = slot.requests.length;
        shopChat.send({type: 'ask', text: 'Read src/ws.mjs and test/ws.test.mjs: why does the reconnect test fail?'});
        await until(() => slot.requests.slice(before).some(request => request.role === 'partner' && request.started));
        failTwice(docsChat, docs);
        await answerFrom(shopChat);
        const remark = await until(() => docsChat.received.some(message => message.type === 'remark')).then(() => true, () => false);
        status = await requestDaemon(config.socket, {type: 'status'});

        for (const request of slot.requests) {
          t.diagnostic(`${request.role.padEnd(7)} arrived ${at(request.arrived)}, ran ${request.started ? at(request.started) : '   -   '} to ${request.ended ? at(request.ended) : '-'}${request.cancelled ? ', cancelled' : ''}  ${request.said}`);
        }
        const store = openStore(join(dataDir, 'sessions.sqlite'));
        const remarks = store.remarks(0);
        store.close();
        t.diagnostic(`remarks kept: ${remarks.map(each => `${each.trigger} (score ${each.score}, waited ${each.waitedMs ?? 0} ms)`).join(', ') || 'none'}`);
        t.diagnostic(`slot: ${JSON.stringify(status.slot)}`);

        const watcherCalls = slot.requests.filter(request => request.role === 'watcher' && request.started);
        const queued = watcherCalls.map(request => request.started - request.arrived);
        t.diagnostic(`the Watcher queued behind other requests: ${queued.join(' ')} ms`);
        assert.ok(queued.every(ms => ms < 1000), 'no Watcher call sat behind a Partner answer');
        assert.ok(remark, 'the docs project got its remark after the shop\'s answer');
        const docsRemark = remarks.find(each => each.trigger === 'repeated_error' && each.waitedMs > 0);
        assert.ok(docsRemark, 'and it says how long it waited for the model');
      } finally {
        for (const chat of chats) chat.close();
        await daemon.close();
        slot.close();
      }
    });
  }
});
