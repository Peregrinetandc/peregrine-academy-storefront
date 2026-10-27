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

describe('Bundle Checkout Readiness & Production Safety Invariants', () => {

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

  // 1. UI Verification & Customer Form Readiness
  describe('UI Enforcement & Product Options Display', () => {
    const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');

    test('Button is enabled and active in HTML for immediate customer purchases', () => {
      assert.doesNotMatch(html, /<button[^>]*id="submit-pay-btn"[^>]*disabled/, 'Button must not have disabled attribute');
      assert.doesNotMatch(html, /aria-disabled="true"/, 'Button must not have aria-disabled');
      assert.doesNotMatch(html, /cursor-not-allowed/, 'Button must not have cursor-not-allowed');
      assert.match(html, /Proceed to Secure Payment/, 'Button must retain "Proceed to Secure Payment" label');
      assert.match(html, /₹1,998/, 'Button must display active package price ₹1,998');
    });

    test('Obsolete pause banners and disabled checkout notices are removed from UI', () => {
      assert.doesNotMatch(html, /id="bundle-safety-banner"/, 'Obsolete safety banner must be removed');
      assert.doesNotMatch(html, /id="bundle-disabled-explanation"/, 'Obsolete disabled explanation must be removed');
      assert.doesNotMatch(html, /Online payment is disabled/, 'Online payment disabled text must be removed');
      assert.doesNotMatch(html, /Checkout Temporarily Disabled/, 'Temporarily disabled notice must be removed');
    });

    test('Customer contact information fields are preserved for layout fidelity', () => {
      assert.match(html, /id="cust-name"/, 'Full Name field must be preserved');
      assert.match(html, /id="cust-email"/, 'Email Address field must be preserved');
      assert.match(html, /id="cust-phone"/, 'Phone / WhatsApp field must be preserved');
    });

    test('Presents clear purchase options for Bundle (₹1,998), LMS Course (₹1,499), and Book (₹499)', () => {
      assert.match(html, /id="card-bundle"/, 'Bundle purchase card must be present');
      assert.match(html, /id="card-lms"/, 'LMS Course purchase card must be present');
      assert.match(html, /id="card-book"/, 'Digital Book purchase card must be present');
      assert.match(html, /AI Speaking Partner/, 'AI Speaking Partner information must be present');
      assert.match(html, /Preview Available/, 'AI Speaking Partner preview badge must be present');
    });
  });

  // 2. Active Bundle Order Creation & Processing
  describe('Server-Side Order Creation for Active Bundle', () => {
    test('handleCreateOrder successfully creates order for SKU_BUNDLE_ALL_IN_ONE at ₹1,998', async () => {
      const res = await handleCreateOrder({
        sku: 'SKU_BUNDLE_ALL_IN_ONE',
        customerEmail: 'scholar.bundle@peregrineacademy.in',
        customerName: 'Fatima Al-Nuaimi',
        customerPhone: '+971501234567'
      });

      assert.equal(res.success, true);
      assert.equal(res.isPaused, undefined);
      assert.ok(res.order);
      assert.equal(res.order.amountInr, 1998);
      assert.equal(res.amountInSubunits, 199800);
      assert.ok(res.razorpayOrderId);
      assert.equal(res.order.items.length, 2, 'Bundle must contain LMS Course and Spoken Book');
      assert.ok(res.order.items.some(i => i.sku === 'SKU_LMS_SPOKEN_ARABIC'));
      assert.ok(res.order.items.some(i => i.sku === 'SKU_BOOK_KHALIJI_STORIES'));
    });

    test('Direct HTTP POST to /api/order/create for bundle returns 200 with order details', async () => {
      const res = await dispatchHttp('POST', '/api/order/create', {
        sku: 'SKU_BUNDLE_ALL_IN_ONE',
        customerEmail: 'api.student@peregrineacademy.in',
        customerName: 'API Customer'
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.order.amountInr, 1998);
    });

    test('handleCreateOrder rejects orders with invalid or non-existent SKUs', async () => {
      const res = await handleCreateOrder({
        sku: 'SKU_NON_EXISTENT_UNKNOWN',
        customerEmail: 'invalid@example.com',
        customerName: 'Test'
      });
      assert.equal(res.success, false);
      assert.match(res.error || '', /Invalid SKU/);
    });
  });

  // 3. Verification & Provisioning Invariants
  describe('Bundle Payment Verification & Fulfillment', () => {
    test('handleVerifyPayment authoritatively transitions bundle order to paid and fulfills both LMS and Book', async () => {
      const createRes = await handleCreateOrder({
        sku: 'SKU_BUNDLE_ALL_IN_ONE',
        customerEmail: 'verified.bundle@peregrineacademy.in',
        customerName: 'Amina Al-Nuaimi'
      });

      assert.equal(createRes.success, true);
      const orderId = createRes.order.id;
      const rzpOrderId = createRes.razorpayOrderId;
      const paymentId = 'pay_bundle_verified_777';

      const sig = crypto
        .createHmac('sha256', secret)
        .update(`${rzpOrderId}|${paymentId}`)
        .digest('hex');

      const verifyRes = await handleVerifyPayment(
        {
          orderId,
          razorpayOrderId: rzpOrderId,
          razorpayPaymentId: paymentId,
          razorpaySignature: sig
        },
        { razorpayKeySecret: secret, skipGatewayFetch: true }
      );

      assert.equal(verifyRes.success, true);
      assert.equal(verifyRes.paymentVerified, true);
      assert.equal(verifyRes.fulfillmentStatus, 'fulfilled');
      assert.equal(verifyRes.order?.status, 'fulfilled');

      const lmsItem = verifyRes.order?.items.find(i => i.sku === 'SKU_LMS_SPOKEN_ARABIC');
      const bookItem = verifyRes.order?.items.find(i => i.sku === 'SKU_BOOK_KHALIJI_STORIES');

      assert.ok(lmsItem);
      assert.equal(lmsItem.provisioningStatus, 'granted');
      assert.ok(lmsItem.claimUrl.includes('learn.peregrineacademy.in'));

      assert.ok(bookItem);
      assert.equal(bookItem.provisioningStatus, 'granted');
      assert.ok(bookItem.claimToken);
      assert.ok(bookItem.claimUrl.includes('arabic.peregrineacademy.in'));
    });

    test('Safety gate rejects verification if order was explicitly created under isPaused flag', async () => {
      const pausedOrder = {
        id: 'ord_explicit_paused_99',
        orderNumber: 'PRGN-20261027-PAUSED99',
        customerEmail: 'paused@example.com',
        customerName: 'Paused Customer',
        sku: 'SKU_BUNDLE_ALL_IN_ONE',
        amountInr: 1998,
        currency: 'INR',
        status: 'pending_payment',
        razorpayOrderId: 'order_paused_rzp_99',
        items: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: { isPaused: true }
      };
      await orderRepository.save(pausedOrder);

      const fakePaymentId = 'pay_fake_paused_99';
      const validSig = crypto
        .createHmac('sha256', secret)
        .update(`order_paused_rzp_99|${fakePaymentId}`)
        .digest('hex');

      const verifyRes = await handleVerifyPayment(
        {
          orderId: pausedOrder.id,
          razorpayOrderId: 'order_paused_rzp_99',
          razorpayPaymentId: fakePaymentId,
          razorpaySignature: validSig
        },
        { razorpayKeySecret: secret, skipGatewayFetch: true }
      );

      assert.equal(verifyRes.success, false);
      assert.match(verifyRes.error || '', /Payment verification forbidden/);
    });
  });

  // 4. Preservation of Permitted Single Product Checkouts
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
