// What Pair's panel knows of the chat: the daemon's messages turned into entries (what was said, the remarks with
// their verdicts, the questions Pair asks with their answers, the /gen cards), and what each click or typed line
// sends back. The same rules as the terminal's chat pane (src/chat.mjs), without a terminal: plain JavaScript with no
// imports but its neighbours, so the tests run it in Node and the panel (main.js) in Herdr.
import {allows, genText, HELP, LEVELS, parseInput} from './commands.js';
import {cardKeys, GEN_AT_WORK, genStatus, relayActions, relayKeys, remarkKeys, shownTool} from './keys.js';

const KIND_OF = {user: 'you', pair: 'pair', system: 'system'};
const BUSY = ['thinking', 'tool'];
export const ROLE_NAMES = {navigator: 'Navigator', scout: 'Scout', driver: 'Driver'};

/**
 * The answers a question of Pair's (`confirm`) offers as buttons, from its hint ("y add only · d delegate · n
 * nothing", "y: scaffold · file, try · n cancels"): `{key, label, text}`, `text` being what the answer sends. Without
 * a hint, Yes and No. `free`: words typed in the box answer it too.
 */
export function confirmChoices(confirm) {
  if (!confirm.hint) return {choices: [{key: 'y', label: 'Yes', text: 'y'}, {key: 'n', label: 'No', text: 'n'}], free: false};
  const choices = [];
  let free = false;
  for (const part of confirm.hint.split(' · ').map(each => each.trim()).filter(Boolean)) {
    const keyed = /^([a-z]):?\s+(.+)$/i.exec(part);
    if (keyed) choices.push({key: keyed[1].toLowerCase(), label: keyed[2], text: keyed[1].toLowerCase()});
    else if (/^[\w-]+(,\s*[\w-]+)*$/.test(part)) for (const word of part.split(/,\s*/)) choices.push({key: word, label: word, text: word}); // a shape's other choices
    else free = true; // "or your answer"
  }
  return {choices, free};
}

export class ChatModel {
  /** `send(message)` to the daemon: false when it could not go (no daemon). `now()` for the times. */
  constructor({send = () => false, now = () => Date.now()} = {}) {
    Object.assign(this, {send, now});
    this.entries = [];
    this.held = []; // what came unasked while an answer streams: it goes under the answer once that is done
    this.header = {project: null, goal: null, role: null, level: null, muted: [], keep: false, board: null};
    this.root = null;
    this.model = null; // the Partner's model, as the daemon names it
    this.watcherModel = null; // and the Watcher's
    this.models = {}; // role -> why its model is not answering, or null
    this.index = null; // search by meaning's index of this project, as far as it is built
    this.connection = 'connecting'; // connecting, up, away (it went), down (never there)
    this.activity = {state: 'idle'};
    this.presence = null;
    this.turn = null;
    this.confirming = null; // the id of the question Pair asks
    this.cards = new Map(); // the gen cards, by request number
    this.plan = null;
    this.first = null;
    this.listed = []; // the ids of the remarks /remarks showed last
    this.about = null; // the remark a follow-up is about: {id, text}
    this.keepFrom = null; // the scaffold whose card's k was clicked: /keep keeps from it
    this.flash = null; // a short note under the box: {text, at}
    this.nextId = 1;
    this.turnFrom = 1;
  }

  // Entries.

  add(entry) {
    const card = entry.meta?.gen ? this.cards.get(entry.meta.gen) : undefined;
    this.entries.push({id: this.nextId++, at: this.now(), ...entry, ...(card ? {card} : {})});
    return this.entries.at(-1);
  }

  partialIndex() {
    return this.entries.findLastIndex(entry => entry.partial);
  }

  /** What comes unasked waits under an answer that streams, so the words being read do not move. */
  arrive(entry) {
    if (this.partialIndex() === -1) return this.add(entry);
    this.held.push({at: this.now(), ...entry});
    return entry;
  }

  flushHeld() {
    if (this.partialIndex() === -1) for (const entry of this.held.splice(0)) this.add(entry);
  }

  note(text, kind = 'system') {
    return this.arrive({kind, text});
  }

  say(text) {
    this.flash = {text, at: this.now()};
  }

  dropPartial() {
    const i = this.partialIndex();
    if (i !== -1) this.entries.splice(i, 1);
  }

  get busy() {
    return BUSY.includes(this.activity.state);
  }

  /** Whether a /gen request works or waits: the stop button stops it too. */
  get genAtWork() {
    return [...this.cards.values()].some(card => GEN_AT_WORK.includes(card.state));
  }

