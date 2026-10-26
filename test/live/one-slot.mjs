// A local proxy in front of a real OpenAI-compatible server that lets one request through at a time, as many
// local servers do: the others queue. A request whose client goes away is dropped from the queue, or cut off
// upstream. It records when each request arrived, started and ended, whose it was, and what it last said.
import {createServer} from 'node:http';

/** The role of a chat completion: the Watcher's ask for a few tokens, or the Partner's. */
const roleOf = body => (body.max_tokens <= 8 ? 'watcher' : 'partner');

/** The start of the request's last message, to tell the requests apart. */
function lastSaid(body) {
  const content = body.messages?.at(-1)?.content;
  const text = typeof content === 'string' ? content : (content ?? []).map(part => part.text ?? '').join('');
  return `${body.messages?.at(-1)?.role ?? '-'}: ${text.replace(/\s+/g, ' ').slice(0, 50)}`;
}

export async function oneSlot(targetUrl) {
  const target = targetUrl.replace(/\/$/, '');
  const queue = [];
  const requests = [];
  let busy = false;

  function next() {
    if (busy || !queue.length) return;
    busy = true;
    const job = queue.shift();
    job.run().finally(() => { busy = false; next(); });
  }

  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = text ? JSON.parse(text) : {};
    const record = {role: roleOf(body), said: lastSaid(body), arrived: Date.now(), started: null, ended: null, cancelled: false};
    if (request.url.endsWith('/chat/completions')) requests.push(record);
    const upstream = new AbortController();
    response.on('close', () => {
      if (record.ended) return;
      record.cancelled = true;
      upstream.abort();
      const queued = queue.findIndex(job => job.record === record);
      if (queued >= 0) queue.splice(queued, 1);
    });
    const run = async () => {
      record.started = Date.now();
      try {
        const reply = await fetch(`${target}${request.url}`, {
          method: request.method,
          headers: {'content-type': 'application/json', ...(request.headers.authorization ? {authorization: request.headers.authorization} : {})},
          body: text || undefined,
          signal: upstream.signal,
        });
        response.writeHead(reply.status, {'content-type': reply.headers.get('content-type') ?? 'application/json'});
        for await (const chunk of reply.body) response.write(chunk);
        record.ended = Date.now();
        response.end();
      } catch {
        record.ended = Date.now();
        response.destroy();
      }
    };
    // Only the completions take the slot; listing the models does not.
    if (!request.url.endsWith('/chat/completions')) return run();
    queue.push({record, run});
    next();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {url: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close()};
}
