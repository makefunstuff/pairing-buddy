// `pair doctor --thinking`: which thinking settings the Partner's OpenAI-compatible server takes. There is no way
// to ask a server, so Pair sends the known ones and looks at the replies: thinking off must not think, a level must
// think more at `high` than at `low`. It ends with the `compat` block to paste into the config.
import {createPairModels} from './models.mjs';
import {probeEffort} from './probe.mjs';

// How thinking is switched on and off: the server's default (nothing sent), a chat template's switch, or a field.
const SWITCHES = [
  {name: 'nothing sent', compat: {}},
  {name: 'the chat template\'s enable_thinking', compat: {thinkingFormat: 'chat-template', chatTemplateKwargs: {enable_thinking: {$var: 'thinking.enabled'}}}},
  {name: 'the chat template\'s thinking', compat: {thinkingFormat: 'chat-template', chatTemplateKwargs: {thinking: {$var: 'thinking.enabled'}}}},
  {name: 'a "thinking" field', compat: {thinkingFormat: 'deepseek'}},
  {name: 'reasoning_effort', compat: {supportsReasoningEffort: true}},
];

// How the level is sent, given a switch: as reasoning_effort (in the chat template's values when the switch is
// there), or as a token budget in the field one server or another names.
const LEVEL_FIELDS = [
  {
    name: 'reasoning_effort',
    add: ({thinkingFormat, chatTemplateKwargs}) => (thinkingFormat === 'chat-template'
      ? {chatTemplateKwargs: {...chatTemplateKwargs, reasoning_effort: {$var: 'thinking.effort', omitWhenOff: true}}}
      : {supportsReasoningEffort: true}),
  },
  ...['thinking_budget_tokens', 'thinking_token_budget', 'thinking_budget'].map(field => ({name: field, add: () => ({thinkingTokenBudgetField: field})})),
];

// The compat keys that say how thinking is sent; the probe replaces these and keeps the rest of the config's.
const THINKING_KEYS = ['thinkingFormat', 'chatTemplateKwargs', 'supportsReasoningEffort', 'thinkingTokenBudgetField', 'supportsThinkingTokenBudget'];
// Levels the OpenAI API does not have; a server that takes reasoning_effort may reject them.
const NEAREST = {minimal: 'low', xhigh: 'high'};

/** `level` thinks clearly more than `less`: half again as many tokens, and at least a hundred more. */
const moreThan = (level, less) => level.tokens >= 1.5 * less.tokens && level.tokens - less.tokens >= 100;

/**
 * What the Partner's model does with `compat` at each of `levels` ("off" for thinking off), by level; `{error}` when
 * the server rejects one. At "low" the budget is held small, so a budget field that is sent shows.
 */
async function measure(config, compat, levels) {
  const entry = {...config.models.partner, reasoning: true, compat};
  const {models, partner} = createPairModels({...config, models: {watcher: entry, partner: entry}});
  const found = {};
  for (const level of levels) {
    const result = await probeEffort(models, partner, level === 'off' ? null : level, level === 'low' ? {thinkingBudgets: {low: 256}} : {});
    if (!result.ok) return {error: result.error};
    found[level] = result;
  }
  return found;
}

const tokens = result => `${result.tokens} tokens`;

/** The probe's findings, one `{level, name: 'thinking', text}` at a time, the last with the block to paste. */
export async function* probeThinkingSettings(config, {measureWith = measure} = {}) {
  const entry = config.models.partner;
  if (entry.api !== 'openai' || entry.provider) {
    yield {level: 'ok', name: 'thinking', text: 'only an OpenAI-compatible endpoint needs this: a provider\'s levels come from pi-ai\'s catalog, and the anthropic API takes each level as a budget'};
    return;
  }
  const kept = Object.fromEntries(Object.entries(entry.compat ?? {}).filter(([key]) => !THINKING_KEYS.includes(key)));
  let chosen = null;
  for (const candidate of SWITCHES) {
    const result = await measureWith(config, {...kept, ...candidate.compat}, ['off', 'high']);
    if (result.error) { yield {level: 'warn', name: 'thinking', text: `${candidate.name}: the server rejects it (${result.error})`}; continue; }
    const switches = !result.off.thought && result.high.thought;
    yield {level: switches ? 'ok' : 'warn', name: 'thinking', text: `${candidate.name}: ${result.off.thought ? 'thinks with thinking off' : 'no thinking when off'}, `
      + `${result.high.thought ? `thinks when on (${tokens(result.high)})` : 'no thinking when on'}`};
    if (switches) { chosen = candidate; break; }
    if (!chosen && result.high.thought) chosen = {...candidate, alwaysThinks: true}; // thinks, but cannot be switched off
  }
  if (!chosen) {
    yield {level: 'warn', name: 'thinking', text: 'the model never thinks: set "reasoning": false on its entry, so Pair sends no thinking level'};
    return;
  }
  let levels = null;
  for (const field of LEVEL_FIELDS) {
    const compat = {...kept, ...chosen.compat, ...field.add(chosen.compat)};
    const result = await measureWith(config, compat, ['low', 'high']);
    if (result.error) { yield {level: 'warn', name: 'thinking', text: `levels as ${field.name}: the server rejects it (${result.error})`}; continue; }
    const distinct = result.low.thought && moreThan(result.high, result.low);
    yield {level: distinct ? 'ok' : 'warn', name: 'thinking', text: `levels as ${field.name}: ${tokens(result.low)} at "low", ${tokens(result.high)} at "high"${distinct ? '' : ', no clear difference'}`};
    if (distinct) { levels = {field, compat}; break; }
  }
  const compat = levels?.compat ?? {...kept, ...chosen.compat};
  const map = levels?.field.name === 'reasoning_effort' ? await levelMap(config, compat, measureWith) : null;
  const paste = [`"compat": ${JSON.stringify(compat)}`, ...(map ? [`"thinkingLevelMap": ${JSON.stringify(map)}`] : [])].join(', ');
  const says = [
    chosen.alwaysThinks ? 'the model thinks whatever it is told, so the Watcher is slower than it need be' : `thinking switches with ${chosen.name}`,
    levels ? `levels reach it as ${levels.field.name}` : 'no field Pair knows gives it levels, so "low", "medium" and "high" are one request',
  ].join('; ');
  yield {level: levels && !chosen.alwaysThinks ? 'ok' : 'warn', name: 'thinking', text: `${says}. Put this in the Partner's entry: ${paste}`};
}

/** The level map a reasoning_effort server needs: the configured levels it rejects, sent as the nearest it takes. */
async function levelMap(config, compat, measureWith) {
  const used = new Set(Object.values(config.models.partner.thinking));
  const map = {};
  for (const [level, nearest] of Object.entries(NEAREST)) {
    if (used.has(level) && (await measureWith(config, compat, [level])).error) map[level] = nearest;
  }
  return Object.keys(map).length ? map : null;
}