  get gen() {
    return genStatus([...this.cards.values()]);
  }

  goalAsked() {
    const lastYou = this.entries.findLastIndex(entry => entry.kind === 'you');
    return this.entries.findLastIndex(entry => entry.meta?.goal === 'ask' || /^What are we doing this session\?/.test(entry.text ?? '')) > lastYou;
  }

  /** The entries of remark `id`: its words and what it pointed at or suggested. */
  remarkGroup(id) {
    return this.entries.filter(entry => entry.meta?.remark === id);
  }

  /** The buttons of the remark at entry `index`: take its suggestion, go to its line (see remarkKeys). */
  remarkKeys(index) {
    return remarkKeys(this.entries, index);
  }

  /** The question Pair asks now, as an entry; null when none waits. */
  get asking() {
    return this.confirming === null ? null : this.entries.find(entry => entry.confirm === this.confirming) ?? null;
  }

  // From the daemon.

  entryOf(message) {
    const meta = message.meta ?? {};
    let kind = KIND_OF[message.sender] ?? 'system';
    if (kind === 'pair' && meta.trigger) kind = 'watch';
    if (kind === 'system' && meta.error) kind = 'error';
    if (kind === 'pair' && meta.gen) return {kind: 'gen', text: genText(message.text), at: message.at ?? this.now(), meta, card: this.cards.get(meta.gen)};
    const about = meta.about ? this.entries.find(entry => entry.meta?.remark === meta.about && entry.kind === 'watch') : null;
    return {kind, text: message.text, at: message.at ?? this.now(), meta, aboutText: about?.text.split('\n')[0]};
  }

