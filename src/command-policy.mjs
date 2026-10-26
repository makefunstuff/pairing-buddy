// Which commands Scout may run in its pane: `allow` (read-only, tests and builds), `ask` (the user decides
// in the chat) or `refuse`. Anything not known to be safe asks; git history, network and root are refused.
// Pure: it looks only at the command line, never at the disk.

const VERDICTS = ['allow', 'ask', 'refuse'];

const READ_ONLY = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'rg', 'grep', 'egrep', 'fgrep', 'fd', 'find', 'tree', 'pwd', 'echo', 'printf',
  'which', 'type', 'file', 'stat', 'du', 'df', 'diff', 'cmp', 'sort', 'uniq', 'cut', 'tr', 'basename', 'dirname',
  'realpath', 'readlink', 'date', 'jq', 'xxd', 'od', 'hexdump', 'ps', 'true', 'false',
]);

// Flags that make an otherwise read-only program write files or run other programs.
const UNSAFE_FLAGS = {
  find: ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls'],
  sort: ['-o', '--output'],
  tree: ['-o'],
  rg: ['--pre'],
  eslint: ['--fix'],
};

const WRITES = new Set(['rm', 'rmdir', 'mv', 'cp', 'mkdir', 'touch', 'chmod', 'chown', 'ln', 'dd', 'truncate', 'tee', 'shred', 'install', 'patch']);
const NETWORK = new Set(['curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat', 'telnet', 'ftp']);
const ROOT = new Set(['sudo', 'su', 'doas']);
const INTERACTIVE = new Set(['less', 'more', 'vi', 'vim', 'nvim', 'nano', 'emacs', 'top', 'htop', 'man', 'watch']);

const RUNNERS = new Set(['vitest', 'jest', 'mocha', 'tsc', 'eslint', 'pytest', 'py.test']);
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const SCRIPT = /^(test|build|lint|check|typecheck)(:[\w:.-]+)?$/;
const INSTALLS = new Set(['install', 'i', 'ci', 'add', 'update', 'upgrade', 'uninstall', 'remove', 'rm', 'link']);

const GIT_READ = new Set(['status', 'log', 'diff', 'show', 'blame', 'grep', 'ls-files', 'ls-tree', 'rev-parse', 'rev-list', 'describe', 'shortlog', 'cat-file']);
const GIT_HISTORY = new Set(['commit', 'push', 'reset', 'rebase', 'merge', 'cherry-pick', 'revert', 'am', 'pull', 'filter-branch', 'update-ref']);
const GIT_NETWORK = new Set(['fetch', 'clone']);
// Subcommands that only read when they get no arguments or one of these first.
const GIT_LISTING = {branch: ['-a', '-r', '-v', '-vv', '--list', '--show-current'], stash: ['list', 'show'], remote: ['-v'], tag: ['-l', '--list'], config: ['--get', '--list', '-l'], reflog: ['show']};

const CARGO = new Set(['test', 'build', 'check', 'clippy', 'nextest', 'bench', 'doc', 'tree', 'metadata']);
const GO = new Set(['test', 'build', 'vet', 'list', 'version', 'env']);
const MAKE_TARGETS = new Set(['test', 'check', 'build', 'lint', 'all']);

const allow = () => ({verdict: 'allow', reason: ''});
const ask = reason => ({verdict: 'ask', reason});
const refuse = reason => ({verdict: 'refuse', reason});
const worst = (a, b) => (VERDICTS.indexOf(b.verdict) > VERDICTS.indexOf(a.verdict) ? b : a);

/**
 * Splits a command line into words and operators the way a shell would, quotes included. Marks what it
 * cannot see through: command substitution, variables and newlines.
 */
