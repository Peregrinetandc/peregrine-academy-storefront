import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import server from '../server.js';
import { handleCreateOrder, handleVerifyPayment, handleRazorpayWebhook, reconcileOrderPayment } from '../src/api/orders.ts';
import { executeOrderProvisioning } from '../src/lib/provisioning/orchestrator.ts';
import { orderRepository } from '../src/lib/storage/order-repository.ts';
import { PRODUCT_CATALOG } from '../src/config/products.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Bundle Checkout Warning & Payment Safety Invariants', () => {

  const secret = 'test_safety_secret_xyz_777';
  const webhookSecret = 'whsec_safety_xyz_888';
  process.env.RAZORPAY_KEY_SECRET = secret;
  process.env.RAZORPAY_WEBHOOK_SECRET = webhookSecret;

  async function dispatchHttp(method, urlPath, body = null) {
    const { Readable, Writable } = await import('node:stream');
    return new Promise((resolve) => {
      const serialized = body ? JSON.stringify(body) : '';
      const req = new Readable();
      req._read = () => {};
      req.method = method;
      req.url = urlPath;
      req.headers = {
        host: 'localhost:3000',
        'content-type': 'application/json'
      };
      if (serialized) {
        req.headers['content-length'] = Buffer.byteLength(serialized);
      }
      const res = new Writable();
      let resBody = '';
      res.headers = {};
      res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
      res.writeHead = (status, h) => {
        res.statusCode = status;
        if (h) Object.assign(res.headers, h);
      };
      res._write = (chunk, enc, cb) => { resBody += chunk.toString(); cb(); };
      res.end = (chunk) => {
        if (chunk) resBody += chunk.toString();
        resolve({ status: res.statusCode, body: resBody ? JSON.parse(resBody) : null });
      };
      server.emit('request', req, res);
      if (serialized) req.push(serialized);
      req.push(null);
    });
  }

  // 1. Bundle checkout blocked in UI
  describe('UI Enforcement & Customer Form Protection', () => {
    const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');

    test('Button is disabled in HTML with appropriate accessibility and styling', () => {
      // Must contain disabled attribute and aria-disabled="true"
      assert.match(html, /<button[^>]*id="submit-pay-btn"[^>]*disabled/, 'Button must have disabled attribute');
      assert.match(html, /aria-disabled="true"/, 'Button must have aria-disabled="true"');
      assert.match(html, /cursor-not-allowed/, 'Button must show cursor-not-allowed');
      assert.match(html, /Proceed to Secure Payment/, 'Button must retain "Proceed to Secure Payment" label');
      assert.match(html, /Paused/, 'Button must visibly indicate Paused status');
    });

    test('Clear explanation of bundle pause is displayed in UI', () => {
      const expectedNotice = 'Because AIAS access limits and duration are undecided, bundle checkout cannot safely operate and is paused. Online payment is disabled.';
      assert.ok(html.includes(expectedNotice), 'UI must contain exact explanation of why bundle checkout is paused');
      assert.match(html, /id="bundle-safety-banner"/, 'Prominent safety banner must be present');
      assert.match(html, /id="bundle-disabled-explanation"/, 'Checkout button explanation must be present');
    });

    test('Customer contact information fields are preserved for layout fidelity', () => {
      assert.match(html, /id="cust-name"/, 'Full Name field must be preserved');
      assert.match(html, /id="cust-email"/, 'Email Address field must be preserved');
      assert.match(html, /id="cust-phone"/, 'Phone / WhatsApp field must be preserved');
    });

    test('Client-side script enforces IS_BUNDLE_PAUSED and halts before any API request', () => {
      assert.match(html, /const\s+IS_BUNDLE_PAUSED\s*=\s*true;/, 'Script must declare IS_BUNDLE_PAUSED = true');
      assert.match(html, /if\s*\(\s*IS_BUNDLE_PAUSED\s*\)\s*\{[\s\S]*?return\s+false;/, 'handleCheckoutSubmit must abort immediately if bundle is paused');
      assert.match(html, /orderForm\.addEventListener\('keydown'/, 'Keyboard Enter submission must be intercepted');
    });
  });

  // 2. Bundle order creation rejected server-side
  describe('Server-Side Order Creation Rejection', () => {
    test('handleCreateOrder strictly rejects SKU_BUNDLE_ALL_IN_ONE without test flag', async () => {
      const res = await handleCreateOrder({
        sku: 'SKU_BUNDLE_ALL_IN_ONE',
        customerEmail: 'scholar@peregrineacademy.in',
        customerName: 'Fatima Al-Nuaimi'
      });

      assert.equal(res.success, false);
      assert.equal(res.isPaused, true);
      assert.equal(res.order, null);
      assert.equal(res.razorpayOrderId, '');
      assert.match(res.error || '', /temporarily paused/);
      assert.match(res.error || '', /Because AIAS access limits and duration are undecided/);
    });

    test('Direct HTTP POST to /api/order/create for bundle returns 400 with pause explanation', async () => {
      const res = await dispatchHttp('POST', '/api/order/create', {
        sku: 'SKU_BUNDLE_ALL_IN_ONE',
        customerEmail: 'direct.hacker@example.com',
        customerName: 'Direct Attempt'
      });

      assert.equal(res.status, 400);
      assert.equal(res.body.success, false);
      assert.equal(res.body.isPaused, true);
      assert.match(res.body.error, /undecided/);
    });
  });

  // 3. Direct endpoint requests cannot bypass the restriction
  describe('Direct Endpoint Bypass Prevention', () => {
    test('handleVerifyPayment rejects verification for an unauthorized bundle order', async () => {
      // Craft an unapproved bundle order in local storage
      const unauthorizedBundleOrder = {
        id: 'ord_unauthorized_bundle_99',
        orderNumber: 'PRGN-20261027-UNAUTH',
        customerEmail: 'intruder@example.com',
        customerName: 'Intruder',
        sku: 'SKU_BUNDLE_ALL_IN_ONE',
        amountInr: 1998,
        currency: 'INR',
        status: 'pending_payment',
        razorpayOrderId: 'order_fake_rzp_99',
        items: [
          {
            id: 'item-u1',
            sku: 'SKU_BUNDLE_ALL_IN_ONE',
            name: 'Complete Arabic Learning Package',
            targetPlatform: 'AIAS',
            unitPriceInr: 1998,
            quantity: 1,
            provisioningStatus: 'pending',
            retryCount: 0
          }
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await orderRepository.save(unauthorizedBundleOrder);

      const secret = 'test_safety_secret_xyz_777';
      const fakePaymentId = 'pay_fake_unauth_99';
      const validSig = crypto
        .createHmac('sha256', secret)
        .update(`order_fake_rzp_99|${fakePaymentId}`)
        .digest('hex');

      const verifyRes = await handleVerifyPayment(
        {
          orderId: unauthorizedBundleOrder.id,
          razorpayOrderId: 'order_fake_rzp_99',
          razorpayPaymentId: fakePaymentId,
          razorpaySignature: validSig
        },
        { razorpayKeySecret: secret, skipGatewayFetch: true }
      );

      assert.equal(verifyRes.success, false);
      assert.match(verifyRes.error || '', /Payment verification forbidden/);
      assert.match(verifyRes.error || '', /undecided/);

      // Verify status was NOT transitioned to paid or fulfilled
      const current = await orderRepository.get(unauthorizedBundleOrder.id);
      assert.equal(current?.status, 'pending_payment');
    });

    test('handleRazorpayWebhook rejects fulfillment for an unauthorized bundle order', async () => {
      const webhookBundleOrder = {
        id: 'ord_wh_bundle_unauth_88',
        orderNumber: 'PRGN-20261027-WHUNAUTH',
        customerEmail: 'wh.intruder@example.com',
        customerName: 'Webhook Intruder',
        sku: 'SKU_BUNDLE_ALL_IN_ONE',
        amountInr: 1998,
        currency: 'INR',
        status: 'pending_payment',
        razorpayOrderId: 'order_wh_rzp_88',
        items: [
          {
            id: 'item-wh1',
            sku: 'SKU_AIAS_TUTOR_PASS',
            name: 'AI Speaking Partner',
            targetPlatform: 'AIAS',
            unitPriceInr: 0,
            quantity: 1,
            provisioningStatus: 'pending',
            retryCount: 0
          }
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await orderRepository.save(webhookBundleOrder);

      const webhookPayload = JSON.stringify({
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: 'pay_wh_888',
              order_id: 'order_wh_rzp_88',
              amount: 199800,
              status: 'captured'
            }
          }
        }
      });

      const whSig = crypto
        .createHmac('sha256', webhookSecret)
        .update(webhookPayload)
        .digest('hex');

      const whResult = await handleRazorpayWebhook(webhookPayload, whSig, {
        webhookSecret
      });

      assert.equal(whResult.success, false);
      assert.match(whResult.error || '', /Webhook fulfillment rejected/);
      assert.match(whResult.error || '', /undecided/);

      // Ensure order remained pending_payment
      const current = await orderRepository.get(webhookBundleOrder.id);
      assert.equal(current?.status, 'pending_payment');
    });

    test('reconcileOrderPayment strictly rejects reconciliation for paused bundle orders', async () => {
      const recBundleOrder = {
        id: 'ord_rec_bundle_unauth_77',
        orderNumber: 'PRGN-20261027-RECUNAUTH',
        customerEmail: 'rec.intruder@example.com',
        customerName: 'Reconcile Intruder',
        sku: 'SKU_BUNDLE_ALL_IN_ONE',
        amountInr: 1998,
        currency: 'INR',
        status: 'pending_payment',
        razorpayOrderId: 'order_rec_rzp_77',
        razorpayPaymentId: 'pay_rec_777',
        items: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await orderRepository.save(recBundleOrder);

      const recRes = await reconcileOrderPayment(recBundleOrder.id);
      assert.equal(recRes.reconciled, false);
      assert.match(recRes.error || '', /Reconciliation forbidden/);
    });
  });

  // 4. No bundle access granted without valid authorized payment
  describe('Fulfillment Access Control & State Machine Defense', () => {
    test('executeOrderProvisioning refuses to fulfill unauthorized bundle order', async () => {
      const unauthOrder = {
        id: 'ord_prov_gate_55',
        orderNumber: 'PRGN-20261027-PROV55',
        customerEmail: 'prov@example.com',
        customerName: 'Prov Test',
        sku: 'SKU_BUNDLE_ALL_IN_ONE',
        amountInr: 1998,
        currency: 'INR',
        status: 'paid',
        items: [
          {
            id: 'item-p1',
            sku: 'SKU_AIAS_TUTOR_PASS',
            name: 'AI Speaking Partner',
            targetPlatform: 'AIAS',
            unitPriceInr: 0,
            quantity: 1,
            provisioningStatus: 'pending',
            retryCount: 0
          }
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      const result = await executeOrderProvisioning(unauthOrder, { simulate: false });
      assert.equal(result.allSucceeded, false);
      assert.equal(result.provisionedCount, 0);
      assert.match(result.itemResults[0].error || '', /Provisioning forbidden/);
    });
  });

  // 5. Other permitted product checkouts remain unaffected
  describe('Preservation of Permitted Single Product Checkouts', () => {
    test('Digital Arabic Book (SKU_BOOK_KHALIJI_STORIES, ₹499) checkout remains fully functional', async () => {
      const createRes = await handleCreateOrder({
        sku: 'SKU_BOOK_KHALIJI_STORIES',
        customerEmail: 'scholar.book@peregrineacademy.in',
        customerName: 'Zayed Al-Falasi',
        customerPhone: '+971501112233'
      });

      assert.equal(createRes.success, true);
      assert.ok(createRes.order);
      assert.equal(createRes.order.sku, 'SKU_BOOK_KHALIJI_STORIES');
      assert.equal(createRes.order.amountInr, 499);
      assert.equal(createRes.amountInSubunits, 49900);
      assert.ok(createRes.razorpayOrderId);
      assert.equal(createRes.isPaused, undefined);

      // Verify payment verification for book works
      const bookOrderId = createRes.order.id;
      const rzpOrderId = createRes.razorpayOrderId;
      const paymentId = 'pay_book_valid_1001';
      const sig = crypto
        .createHmac('sha256', secret)
        .update(`${rzpOrderId}|${paymentId}`)
        .digest('hex');

      const verifyRes = await handleVerifyPayment(
        {
          orderId: bookOrderId,
          razorpayOrderId: rzpOrderId,
          razorpayPaymentId: paymentId,
          razorpaySignature: sig
        },
        { razorpayKeySecret: secret, skipGatewayFetch: true }
      );

      assert.equal(verifyRes.success, true);
      assert.equal(verifyRes.paymentVerified, true);
      assert.equal(verifyRes.fulfillmentStatus, 'fulfilled');
      assert.equal(verifyRes.order?.items[0].provisioningStatus, 'granted');
      assert.ok(verifyRes.order?.items[0].claimUrl);
      assert.ok(verifyRes.order?.items[0].claimToken);
    });

    test('Spoken Arabic LMS Course (SKU_LMS_SPOKEN_ARABIC, ₹1,499) checkout remains fully functional', async () => {
      const createRes = await handleCreateOrder({
        sku: 'SKU_LMS_SPOKEN_ARABIC',
        customerEmail: 'lms.student@peregrineacademy.in',
        customerName: 'Tariq Al-Hashemi'
      });

      assert.equal(createRes.success, true);
      assert.equal(createRes.order.amountInr, 1499);
      assert.equal(createRes.amountInSubunits, 149900);
    });
  });

});
