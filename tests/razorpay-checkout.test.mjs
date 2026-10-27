import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  createRazorpayOrder,
  verifyRazorpayPaymentSignature,
  verifyRazorpayWebhookSignature,
  fetchRazorpayPayment
} from '../src/lib/razorpay.ts';
import {
  handleCreateOrder,
  handleVerifyPayment,
  handleRazorpayWebhook,
  memoryOrderLedger
} from '../src/api/orders.ts';

describe('Real Razorpay Checkout Integration & Security Rules', () => {
  const testKeyId = 'rzp_test_mock_key_01';
  const testKeySecret = 'test_secret_for_checkout_suite_012345';
  const testWebhookSecret = 'test_webhook_secret_998877';

  test('createRazorpayOrder constructs correct API request payload and headers', async () => {
    let capturedUrl = '';
    let capturedOptions = null;

    const mockFetch = async (url, opts) => {
      capturedUrl = url.toString();
      capturedOptions = opts;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'order_rzp_live_test_001',
          entity: 'order',
          amount: 49900,
          currency: 'INR',
          receipt: 'PRGN-TEST-001',
          status: 'created',
          created_at: 1700000000
        })
      };
    };

    const res = await createRazorpayOrder({
      amountInSubunits: 49900,
      currency: 'INR',
      receipt: 'PRGN-TEST-001',
      notes: { sku: 'SKU_BOOK_KHALIJI_STORIES' },
      keyId: testKeyId,
      keySecret: testKeySecret,
      fetchFn: mockFetch
    });

    assert.equal(capturedUrl, 'https://api.razorpay.com/v1/orders');
    assert.equal(capturedOptions.method, 'POST');
    assert.equal(
      capturedOptions.headers['Authorization'],
      `Basic ${Buffer.from(`${testKeyId}:${testKeySecret}`).toString('base64')}`
    );
    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.amount, 49900);
    assert.equal(body.currency, 'INR');
    assert.equal(body.receipt, 'PRGN-TEST-001');
    assert.equal(res.id, 'order_rzp_live_test_001');
  });

  test('createRazorpayOrder rejects invalid amount or missing credentials', async () => {
    await assert.rejects(
      async () => {
        await createRazorpayOrder({
          amountInSubunits: 0,
          currency: 'INR',
          receipt: 'PRGN-001',
          keyId: testKeyId,
          keySecret: testKeySecret
        });
      },
      /Invalid order amount/
    );

    await assert.rejects(
      async () => {
        await createRazorpayOrder({
          amountInSubunits: 49900,
          currency: 'INR',
          receipt: 'PRGN-001',
          keyId: '',
          keySecret: ''
        });
      },
      /Razorpay credentials/
    );
  });

  test('handleVerifyPayment: Valid payment signature authoritatively fulfills order', async () => {
    const createRes = await handleCreateOrder(
      {
        sku: 'SKU_BOOK_KHALIJI_STORIES',
        customerEmail: 'ahmed.ali@peregrineacademy.in',
        customerName: 'Ahmed Ali'
      },
      {
        razorpayKeyId: testKeyId,
        razorpayKeySecret: testKeySecret,
        allowPausedBundleForTesting: true,
        fetchFn: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ id: 'order_test_valid_01', entity: 'order', status: 'created' })
        })
      }
    );

    assert.equal(createRes.success, true);
    const orderId = createRes.order.id;
    const rzpOrderId = createRes.razorpayOrderId;
    const paymentId = 'pay_test_succ_1001';

    const validSignature = crypto
      .createHmac('sha256', testKeySecret)
      .update(`${rzpOrderId}|${paymentId}`)
      .digest('hex');

    const verifyRes = await handleVerifyPayment(
      {
        orderId,
        razorpayOrderId: rzpOrderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: validSignature
      },
      {
        razorpayKeyId: testKeyId,
        razorpayKeySecret: testKeySecret,
        skipGatewayFetch: true
      }
    );

    assert.equal(verifyRes.success, true);
    assert.equal(verifyRes.paymentVerified, true);
    assert.equal(verifyRes.fulfillmentStatus, 'fulfilled');
    assert.equal(verifyRes.order?.status, 'fulfilled');
    assert.equal(verifyRes.order?.razorpayPaymentId, paymentId);
  });

  test('handleVerifyPayment: Invalid / tampered signature is strictly rejected', async () => {
    const createRes = await handleCreateOrder({
      sku: 'SKU_BOOK_KHALIJI_STORIES',
      customerEmail: 'fatima@peregrineacademy.in',
      customerName: 'Fatima Z.'
    });

    const verifyRes = await handleVerifyPayment(
      {
        orderId: createRes.order.id,
        razorpayOrderId: createRes.razorpayOrderId,
        razorpayPaymentId: 'pay_test_tampered_001',
        razorpaySignature: 'tampered_signature_hex_deadbeef000000000000000000000000'
      },
      {
        razorpayKeyId: testKeyId,
        razorpayKeySecret: testKeySecret,
        skipGatewayFetch: true
      }
    );

    assert.equal(verifyRes.success, false);
    assert.match(verifyRes.error || '', /Invalid Razorpay payment signature/);
    // Order must remain pending_payment
    const stored = memoryOrderLedger.get(createRes.order.id);
    assert.equal(stored?.status, 'pending_payment');
  });

  test('handleVerifyPayment: Wrong Razorpay order ID mismatch is rejected', async () => {
    const createRes = await handleCreateOrder({
      sku: 'SKU_BOOK_KHALIJI_STORIES',
      customerEmail: 'omar@peregrineacademy.in',
      customerName: 'Omar H.'
    });

    const wrongRzpOrderId = 'order_WRONG_MISMATCH_9999';
    const paymentId = 'pay_test_wrong_order_001';
    const signatureForWrong = crypto
      .createHmac('sha256', testKeySecret)
      .update(`${wrongRzpOrderId}|${paymentId}`)
      .digest('hex');

    const verifyRes = await handleVerifyPayment(
      {
        orderId: createRes.order.id,
        razorpayOrderId: wrongRzpOrderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: signatureForWrong
      },
      {
        razorpayKeyId: testKeyId,
        razorpayKeySecret: testKeySecret,
        skipGatewayFetch: true
      }
    );

    assert.equal(verifyRes.success, false);
    assert.match(verifyRes.error || '', /Razorpay order ID mismatch/);
  });

  test('handleVerifyPayment: Wrong amount reported by gateway is rejected', async () => {
    const createRes = await handleCreateOrder({
      sku: 'SKU_LMS_SPOKEN_ARABIC', // ₹1,499 -> 149,900 subunits
      customerEmail: 'khaled@peregrineacademy.in',
      customerName: 'Khaled M.'
    });

    const rzpOrderId = createRes.razorpayOrderId;
    const paymentId = 'pay_wrong_amount_01';
    const validSignature = crypto
      .createHmac('sha256', testKeySecret)
      .update(`${rzpOrderId}|${paymentId}`)
      .digest('hex');

    // Gateway reports ₹499 (49,900 subunits) instead of ₹1,499 (149,900 subunits)
    const mockFetchWrongAmount = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        id: paymentId,
        entity: 'payment',
        order_id: rzpOrderId,
        amount: 49900, // WRONG AMOUNT!
        currency: 'INR',
        status: 'captured'
      })
    });

    const verifyRes = await handleVerifyPayment(
      {
        orderId: createRes.order.id,
        razorpayOrderId: rzpOrderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: validSignature
      },
      {
        razorpayKeyId: testKeyId,
        razorpayKeySecret: testKeySecret,
        skipGatewayFetch: false,
        fetchFn: mockFetchWrongAmount
      }
    );

    assert.equal(verifyRes.success, false);
    assert.match(verifyRes.error || '', /Payment amount mismatch/);
  });

  test('handleVerifyPayment: Replay protection prevents duplicate grants', async () => {
    const createRes = await handleCreateOrder({
      sku: 'SKU_BOOK_KHALIJI_STORIES',
      customerEmail: 'replay.user@peregrineacademy.in',
      customerName: 'Replay Test'
    });

    const rzpOrderId = createRes.razorpayOrderId;
    const paymentId = 'pay_replay_test_01';
    const signature = crypto
      .createHmac('sha256', testKeySecret)
      .update(`${rzpOrderId}|${paymentId}`)
      .digest('hex');

    // First attempt: should succeed
    const firstVerify = await handleVerifyPayment(
      {
        orderId: createRes.order.id,
        razorpayOrderId: rzpOrderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: signature
      },
      {
        razorpayKeyId: testKeyId,
        razorpayKeySecret: testKeySecret,
        skipGatewayFetch: true
      }
    );
    assert.equal(firstVerify.success, true);
    assert.equal(firstVerify.isDuplicate, undefined);

    // Second attempt (exact same request replay): must succeed idempotently without error
    const secondVerify = await handleVerifyPayment(
      {
        orderId: createRes.order.id,
        razorpayOrderId: rzpOrderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: signature
      },
      {
        razorpayKeyId: testKeyId,
        razorpayKeySecret: testKeySecret,
        skipGatewayFetch: true
      }
    );
    assert.equal(secondVerify.success, true);
    assert.equal(secondVerify.isDuplicate, true);
    assert.equal(secondVerify.order?.status, 'fulfilled');
  });

  test('handleRazorpayWebhook: Valid webhook fulfills order, duplicate is idempotent', async () => {
    const createRes = await handleCreateOrder({
      sku: 'SKU_BOOK_KHALIJI_STORIES',
      customerEmail: 'webhook.user@peregrineacademy.in',
      customerName: 'Webhook User'
    });

    const rzpOrderId = createRes.razorpayOrderId;
    const webhookPayload = JSON.stringify({
      entity: 'event',
      account_id: 'acc_001',
      event: 'payment.captured',
      contains: ['payment'],
      payload: {
        payment: {
          entity: {
            id: 'pay_webhook_succ_01',
            order_id: rzpOrderId,
            amount: 49900,
            currency: 'INR',
            status: 'captured'
          }
        }
      },
      created_at: 1700000000
    });

    const validWebhookSig = crypto
      .createHmac('sha256', testWebhookSecret)
      .update(webhookPayload)
      .digest('hex');

    // First webhook delivery
    const firstDelivery = await handleRazorpayWebhook(webhookPayload, validWebhookSig, {
      webhookSecret: testWebhookSecret
    });
    assert.equal(firstDelivery.success, true);
    assert.equal(firstDelivery.isDuplicate, false);

    const storedOrder = memoryOrderLedger.get(createRes.order.id);
    assert.equal(storedOrder?.status, 'fulfilled');

    // Duplicate webhook delivery
    const secondDelivery = await handleRazorpayWebhook(webhookPayload, validWebhookSig, {
      webhookSecret: testWebhookSecret
    });
    assert.equal(secondDelivery.success, true);
    assert.equal(secondDelivery.isDuplicate, true);
  });

  test('handleRazorpayWebhook: Invalid signature is rejected', async () => {
    const payload = JSON.stringify({ event: 'payment.captured' });
    const res = await handleRazorpayWebhook(payload, 'bad_webhook_sig', {
      webhookSecret: testWebhookSecret
    });
    assert.equal(res.success, false);
    assert.match(res.error || '', /Invalid webhook signature/);
  });

  test('Provisioning failure: Payment is marked paid but order is NOT fulfilled', async () => {
    const createRes = await handleCreateOrder({
      sku: 'SKU_BOOK_KHALIJI_STORIES',
      customerEmail: 'fail.test@peregrineacademy.in',
      customerName: 'Fail Test'
    });

    const rzpOrderId = createRes.razorpayOrderId;
    const paymentId = 'pay_prov_fail_01';
    const signature = crypto
      .createHmac('sha256', testKeySecret)
      .update(`${rzpOrderId}|${paymentId}`)
      .digest('hex');

    // Simulate provisioning failure by passing invalid handoff options
    const verifyRes = await handleVerifyPayment(
      {
        orderId: createRes.order.id,
        razorpayOrderId: rzpOrderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: signature
      },
      {
        razorpayKeyId: testKeyId,
        razorpayKeySecret: testKeySecret,
        skipGatewayFetch: true,
        provisioningOptions: {
          simulate: false,
          readerApiUrl: 'https://invalid-nonexistent-domain-test.local',
          handoffSecret: 'dummy_secret'
        }
      }
    );

    // Order must report failure because provisioning failed
    assert.equal(verifyRes.success, false);
    assert.equal(verifyRes.paymentVerified, true);
    // Crucial check: Order status must NOT be fulfilled!
    assert.notEqual(verifyRes.order?.status, 'fulfilled');
    assert.equal(verifyRes.order?.status, 'failed');
    assert.ok(verifyRes.order?.paymentVerifiedAt);
    assert.match(verifyRes.error || '', /failed to provision/);
  });

  test('Production safety: Test mock signature strictly fails closed if NODE_ENV=production', async () => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    try {
      await assert.rejects(
        async () => {
          await handleVerifyPayment(
            {
              orderId: 'dummy_id',
              razorpayOrderId: 'dummy_rzp',
              razorpayPaymentId: 'dummy_pay',
              razorpaySignature: 'test_valid_mock_signature'
            },
            { allowTestMockSignature: true }
          );
        },
        /Test mock signature verification is strictly forbidden in production/
      );
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });

  test('Commercial safety: Unready/invalid products strictly fail closed without bypass flag', async () => {
    const createRes = await handleCreateOrder({
      sku: 'SKU_NON_EXISTENT_UNREADY',
      customerEmail: 'customer@example.com',
      customerName: 'Customer Name'
    });

    assert.equal(createRes.success, false);
    assert.match(createRes.error || '', /Invalid SKU/);
  });

  test('Complete Learning Package: Order creation at ₹1,998 and authoritative multi-platform fulfillment', async () => {
    const createRes = await handleCreateOrder(
      {
        sku: 'SKU_BUNDLE_ALL_IN_ONE',
        customerEmail: 'two.package@peregrineacademy.in',
        customerName: 'Maryam Al-Dhaheri',
        customerPhone: '+971501234567'
      },
      {
        razorpayKeyId: testKeyId,
        razorpayKeySecret: testKeySecret,
        fetchFn: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ id: 'order_bundle_pkg_001', entity: 'order', status: 'created', amount: 199800 })
        })
      }
    );

    assert.equal(createRes.success, true);
    assert.equal(createRes.order.amountInr, 1998);
    assert.equal(createRes.amountInSubunits, 199800);
    assert.equal(createRes.order.items.length, 2);

    const lmsItem = createRes.order.items.find(i => i.targetPlatform === 'LMS');
    const bookItem = createRes.order.items.find(i => i.targetPlatform === 'BOOK_READER');

    assert.equal(lmsItem?.unitPriceInr, 1499);
    assert.equal(bookItem?.unitPriceInr, 499);

    // Authoritative verification
    const orderId = createRes.order.id;
    const rzpOrderId = createRes.razorpayOrderId;
    const paymentId = 'pay_bundle_pkg_101';

    const validSig = crypto
      .createHmac('sha256', testKeySecret)
      .update(`${rzpOrderId}|${paymentId}`)
      .digest('hex');

    const verifyRes = await handleVerifyPayment(
      {
        orderId,
        razorpayOrderId: rzpOrderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: validSig
      },
      {
        razorpayKeyId: testKeyId,
        razorpayKeySecret: testKeySecret,
        skipGatewayFetch: true
      }
    );

    assert.equal(verifyRes.success, true);
    assert.equal(verifyRes.order?.status, 'fulfilled');
    assert.equal(verifyRes.order?.amountInr, 1998);

    const fulfilledLms = verifyRes.order?.items.find(i => i.targetPlatform === 'LMS');
    const fulfilledBook = verifyRes.order?.items.find(i => i.targetPlatform === 'BOOK_READER');
    assert.equal(fulfilledLms?.provisioningStatus, 'granted');
    assert.equal(fulfilledBook?.provisioningStatus, 'granted');
    assert.ok(fulfilledBook?.claimToken);
  });

  test('AI Speaking Partner Standalone / Preview: 30-day non-recurring trial window', async () => {
    const aiasRes = await handleCreateOrder(
      {
        sku: 'SKU_AIAS_TUTOR_PASS',
        customerEmail: 'aias.trial@peregrineacademy.in',
        customerName: 'Trial Student'
      },
      {
        razorpayKeyId: testKeyId,
        razorpayKeySecret: testKeySecret,
        skipGatewayFetch: true
      }
    );

    assert.equal(aiasRes.success, true);
    assert.equal(aiasRes.order.amountInr, 0);

    const orderId = aiasRes.order.id;
    const paymentId = 'pay_trial_free_001';
    const validSig = crypto
      .createHmac('sha256', testKeySecret)
      .update(`${aiasRes.razorpayOrderId}|${paymentId}`)
      .digest('hex');

    const verifyRes = await handleVerifyPayment(
      {
        orderId,
        razorpayOrderId: aiasRes.razorpayOrderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: validSig
      },
      {
        razorpayKeyId: testKeyId,
        razorpayKeySecret: testKeySecret,
        skipGatewayFetch: true
      }
    );

    const fulfilledAias = verifyRes.order?.items.find(i => i.targetPlatform === 'AIAS');
    assert.equal(fulfilledAias?.provisioningStatus, 'granted');
    assert.ok(fulfilledAias?.claimToken?.startsWith('AIAS-'));
    assert.ok(fulfilledAias?.accessGrantedAt);
    assert.ok(fulfilledAias?.accessExpiresAt);

    // Verify 30-day window
    const durationDays = (Date.parse(fulfilledAias.accessExpiresAt) - Date.parse(fulfilledAias.accessGrantedAt)) / (1000 * 60 * 60 * 24);
    assert.equal(Math.round(durationDays), 30, 'Trial period must be exactly 30 days');
  });
});
