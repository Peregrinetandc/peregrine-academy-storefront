import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  canTransitionOrder,
  transitionOrder
} from '../src/lib/order-state-machine.ts';

describe('Order State Machine & Transition Rules', () => {
  const baseOrder = {
    id: 'ord_12345',
    orderNumber: 'PRGN-20261026-TEST',
    customerEmail: 'test@example.com',
    customerName: 'Test Student',
    sku: 'SKU_BUNDLE_ALL_IN_ONE',
    items: [],
    amountInr: 1999,
    currency: 'INR',
    status: 'draft',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  test('Valid happy-path transition: draft -> pending_payment -> paid -> provisioning -> fulfilled', () => {
    let order = { ...baseOrder };

    order = transitionOrder(order, 'pending_payment');
    assert.equal(order.status, 'pending_payment');

    order = transitionOrder(order, 'paid');
    assert.equal(order.status, 'paid');
    assert.ok(order.paymentVerifiedAt, 'paymentVerifiedAt must be populated');

    order = transitionOrder(order, 'provisioning');
    assert.equal(order.status, 'provisioning');

    order = transitionOrder(order, 'fulfilled');
    assert.equal(order.status, 'fulfilled');
    assert.ok(order.provisionedAt, 'provisionedAt must be populated');
  });

  test('Illegal transition: draft -> fulfilled directly is forbidden', () => {
    const order = { ...baseOrder, status: 'draft' };
    assert.equal(canTransitionOrder('draft', 'fulfilled'), false);
    assert.throws(() => {
      transitionOrder(order, 'fulfilled');
    }, /Illegal order state transition/);
  });

  test('Illegal transition: paid -> draft is forbidden', () => {
    assert.equal(canTransitionOrder('paid', 'draft'), false);
  });

  test('Partially provisioned orders can transition back to provisioning for retries', () => {
    const order = { ...baseOrder, status: 'partially_provisioned' };
    assert.equal(canTransitionOrder('partially_provisioned', 'provisioning'), true);
    
    const retrying = transitionOrder(order, 'provisioning');
    assert.equal(retrying.status, 'provisioning');
  });

  test('Fulfilled orders can transition to refund_pending -> refunded', () => {
    let order = { ...baseOrder, status: 'fulfilled' };
    order = transitionOrder(order, 'refund_pending');
    assert.equal(order.status, 'refund_pending');

    order = transitionOrder(order, 'refunded');
    assert.equal(order.status, 'refunded');
  });
});
