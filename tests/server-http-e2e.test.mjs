import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import server from '../server.js';

describe('Server-Level HTTP End-to-End Route Testing', () => {
  const secret = 'test_local_secret_999';
  const webhookSecret = 'whsec_test_123';
  process.env.RAZORPAY_KEY_SECRET = secret;
  process.env.RAZORPAY_WEBHOOK_SECRET = webhookSecret;

  async function dispatch(method, path, body = null, headers = {}) {
    const { Readable, Writable } = await import('node:stream');
    return new Promise((resolve) => {
      const serialized = body ? JSON.stringify(body) : '';
      const req = new Readable();
      req._read = () => {};
      req.method = method;
      req.url = path;
      req.headers = {
        host: 'localhost:3000',
        'content-type': 'application/json',
        ...headers
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

  test('GET / serves HTML containing primary checkout and exploration section below it', async () => {
    const { Readable, Writable } = await import('node:stream');
    const req = new Readable();
    req._read = () => {};
    req.method = 'GET';
    req.url = '/';
    req.headers = { host: 'localhost:3000' };
    const res = new Writable();
    let resBody = '';
    res.headers = {};
    res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
    res.writeHead = (status, h) => { res.statusCode = status; };
    res._write = (chunk, enc, cb) => { resBody += chunk.toString(); cb(); };
    
    await new Promise((resolve) => {
      res.end = (chunk) => {
        if (chunk) resBody += chunk.toString();
        resolve();
      };
      server.emit('request', req, res);
      req.push(null);
    });

    assert.equal(res.statusCode, 200);
    assert.ok(resBody.includes('Complete Your Arabic Learning Package'));
    assert.ok(resBody.includes('₹1,998'));
    assert.ok(resBody.includes('Explore Your Learning Package'));
    assert.ok(resBody.includes('https://learn.peregrineacademy.in/'));
    assert.ok(resBody.includes('https://arabic.peregrineacademy.in/'));
    assert.ok(resBody.includes('https://arabic.peregrineacademy.in/#ai-tutor'));
  });

  test('POST /api/order/create returns valid order and Razorpay order ID', async () => {
    const res = await dispatch('POST', '/api/order/create', {
      sku: 'SKU_BOOK_KHALIJI_STORIES',
      customerEmail: 'http.test@peregrineacademy.in',
      customerName: 'HTTP Test User'
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.ok(res.body.order.id);
    assert.ok(res.body.razorpayOrderId);
    assert.equal(res.body.amountInSubunits, 49900);
  });

  test('POST /api/order/verify strictly rejects tampered signature with HTTP 400', async () => {
    const createRes = await dispatch('POST', '/api/order/create', {
      sku: 'SKU_BOOK_KHALIJI_STORIES',
      customerEmail: 'tamper@peregrineacademy.in',
      customerName: 'Tamper Test'
    });

    const verifyRes = await dispatch('POST', '/api/order/verify', {
      orderId: createRes.body.order.id,
      razorpayOrderId: createRes.body.razorpayOrderId,
      razorpayPaymentId: 'pay_http_tamper',
      razorpaySignature: 'bad_signature_hex_00000000000000000000000000000000'
    });

    assert.equal(verifyRes.status, 400);
    assert.equal(verifyRes.body.success, false);
    assert.match(verifyRes.body.error, /Invalid Razorpay payment signature/);
  });

  test('POST /api/order/verify transitions order to fulfilled on valid signature', async () => {
    const createRes = await dispatch('POST', '/api/order/create', {
      sku: 'SKU_BOOK_KHALIJI_STORIES',
      customerEmail: 'valid.pay@peregrineacademy.in',
      customerName: 'Valid Pay User'
    });

    const orderId = createRes.body.order.id;
    const rzpOrderId = createRes.body.razorpayOrderId;
    const paymentId = 'pay_http_valid_101';
    const validSig = crypto.createHmac('sha256', secret).update(`${rzpOrderId}|${paymentId}`).digest('hex');

    const verifyRes = await dispatch('POST', '/api/order/verify', {
      orderId,
      razorpayOrderId: rzpOrderId,
      razorpayPaymentId: paymentId,
      razorpaySignature: validSig
    });

    assert.equal(verifyRes.status, 200);
    assert.equal(verifyRes.body.success, true);
    assert.equal(verifyRes.body.order.status, 'fulfilled');
    assert.equal(verifyRes.body.paymentVerified, true);
  });

  test('POST /api/order/verify handles replayed requests idempotently', async () => {
    const createRes = await dispatch('POST', '/api/order/create', {
      sku: 'SKU_BOOK_KHALIJI_STORIES',
      customerEmail: 'replay.http@peregrineacademy.in',
      customerName: 'Replay HTTP User'
    });

    const orderId = createRes.body.order.id;
    const rzpOrderId = createRes.body.razorpayOrderId;
    const paymentId = 'pay_http_replay_102';
    const validSig = crypto.createHmac('sha256', secret).update(`${rzpOrderId}|${paymentId}`).digest('hex');

    // First attempt
    const firstRes = await dispatch('POST', '/api/order/verify', {
      orderId,
      razorpayOrderId: rzpOrderId,
      razorpayPaymentId: paymentId,
      razorpaySignature: validSig
    });
    assert.equal(firstRes.status, 200);

    // Replay
    const replayRes = await dispatch('POST', '/api/order/verify', {
      orderId,
      razorpayOrderId: rzpOrderId,
      razorpayPaymentId: paymentId,
      razorpaySignature: validSig
    });
    assert.equal(replayRes.status, 200);
    assert.equal(replayRes.body.isDuplicate, true);
    assert.equal(replayRes.body.order.status, 'fulfilled');
  });

  test('POST /api/webhook/razorpay verifies webhook signature and transitions order', async () => {
    const createRes = await dispatch('POST', '/api/order/create', {
      sku: 'SKU_BOOK_KHALIJI_STORIES',
      customerEmail: 'webhook.http@peregrineacademy.in',
      customerName: 'Webhook HTTP User'
    });

    const rzpOrderId = createRes.body.razorpayOrderId;
    const whPayload = JSON.stringify({
      entity: 'event',
      account_id: 'acc_001',
      event: 'payment.captured',
      contains: ['payment'],
      payload: {
        payment: {
          entity: {
            id: 'pay_wh_http_103',
            order_id: rzpOrderId,
            amount: 49900,
            currency: 'INR',
            status: 'captured'
          }
        }
      },
      created_at: 1700000000
    });

    const whSig = crypto.createHmac('sha256', webhookSecret).update(whPayload).digest('hex');

    const whRes = await dispatch('POST', '/api/webhook/razorpay', JSON.parse(whPayload), {
      'x-razorpay-signature': whSig
    });

    assert.equal(whRes.status, 200);
    assert.equal(whRes.body.success, true);
    assert.equal(whRes.body.isDuplicate, false);
  });
});
