// `pair doctor --thinking` against fake servers that each take thinking their own way.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {test} from 'node:test';
import {parseConfig} from '../src/config.mjs';
import {probeThinkingSettings} from '../src/thinking-probe.mjs';

/**
 * An OpenAI-compatible server whose model thinks as `thinkingOf(body)` says, in tokens (0: no thinking), and rejects
 * a request with `rejects(body)`. It streams the thinking as reasoning_content and reports it in the usage.
 */
async function fakeServer({thinkingOf, rejects = () => false}) {
  const bodies = [];
  const server = createServer((request, response) => {
    let text = '';
    request.on('data', chunk => { text += chunk; }).on('end', () => {
      if (request.url === '/v1/models') return response.end(JSON.stringify({data: [{id: 'm'}]}));
      const body = JSON.parse(text);
      bodies.push(body);
      if (rejects(body)) { response.writeHead(400); return response.end('{"error": {"message": "unknown field"}}'); }
      const thought = thinkingOf(body);
      response.writeHead(200, {'content-type': 'text/event-stream'});
      const chunk = (delta, extra = {}) => `data: ${JSON.stringify({id: '1', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{index: 0, ...delta}], ...extra})}\n\n`;
      const thinking = thought ? chunk({delta: {role: 'assistant', reasoning_content: 'Let me add them up. '.repeat(10)}}) : '';
      const usage = {usage: {prompt_tokens: 30, completion_tokens: thought + 3, completion_tokens_details: {reasoning_tokens: thought}}};
      response.end(`${thinking}${chunk({delta: {role: 'assistant', content: '8418'}})}${chunk({delta: {}, finish_reason: 'stop'}, usage)}data: [DONE]\n\n`);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {url: `http://127.0.0.1:${server.address().port}/v1`, bodies, close: () => server.close()};
}

const configAt = (url, entry = {}) => parseConfig({model: {api: 'openai', baseUrl: url, model: 'm', contextWindow: 65536, ...entry}});
const probe = async config => {
  const lines = [];
  for await (const line of probeThinkingSettings(config)) lines.push(line);
  return lines;
};

test('a chat template with an enable_thinking switch and a budget field: the probe finds both and prints them', {timeout: 30_000}, async () => {
  // Thinks unless the template's switch is off; a budget in thinking_budget_tokens holds the thinking to it.
  const server = await fakeServer({
    thinkingOf: body => (body.chat_template_kwargs?.enable_thinking === false ? 0 : Math.min(900, body.thinking_budget_tokens ?? 900)),
    rejects: body => 'thinking' in body,
  });
  try {
    const lines = await probe(configAt(server.url, {compat: {maxTokensField: 'max_tokens'}}));
    assert.match(lines[0].text, /^Pair's default request: thinks with thinking off, thinks when on \(900 tokens\)$/);
    assert.match(lines[1].text, /^the chat template's enable_thinking: no thinking when off, thinks when on/);
    assert.equal(lines.length, 5, 'the switch found, then levels: reasoning_effort shows no difference, the budget field does');
    assert.match(lines[2].text, /^levels as reasoning_effort: 900 tokens at "low", 900 tokens at "high", no clear difference$/);
    assert.match(lines[3].text, /^levels as thinking_budget_tokens: 32 tokens at "low", 900 tokens at "high"$/);
    const last = lines.at(-1);
    assert.equal(last.level, 'ok');
    const paste = JSON.parse(`{${/Put this in the Partner's entry: (.*)$/.exec(last.text)[1]}}`);
    assert.deepEqual(paste, {compat: {
      maxTokensField: 'max_tokens', thinkingFormat: 'chat-template', chatTemplateKwargs: {enable_thinking: {$var: 'thinking.enabled'}}, thinkingTokenBudgetField: 'thinking_budget_tokens',
    }}, 'the config\'s other compat keys are kept');
  } finally {
    server.close();
  }
});

test('a server that thinks only when given reasoning_effort, and checks its value: it reads the field; "minimal" gets a level map', {timeout: 30_000}, async () => {
  const server = await fakeServer({
    thinkingOf: body => (body.reasoning_effort ? 300 : 0), // about as long at each level, as with a short question
    rejects: body => body.reasoning_effort !== undefined && !['low', 'medium', 'high'].includes(body.reasoning_effort),
  });
  try {
    const lines = await probe(configAt(server.url, {thinking: {remark: 'minimal'}}));
    assert.ok(lines.some(line => /^levels as reasoning_effort: the server reads it \(it rejects a level it does not have\); 300 tokens at "low", 300 tokens at "high"$/.test(line.text)));
    const last = lines.at(-1);
    assert.equal(last.level, 'ok');
    assert.match(last.text, /^thinking switches with reasoning_effort; levels reach it as reasoning_effort\. Put this in the Partner's entry: "compat": \{"supportsReasoningEffort":true\}, "thinkingLevelMap": \{"minimal":"low"\}$/);
  } finally {
    server.close();
  }
});

test('a model that never thinks, and a provider entry, need no probe', async () => {
  const server = await fakeServer({thinkingOf: () => 0});
  try {
    const lines = await probe(configAt(server.url));
    assert.match(lines.at(-1).text, /^the model never thinks: set "reasoning": false/);
  } finally {
    server.close();
  }
  const [line] = await probe(parseConfig({model: {provider: 'deepseek', model: 'deepseek-flash'}}));
  assert.match(line.text, /^only an OpenAI-compatible endpoint needs this/);
});
