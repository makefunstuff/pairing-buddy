// Which tests a save can affect: the command on save narrowed to them, where the runner can be told.
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {affectedCommand} from '../src/affected.mjs';

function project(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'pair-affected-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), {recursive: true});
    writeFileSync(join(root, path), text);
  }
  return root;
}

test('go: the saved file\'s package and every package that imports it, directly or through another', async t => {
  const root = project(t, {
    'go.mod': 'module example.com/shop\n\ngo 1.22\n',
    'main.go': 'package main\n\nimport "example.com/shop/checkout"\n',
    'cart/cart.go': 'package cart\n',
    'checkout/checkout.go': 'package checkout\n\nimport (\n\t"fmt"\n\tc "example.com/shop/cart"\n)\n',
    'tax/tax.go': 'package tax\n',
    'tax/tax_test.go': 'package tax_test\n\nimport "example.com/shop/tax"\n',
    'vendor/x/x.go': 'package x\n\nimport "example.com/shop/cart"\n',
  });
  const narrowed = files => affectedCommand({command: 'go test -json ./...', root, files});
  assert.equal(await narrowed(['cart/cart.go']), 'go test -json . ./cart ./checkout');
  assert.equal(await narrowed(['tax/tax.go']), 'go test -json ./tax');
  assert.equal(await narrowed(['tax/tax_test.go', 'cart/cart.go']), 'go test -json . ./cart ./checkout ./tax');
  assert.equal(await narrowed(['web/app.ts']), null, 'not Go: the whole run');
  assert.equal(await narrowed(['gone/gone.go']), null, 'a package Pair does not find: the whole run');
  assert.equal(await affectedCommand({command: 'go test -json ./cart', root, files: ['cart/cart.go']}), null, 'a command that names its packages runs as it is');
});

test('jest, vitest and pytest are told the saved files', async () => {
  const narrowed = (command, files) => affectedCommand({command, root: '/p', files});
  assert.equal(await narrowed('npx jest --json', ['src/a.js']), "npx jest --json --passWithNoTests --findRelatedTests 'src/a.js'");
  assert.equal(await narrowed('npx vitest run --reporter=json', ['src/a.ts', 'src/b.ts']), "npx vitest related --run --passWithNoTests --reporter=json 'src/a.ts' 'src/b.ts'");
  assert.equal(await narrowed('pytest -q -k fast', ['tests/test_a.py']), "pytest -q -k fast 'tests/test_a.py'");
  assert.equal(await narrowed('pytest -q', ['calc.py']), null, 'a source file: pytest cannot say which tests use it');
  assert.equal(await narrowed('pytest tests/unit', ['tests/unit/test_a.py']), null, 'a command that names its tests runs as it is');
  assert.equal(await narrowed('cargo test', ['src/lib.rs']), null);
  assert.equal(await narrowed('npm test', ['src/a.js']), null, 'what npm test runs is unknown');
  assert.equal(await narrowed('npx jest --json && echo done', ['src/a.js']), null, 'a list of commands runs as it is');
});
