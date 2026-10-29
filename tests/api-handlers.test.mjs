import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { handleCreateOrder, handleVerifyPayment, handleRetryProvisioning, memoryOrderLedger } from '../src/api/orders.ts';

describe('Storefront API Handlers (Orders, Payments, & Claims)', () => {
  test('handleCreateOrder for Book creates pending order at ₹499', async () => {
    const res = await handleCreateOrder({
      sku: 'SKU_BOOK_KHALIJI_STORIES',
      customerEmail: 'scholar.uae@peregrineacademy.in',
      customerName: 'Sultan Al-Dhaheri',
      customerPhone: '+971500000000'
    });

    assert.equal(res.success, true);
    assert.ok(res.order);
    assert.equal(res.order.status, 'pending_payment');
    assert.equal(res.order.amountInr, 499);
    assert.equal(res.order.items.length, 1);
    assert.equal(res.order.items[0].targetPlatform, 'BOOK_READER');
    assert.ok(res.razorpayOrderId);
    assert.ok(memoryOrderLedger.has(res.order.id));
  });

  test('handleCreateOrder for LMS Course creates pending order at ₹1,499', async () => {
    const res = await handleCreateOrder({
      sku: 'SKU_LMS_SPOKEN_ARABIC',
      customerEmail: 'scholar2@peregrineacademy.in',
      customerName: 'Hessa Al-Falasi'
    });

    assert.equal(res.success, true);
    assert.ok(res.order);
    assert.equal(res.order.amountInr, 1499);
    assert.equal(res.order.items[0].targetPlatform, 'LMS');
  });

  test('handleCreateOrder for AIAS creates pending order at ₹0 (Free 1st Month)', async () => {
    const res = await handleCreateOrder({
      sku: 'SKU_AIAS_TUTOR_PASS',
      customerEmail: 'scholar3@peregrineacademy.in',
      customerName: 'Rashid Al-Maktoum'
    });

    assert.equal(res.success, true);
    assert.ok(res.order);
    assert.equal(res.order.amountInr, 0);
    assert.equal(res.order.items[0].targetPlatform, 'AIAS');
  });

  test('handleCreateOrder for Complete Learning Package creates pending order at ₹1,998 with 2 items', async () => {
    const res = await handleCreateOrder({
      sku: 'SKU_BUNDLE_ALL_IN_ONE',
      customerEmail: 'bundle.scholar@peregrineacademy.in',
      customerName: 'Amina Al-Nuaimi'
    });

    assert.equal(res.success, true);
    assert.ok(res.order);
    assert.equal(res.order.amountInr, 1998);
    assert.equal(res.order.items.length, 2);
    assert.ok(res.order.items.some(i => i.sku === 'SKU_LMS_SPOKEN_ARABIC'));
    assert.ok(res.order.items.some(i => i.sku === 'SKU_BOOK_KHALIJI_STORIES'));
  });

  test('handleCreateOrder rejects invalid email or missing name', async () => {
    const resNoEmail = await handleCreateOrder({
      sku: 'SKU_BOOK_KHALIJI_STORIES',
      customerEmail: 'invalid-email',
      customerName: 'Test'
    });
    assert.equal(resNoEmail.success, false);

    const resNoName = await handleCreateOrder({
      sku: 'SKU_BOOK_KHALIJI_STORIES',
      customerEmail: 'valid@example.com',
      customerName: ''
    });
    assert.equal(resNoName.success, false);
  });

  test('handleVerifyPayment authoritatively transitions order to paid and fulfills items', async () => {
    const orderRes = await handleCreateOrder({
      sku: 'SKU_BUNDLE_ALL_IN_ONE',
      customerEmail: 'maryam.test@peregrineacademy.in',
      customerName: 'Maryam K.'
    }, { allowPausedBundleForTesting: true });

    const orderId = orderRes.order.id;
    const rzpOrderId = orderRes.razorpayOrderId;
    const rzpPaymentId = `pay_test_${Date.now()}`;
    const secret = 'rzp_secret_for_api_test';

    const validSignature = crypto
      .createHmac('sha256', secret)
      .update(`${rzpOrderId}|${rzpPaymentId}`)
      .digest('hex');

    const verifyRes = await handleVerifyPayment(
      {
        orderId,
        razorpayOrderId: rzpOrderId,
        razorpayPaymentId: rzpPaymentId,
        razorpaySignature: validSignature
      },
      {
        razorpayKeyId: 'rzp_test_api_mock_01',
        razorpayKeySecret: secret,
        fetchFn: async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            id: rzpPaymentId,
            entity: 'payment',
            amount: 199800,
            currency: 'INR',
            status: 'captured',
            order_id: rzpOrderId,
            captured: true
          })
        })
      }
    );

    assert.equal(verifyRes.success, true);
    assert.ok(verifyRes.order);
    assert.equal(verifyRes.order.status, 'fulfilled');
    assert.ok(verifyRes.order.paymentVerifiedAt);
    assert.ok(verifyRes.order.provisionedAt);

    // Verify line items
    const lmsItem = verifyRes.order.items.find(i => i.targetPlatform === 'LMS');
    const bookItem = verifyRes.order.items.find(i => i.targetPlatform === 'BOOK_READER');

    assert.equal(lmsItem?.provisioningStatus, 'granted');
    assert.equal(bookItem?.provisioningStatus, 'granted');
    assert.ok(bookItem?.claimUrl?.includes('/claim?token='));
  });
});