  /**
   * Takes a message of the daemon's. Returns what the panel should know beyond its redraw: `{remark}` for a new
   * remark, `{confirm}` for a new question, so it can raise a toast while it is not seen; else null.
   */
  receive(message, {reconnected = false} = {}) {
    let news = null;
    switch (message.type) {
      case 'welcome': {
        this.cards.clear();
        for (const entry of this.entries) delete entry.card;
        this.connection = 'up';
        this.root = message.root;
        this.plan = message.plan ?? null;
        this.header = {
          ...this.header, project: message.root.split('/').filter(Boolean).at(-1) ?? message.root, goal: message.goal ?? null, role: message.role,
          keep: Boolean(message.keep), level: message.level, muted: message.muted ?? [], board: message.board ?? null,
        };
        this.model = message.model ?? null;
        this.watcherModel = message.watcher ?? null;
        this.models = message.models ?? {};
        if (!reconnected) for (const [role, why] of Object.entries(this.models)) if (why) this.note(`The ${role} model is not answering (${why}). \`pair doctor\` checks it.`, 'error');
        if (reconnected) this.say('Reconnected to Pair\'s daemon');
        break;
      }
      case 'health':
        this.models = message.models ?? {};
        this.note(message.text, Object.values(this.models).some(Boolean) ? 'error' : 'system');
        break;
      case 'role':
        this.header.role = message.role;
        this.header.keep = Boolean(message.keep);
        break;
      case 'goal':
        this.header.goal = message.goal;
        break;
      case 'level':
        this.header.level = message.level;
        break;
      case 'muted':
        this.header.muted = message.kinds ?? [];
        break;
      case 'board':
        this.header.board = message.board ?? null;
        break;
      case 'index_progress':
        this.index = message;
        break;
      case 'meaning_state':
      case 'voice_state':
        if (message.text) this.note(message.text);
        break;
      case 'activity':
        if (this.activity.state === 'idle' && message.state !== 'idle') this.turnFrom = this.nextId;
        this.activity = message;
        if (message.state === 'idle') this.dropPartial();
        break;
      case 'presence':
        this.presence = message;
        break;
      case 'turn': {
        if (message.asked) this.turn = message;
        this.dropPartial();
        const said = this.entries.find(entry => entry.id >= this.turnFrom && ['pair', 'watch'].includes(entry.kind));
        if (said && !message.cancelled) said.turn = {ms: message.ms, tokens: message.tokens};
        this.turnFrom = this.nextId;
        break;
      }
      case 'partial': {
        const i = this.partialIndex();
        if (!message.text) this.dropPartial();
        else if (i !== -1) this.entries[i].text = message.text;
        else this.add({kind: 'pair', text: message.text, partial: true});
        break;
      }
      case 'tool': {
        if (!shownTool(message.tool)) break;
        const last = this.entries.at(-1);
        const tools = last?.kind === 'tool' ? last : this.entries.at(-2)?.kind === 'tool' && last?.partial ? this.entries.at(-2) : this.add({kind: 'tool', tools: []});
        tools.tools.push({tool: message.tool, what: message.what});
        break;
      }
      case 'confirm': {
        this.confirming = message.id;
        const entry = this.add({
          kind: 'confirm', text: message.gen ? genText(message.text) : message.text, confirm: message.id,
          ...(message.command ? {command: message.command} : {}), ...(message.copy ? {copy: true} : {}), ...(Array.isArray(message.keys) ? {keys: message.keys} : {}),
          ...(message.hint ? {hint: message.hint} : {}), ...(message.gen ? {gen: message.gen} : {}),
        });
        news = {confirm: entry};
        break;
      }
      case 'confirmed': {
        if (message.id === this.confirming) this.confirming = null;
        const entry = this.entries.find(each => each.confirm === message.id);
        if (entry && entry.answer === undefined) entry.answer = false; // it timed out, or was withdrawn
        break;
      }
      case 'plan':
        this.plan = message.steps ?? null;
        if (message.proposed) this.note('/plan edits the steps · /plan off drops them');
        break;
      case 'first':
        if (message.step) this.first = message.step;
        if (message.step) this.note('e edits tomorrow\'s first step');
        break;
      case 'ledger':
      case 'agent_list':
        if (message.text) this.arrive({kind: 'note', text: message.text});
        break;
      case 'found': // /find's answer; a picker's (with its id) is a Neovim's
        if (message.id === undefined && message.text) this.arrive({kind: 'note', text: message.text});
        break;
      case 'remarks':
        this.listed = (message.remarks ?? []).map(remark => remark.id);
        if (message.text) this.arrive({kind: 'note', text: message.text});
        break;
      case 'agents':
        for (const entry of [...this.entries, ...this.held]) if (entry.meta?.agent) entry.meta.agent.live = false;
        if (message.item) this.arrive({kind: 'note', text: `◇ ${message.text}${message.more ? ` (+${message.more} more · /agents)` : ''}`, meta: {agent: relayKeys(message.item)}});
        break;
      case 'acted':
        for (const entry of this.remarkGroup(message.remark)) if (!entry.verdict) entry.verdict = 'useful';
        break;
      case 'message': {
        if (message.meta?.goal === 'set' && !this.goalAsked()) break;
        const entry = this.entryOf(message);
        if (message.sender === 'user' && !message.history) {
          const mine = this.entries.find(each => each.pending);
          if (mine) {
            Object.assign(mine, entry, {pending: false});
            break;
          }
        }
        const i = this.partialIndex();
        if (i !== -1 && entry.kind !== 'you') {
          const partial = this.entries[i];
          if (entry.kind === 'pair' && entry.text.startsWith(partial.text.slice(0, 24))) {
            this.entries[i] = {...partial, ...entry, partial: false};
            break;
          }
        }
        const added = entry.kind === 'you' ? this.add(entry) : this.arrive(entry);
        // A remark's first words, new (not the history a reconnect shows): the panel may raise a toast.
        if (entry.kind === 'watch' && !message.history && this.remarkGroup(entry.meta.remark).length <= 1) news = {remark: added};
        break;
      }
      case 'gen_card':
        this.cards.set(message.gen, message);
        for (const entry of this.entries) if (entry.meta?.gen === message.gen) entry.card = message;
        break;
      case 'applied': {
        const entry = this.entries.find(each => each.meta?.suggestion?.action === message.action);
        if (entry) entry.applied = true;
        this.say('Taken in Neovim, unsaved: u there undoes it, /undo here');
        break;
      }
      case 'take_none':
        this.say({gone: 'That suggestion is no longer showing in Neovim (taken, dismissed or edited)', changed: 'Its lines changed in Neovim since, so it was dropped'}[message.why]
          ?? 'Nothing to take: no suggestion or gen block is showing in Neovim');
        break;
      case 'suggestion_gone':
        for (const entry of [...this.entries, ...this.held]) if (entry.meta?.suggestion?.action === message.action) entry.gone = true;
        break;
      case 'ended':
        this.note(`session ended${message.why ? ` by itself: ${message.why}` : ''}`);
        news = {ended: true};
        break;
      default:
        return null;
    }
    this.flushHeld();
    return news;
  }

  /** The daemon went away: what is typed is kept, and sent once it is back. */
  lost() {
    this.connection = 'away';
    this.awaySince = this.now();
  }

