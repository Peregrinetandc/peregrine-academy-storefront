import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import netlifyHandler, { handler as netlifyV1Handler } from '../netlify/functions/api.ts';
import vercelHandler from '../api/index.ts';

describe('Serverless Deployment Adapters (Netlify & Vercel)', () => {
  const secret = 'test_serverless_secret_123';
  const webhookSecret = 'whsec_serverless_456';
  process.env.RAZORPAY_KEY_SECRET = secret;
  process.env.RAZORPAY_WEBHOOK_SECRET = webhookSecret;

  describe('Netlify Functions V2 (Standard Web Request/Response)', () => {
    test('OPTIONS /api/order/create returns 204 CORS preflight', async () => {
      const req = new Request('https://example.com/api/order/create', {
        method: 'OPTIONS'
      });
      const res = await netlifyHandler(req, {});
      assert.equal(res.status, 204);
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
    });

    test('POST /api/order/create for Digital Arabic Book succeeds with 200', async () => {
      const req = new Request('https://example.com/api/order/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sku: 'SKU_BOOK_KHALIJI_STORIES',
          customerEmail: 'serverless.scholar@peregrineacademy.in',
          customerName: 'Fatima Al-Falasi'
        })
      });
      const res = await netlifyHandler(req, {});
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.amountInSubunits, 49900);
      assert.ok(data.order.id);
    });

    test('POST /api/order/create for Complete Package strictly fails closed (paused) with 400', async () => {
      const req = new Request('https://example.com/api/order/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sku: 'SKU_BUNDLE_ALL_IN_ONE',
          customerEmail: 'serverless.bundle@peregrineacademy.in',
          customerName: 'Test Bundle'
        })
      });
      const res = await netlifyHandler(req, {});
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.isPaused, true);
      assert.match(data.error, /undecided/);
    });

    test('POST /api/order/verify rejects invalid signature with 400', async () => {
      const req = new Request('https://example.com/api/order/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderId: 'ord_fake_999',
          razorpayOrderId: 'order_fake_rzp',
          razorpayPaymentId: 'pay_fake_rzp',
          razorpaySignature: 'invalid_tampered_sig'
        })
      });
      const res = await netlifyHandler(req, {});
      assert.equal(res.status, 400);
    });
  });

  describe('Netlify Functions V1 (Event/Context Legacy)', () => {
    test('POST /api/order/create for Digital Arabic Book succeeds via event', async () => {
      const event = {
        httpMethod: 'POST',
        path: '/.netlify/functions/api/order/create',
        body: JSON.stringify({
          sku: 'SKU_BOOK_KHALIJI_STORIES',
          customerEmail: 'v1.scholar@peregrineacademy.in',
          customerName: 'Zayed Al-Nuaimi'
        }),
        headers: { 'content-type': 'application/json' }
      };
      const res = await netlifyV1Handler(event, {});
      assert.equal(res.statusCode, 200);
      const data = JSON.parse(res.body);
      assert.equal(data.success, true);
      assert.equal(data.amountInSubunits, 49900);
    });
  });

  describe('Vercel Serverless Function (Node.js IncomingMessage / ServerResponse)', () => {
    async function dispatchVercel(method, urlPath, body = null, headers = {}) {
      return new Promise(async (resolve) => {
        const req = {
          method,
          url: urlPath,
          headers: { host: 'localhost:3000', ...headers },
          body
        };
        let statusCode = 200;
        const resHeaders = {};
        let resData = '';
        const res = {
          set statusCode(code) { statusCode = code; },
          get statusCode() { return statusCode; },
          setHeader(k, v) { resHeaders[k.toLowerCase()] = v; },
          end(chunk) {
            if (chunk) resData += chunk;
            resolve({
              status: statusCode,
              headers: resHeaders,
              body: resData ? JSON.parse(resData) : null
            });
          }
        };
        await vercelHandler(req, res);
      });
    }

    test('OPTIONS /api/order/create returns 204', async () => {
      const res = await dispatchVercel('OPTIONS', '/api/order/create');
      assert.equal(res.status, 204);
      assert.equal(res.headers['access-control-allow-origin'], '*');
    });

    test('POST /api/order/create creates ₹499 book order', async () => {
      const res = await dispatchVercel('POST', '/api/order/create', {
        sku: 'SKU_BOOK_KHALIJI_STORIES',
        customerEmail: 'vercel.test@peregrineacademy.in',
        customerName: 'Vercel Test User'
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.amountInSubunits, 49900);
    });

    test('POST /api/order/create rejects paused bundle with 400', async () => {
      const res = await dispatchVercel('POST', '/api/order/create', {
        sku: 'SKU_BUNDLE_ALL_IN_ONE',
        customerEmail: 'vercel.bundle@peregrineacademy.in',
        customerName: 'Vercel Bundle User'
      });
      assert.equal(res.status, 400);
      assert.equal(res.body.success, false);
      assert.equal(res.body.isPaused, true);
    });
  });
});
