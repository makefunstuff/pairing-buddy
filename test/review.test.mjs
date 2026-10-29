// A board task's branch as a guided review (board stage 2b): the reviewer's verdict and findings on top, ≠ brief on
// the branch, files ordered by the brief, a file or a hunk kept unsaved with origin board:<id>, and tell, merge or
// archive only on a pick. A session on a store in memory in a scratch git repository, with the fake shepherdr, a
// stand-in model and a stand-in editor whose buffers are a map.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {Board, MERGE_IT} from '../src/board.mjs';
import {editOrigin, fold, initialState, originName} from '../src/fold.mjs';
import {diffView, namedAt, orderFiles, reviewFacts, withHunks} from '../src/review.mjs';
import {PairSession} from '../src/session.mjs';
import {openStore} from '../src/store.mjs';
import {fakeShepherdr} from './fake-shepherdr.mjs';
import {scratch} from './temp.mjs';

const until = async check => { for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10)); };

const NOON = new Date(2026, 9, 29, 12, 0).getTime();
const FACTS = 'PR #104 · commit 1a2b3c4 · checks passed (npm test, GitHub) · review: 1 round, 2 minor left (retries without a cap in billing/webhook.js:3; docs miss the PDF setting) · not proven: real Stripe';
const NOTES = '# Shop\n\nMoney in integer cents, never floats.\nThe invoice lives in billing/invoice.js.\n';
const INVOICE = 'export function total(lines) {\n  let sum = 0\n  for (const line of lines) sum += line.cents\n  return sum\n}\n\nexport function label(cents) {\n  return `${cents}`\n}\n';
const INVOICE_80 = 'export function total(lines) {\n  let sum = 0.0\n  for (const line of lines) sum += line.amount\n  return sum\n}\n\nexport function label(cents) {\n  return `${(cents / 100).toFixed(2)} EUR`\n}\n';

/**
 * A repository on main with NOTES.md, billing/invoice.js, cmd/main.js and old.txt, and the branch work/80-billing that
 * changes the invoice in two places, adds billing/webhook.js, changes cmd/main.js and deletes old.txt; checked out on
 * main again, as the user's checkout is.
 */
function repo() {
  const root = realpathSync(scratch('pair-review-'));
  const git = (...args) => execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {stdio: 'pipe'});
  const write = (rel, text) => {
    mkdirSync(join(root, rel, '..'), {recursive: true});
    writeFileSync(join(root, rel), text);
  };
  git('init', '-q', '-b', 'main');
  write('NOTES.md', NOTES);
  write('billing/invoice.js', INVOICE);
  write('cmd/main.js', 'import {total} from "../billing/invoice.js"\nconsole.log(total([]))\n');
  write('old.txt', 'old\n');
  git('add', '.');
  git('commit', '-q', '-m', 'shop');
  git('checkout', '-q', '-b', 'work/80-billing');
  write('billing/invoice.js', INVOICE_80);
  write('billing/webhook.js', 'export function retry(send) {\n  for (;;) send()\n}\n');
  write('cmd/main.js', 'import {total} from "../billing/invoice.js"\nconsole.log(total([]), "billing")\n');
  git('rm', '-q', 'old.txt');
  git('add', '.');
  git('commit', '-q', '-m', 'billing');
  git('checkout', '-q', 'main');
  return {root, git};
}

const TASK = {
  id: 'SHO-80', title: 'Billing module', status: 'ready', place: 'p:here:shop', branch: 'work/80-billing',
  pr: {number: 104, url: 'https://github.com/o/shop/pull/104'}, said: 'Invoices and webhooks, with tests.', facts: FACTS,
  desc: 'Write billing/webhook.js and the invoice total.\n\nSettings block…',
};

/**
 * A session in `root` with the fake board, `askModel` for the brief's check, and an editor whose buffers are a map
 * (file -> text): it reads them, keeps hunks in them as the plugin does, and books every request it gets.
 */