  // To the daemon.

  out(message) {
    if (this.connection !== 'up') {
      this.say('Not sent: Pair\'s daemon is not back yet');
      return false;
    }
    return this.send(message) !== false;
  }

  /**
   * A line from the box. Returns what the panel does itself: {local: 'help'|'clear'|'copy'|'search'|'quit', ...}, or
   * {keep: text} when the line stays in the box (not sent), or {sent: true}.
   */
  submit(line) {
    const text = line.trim();
    if (!text) return {keep: line};
    if (this.confirming !== null) {
      this.answer(this.asking, {text: line.trim()});
      return {sent: true};
    }
    if (this.first !== null && text === 'e') {
      const step = this.first;
      this.first = null;
      return {keep: `/first ${step}`};
    }
    this.first = null;
    if (this.plan !== null && text === 'p') return {keep: `/plan ${this.plan}`};
    const parsed = parseInput(line);
    if (!parsed) return {keep: line};
    if (parsed.type === 'keep' && this.keepFrom !== null) parsed.gen = this.keepFrom;
    this.keepFrom = null;
    if (parsed.local === 'unknown') {
      this.add({kind: 'error', text: `There is no ${parsed.command}: / lists the commands. "${text}" is still in the box to fix.`});
      return {keep: line};
    }
    if (parsed.local === 'help') {
      this.add({kind: 'note', text: HELP});
      return {local: 'help'};
    }
    if (parsed.local === 'clear') {
      this.entries = [];
      return {local: 'clear'};
    }
    if (parsed.local === 'copy') {
      const answers = this.entries.filter(entry => ['pair', 'watch', 'gen'].includes(entry.kind) && !entry.partial);
      const entry = answers[answers.length - (parsed.number ?? 1)];
      if (!entry) this.say('Pair has said nothing to copy yet');
      return {local: 'copy', text: entry ? entryText(entry) : null};
    }
    if (parsed.local) return {local: parsed.local, ...(parsed.text !== undefined ? {text: parsed.text} : {})};
    if (this.connection !== 'up') {
      this.out(parsed);
      return {keep: line};
    }
    if (parsed.type === 'ask' || (parsed.type === 'drive' && parsed.text)) {
      const about = this.about;
      this.add({kind: 'you', text: parsed.text, pending: true, meta: about ? {about: about.id} : {}, aboutText: about?.text});
      if (about && parsed.type === 'ask') parsed.about = about.id;
      this.about = null;
    }
    if (parsed.type === 'feedback') this.rated(parsed);
    this.out(parsed.type === 'feedback' && parsed.number && this.listed[parsed.number - 1] ? {...parsed, remark: this.listed[parsed.number - 1]} : parsed);
    return {sent: true};
  }

  /** Marks the remark a verdict is about as rated, on screen. */
  rated({useful, remark, number}) {
    const id = remark ?? (number ? this.listed[number - 1] : null);
    const i = id ? this.entries.findLastIndex(entry => entry.meta?.remark === id) : this.entries.findLastIndex(entry => entry.meta?.trigger && entry.kind === 'watch');
    if (i !== -1) for (const entry of this.remarkGroup(this.entries[i].meta.remark)) entry.verdict = useful ? 'useful' : 'noise';
  }

  /** Useful or Noise on a remark. */
  rate(entry, useful) {
    const remark = entry.meta?.remark;
    if (!remark || !this.out({type: 'feedback', useful, remark})) return;
    this.rated({useful, remark});
  }

  /** Dismiss: the remark seen, neither useful nor noise; its card folds. */
  dismiss(entry) {
    const remark = entry.meta?.remark;
    if (!remark || !this.out({type: 'seen', remark})) return;
    for (const each of this.remarkGroup(remark)) each.dismissed = true;
  }

  /** Accept: the remark's suggestion goes into its buffer in Neovim, which says when it took it. */
  accept(entry) {
    const suggestion = entry.meta?.suggestion;
    if (suggestion && !entry.applied && !entry.gone) this.out({type: 'accept', action: suggestion.action});
  }

  /** Jump: Neovim goes to the line the remark is about. */
  jump(entry) {
    const place = entry.meta?.place;
    if (place && this.out({type: 'go', file: place.file, line: place.line})) this.say(`Neovim goes to ${place.file}:${place.line}; Ctrl-O comes back`);
  }

  /** No more remarks of this one's kind, this session. */
  mute(entry) {
    if (entry.meta?.trigger) this.out({type: 'mute', trigger: entry.meta.trigger});
  }