export function tokenize(line) {
  const tokens = [];
  const flags = {substitution: false, variable: false, newline: false};
  let word = null;
  const push = () => { if (word !== null) tokens.push({word}); word = null; };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      word = (word ?? '') + line.slice(i + 1, end === -1 ? line.length : end);
      i = end === -1 ? line.length : end;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < line.length && line[j] !== '"'; j++) {
        if (line[j] === '\\' && j + 1 < line.length) j++;
        if (line[j] === '$') flags[line[j + 1] === '(' ? 'substitution' : 'variable'] = true;
        if (line[j] === '`') flags.substitution = true;
      }
      word = (word ?? '') + line.slice(i + 1, j).replace(/\\(.)/g, '$1');
      i = j;
    } else if (c === '\\') {
      word = (word ?? '') + (line[++i] ?? '');
    } else if (c === '\n') {
      flags.newline = true;
      push();
    } else if (/\s/.test(c)) {
      push();
    } else if (c === '`' || (c === '$' && line[i + 1] === '(')) {
      flags.substitution = true;
      word = (word ?? '') + c;
    } else if (c === '$') {
      flags.variable = true;
      word = (word ?? '') + c;
    } else if ('|&;<>()'.includes(c)) {
      // A file descriptor right before a redirection (2>) belongs to the operator.
      if ((c === '>' || c === '<') && word !== null && /^\d$/.test(word)) word = null;
      push();
      const two = line.slice(i, i + 2);
      const op = ['&&', '||', '>>', '&>', '>&'].includes(two) ? two : c;
      i += op.length - 1;
      tokens.push({op});
    } else {
      word = (word ?? '') + c;
    }
  }
  push();
  return {tokens, ...flags};
}

const PATHLIKE_OUTSIDE = /^(\/|~)|(^|\/)\.\.(\/|$)/;

/** Whether a word names a path outside the project: absolute, from home, or climbing out with `..`. */
function outside(word) {
  const value = word.startsWith('-') && word.includes('=') ? word.slice(word.indexOf('=') + 1) : word;
  return value !== '/dev/null' && PATHLIKE_OUTSIDE.test(value);
}

function git(args) {
  let i = 0;
  while (args[i]?.startsWith('-')) {
    if (args[i] === '--no-pager') { i++; continue; }
    if (args[i] === '-C') { i += 2; continue; }
    return ask(`git ${args[i]} changes how git runs`);
  }
  const [sub, ...rest] = args.slice(i);
  if (!sub) return allow();
  if (GIT_HISTORY.has(sub)) return refuse(`git ${sub} changes git history; that is yours to do`);
  if (GIT_NETWORK.has(sub)) return refuse(`git ${sub} goes over the network`);
  if (rest.some(arg => arg.startsWith('--output') || arg === '-O' || arg.startsWith('--open-files-in-pager'))) return ask(`git ${sub} with that option writes a file or opens a program`);
  if (GIT_READ.has(sub)) return allow();
  // A bare `git stash` stashes your changes; the other listing subcommands only list without arguments.
  const bare = !rest.length && sub !== 'stash';
  if (GIT_LISTING[sub] && (bare || GIT_LISTING[sub].includes(rest[0]))) return allow();
  return ask(`git ${sub} can change your working tree or repository`);
}

function packageManager(name, args) {
  const [sub, script] = args;
  if (['test', 't'].includes(sub)) return allow();
  if (sub === 'run' && SCRIPT.test(script ?? '')) return allow();
  if (name === 'yarn' && SCRIPT.test(sub ?? '')) return allow();
  if (['exec', 'x'].includes(sub) && RUNNERS.has(script)) return allow();
  if (sub === 'publish') return refuse(`${name} publish publishes a package`);
  if (INSTALLS.has(sub)) return ask(`${name} ${sub} installs or removes packages`);
  return ask(`${name} ${sub ?? ''} is not a test or build script`.trim());
}

function cargo(args) {
  const [sub] = args;
  if (sub === 'fmt') return args.includes('--check') ? allow() : ask('cargo fmt rewrites files');
  if (sub === 'clippy' && args.includes('--fix')) return ask('cargo clippy --fix rewrites files');
  if (CARGO.has(sub)) return allow();
  if (sub === 'publish') return refuse('cargo publish publishes a crate');
  return ask(`cargo ${sub ?? ''} is not a test or build command`.trim());
}

