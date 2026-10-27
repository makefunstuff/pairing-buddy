import {describe, test} from 'node:test';
import assert from 'node:assert/strict';

describe('group', () => {
  test('breaks', () => {
    assert.equal(1, 2);
  });
  test('holds', () => {
    assert.equal(1, 1);
  });
});