  /** Explain: the one idea worth keeping behind the remark. */
  explain(entry) {
    if (entry.meta?.remark) this.out({type: 'teach', remark: entry.meta.remark});
  }

  /** Follow up: the next question is about this remark. */
  followUp(entry) {
    if (entry.meta?.remark) this.about = {id: entry.meta.remark, text: (entry.text ?? '').split('\n')[0]};
  }

  /**
   * An answer to Pair's question `entry`: a button's `text` (y, n, a choice's letter or word), or words typed. Only y
   * or yes allows it; a choice's word answers with that choice.
   */
  answer(entry, {text}) {
    if (!entry || entry.answer !== undefined || entry.confirm !== this.confirming) return false;
    if (!this.out({type: 'confirm', id: entry.confirm, ok: allows(text), text})) return false;
    entry.answer = allows(text) ? true : text === 'n' ? false : text;
    this.confirming = null;
    return true;
  }

  /** Stop: the answer Pair works on, or a /gen request at work; while Pair asks, the question gets no. */
  stop() {
    if (this.asking) return this.answer(this.asking, {text: 'n'});
    if (this.busy || this.activity.state === 'remark' || this.genAtWork) return this.out({type: 'cancel'});
    return false;
  }

  /** The next talk level, as Alt-L in the terminal's pane. */
  cycleLevel() {
    this.out({type: 'level', level: LEVELS[(LEVELS.indexOf(this.header.level) + 1) % LEVELS.length]});
  }

  setRole(role) {
    if (role === 'driver') return this.out({type: 'drive', text: ''});
    return this.out({type: 'role', role});
  }

  /** A gen card's button: k keep, enter open, d drop what is left, u undo (see Gen.card). */
  cardAct(entry, key) {
    const {card} = entry;
    if (!card || !cardKeys(card).some(([one]) => one === key)) return null;
    const n = `gen #${card.gen}`;
    if (key === 'u') return this.out({type: 'undo', action: card.action});
    if (key === 'enter') {
      if (this.out({type: 'gen_open', action: card.action})) this.say(card.shape === 'file' || card.shape === 'scaffold' ? `${n}: :Pair gen list opens in Neovim` : `Neovim goes to ${n}'s code; Ctrl-O comes back`);
      return true;
    }
    if (key === 'd') return this.out({type: 'gen_drop_all', action: card.action});
    if (card.shape === 'here') return this.out({type: 'accept', action: card.action});
    if (card.shape === 'file') {
      if (this.out({type: 'gen_open', action: card.action, what: 'next'})) this.say(`${n}: the next file to review opens in Neovim; :w there takes it`);
      return true;
    }
    if (card.shape === 'try') return this.out({type: 'keep', path: '', gen: card.gen});
    this.keepFrom = card.gen; // a scaffold: /keep in the box, a file of it to pick
    return {keep: '/keep '};
  }

  /** A relayed line's button: its task's report or pull request, its branch's diff, a terminal in its worktree. */
  relayAct(entry, key) {
    if (!relayActions(entry).some(([one]) => one === key)) return;
    const {key: agent, title} = entry.meta.agent;
    const what = {o: 'open', d: 'diff', t: 'term'}[key];
    if (this.out({type: 'agent_link', key: agent, what})) this.say({o: `${title}: its report or pull request opens`, d: `${title}: its branch's diff opens in Neovim`, t: `${title}: a terminal in its worktree opens in Neovim`}[key]);
  }

  /** Alt-y's take: the newest suggestion or gen code still showing in Neovim goes into its buffer. */
  take() {
    this.out({type: 'take'});
  }

  /** What the box shows as its placeholder now. */
  placeholder() {
    if (this.connection === 'away') return 'What you type is kept; Enter sends once Pair is back';
    if (this.confirming !== null) return confirmChoices(this.asking ?? {}).free ? 'Or type your answer' : 'Or type an answer';
    if (!this.header.goal && this.goalAsked()) return 'The session\'s goal, or "later"';
    return this.busy ? 'Type ahead' : 'Ask Pair anything · / for commands';
  }
}

/** All the words of `entry`, as copy takes them. */
export function entryText(entry) {
  if (entry.kind === 'tool') return entry.tools.map(({tool, what}) => `${tool} ${what}`).join('\n');
  const diff = entry.meta?.suggestion ? `\n${entry.meta.suggestion.new.join('\n')}` : '';
  return `${entry.text ?? ''}${diff}`;
}

export {cardKeys, relayActions, remarkKeys};
