import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import netlifyHandler, { handler as netlifyV1Handler } from '../netlify/functions/api.ts';
import orderCreateHandler from '../netlify/functions/order-create.ts';
import orderVerifyHandler from '../netlify/functions/order-verify.ts';
import webhookHandler from '../netlify/functions/webhook-razorpay.ts';
import vercelHandler from '../api/index.ts';

describe('Serverless Deployment Adapters (Netlify & Vercel)', () => {
  const secret = 'test_serverless_secret_123';
  const webhookSecret = 'whsec_serverless_456';
  process.env.RAZORPAY_KEY_SECRET = secret;
  process.env.RAZORPAY_WEBHOOK_SECRET = webhookSecret;

  describe('Dedicated Netlify Functions Endpoints', () => {
    test('order-create function processes ₹499 book request', async () => {
      const req = new Request('https://example.com/.netlify/functions/order-create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sku: 'SKU_BOOK_KHALIJI_STORIES',
          customerEmail: 'dedicated.func@peregrineacademy.in',
          customerName: 'Dedicated Test'
        })
      });
      const res = await orderCreateHandler(req);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
    });

    test('order-create function processes bundle request for Complete Package at ₹1,998', async () => {
      const req = new Request('https://example.com/.netlify/functions/order-create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sku: 'SKU_BUNDLE_ALL_IN_ONE',
          customerEmail: 'dedicated.bundle@peregrineacademy.in',
          customerName: 'Dedicated Bundle'
        })
      });
      const res = await orderCreateHandler(req);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.amountInSubunits, 199800);
      assert.equal(data.order.amountInr, 1998);
    });

    test('order-create function strictly fails closed for invalid or unready SKU with 400', async () => {
      const req = new Request('https://example.com/.netlify/functions/order-create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sku: 'SKU_UNKNOWN_INVALID',
          customerEmail: 'invalid@example.com',
          customerName: 'Invalid'
        })
      });
      const res = await orderCreateHandler(req);
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
    });

    test('order-verify function rejects tampered signature', async () => {
      const req = new Request('https://example.com/.netlify/functions/order-verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderId: 'fake-id',
          razorpayOrderId: 'fake-order',
          razorpayPaymentId: 'fake-pay',
          razorpaySignature: 'bad-sig'
        })
      });
      const res = await orderVerifyHandler(req);
      assert.equal(res.status, 400);
    });

    test('webhook-razorpay function rejects invalid signature', async () => {
      const req = new Request('https://example.com/.netlify/functions/webhook-razorpay', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-razorpay-signature': 'bad_wh_sig'
        },
        body: JSON.stringify({ event: 'payment.captured' })
      });
      const res = await webhookHandler(req);
      assert.equal(res.status, 400);
    });
  });

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

    test('POST /api/order/create for Complete Package succeeds with 200', async () => {
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
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.amountInSubunits, 199800);
      assert.equal(data.order.amountInr, 1998);
    });

    test('POST /api/order/create strictly fails closed for invalid SKU with 400', async () => {
      const req = new Request('https://example.com/api/order/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sku: 'SKU_INVALID_FAKE',
          customerEmail: 'fake@example.com',
          customerName: 'Fake'
        })
      });
      const res = await netlifyHandler(req, {});
      assert.equal(res.status, 400);
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

    test('POST /api/order/create creates ₹1,998 bundle order', async () => {
      const res = await dispatchVercel('POST', '/api/order/create', {
        sku: 'SKU_BUNDLE_ALL_IN_ONE',
        customerEmail: 'vercel.bundle@peregrineacademy.in',
        customerName: 'Vercel Bundle User'
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.amountInSubunits, 199800);
    });

    test('POST /api/order/create rejects invalid SKU with 400', async () => {
      const res = await dispatchVercel('POST', '/api/order/create', {
        sku: 'SKU_INVALID_FAKE',
        customerEmail: 'invalid@example.com',
        customerName: 'Invalid'
      });
      assert.equal(res.status, 400);
      assert.equal(res.body.success, false);
    });
  });

  describe('Serverless Bundler Identifier Collision Protection (Regression Prevention)', () => {
    test('Zero files in src/, netlify/, and api/ declare top-level __filename or __dirname', async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const { fileURLToPath } = await import('node:url');

      const currentDir = path.dirname(fileURLToPath(import.meta.url));
      const rootDir = path.join(currentDir, '..');

      function scanDir(dir) {
        let results = [];
        if (!fs.existsSync(dir)) return results;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            results = results.concat(scanDir(fullPath));
          } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) {
            results.push(fullPath);
          }
        }
        return results;
      }

      const filesToScan = [
        ...scanDir(path.join(rootDir, 'src')),
        ...scanDir(path.join(rootDir, 'netlify')),
        ...scanDir(path.join(rootDir, 'api'))
      ];

      for (const filePath of filesToScan) {
        const content = fs.readFileSync(filePath, 'utf8');
        const hasConflict = /(const|let|var)\s+(__filename|__dirname)\b/.test(content);
        assert.equal(
          hasConflict,
          false,
          `File ${path.relative(rootDir, filePath)} contains forbidden declaration of __filename or __dirname which causes Netlify bundler SyntaxError collision.`
        );
      }
    });

    test('order-repository.ts uses safe modulePath and moduleDir identifiers', async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      const currentDir = path.dirname(fileURLToPath(import.meta.url));
      const repoFile = path.join(currentDir, '../src/lib/storage/order-repository.ts');
      const content = fs.readFileSync(repoFile, 'utf8');

      assert.match(content, /const\s+modulePath\s*=\s*fileURLToPath/);
      assert.match(content, /const\s+moduleDir\s*=\s*path\.dirname/);
      assert.doesNotMatch(content, /const\s+__filename/);
      assert.doesNotMatch(content, /const\s+__dirname/);
    });
  });
});
