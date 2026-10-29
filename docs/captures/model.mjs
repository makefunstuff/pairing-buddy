// A fake OpenAI-compatible model server for the captures: the daemon talks to it exactly as it would to
// llama.cpp or vLLM, and it answers from a scene's script. The Watcher's answer is a function of the prompt;
// the Partner's answers are taken in order, each after its own pause. Health probes get "OK".
import {createServer} from 'node:http';
import {CHECK_PROMPT, CONFLICT_PROMPT} from '../../src/brief.mjs';
import {MARKS_PROMPT, TASKS_PROMPT} from '../../src/note-reading.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const textOf = content => (typeof content === 'string' ? content : (content ?? []).map(part => part.text ?? '').join(''));

/**
 * Starts the server on 127.0.0.1 and a free port. `scene.watcher(prompt)` is the Watcher's answer; `scene.partner`
 * lists the Partner's turns as `{wait, say}` or `{wait, call: [name, args]}` (or `calls: [[name, args], ...]`),
 * each with an optional `when` regex the input must match; a `say` with `stream` (ms) comes a few words at a time,
 * that long apart, as a model streams it. `scene.notes` answers a note's readings: `marks`, one
 * list per reading (the last again after them), and `tasks`, each after `wait`. A /gen request's brief checks get
 * no contradiction before it, and after it `scene.checks`, one list per check in order (none once they run out).
 * `log` hears each request. Resolves with `{baseUrl, close()}`.
 */
export async function startModelServer(scene, {log = () => {}} = {}) {
  const turns = [...scene.partner];
  let calls = 0;

  async function answer(body) {
    const system = textOf(body.messages.find(message => message.role === 'system')?.content);
    const last = textOf(body.messages.at(-1)?.content);
    if (system === 'Answer with one word.') return {text: 'OK'};
    if (scene.notes && (system === MARKS_PROMPT || system === TASKS_PROMPT)) {
      const {marks, tasks, wait} = scene.notes;
      const list = system === TASKS_PROMPT ? tasks : marks.length > 1 ? marks.shift() : marks[0];
      log(`partner -> ${list.length} ${system === TASKS_PROMPT ? 'tasks' : 'marks'}`);
      await sleep(wait ?? 0);
      return {text: JSON.stringify(list)};
    }
    if (system === CONFLICT_PROMPT) return {text: '[]'};
    if (system === CHECK_PROMPT) {
      const items = scene.checks?.shift() ?? [];
      log(`partner -> the brief's check: ${items.length} items`);
      return {text: JSON.stringify(items)};
    }
    if (body.model === 'watcher') {
      const text = scene.watcher(last);
      log(`watcher -> ${text}: ${last.replace(/\s+/g, ' ').slice(0, 160)}`);
      return {text};
    }
    // A turn with `when` waits for an input that matches it; inputs before it get SILENT.
    const turn = turns[0];
    if (!turn || (turn.when && !turn.when.test(last))) {
      log(`partner -> SILENT: ${last.replace(/\s+/g, ' ').slice(0, 160)}`);
      return {text: 'SILENT'};
    }
    turns.shift();
    await sleep(turn.wait ?? 0);
    const toolCalls = turn.call ? [turn.call] : turn.calls;
    log(`partner -> ${toolCalls ? toolCalls.map(([name]) => name).join(', ') : JSON.stringify(turn.say).slice(0, 80)}`);
    return toolCalls ? {toolCalls} : {text: turn.say, stream: turn.stream};
  }

  /** The answer as the chunks of a streamed chat completion. */
  function chunks(model, {text, toolCalls, stream}) {
    const id = `chatcmpl-capture-${++calls}`;
    const chunk = (delta, finish = null) => ({id, object: 'chat.completion.chunk', created: 0, model, choices: [{index: 0, delta, finish_reason: finish}]});
    const out = [chunk({role: 'assistant'})];
    // Streamed: three words a chunk; else the whole text in one.
    const parts = text && stream ? text.match(/(\S+\s*){1,3}/g) : text ? [text] : [];
    for (const part of parts) out.push(chunk({content: part}));
    (toolCalls ?? []).forEach(([name, args], index) => out.push(chunk({tool_calls: [{
      index, id: `call_${calls}_${index}`, type: 'function', function: {name, arguments: JSON.stringify(args)},
    }]})));
    out.push(chunk({}, toolCalls ? 'tool_calls' : 'stop'));
    out.push({id, object: 'chat.completion.chunk', created: 0, model, choices: [], usage: {prompt_tokens: 100, completion_tokens: 10, total_tokens: 110}});
    return out;
  }

  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url.endsWith('/models')) {
      response.writeHead(200, {'content-type': 'application/json'});
      return response.end(JSON.stringify({object: 'list', data: [{id: 'watcher', object: 'model'}, {id: 'partner', object: 'model'}]}));
    }
    if (request.method !== 'POST' || !request.url.endsWith('/chat/completions')) {
      response.writeHead(404);
      return response.end();
    }
    let raw = '';
    for await (const part of request) raw += part;
    const body = JSON.parse(raw);
    const reply = await answer(body);
    if (!body.stream) {
      response.writeHead(200, {'content-type': 'application/json'});
      const message = {role: 'assistant', content: reply.text ?? null};
      return response.end(JSON.stringify({id: 'chatcmpl-capture', object: 'chat.completion', created: 0, model: body.model, choices: [{index: 0, message, finish_reason: 'stop'}]}));
    }
    response.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache'});
    for (const chunk of chunks(body.model, reply)) {
      response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      if (reply.stream && chunk.choices[0]?.delta?.content) await sleep(reply.stream);
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }),
  };
}
