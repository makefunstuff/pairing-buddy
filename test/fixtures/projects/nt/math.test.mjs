import {test} from 'node:test';
import assert from 'node:assert/strict';

test('adds', () => {
  assert.equal(1 + 2, 3);
});

for (const [a, b, sum] of [[1, 1, 2], [2, 2, 5]]) {
  test(`sums ${a} and ${b}`, () => {
    assert.equal(a + b, sum);
  });
}
