import {test} from 'node:test';
import assert from 'node:assert/strict';
import {subtotal, total} from '../src/cart.mjs';

const items = [{price: 40, qty: 2}, {price: 20, qty: 1}];

test('subtotal adds up the line items', () => {
  assert.equal(subtotal(items), 100);
});

test('total applies a discount code', () => {
  assert.equal(total(items, 'SPRING10'), 90);
});

test('a discount code takes a share of the subtotal', () => {
  assert.equal(total([{price: 250, qty: 2}], 'VIP20'), 400);
});