function python(args) {
  if (args[0] === '-m' && ['pytest', 'unittest'].includes(args[1])) return allow();
  return ask('python runs a program that may change files');
}

/** The verdict for one simple command: its words, with leading VAR=value assignments already removed. */
function program(words) {
  const [first, ...args] = words;
  if (first.includes('/')) return ask(`${first} is a program from a path`);
  if (ROOT.has(first)) return refuse(`${first} runs as root`);
  if (NETWORK.has(first)) return refuse(`${first} goes over the network`);
  if (INTERACTIVE.has(first)) return refuse(`${first} waits for keys; Pair cannot use it in its pane`);
  if (WRITES.has(first)) return ask(`${first} writes or deletes files`);
  const unsafe = (UNSAFE_FLAGS[first] ?? []).find(flag => args.some(arg => arg === flag || arg.startsWith(`${flag}=`)));
  if (unsafe) return ask(`${first} ${unsafe} writes files or runs a program`);
  if (READ_ONLY.has(first) || RUNNERS.has(first)) return allow();
  if (first === 'git') return git(args);
  if (PACKAGE_MANAGERS.has(first)) return packageManager(first, args);
  if (first === 'npx' || first === 'bunx') return RUNNERS.has(args[0]) ? allow() : ask(`${first} ${args[0] ?? ''} may download and run a package`.trim());
  if (first === 'cargo') return cargo(args);
  if (first === 'go') return GO.has(args[0]) ? allow() : ask(`go ${args[0] ?? ''} is not a test or build command`.trim());
  if (first === 'python' || first === 'python3') return python(args);
  if (first === 'node') return args[0] === '--test' || ['-v', '--version'].includes(args[0]) ? allow() : ask('node runs a script that may change files');
  if (first === 'make') return args.every(arg => arg.startsWith('-') || MAKE_TARGETS.has(arg)) ? allow() : ask(`make ${args.join(' ')} runs a target that is not a test or build`);
  return ask(`${first} is not on the list of read-only, test and build commands`);
}

function segment(words) {
  const start = words.findIndex(word => !/^[A-Za-z_]\w*=/.test(word));
  if (start === -1) return ask('it only sets variables');
  const verdict = program(words.slice(start));
  if (verdict.verdict === 'allow' && words.some(outside)) return ask('it reaches outside the project');
  return verdict;
}

/** `{verdict, reason}` for a command line Scout wants to run; `reason` says why it is not simply allowed. */
export function commandPolicy(line) {
  const {tokens, substitution, variable, newline} = tokenize(line);
  if (newline) return refuse('one command line at a time');
  if (!tokens.length) return refuse('the command is empty');
  let verdict = substitution ? ask('it runs a command substitution') : variable ? ask('it expands variables') : allow();
  let words = [];
  const end = () => {
    if (words.length) verdict = worst(verdict, segment(words));
    words = [];
  };
  for (let i = 0; i < tokens.length; i++) {
    const {word, op} = tokens[i];
    if (word !== undefined) { words.push(word); continue; }
    if (['&&', '||', ';', '|'].includes(op)) { end(); continue; }
    // 2>&1 and >&2 copy a descriptor and write nothing.
    if (op === '>&' && /^\d$/.test(tokens[i + 1]?.word ?? '')) { i++; continue; }
    if (['>', '>>', '&>', '>&'].includes(op)) {
      const target = tokens[++i]?.word;
      if (target !== '/dev/null') verdict = worst(verdict, ask(`it writes to ${target ?? 'a file'}`));
      continue;
    }
    if (op === '<') {
      const source = tokens[++i]?.word ?? '';
      if (outside(source)) verdict = worst(verdict, ask('it reaches outside the project'));
      continue;
    }
    if (op === '&') verdict = worst(verdict, ask('it runs something in the background'));
    else verdict = worst(verdict, ask('it opens a subshell'));
  }
  end();
  return verdict;
}
