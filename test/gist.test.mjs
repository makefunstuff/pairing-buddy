import assert from 'node:assert/strict';
import {test} from 'node:test';
import {gist} from '../src/gist.mjs';

test('the gist is the leading comment and the names the file defines', () => {
  assert.equal(
    gist("// Ranks overdue invoices for the dunning run.\n// Oldest first.\nimport {db} from './db';\n\nexport async function rankOverdue(list) {}\nconst LIMIT = 5;\n"),
    'Ranks overdue invoices for the dunning run. Oldest first. It defines rankOverdue, LIMIT.',
  );
  assert.equal(gist('"""Search ranking: BM25 over the title and body."""\nimport math\n\ndef score(doc):\n    pass\n\nclass Ranker:\n'),
    'Search ranking: BM25 over the title and body. It defines score, Ranker.');
  assert.equal(gist('package billing\n\nimport "fmt"\n\n// Invoice is one bill.\ntype Invoice struct {}\n\nfunc (i *Invoice) Total() int {}\n'),
    'Invoice is one bill. It defines Invoice, Total.', 'a comment after the preamble counts too');
  assert.equal(gist('#!/usr/bin/env python3\n# Retries the webhook with backoff.\nimport time\n'), 'Retries the webhook with backoff.');
  assert.equal(gist('/**\n * Reconnects the socket after the phone sleeps.\n */\npub fn reconnect() {}\n'),
    'Reconnects the socket after the phone sleeps. It defines reconnect.');
});

test('a licence says nothing of the file; a file without comment or names has no gist', () => {
  assert.equal(gist('// Copyright 2024 Someone. MIT License.\n\n// Totals for the cart.\nexport const total = 1;\n'), 'Totals for the cart. It defines total.');
  assert.equal(gist('/* SPDX-License-Identifier: MIT */\nint x;\n'), '');
  assert.equal(gist(''), '');
  assert.equal(gist('{"name": "x"}\n'), '');
  assert.ok(gist(`// ${'word '.repeat(100)}`).length <= 240, 'kept short: the Watcher reads it on every drift');
});