function reviewSession(root, {board, askModel = null, buffers = new Map(), clock = {now: NOON}} = {}) {
  const store = openStore(':memory:');
  const sent = [];
  const editor = [];
  const linesOf = text => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));
  const pair = new PairSession({
    record: store.createSession({root, conversationId: 'main', goal: 'billing', level: 'normal', at: clock.now}),
    store,
    partner: {thinkingOf: () => 'off', createConversation: async () => 'c', setRole: async () => {}, ask: async () => 'SILENT', stop: async () => {}},
    score: async () => ({value: 9, reason: 'test'}),
    genDir: scratch('pair-review-data-'),
    genBoard: board,
    askModel,
    notify: (to, message) => { sent.push({via: to, ...message}); return 1; },
    requestEditor: async message => {
      editor.push(message);
      if (message.type === 'read') return buffers.has(message.file) ? {text: buffers.get(message.file)} : null;
      if (message.type === 'board_keep') {
        // As lua/pair/init.lua does: the hunks bottom up, each with the buffer before and after it.
        const lines = linesOf(buffers.get(message.file) ?? (() => { try { return readFileSync(message.file, 'utf8'); } catch { return ''; } })());
        const kept = [];
        for (const hunk of [...message.hunks].sort((a, b) => b.line - a.line)) {
          const before = [...lines];
          const added = linesOf(`${hunk.text}\n`);
          if (hunk.insert) lines.splice(hunk.line, 0, ...added);
          else lines.splice(hunk.line - 1, hunk.endLine - hunk.line + 1, ...added);
          const from = hunk.insert ? hunk.line + 1 : hunk.line;
          kept.unshift({before, after: [...lines], from, to: from + Math.max(added.length, 1) - 1});
        }
        buffers.set(message.file, `${lines.join('\n')}\n`);
        return {kept};
      }
      if (message.type === 'revert') return {ok: true};
      return null;
    },
    now: () => clock.now,
  });
  const of = type => sent.filter(message => message.type === type);
  const said = () => sent.filter(message => message.type === 'message').map(message => message.text);
  return {pair, store, sent, editor, buffers, of, said};
}

const shop = (root, tasks = [TASK]) => fakeShepherdr(scratch('pair-board-'), {spaces: [{name: 'shop', key: 'SHO', path: root}], tasks});

test('the facts line: the reviewer\'s part, the checks, and the rest but the PR and commit', () => {
  assert.deepEqual(reviewFacts(FACTS), {
    review: 'review: 1 round, 2 minor left (retries without a cap in billing/webhook.js:3; docs miss the PDF setting)',
    checks: 'checks passed (npm test, GitHub)',
    notes: ['not proven: real Stripe'],
  });
  assert.deepEqual(reviewFacts('checks failed: 2 tests · branch work/7-x · review: off'), {review: 'review: off', checks: 'checks failed: 2 tests', notes: []});
  assert.deepEqual(reviewFacts(null), {review: null, checks: null, notes: []});
});

test('files ordered by the brief: ≠ brief first, then named by the brief, then by the reviewer, then the bigger changes', () => {
  const rels = ['a/x.js', 'b/y.js', 'c/z.js', 'd/w.js', 'e/v.js'];
  const named = namedAt('Write `c/z.js` first, then x.js.', rels);
  assert.deepEqual([...named], [['a/x.js', 27], ['c/z.js', 7]], 'by its path, or by its name when only one file has it');
  assert.deepEqual([...namedAt('see main.js', ['a/main.js', 'b/main.js'])], [], 'a name two files have names neither');
  const files = rels.map((rel, i) => ({rel, added: i, removed: 0}));
  const order = orderFiles(files, {against: new Set(['e/v.js']), named, found: new Map([['b/y.js', 0]])});
  assert.deepEqual(order.map(file => file.rel), ['e/v.js', 'c/z.js', 'a/x.js', 'b/y.js', 'd/w.js']);
});

