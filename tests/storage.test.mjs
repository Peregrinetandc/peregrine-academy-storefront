import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { orderRepository } from '../src/lib/storage/order-repository.ts';

describe('Local Durable Order Repository & Atomic CAS Operations', () => {
  const sampleOrder = {
    id: 'ord_storage_test_001',
    orderNumber: 'PRGN-20261027-TEST',
    customerEmail: 'durable@peregrineacademy.in',
    customerName: 'Durable Test User',
    customerPhone: '+971501112222',
    sku: 'SKU_BUNDLE_ALL_IN_ONE',
    items: [],
    amountInr: 1998,
    currency: 'INR',
    status: 'pending_payment',
    razorpayOrderId: 'order_durable_rzp_001',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {}
  };

  beforeEach(async () => {
    await orderRepository.clearForTesting();
  });

  afterEach(async () => {
    await orderRepository.clearForTesting();
  });

  test('Saves order and retrieves it durably', async () => {
    await orderRepository.save(sampleOrder);
    const retrieved = await orderRepository.get(sampleOrder.id);

    assert.ok(retrieved);
    assert.equal(retrieved.id, sampleOrder.id);
    assert.equal(retrieved.amountInr, 1998);
    assert.equal(retrieved.status, 'pending_payment');
  });

  test('Finds order by Razorpay order ID', async () => {
    await orderRepository.save(sampleOrder);
    const found = await orderRepository.findByRazorpayOrderId(sampleOrder.razorpayOrderId);

    assert.ok(found);
    assert.equal(found.id, sampleOrder.id);
  });

  test('Atomic CAS: Transition succeeds when current status matches expectation', async () => {
    await orderRepository.save(sampleOrder);

    const casResult = await orderRepository.transitionStatusAtomic(
      sampleOrder.id,
      'pending_payment',
      'paid',
      { razorpayPaymentId: 'pay_storage_succ_01', razorpaySignature: 'sig_01' }
    );

    assert.equal(casResult.success, true);
    assert.equal(casResult.order?.status, 'paid');
    assert.equal(casResult.order?.razorpayPaymentId, 'pay_storage_succ_01');

    // Verify it persisted
    const stored = await orderRepository.get(sampleOrder.id);
    assert.equal(stored?.status, 'paid');
  });

  test('Atomic CAS: Transition fails when status was already changed (concurrent race protection)', async () => {
    await orderRepository.save(sampleOrder);

    // First transition: pending_payment -> paid
    const firstCas = await orderRepository.transitionStatusAtomic(
      sampleOrder.id,
      'pending_payment',
      'paid'
    );
    assert.equal(firstCas.success, true);

    // Second simultaneous transition attempting to transition from pending_payment again:
    const secondCas = await orderRepository.transitionStatusAtomic(
      sampleOrder.id,
      'pending_payment',
      'paid'
    );
    assert.equal(secondCas.success, false);
    assert.match(secondCas.error || '', /Atomic CAS failed/);
  });
});
