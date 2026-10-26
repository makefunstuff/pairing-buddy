import assert from 'node:assert/strict';
import {test} from 'node:test';
import {commandPolicy, tokenize} from '../src/command-policy.mjs';

const verdictOf = command => commandPolicy(command).verdict;

function expectAll(verdict, commands) {
  for (const command of commands) assert.equal(verdictOf(command), verdict, `${command}: ${commandPolicy(command).reason}`);
}

test('read-only commands run', () => {
  expectAll('allow', [
    'ls -la src', 'cat package.json', 'rg -n "timeout" src', 'grep -rn RECONNECT .', 'find . -name "*.ts"', 'wc -l src/*.mjs',
    'head -20 README.md | tail -5', 'git status', 'git log --oneline -10', 'git diff HEAD~1 -- src', 'git show HEAD:src/ws.ts',
    'git blame -L 1,20 src/ws.ts', 'git branch -a', 'git --no-pager log -3', 'git stash list', 'git rev-parse --abbrev-ref HEAD',
  ]);
});

test('tests and builds run', () => {
  expectAll('allow', [
    'npm test', 'npm run test:unit', 'npm run build', 'pnpm test', 'yarn lint', 'npx vitest run src/ws.test.ts', 'npx jest -t reconnect',
    'cargo test', 'cargo test reconnect -- --nocapture', 'cargo build --release', 'cargo clippy', 'cargo fmt --check',
    'go test ./...', 'go vet ./...', 'pytest -x tests/test_ws.py', 'python -m pytest -k reconnect', 'node --test test/',
    'make test', 'make -j4 test', 'CI=1 npm test', 'npm test 2>&1 | tail -40', 'cargo test > /dev/null',
  ]);
});

test('commands that write, delete or install ask first', () => {
  expectAll('ask', [
    'rm -rf build', 'mv a.js b.js', 'cp a b', 'mkdir tmp', 'touch x', 'chmod +x run.sh', 'npm install', 'npm i left-pad', 'npm ci',
    'pip install requests', 'cargo add serde', 'cargo install ripgrep', 'go get example.com/x', 'cargo fmt', 'eslint --fix .',
    'find . -name "*.log" -delete', 'find . -exec rm {} ;', 'git checkout main', 'git stash', 'git add -A', 'git clean -fd',
    'git branch new-feature', 'npm test > out.txt', 'echo hi >> notes.md', 'sort -o sorted.txt list.txt', 'sed -i s/a/b/ x',
  ]);
});

test('read-only programs ask when a flag or operand makes them write or run a program', () => {
  expectAll('ask', [
    'fd . -x rm {}', 'fd precious -x rm', 'fd -e js --exec-batch rm', 'fd . -X rm', 'fd -HX rm', 'fd . --exec=rm',
    'sort -onew.txt package.json', 'sort -ro out.txt list.txt', 'sort --out=x list.txt', 'sort --compress-program=sh list.txt',
    'tree -ofile.txt', 'uniq in.txt out.txt', 'uniq -c in.txt out.txt', 'uniq - out.txt', 'xxd in.bin out.hex', 'xxd -l 64 in.bin out.hex',
    'file -C -m magic', 'go env -w GOFLAGS=-mod=mod', 'go env -u GOFLAGS', 'go test -exec rm ./...', 'go test --exec=rm ./...',
    'go vet -vettool=./x ./...',
  ]);
  expectAll('allow', ['fd -e js', 'fd reconnect src', 'sort -k2 -n list.txt', 'uniq -c in.txt', 'uniq -f 2 in.txt', 'xxd -l 64 in.bin', 'tree -L 2', 'go env GOPATH']);
});

test('tests and builds ask when they would rewrite snapshots, open a program or run an unknown target', () => {
  expectAll('ask', [
    'jest -u', 'vitest -u', 'npx vitest -u', 'npx jest --updateSnapshot', 'npm exec jest -- -u', 'npm test -- -u', 'yarn test -u',
    'npm run test -- --update', 'npx eslint --fix .', 'make', 'make -j4', 'cargo doc --open',
  ]);
  expectAll('allow', ['npx vitest run', 'npm test -- --reporter=dot', 'cargo doc']);
});

test('git history, the network and root are refused', () => {
  expectAll('refuse', [
    'git commit -m wip', 'git push', 'git push --force origin main', 'git reset --hard HEAD~1', 'git rebase main', 'git merge dev',
    'git cherry-pick abc123', 'git revert HEAD', 'git pull', 'git fetch', 'npm test && git commit -am done', 'git -C . commit',
    'git -c user.name=x commit -m hi', 'git --git-dir=.git push', 'git --git-dir .git push', 'git --no-pager -c x=y reset --hard',
    'curl https://example.com', 'wget http://x', 'ssh host', 'sudo npm test', 'npm publish', 'cargo publish', 'less README.md', 'vim a.js',
  ]);
});

test('unknown programs, paths outside the project and opaque shell features ask', () => {
  expectAll('ask', [
    'deploy', './scripts/release.sh', 'bash -c "rm -rf x"', 'python manage.py migrate', 'node scripts/seed.js',
    'cat /etc/passwd', 'cat ~/.ssh/id_rsa', 'rg password ../other-project', 'ls -la /', 'grep -r key --include=x /home',
    'cat $HOME/.netrc', 'echo $(whoami)', 'ls `pwd`', 'npm test &', '(cd src && ls)', 'cat < /etc/hosts', 'npm run deploy',
    'make install', 'git -c core.pager=sh log',
  ]);
});

test('one command line at a time', () => {
  assert.deepEqual(commandPolicy('ls\nrm -rf x'), {verdict: 'refuse', reason: 'one command line at a time'});
  assert.equal(verdictOf('  '), 'refuse');
});

test('the most careful verdict of a chain wins, and its reason says why', () => {
  assert.deepEqual(commandPolicy('npm test && rm -rf coverage'), {verdict: 'ask', reason: 'rm writes or deletes files'});
  assert.deepEqual(commandPolicy('rm -rf x; git push'), {verdict: 'refuse', reason: 'git push changes git history; that is yours to do'});
  assert.equal(verdictOf('git log | head -5 && cargo test'), 'allow');
});

test('quotes hide operators and dollars from the policy', () => {
  assert.deepEqual(tokenize(`rg 'a|b; rm -rf /' src`).tokens, [{word: 'rg'}, {word: 'a|b; rm -rf /'}, {word: 'src'}]);
  assert.equal(verdictOf(`rg 'price: $5' src`), 'allow');
  assert.equal(verdictOf('rg "price: $5" src'), 'ask', 'double quotes still expand variables');
  assert.deepEqual(tokenize('npm test 2>&1').tokens, [{word: 'npm'}, {word: 'test'}, {op: '>&'}, {word: '1'}]);
});