test('a file\'s diff as the review shows it: a hunk each, with its context, and where each hunk is', () => {
  const view = diffView(INVOICE, INVOICE_80);
  assert.deepEqual(view.hunks.map(hunk => hunk.k), [0, 1]);
  assert.equal(view.lines[0], '@@ -1,6 +1,6 @@');
  assert.deepEqual(view.lines.slice(view.hunks[0].first, view.hunks[0].last).filter(line => /^[-+]/.test(line)),
    ['-  let sum = 0', '-  for (const line of lines) sum += line.cents', '+  let sum = 0.0', '+  for (const line of lines) sum += line.amount']);
  assert.equal(view.lines[view.hunks[1].first - 1], '@@ -7,3 +7,3 @@', 'the second hunk\'s context does not repeat the first one\'s');
  assert.deepEqual(diffView('', 'a\nb\n').lines, ['@@ -1,0 +1,2 @@', '+a', '+b'], 'a new file');
  const a = ['1', '2', '3'];
  const hunks = [{from: 0, to: 1, lines: ['one']}, {from: 2, to: 3, lines: ['three']}];
  assert.deepEqual(withHunks(a, hunks, new Set([1])), ['1', '2', 'three']);
});

test('an origin of a board task\'s code: board:SHO-80, Pair\'s in words; Neovim\'s marks of it carry its id', () => {
  assert.equal(editOrigin('board:SHO-80'), 'board:SHO-80');
  assert.equal(editOrigin('board:'), 'user');
  assert.equal(originName('board:SHO-80'), 'Pair (board SHO-80)');
  const state = fold(initialState(), {kind: 'generated', file: '/p/a.js', marks: [{from: 1, to: 3, gen: 'SHO-80'}, {from: 5, to: 5, gen: 4}]});
  assert.deepEqual(state.generated['/p/a.js'].map(range => range.gen), ['SHO-80', 4]);
});

test('the board\'s words for a review: a tell, merge as a tell (Shepherdr has no approve), archive', () => {
  const board = new Board('shepherdr');
  assert.deepEqual(board.mergeWords('SHO-80'), ['shepherdr', 'task', 'tell', 'SHO-80', MERGE_IT]);
  assert.deepEqual(board.archiveWords('SHO-80'), ['shepherdr', 'task', 'archive', 'SHO-80']);
});

test(':Pair review opens the branch as a review: reviewer and findings on top, the files in the brief\'s order, nothing written', async () => {
  const {root} = repo();
  const board = shop(root);
  const {pair, of, said} = reviewSession(root, {board: board.command});
  assert.equal(await pair.gen.reviews.open('SHO-80'), '');
  const [opened] = of('gen_list_open');
  assert.ok(Number.isInteger(opened.action), 'the review list opens on it');
  assert.deepEqual(said().at(-1).split('\n'), [
    'review SHO-80 · Billing module · work/80-billing · 4 files · https://github.com/o/shop/pull/104',
    'its agent: Invoices and webhooks, with tests.',
    'reviewer: review: 1 round, 2 minor left (retries without a cap in billing/webhook.js:3; docs miss the PDF setting) · checks passed (npm test, GitHub)',
    '· not proven: real Stripe',
  ]);
  const {requests: [review]} = pair.gen.review();
  assert.equal(review.shape, 'review');
  assert.equal(review.task, 'SHO-80');
  assert.equal(review.pr, 'https://github.com/o/shop/pull/104');
  // Named by the task's brief and the note (invoice.js, webhook.js), then the rest, the bigger change first.
  assert.deepEqual(review.branch_files.map(file => `${file.status} ${file.name} +${file.added} -${file.removed}`), [
    'A billing/webhook.js +3 -0', 'M billing/invoice.js +3 -3', 'M cmd/main.js +1 -1', 'D old.txt +0 -1',
  ]);
  assert.equal(review.branch_files[0].found, true, 'the reviewer names it too');
  assert.deepEqual(board.calls(), [['task', 'show', 'SHO-80', '--json']], 'the board is read, and nothing else');
  assert.deepEqual(of('gen_card'), [], 'a review has no gen card: it has its list');
  // Opened again with no new commit on the branch: the same review, as you left it.
  await pair.gen.reviews.open('SHO-80');
  assert.equal(pair.gen.review().requests.length, 1);
  assert.match(said().at(-1), /as you left it/);
});

