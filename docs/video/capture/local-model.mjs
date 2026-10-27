// A stand-in for a local OpenAI-compatible server (llama.cpp, vLLM) with one model, for the start capture's
// `pair doctor`: it thinks when asked to (reasoning_effort), and answers a short sum, a score or "OK".
// Usage: node local-model.mjs <port>   (127.0.0.1 only)
import {createServer} from 'node:http';

const port = Number(process.argv[2]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const textOf = content => (typeof content === 'string' ? content : (content ?? []).map(part => part.text ?? '').join(''));

createServer(async (request, response) => {
  if (request.method === 'GET' && request.url.endsWith('/models')) {
    response.writeHead(200, {'content-type': 'application/json'});
    return response.end(JSON.stringify({object: 'list', data: [{id: 'local-model', object: 'model'}]}));
  }
  if (request.method !== 'POST' || !request.url.endsWith('/chat/completions')) { response.writeHead(404); return response.end(); }
  let raw = '';
  for await (const part of request) raw += part;
  const body = JSON.parse(raw);
  const last = textOf(body.messages.at(-1)?.content);
  const effort = body.reasoning_effort;
  const thinks = Boolean(effort) && effort !== 'none';
  const sum = last.match(/(\d+)\s*\+\s*(\d+)/);
  const text = sum ? String(Number(sum[1]) + Number(sum[2])) : /score|number|0-9|0 to 9/i.test(last) ? '2' : 'OK';
  const reasoning = thinks ? `The user wants a short answer. ${effort === 'high' || effort === 'xhigh' ? 'Check it twice. ' : ''}${'Think. '.repeat({minimal: 1, low: 2, medium: 4, high: 8, xhigh: 12}[effort] ?? 3)}` : '';
  await sleep(thinks ? 600 : 180);
  const id = 'chatcmpl-local';
  const chunk = (delta, finish = null) => ({id, object: 'chat.completion.chunk', created: 0, model: body.model, choices: [{index: 0, delta, finish_reason: finish}]});
  const usage = {id, object: 'chat.completion.chunk', created: 0, model: body.model, choices: [], usage: {prompt_tokens: 40, completion_tokens: 8 + reasoning.length / 4, total_tokens: 60}};
  if (!body.stream) {
    response.writeHead(200, {'content-type': 'application/json'});
    return response.end(JSON.stringify({id, object: 'chat.completion', created: 0, model: body.model, choices: [{index: 0, message: {role: 'assistant', content: text, ...(reasoning && {reasoning_content: reasoning})}, finish_reason: 'stop'}], usage: usage.usage}));
  }
  response.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache'});
  for (const part of [chunk({role: 'assistant'}), ...(reasoning ? [chunk({reasoning_content: reasoning})] : []), chunk({content: text}), chunk({}, 'stop'), usage]) response.write(`data: ${JSON.stringify(part)}\n\n`);
  response.end('data: [DONE]\n\n');
}).listen(port, '127.0.0.1', () => console.error(`local model on ${port}`));
