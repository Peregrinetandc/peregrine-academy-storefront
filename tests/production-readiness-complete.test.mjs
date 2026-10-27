import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleCreateOrder, handleVerifyPayment, handleRazorpayWebhook, handleRetryProvisioning } from '../src/api/orders.ts';
import { orderRepository } from '../src/lib/storage/order-repository.ts';
import { PRODUCT_CATALOG } from '../src/config/products.ts';
import { provisionAiasTutor } from '../src/lib/provisioning/aias-adapter.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Production Readiness & End-to-End Commerce Validation', () => {
  const secret = 'rzp_prod_readiness_secret_999';
  const webhookSecret = 'whsec_prod_readiness_888';

  // 1. Core Product Purchases
  describe('Authoritative Product Purchases & Correct Pricing', () => {
    test('Digital Arabic Book purchase at authoritative ₹499', async () => {
      const createRes = await handleCreateOrder({
        sku: 'SKU_BOOK_KHALIJI_STORIES',
        customerEmail: 'book.buyer@peregrineacademy.in',
        customerName: 'Rashid Al-Maktoum'
      }, { razorpayKeySecret: secret, skipGatewayFetch: true });

      assert.equal(createRes.success, true);
      assert.equal(createRes.order.amountInr, 499);
      assert.equal(createRes.amountInSubunits, 49900);
      assert.equal(createRes.order.items.length, 1);
      assert.equal(createRes.order.items[0].targetPlatform, 'BOOK_READER');

      const paymentId = 'pay_book_001';
      const sig = crypto.createHmac('sha256', secret)
        .update(`${createRes.razorpayOrderId}|${paymentId}`)
        .digest('hex');

      const verifyRes = await handleVerifyPayment({
        orderId: createRes.order.id,
        razorpayOrderId: createRes.razorpayOrderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: sig
      }, { razorpayKeySecret: secret, skipGatewayFetch: true });

      assert.equal(verifyRes.success, true);
      assert.equal(verifyRes.fulfillmentStatus, 'fulfilled');
      const item = verifyRes.order?.items[0];
      assert.equal(item?.provisioningStatus, 'granted');
      assert.ok(item?.claimToken);
      assert.ok(item?.claimUrl?.includes('arabic.peregrineacademy.in'));
    });

    test('Spoken Arabic LMS Course purchase at authoritative ₹1,499', async () => {
      const createRes = await handleCreateOrder({
        sku: 'SKU_LMS_SPOKEN_ARABIC',
        customerEmail: 'lms.buyer@peregrineacademy.in',
        customerName: 'Fatima Al-Falasi'
      }, { razorpayKeySecret: secret, skipGatewayFetch: true });

      assert.equal(createRes.success, true);
      assert.equal(createRes.order.amountInr, 1499);
      assert.equal(createRes.amountInSubunits, 149900);

      const paymentId = 'pay_lms_001';
      const sig = crypto.createHmac('sha256', secret)
        .update(`${createRes.razorpayOrderId}|${paymentId}`)
        .digest('hex');

      const verifyRes = await handleVerifyPayment({
        orderId: createRes.order.id,
        razorpayOrderId: createRes.razorpayOrderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: sig
      }, { razorpayKeySecret: secret, skipGatewayFetch: true });

      assert.equal(verifyRes.success, true);
      assert.equal(verifyRes.fulfillmentStatus, 'fulfilled');
      const item = verifyRes.order?.items[0];
      assert.equal(item?.provisioningStatus, 'granted');
      assert.ok(item?.claimUrl?.includes('learn.peregrineacademy.in'));
      assert.ok(item?.claimUrl?.includes('23c9297a-a4c2-4237-baa7-244646de1662'));
    });

    test('Book + Course Bundle purchase at authoritative ₹1,998', async () => {
      const createRes = await handleCreateOrder({
        sku: 'SKU_BUNDLE_ALL_IN_ONE',
        customerEmail: 'bundle.buyer@peregrineacademy.in',
        customerName: 'Amina Al-Nuaimi'
      }, { razorpayKeySecret: secret, skipGatewayFetch: true });

      assert.equal(createRes.success, true);
      assert.equal(createRes.order.amountInr, 1998);
      assert.equal(createRes.amountInSubunits, 199800);
      assert.equal(createRes.order.items.length, 2);

      const paymentId = 'pay_bundle_001';
      const sig = crypto.createHmac('sha256', secret)
        .update(`${createRes.razorpayOrderId}|${paymentId}`)
        .digest('hex');

      const verifyRes = await handleVerifyPayment({
        orderId: createRes.order.id,
        razorpayOrderId: createRes.razorpayOrderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: sig
      }, { razorpayKeySecret: secret, skipGatewayFetch: true });

      assert.equal(verifyRes.success, true);
      assert.equal(verifyRes.fulfillmentStatus, 'fulfilled');
      assert.equal(verifyRes.order?.items.length, 2);
      assert.ok(verifyRes.order?.items.every(i => i.provisioningStatus === 'granted'));
    });

    test('AIAS free-period entitlement conforms to 30-day non-recurring policy', async () => {
      const trialResult = await provisionAiasTutor({
        orderId: 'ord_trial_test_001',
        customerEmail: 'scholar.trial@peregrineacademy.in',
        durationDays: 30
      });

      assert.equal(trialResult.success, true);
      assert.equal(trialResult.isFreeTrial, true);
      assert.equal(trialResult.autoRenew, false);
      assert.equal(trialResult.durationDays, 30);
      assert.ok(trialResult.activationCode.startsWith('AIAS-'));

      const daysDiff = (Date.parse(trialResult.expiresAt) - Date.parse(trialResult.startsAt)) / (1000 * 60 * 60 * 24);
      assert.equal(Math.round(daysDiff), 30);
    });
  });

  // 2. Gateway Security & Invariant Enforcement
  describe('Gateway Security, Signature Verification & Fail-Closed Rules', () => {
    test('Server rejects payment verification with tampered signature', async () => {
      const createRes = await handleCreateOrder({
        sku: 'SKU_BOOK_KHALIJI_STORIES',
        customerEmail: 'hacker@example.com',
        customerName: 'Attacker'
      }, { razorpayKeySecret: secret, skipGatewayFetch: true });

      const verifyRes = await handleVerifyPayment({
        orderId: createRes.order.id,
        razorpayOrderId: createRes.razorpayOrderId,
        razorpayPaymentId: 'pay_tampered_001',
        razorpaySignature: 'deadbeef_invalid_signature_hex'
      }, { razorpayKeySecret: secret, skipGatewayFetch: true });

      assert.equal(verifyRes.success, false);
      assert.match(verifyRes.error || '', /Invalid Razorpay payment signature/);
    });

    test('Rejects invalid or unrecognized product IDs', async () => {
      const res = await handleCreateOrder({
        sku: 'SKU_INVENTED_NON_EXISTENT',
        customerEmail: 'user@example.com',
        customerName: 'User'
      });
      assert.equal(res.success, false);
      assert.match(res.error || '', /Invalid SKU/);
    });

    test('Rejects verification when razorpayKeySecret is unconfigured', async () => {
      const createRes = await handleCreateOrder({
        sku: 'SKU_BOOK_KHALIJI_STORIES',
        customerEmail: 'missing.secret@example.com',
        customerName: 'User'
      }, { skipGatewayFetch: true });

      const verifyRes = await handleVerifyPayment({
        orderId: createRes.order.id,
        razorpayOrderId: createRes.razorpayOrderId,
        razorpayPaymentId: 'pay_test_no_secret',
        razorpaySignature: 'some_signature'
      }, { razorpayKeySecret: '' });

      assert.equal(verifyRes.success, false);
      assert.match(verifyRes.error || '', /secret key not configured/);
    });

    test('Fails closed if gateway payment amount does not match order amount', async () => {
      const createRes = await handleCreateOrder({
        sku: 'SKU_BOOK_KHALIJI_STORIES',
        customerEmail: 'amount.mismatch@example.com',
        customerName: 'User'
      }, {
        razorpayKeyId: 'rzp_test_key',
        razorpayKeySecret: secret,
        fetchFn: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ id: 'order_test_mismatch_1', amount: 49900, status: 'created' })
        })
      });

      const paymentId = 'pay_underpaid_001';
      const sig = crypto.createHmac('sha256', secret)
        .update(`${createRes.razorpayOrderId}|${paymentId}`)
        .digest('hex');

      // Gateway returns payment of ₹100 instead of ₹499
      const verifyRes = await handleVerifyPayment({
        orderId: createRes.order.id,
        razorpayOrderId: createRes.razorpayOrderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: sig
      }, {
        razorpayKeyId: 'rzp_test_key',
        razorpayKeySecret: secret,
        fetchFn: async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            id: paymentId,
            order_id: createRes.razorpayOrderId,
            amount: 10000, // ₹100 in subunits instead of 49900
            currency: 'INR',
            status: 'captured'
          })
        })
      });

      assert.equal(verifyRes.success, false);
      assert.match(verifyRes.error || '', /Payment amount mismatch/);
    });
  });

  // 3. Idempotency & Concurrency Safety
  describe('Idempotency & Replay Protection', () => {
    test('Repeated payment verification callback returns idempotent truthful success', async () => {
      const createRes = await handleCreateOrder({
        sku: 'SKU_BOOK_KHALIJI_STORIES',
        customerEmail: 'idempotent@peregrineacademy.in',
        customerName: 'Idempotent Buyer'
      }, { razorpayKeySecret: secret, skipGatewayFetch: true });

      const paymentId = 'pay_idemp_101';
      const sig = crypto.createHmac('sha256', secret)
        .update(`${createRes.razorpayOrderId}|${paymentId}`)
        .digest('hex');

      const firstVerify = await handleVerifyPayment({
        orderId: createRes.order.id,
        razorpayOrderId: createRes.razorpayOrderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: sig
      }, { razorpayKeySecret: secret, skipGatewayFetch: true });

      assert.equal(firstVerify.success, true);
      assert.equal(firstVerify.fulfillmentStatus, 'fulfilled');

      // Second verification replay with identical payment ID
      const secondVerify = await handleVerifyPayment({
        orderId: createRes.order.id,
        razorpayOrderId: createRes.razorpayOrderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: sig
      }, { razorpayKeySecret: secret, skipGatewayFetch: true });

      assert.equal(secondVerify.success, true);
      assert.equal(secondVerify.isDuplicate, true);
      assert.equal(secondVerify.fulfillmentStatus, 'fulfilled');
      assert.equal(secondVerify.order?.id, firstVerify.order?.id);
    });

    test('Duplicate webhook deliveries do not trigger duplicate entitlements', async () => {
      const createRes = await handleCreateOrder({
        sku: 'SKU_LMS_SPOKEN_ARABIC',
        customerEmail: 'wh.idemp@peregrineacademy.in',
        customerName: 'Webhook Buyer'
      }, { razorpayKeySecret: secret, skipGatewayFetch: true });

      const paymentPayload = JSON.stringify({
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: 'pay_wh_idemp_202',
              order_id: createRes.razorpayOrderId,
              amount: 149900,
              currency: 'INR',
              status: 'captured'
            }
          }
        }
      });

      const whSig = crypto.createHmac('sha256', webhookSecret)
        .update(paymentPayload)
        .digest('hex');

      const firstWh = await handleRazorpayWebhook(paymentPayload, whSig, { webhookSecret });
      assert.equal(firstWh.success, true);

      // Duplicate delivery of identical webhook
      const secondWh = await handleRazorpayWebhook(paymentPayload, whSig, { webhookSecret });
      assert.equal(secondWh.success, true);
      assert.equal(secondWh.isDuplicate, true);
    });
  });

  // 4. Provisioning Failure Recovery
  describe('Entitlement Delivery Failure Handling & Safe Retry', () => {
    test('Partial provisioning failure sets order to partially_provisioned without corrupting paid status', async () => {
      const createRes = await handleCreateOrder({
        sku: 'SKU_BUNDLE_ALL_IN_ONE',
        customerEmail: 'partial.fail@peregrineacademy.in',
        customerName: 'Partial Buyer'
      }, { razorpayKeySecret: secret, skipGatewayFetch: true });

      const paymentId = 'pay_partial_301';
      const sig = crypto.createHmac('sha256', secret)
        .update(`${createRes.razorpayOrderId}|${paymentId}`)
        .digest('hex');

      // Force failure on reader adapter
      const verifyRes = await handleVerifyPayment({
        orderId: createRes.order.id,
        razorpayOrderId: createRes.razorpayOrderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: sig
      }, {
        razorpayKeySecret: secret,
        skipGatewayFetch: true,
        provisioningOptions: {
          simulate: false,
          readerApiUrl: 'https://invalid-nonexistent-reader-url.com',
          handoffSecret: 'secret'
        }
      });

      assert.equal(verifyRes.paymentVerified, true);
      assert.equal(verifyRes.fulfillmentStatus, 'partially_provisioned');

      // Retry provisioning with simulation succeeds
      const retryRes = await handleRetryProvisioning(createRes.order.id, { simulate: true });
      assert.equal(retryRes.success, true);
      assert.equal(retryRes.order?.status, 'fulfilled');
    });
  });

  // 5. Mobile Checkout & Responsive UI Baseline
  describe('Mobile Responsiveness & UI Accessibility Standards', () => {
    const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');

    test('Ensures viewport meta with viewport-fit=cover for iOS safe areas', () => {
      assert.match(html, /viewport-fit=cover/);
    });

    test('Buttons and inputs maintain minimum 44px/48px touch targets for mobile accessibility', () => {
      assert.match(html, /min-h-\[44px\]/);
      assert.match(html, /min-h-\[48px\]/);
      assert.match(html, /touch-action:\s*manipulation/);
    });

    test('Retains optional Mobile / WhatsApp notification field with client validation', () => {
      assert.match(html, /id="cust-phone"/);
      assert.match(html, /Optional,\s*for\s*instant\s*notification/);
      assert.match(html, /validate|test\(phone\)/);
    });

    test('Includes clear success hub with direct dashboard and reader launch buttons', () => {
      assert.match(html, /id="checkout-success-section"/);
      assert.match(html, /id="success-entitlements-list"/);
      assert.match(html, /Open LMS Dashboard/);
      assert.match(html, /Claim & Open Digital Reader/);
    });

    test('Footer accurately attributes Dr. Muhammed Swalih T (PhD, EFLU Hyderabad)', () => {
      assert.match(html, /Directed by Dr\. Muhammed Swalih T \(PhD, EFLU Hyderabad\)/);
      assert.doesNotMatch(html, /JNU/);
    });
  });

  // 6. Meta Ads & Pixel Conversion Tracking Invariants
  describe('Meta Ads Readiness & Pixel Event Flow Verification', () => {
    const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');

    test('Meta Pixel base code and OpenGraph tags are present in HTML head', () => {
      assert.match(html, /connect\.facebook\.net\/en_US\/fbevents\.js/);
      assert.match(html, /meta-pixel-id/);
      assert.match(html, /property="og:image"/);
      assert.match(html, /property="og:title"/);
      assert.match(html, /property="og:description"/);
      assert.match(html, /twitter:card/);
    });

    test('ViewContent tracks dynamically on package view and selection change', () => {
      assert.match(html, /trackProductView/);
      assert.match(html, /fbq\('track',\s*'ViewContent'/);
    });

    test('InitiateCheckout fires on form checkout submission with active product price', () => {
      assert.match(html, /handleCheckoutSubmit/);
      assert.match(html, /fbq\('track',\s*'InitiateCheckout'/);
      assert.match(html, /value:\s*activeProduct\.priceInr/);
    });

    test('Purchase event is strictly gated to verified server response and deduplicated', () => {
      assert.match(html, /renderSuccessEntitlements/);
      assert.match(html, /!trackedPurchases\.has\(order\.orderNumber\)/);
      assert.match(html, /trackedPurchases\.add\(order\.orderNumber\)/);
      assert.match(html, /fbq\('track',\s*'Purchase'/);
      assert.match(html, /value:\s*order\.amountInr/);
      assert.match(html, /order_id:\s*order\.orderNumber/);
    });
  });
});
