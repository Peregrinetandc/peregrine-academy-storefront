import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  handleCreateOrder,
  handleVerifyPayment,
  handleRazorpayWebhook,
  reconcileOrderPayment
} from '../src/api/orders.ts';
import {
  createRazorpayOrder,
  captureRazorpayPayment,
  fetchRazorpayPayment
} from '../src/lib/razorpay.ts';
import {
  canTransitionOrder,
  transitionOrder
} from '../src/lib/order-state-machine.ts';
import { orderRepository } from '../src/lib/storage/index.ts';

describe('P0 Security Fixes: Payment Capture, Concurrency Race, & Recovery Invariants', () => {
  const testKeyId = 'rzp_test_p0_key';
  const testSecret = 'secret_test_p0_1234567890abcdef';
  const testWebhookSecret = 'whsec_p0_test_987654321';

  beforeEach(async () => {
    await orderRepository.clearForTesting();
  });

  describe('Fix 1: Razorpay Capture Semantics & Gateway Validation', () => {
    test('createRazorpayOrder explicitly passes payment_capture: 1 for auto-capture', async () => {
      let capturedPayload = null;
      const mockFetch = async (url, opts) => {
        capturedPayload = JSON.parse(opts.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'order_capture_001',
            entity: 'order',
            amount: 49900,
            currency: 'INR',
            receipt: 'PRGN-CAP-001',
            status: 'created',
            created_at: 1700000000
          })
        };
      };

      await createRazorpayOrder({
        amountInSubunits: 49900,
        currency: 'INR',
        receipt: 'PRGN-CAP-001',
        keyId: testKeyId,
        keySecret: testSecret,
        fetchFn: mockFetch
      });

      assert.ok(capturedPayload, 'Order creation payload must be captured');
      assert.equal(capturedPayload.payment_capture, 1, 'Orders API payload must explicitly include payment_capture: 1');
    });

    test('Authorized-only payment CANNOT trigger fulfillment if capture fails or is missing', async () => {
      const createRes = await handleCreateOrder({
        sku: 'SKU_BOOK_KHALIJI_STORIES',
        customerEmail: 'authonly@peregrineacademy.in',
        customerName: 'Authorized Only User'
      });
      assert.equal(createRes.success, true);

      const rzpOrderId = createRes.razorpayOrderId;
      const paymentId = 'pay_auth_only_fail_01';
      const signature = crypto
        .createHmac('sha256', testSecret)
        .update(`${rzpOrderId}|${paymentId}`)
        .digest('hex');

      // Gateway returns authorized status, but capture call fails
      const mockFetch = async (url, opts) => {
        const urlStr = url.toString();
        if (urlStr.includes('/capture')) {
          return {
            ok: false,
            status: 400,
            json: async () => ({ error: { description: 'Bank declined manual capture window' } })
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: paymentId,
            entity: 'payment',
            amount: 49900,
            currency: 'INR',
            status: 'authorized',
            order_id: rzpOrderId,
            captured: false
          })
        };
      };

      const verifyRes = await handleVerifyPayment(
        {
          orderId: createRes.order.id,
          razorpayOrderId: rzpOrderId,
          razorpayPaymentId: paymentId,
          razorpaySignature: signature
        },
        {
          razorpayKeyId: testKeyId,
          razorpayKeySecret: testSecret,
          skipGatewayFetch: false,
          fetchFn: mockFetch
        }
      );

      assert.equal(verifyRes.success, false, 'Authorized-only payment must not fulfill order when capture fails');
      assert.match(verifyRes.error || '', /Payment is authorized but capture could not be completed/);

      // Verify database state: order must remain pending_payment and NOT be paid or fulfilled
      const currentOrder = await orderRepository.get(createRes.order.id);
      assert.equal(currentOrder?.status, 'pending_payment', 'Order must not transition to paid or fulfilled');
    });

    test('Captured payment triggers server-side confirmation and fulfills order', async () => {
      const createRes = await handleCreateOrder({
        sku: 'SKU_BOOK_KHALIJI_STORIES',
        customerEmail: 'captured@peregrineacademy.in',
        customerName: 'Captured User'
      });

      const rzpOrderId = createRes.razorpayOrderId;
      const paymentId = 'pay_captured_ok_01';
      const signature = crypto
        .createHmac('sha256', testSecret)
        .update(`${rzpOrderId}|${paymentId}`)
        .digest('hex');

      const mockFetch = async (url) => {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: paymentId,
            entity: 'payment',
            amount: 49900,
            currency: 'INR',
            status: 'captured',
            order_id: rzpOrderId,
            captured: true
          })
        };
      };

      const verifyRes = await handleVerifyPayment(
        {
          orderId: createRes.order.id,
          razorpayOrderId: rzpOrderId,
          razorpayPaymentId: paymentId,
          razorpaySignature: signature
        },
        {
          razorpayKeyId: testKeyId,
          razorpayKeySecret: testSecret,
          skipGatewayFetch: false,
          fetchFn: mockFetch
        }
      );

      assert.equal(verifyRes.success, true);
      assert.equal(verifyRes.paymentVerified, true);
      assert.equal(verifyRes.fulfillmentStatus, 'fulfilled');
      assert.equal(verifyRes.order?.status, 'fulfilled');
    });
  });

  describe('Fix 2: Browser/Webhook Race Condition Handling', () => {
    test('Browser verification racing with in-flight webhook provisioning returns truthful success', async () => {
      const createRes = await handleCreateOrder({
        sku: 'SKU_BOOK_KHALIJI_STORIES',
        customerEmail: 'race.winner@peregrineacademy.in',
        customerName: 'Race User'
      });

      const rzpOrderId = createRes.razorpayOrderId;
      const paymentId = 'pay_race_sim_01';
      const signature = crypto
        .createHmac('sha256', testSecret)
        .update(`${rzpOrderId}|${paymentId}`)
        .digest('hex');

      // Step 1: Simulate webhook winning the race and transitioning order to 'paid' / 'provisioning'
      const casResult = await orderRepository.transitionStatusAtomic(
        createRes.order.id,
        'pending_payment',
        'paid',
        { razorpayPaymentId: paymentId, razorpaySignature: signature }
      );
      assert.equal(casResult.success, true);

      // Order is now in 'paid' status, currently in-flight
      const inFlightOrder = await orderRepository.get(createRes.order.id);
      assert.equal(inFlightOrder?.status, 'paid');

      // Step 2: Browser calls handleVerifyPayment while webhook is provisioning
      const mockFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          id: paymentId,
          entity: 'payment',
          amount: 49900,
          currency: 'INR',
          status: 'captured',
          order_id: rzpOrderId,
          captured: true
        })
      });

      const browserVerify = await handleVerifyPayment(
        {
          orderId: createRes.order.id,
          razorpayOrderId: rzpOrderId,
          razorpayPaymentId: paymentId,
          razorpaySignature: signature
        },
        {
          razorpayKeyId: testKeyId,
          razorpayKeySecret: testSecret,
          skipGatewayFetch: false,
          fetchFn: mockFetch
        }
      );

      // Crucial Fix: MUST return success: true (NOT HTTP 400), with verified payment and in-flight status!
      assert.equal(browserVerify.success, true, 'Browser verification must not fail when webhook won CAS');
      assert.equal(browserVerify.paymentVerified, true);
      assert.equal(browserVerify.fulfillmentStatus, 'paid');
      assert.equal(browserVerify.isDuplicate, true);
    });

    test('Duplicate browser callbacks and webhooks do not trigger duplicate entitlements', async () => {
      const createRes = await handleCreateOrder({
        sku: 'SKU_BOOK_KHALIJI_STORIES',
        customerEmail: 'dup.user@peregrineacademy.in',
        customerName: 'Duplicate Test'
      });

      const rzpOrderId = createRes.razorpayOrderId;
      const paymentId = 'pay_dup_999';
      const signature = crypto
        .createHmac('sha256', testSecret)
        .update(`${rzpOrderId}|${paymentId}`)
        .digest('hex');

      const mockFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          id: paymentId,
          entity: 'payment',
          amount: 49900,
          currency: 'INR',
          status: 'captured',
          order_id: rzpOrderId,
          captured: true
        })
      });

      // Browser call 1
      const call1 = await handleVerifyPayment(
        {
          orderId: createRes.order.id,
          razorpayOrderId: rzpOrderId,
          razorpayPaymentId: paymentId,
          razorpaySignature: signature
        },
        { razorpayKeyId: testKeyId, razorpayKeySecret: testSecret, skipGatewayFetch: false, fetchFn: mockFetch }
      );
      assert.equal(call1.success, true);
      assert.equal(call1.fulfillmentStatus, 'fulfilled');

      const token1 = call1.order?.items[0].claimToken;
      assert.ok(token1, 'Claim token must be generated');

      // Webhook call (concurrent / duplicate)
      const webhookPayload = JSON.stringify({
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: paymentId,
              order_id: rzpOrderId,
              amount: 49900,
              currency: 'INR',
              status: 'captured'
            }
          }
        }
      });
      const webhookSig = crypto.createHmac('sha256', testWebhookSecret).update(webhookPayload).digest('hex');

      const webhookRes = await handleRazorpayWebhook(webhookPayload, webhookSig, {
        webhookSecret: testWebhookSecret
      });
      assert.equal(webhookRes.success, true);
      assert.equal(webhookRes.isDuplicate, true);

      // Browser call 2 (replay)
      const call2 = await handleVerifyPayment(
        {
          orderId: createRes.order.id,
          razorpayOrderId: rzpOrderId,
          razorpayPaymentId: paymentId,
          razorpaySignature: signature
        },
        { razorpayKeyId: testKeyId, razorpayKeySecret: testSecret, skipGatewayFetch: false, fetchFn: mockFetch }
      );
      assert.equal(call2.success, true);
      assert.equal(call2.isDuplicate, true);
      assert.equal(call2.order?.items[0].claimToken, token1, 'Entitlement token must remain identical');
    });
  });

  describe('Fix 3: Paid-Order Recovery & Disallowing failed -> draft with Payment Proof', () => {
    test('failed -> draft is strictly rejected when order has payment evidence', async () => {
      const paidFailedOrder = {
        id: 'ord_failed_paid_001',
        orderNumber: 'PRGN-20261027-FAIL01',
        customerEmail: 'failed.paid@peregrineacademy.in',
        customerName: 'Failed Paid User',
        sku: 'SKU_BOOK_KHALIJI_STORIES',
        items: [],
        amountInr: 499,
        currency: 'INR',
        status: 'failed',
        razorpayOrderId: 'order_failed_001',
        razorpayPaymentId: 'pay_successful_charge_001',
        paymentVerifiedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      await orderRepository.save(paidFailedOrder);

      // 1. canTransitionOrder returns false
      assert.equal(canTransitionOrder(paidFailedOrder, 'draft'), false);

      // 2. transitionOrder throws error
      assert.throws(() => {
        transitionOrder(paidFailedOrder, 'draft');
      }, /Cannot transition failed order .* to 'draft' because payment evidence exists/);

      // 3. Repository transitionStatusAtomic rejects failed -> draft
      const casRes = await orderRepository.transitionStatusAtomic(
        paidFailedOrder.id,
        'failed',
        'draft'
      );
      assert.equal(casRes.success, false);
      assert.match(casRes.error || '', /payment evidence exists/);

      const unchanged = await orderRepository.get(paidFailedOrder.id);
      assert.equal(unchanged?.status, 'failed', 'Status must remain failed');
    });

    test('failed -> draft is permitted when order has NO payment evidence (safe unpaid initialization failure)', async () => {
      const unpaidFailedOrder = {
        id: 'ord_unpaid_fail_002',
        orderNumber: 'PRGN-20261027-UNPAID',
        customerEmail: 'unpaid.fail@peregrineacademy.in',
        customerName: 'Unpaid Failed User',
        sku: 'SKU_BOOK_KHALIJI_STORIES',
        items: [],
        amountInr: 499,
        currency: 'INR',
        status: 'failed',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      await orderRepository.save(unpaidFailedOrder);

      assert.equal(canTransitionOrder(unpaidFailedOrder, 'draft'), true);

      const transitioned = transitionOrder(unpaidFailedOrder, 'draft');
      assert.equal(transitioned.status, 'draft');

      const casRes = await orderRepository.transitionStatusAtomic(
        unpaidFailedOrder.id,
        'failed',
        'draft'
      );
      assert.equal(casRes.success, true);
      assert.equal(casRes.order?.status, 'draft');
    });

    test('reconcileOrderPayment reconciles captured payment for ambiguous pending orders', async () => {
      const pendingOrder = {
        id: 'ord_ambiguous_001',
        orderNumber: 'PRGN-20261027-AMBIG',
        customerEmail: 'ambig@peregrineacademy.in',
        customerName: 'Ambiguous User',
        sku: 'SKU_BOOK_KHALIJI_STORIES',
        items: [
          {
            id: 'item_ambig_1',
            sku: 'SKU_BOOK_KHALIJI_STORIES',
            name: 'Spoken Arabic Book',
            targetPlatform: 'BOOK_READER',
            unitPriceInr: 499,
            quantity: 1,
            provisioningStatus: 'pending',
            retryCount: 0
          }
        ],
        amountInr: 499,
        currency: 'INR',
        status: 'pending_payment',
        razorpayOrderId: 'order_ambig_rzp_01',
        razorpayPaymentId: 'pay_ambig_real_01',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      await orderRepository.save(pendingOrder);

      const mockFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          id: 'pay_ambig_real_01',
          entity: 'payment',
          amount: 49900,
          currency: 'INR',
          status: 'captured',
          order_id: 'order_ambig_rzp_01',
          captured: true
        })
      });

      const reconciliation = await reconcileOrderPayment('ord_ambiguous_001', {
        razorpayKeyId: testKeyId,
        razorpayKeySecret: testSecret,
        fetchFn: mockFetch
      });

      assert.equal(reconciliation.reconciled, true);
      assert.equal(reconciliation.status, 'fulfilled');
      assert.equal(reconciliation.order?.status, 'fulfilled');
      assert.equal(reconciliation.order?.items[0].provisioningStatus, 'granted');
    });
  });
});