test('a review says why there is none: no board, no branch, a branch of another repository, an unknown task', async () => {
  const {root} = repo();
  const board = shop(root, [TASK, {...TASK, id: 'SHO-81', branch: null}, {...TASK, id: 'SHO-82', branch: 'work/82-elsewhere'}]);
  const {pair} = reviewSession(root, {board: board.command});
  assert.equal(await pair.gen.reviews.open('SHO-81'), 'SHO-81 has no branch yet: nothing to review.');
  assert.match(await pair.gen.reviews.open('SHO-82'), /^SHO-82's branch work\/82-elsewhere is not in this repository/);
  assert.match(await pair.gen.reviews.open('SHO-99'), /^No review of SHO-99: No task SHO-99\.$/);
  assert.match(await pair.gen.reviews.open(''), /^Say which task to review/);
  const none = reviewSession(root, {board: null});
  assert.match(await none.pair.gen.reviews.open('SHO-80'), /no board/);
});

test('≠ brief runs on the branch: what holds up is listed on top and its file goes first', async () => {
  const {root} = repo();
  const board = shop(root);
  const asked = [];
  const askModel = async (prompt, input) => {
    asked.push(input);
    const piece = input.split('\n').find(line => /^Piece \d+, for billing\/invoice\.js/.test(line)).match(/^Piece (\d+)/)[1];
    return JSON.stringify([{kind: 'contradicts', source: 'note', line: 3, quote: 'Money in integer cents, never floats.', piece: Number(piece), piece_line: 2, text: 'sums in a float'}]);
  };
  const {pair, said, of} = reviewSession(root, {board: board.command, askModel});
  await pair.gen.reviews.open('SHO-80');
  const [action] = [...pair.gen.reviews.pending.keys()];
  await pair.gen.reviews.pending.get(action);
  assert.match(asked[0], /Board task SHO-80: Billing module/);
  assert.match(asked[0], /The request: "Billing module \(board task SHO-80, its whole branch\)"/);
  const {requests: [review]} = pair.gen.review();
  assert.deepEqual(review.contradicts, ['≠ brief "Money in integer cents, never floats." NOTES.md:3 · billing/invoice.js:2 sums in a float']);
  assert.equal(review.branch_files[0].name, 'billing/invoice.js', 'the file against the brief first');
  assert.equal(review.branch_files[0].against, 1);
  assert.match(said().at(-1), /^review SHO-80 · against the brief:\n≠ brief/);
  assert.ok(of('gen_kept').length, 'the list is told to show it');
});

test('k keeps a file, or one hunk of it, unsaved in yours as code not yours yet, origin board:SHO-80; then archive is offered', async () => {
  const {root} = repo();
  const board = shop(root);
  const {pair, editor, buffers, of, said} = reviewSession(root, {board: board.command});
  await pair.gen.reviews.open('SHO-80');
  const {requests: [review]} = pair.gen.review();
  const invoice = review.branch_files.find(file => file.name === 'billing/invoice.js');
  const file = join(root, 'billing/invoice.js');
  // Enter: the diff, read only, with its hunks.
  const diff = await pair.gen.reviews.diff(review.action, invoice.piece);
  assert.equal(diff.title, 'SHO-80 · billing/invoice.js · changed on work/80-billing');
  assert.deepEqual(diff.hunks.map(hunk => [hunk.k, hunk.kept]), [[0, false], [1, false]]);
  // k in the diff on its second hunk: only that one, into the buffer as it is now (you typed a line above).
  buffers.set(file, `// mine\n${INVOICE}`);
  const one = await pair.gen.reviews.keep(review.action, invoice.piece, 1);
  assert.match(one, /^SHO-80: billing\/invoice\.js: 1 change, 1 line, kept unsaved in yours, marked ┊ as not yours yet\. \/undo takes them back\. 1 change of it not kept\. You kept pieces of SHO-80: merging its whole branch now would bring them in twice\. A in the list offers archive SHO-80, to run or copy\.$/);
  assert.equal(buffers.get(file), `// mine\n${INVOICE.replace('return `${cents}`', 'return `${(cents / 100).toFixed(2)} EUR`')}`);
  const keep = editor.filter(message => message.type === 'board_keep');
  assert.equal(keep[0].origin, 'board:SHO-80');
  assert.deepEqual(of('gen_marks').at(-1).marks.map(mark => [mark.gen, mark.line, mark.text]), [['SHO-80', 9, ['  return `${(cents / 100).toFixed(2)} EUR`']]]);
  assert.equal(readFileSync(file, 'utf8'), INVOICE, 'nothing is written to disk');
  // k on the file in the list: the rest of it; the hunk kept already is not kept twice, and the warning is said once.
  const rest = await pair.gen.reviews.keep(review.action, invoice.piece);
  assert.match(rest, /^SHO-80: billing\/invoice\.js: 1 change, 2 lines, kept unsaved in yours/);
  assert.doesNotMatch(rest, /twice/);
  assert.equal(buffers.get(file), `// mine\n${INVOICE_80}`);
  assert.match(await pair.gen.reviews.keep(review.action, invoice.piece), /is kept already/);
  assert.deepEqual((await pair.gen.reviews.diff(review.action, invoice.piece)).hunks.map(hunk => hunk.kept), [true, true]);
  // A new file: a buffer of its own at its path, unsaved; a deleted one is not deleted.
  const webhook = review.branch_files.find(each => each.name === 'billing/webhook.js');
  assert.match(await pair.gen.reviews.keep(review.action, webhook.piece), /billing\/webhook\.js: 1 change, 3 lines, kept unsaved/);
  assert.equal(buffers.get(join(root, 'billing/webhook.js')), 'export function retry(send) {\n  for (;;) send()\n}\n');
  const old = review.branch_files.find(each => each.name === 'old.txt');
  assert.match(await pair.gen.reviews.keep(review.action, old.piece), /deletes old\.txt; Pair deletes no file of yours/);
  const listed = pair.gen.review().requests[0];
  assert.equal(listed.kept, true);
  assert.deepEqual(listed.branch_files.map(each => `${each.name} ${each.kept}/${each.hunks}`), ['billing/webhook.js 1/1', 'billing/invoice.js 2/2', 'cmd/main.js 0/1', 'old.txt 0/1']);
  assert.ok(pair.gen.notYours().files.some(each => each.from.includes('SHO-80')), 'Pair\'s own marks list says where it came from');
  // /undo takes the review's kept code back as one, in its own origin.
  const entry = pair.store.action(review.action);
  await pair.undo(entry.id);
  const reverts = editor.filter(message => message.type === 'revert');
  assert.equal(reverts.length, 3);
  assert.ok(reverts.every(message => message.origin === 'board:SHO-80'));
  assert.match(said().at(-1), /^Undid SHO-80: took back 3 pieces/);
  assert.equal(pair.gen.review().requests[0].kept, false);
  assert.ok(pair.gen.review().requests[0].branch_files.every(each => each.kept === 0), 'its files are to keep again');
  assert.ok(board.calls().every(([verb, sub]) => `${verb} ${sub}` === 'task show'), 'keeping writes nothing to the board');
});

test('t, a and A: a tell, merge as a tell to its agent, and archive, each copied, or run only on the pick; never shepherdr merge', async () => {
  const {root} = repo();
  const board = shop(root);
  const {pair, store} = reviewSession(root, {board: board.command});
  await pair.gen.reviews.open('SHO-80');
  const reviews = pair.gen.reviews;
  assert.deepEqual(await reviews.boardDo({task: 'SHO-80', verb: 'merge'}), {line: `${board.command} task tell SHO-80 'merge it'`});
  assert.deepEqual(await reviews.boardDo({task: 'SHO-80', verb: 'tell', text: 'cap the retries in billing/webhook.js:3'}), {line: `${board.command} task tell SHO-80 'cap the retries in billing/webhook.js:3'`});
  assert.equal(board.calls().length, 1, 'copying runs nothing');
  assert.deepEqual(await reviews.boardDo({task: 'SHO-80', verb: 'tell', text: '  ', run: true}), {error: 'there is nothing to tell'});
  assert.deepEqual(await reviews.boardDo({task: 'SHO-80', verb: 'tell', text: 'cap the retries', run: true}), {said: 'Told SHO-80.'});
  assert.deepEqual(await reviews.boardDo({task: 'SHO-80', verb: 'merge', run: true}), {said: 'Told SHO-80.'});
  assert.deepEqual(await reviews.boardDo({task: 'SHO-80', verb: 'archive', run: true}), {said: 'Archived SHO-80.'});
  assert.deepEqual(await reviews.boardDo({task: 'SHO-80', verb: 'stop', run: true}), {error: 'no such board command'});
  assert.deepEqual(board.calls().slice(1), [['task', 'tell', 'SHO-80', 'cap the retries'], ['task', 'tell', 'SHO-80', 'merge it'], ['task', 'archive', 'SHO-80']]);
  assert.ok(!board.calls().some(([verb]) => verb === 'merge'), 'Pair never runs shepherdr merge');
  assert.deepEqual(store.actions(root, 0).filter(row => row.kind === 'board').map(row => row.text), ['told SHO-80: cap the retries', 'told SHO-80 to merge it', 'archived SHO-80']);
  assert.equal(pair.gen.review().requests[0].archived, true);
});

test('two keeps at once, and a keep while the ≠ check books: each change lands once, and nothing booked is lost', async () => {
  const {root} = repo();
  const board = shop(root);
  let answer;
  const askModel = () => new Promise(resolve => { answer = resolve; });
  const {pair, buffers} = reviewSession(root, {board: board.command, askModel});
  await pair.gen.reviews.open('SHO-80');
  const {requests: [review]} = pair.gen.review();
  const invoice = review.branch_files.find(file => file.name === 'billing/invoice.js');
  const file = join(root, 'billing/invoice.js');
  // k twice quickly, and K with k on its second hunk: one keep after the other.
  await Promise.all([pair.gen.reviews.keep(review.action, invoice.piece), pair.gen.reviews.keep(review.action, invoice.piece), pair.gen.reviews.keep(review.action, invoice.piece, 1)]);
  assert.equal(buffers.get(file), INVOICE_80, 'each change once');
  const hunks = pair.store.action(review.action).detail.pieces.filter(piece => piece.kind === 'hunk');
  assert.deepEqual(hunks.map(piece => piece.hunk), [0, 1], 'both booked, each once');
  // The check books after the keeps, from the entry as they left it.
  const [action] = [...pair.gen.reviews.pending.keys()];
  await until(() => answer);
  answer(JSON.stringify([{kind: 'contradicts', source: 'note', line: 3, quote: 'Money in integer cents, never floats.', piece: 1, piece_line: 1, text: 'floats'}]));
  await pair.gen.reviews.pending.get(action);
  const after = pair.gen.review().requests[0];
  assert.equal(after.contradicts.length, 1, 'the check is booked');
  assert.equal(after.branch_files.find(each => each.name === 'billing/invoice.js').kept, 2, 'and the keeps stay');
});

test('/undo takes back the newest keep of a review opened days ago, after another change of Pair\'s', async () => {
  const {root} = repo();
  const board = shop(root);
  // Opened three days ago, and again today with no new commit: the same review. Pair changed something else since.
  const clock = {now: NOON - 3 * 24 * 60 * 60_000};
  const {pair, editor, of, said} = reviewSession(root, {board: board.command, clock});
  await pair.gen.reviews.open('SHO-80');
  clock.now = NOON - 60_000;
  pair.ledger.add('typed', 'other edit', {data: {undo: true}, detail: {patch: {file: join(root, 'cmd/main.js'), before: ['a'], after: ['b']}}});
  clock.now = NOON;
  await pair.gen.reviews.open('SHO-80');
  const {requests: [review]} = pair.gen.review();
  const main = pair.gen.review().requests[0].branch_files.find(file => file.name === 'cmd/main.js');
  await pair.gen.reviews.keep(review.action, main.piece);
  const kept = of('gen_kept').length;
  await pair.undoLast();
  assert.match(said().at(-1), /^Undid SHO-80: took back 1 piece/);
  assert.equal(editor.filter(message => message.type === 'revert').at(-1).origin, 'board:SHO-80');
  assert.ok(of('gen_kept').length > kept, 'the list and its diff are told, to show it is to keep again');
});
