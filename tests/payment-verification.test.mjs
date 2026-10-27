import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  verifyRazorpayPaymentSignature,
  verifyRazorpayWebhookSignature,
  generateHmacHandoffToken
} from '../src/lib/razorpay.ts';

describe('Server-Side Razorpay Payment & Webhook Verification', () => {
  const testSecret = 'secret_test_key_1234567890abcdef';
  const testOrderId = 'order_DA294jff93';
  const testPaymentId = 'pay_2948194810';

  test('Valid Razorpay payment signature verifies successfully', () => {
    const payload = `${testOrderId}|${testPaymentId}`;
    const validSignature = crypto
      .createHmac('sha256', testSecret)
      .update(payload)
      .digest('hex');

    const isValid = verifyRazorpayPaymentSignature({
      orderId: testOrderId,
      paymentId: testPaymentId,
      signature: validSignature,
      secret: testSecret
    });

    assert.equal(isValid, true, 'Valid signature must verify as true');
  });

  test('Tampered payment ID is strictly rejected', () => {
    const payload = `${testOrderId}|${testPaymentId}`;
    const validSignature = crypto
      .createHmac('sha256', testSecret)
      .update(payload)
      .digest('hex');

    const isValid = verifyRazorpayPaymentSignature({
      orderId: testOrderId,
      paymentId: 'pay_TAMPERED_ID',
      signature: validSignature,
      secret: testSecret
    });

    assert.equal(isValid, false, 'Tampered payment ID must fail verification');
  });

  test('Tampered signature string is strictly rejected', () => {
    const isValid = verifyRazorpayPaymentSignature({
      orderId: testOrderId,
      paymentId: testPaymentId,
      signature: 'bad_signature_hex_0000000000000000000000000000000000000000000000000000',
      secret: testSecret
    });

    assert.equal(isValid, false, 'Bad signature must fail verification');
  });

  test('Missing arguments gracefully return false without crashing', () => {
    assert.equal(
      verifyRazorpayPaymentSignature({
        orderId: '',
        paymentId: testPaymentId,
        signature: 'sig',
        secret: testSecret
      }),
      false
    );
  });

  test('Valid webhook signature verifies successfully', () => {
    const webhookSecret = 'whsec_99482848194';
    const rawBody = JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { id: testPaymentId, amount: 199900 } } }
    });

    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(rawBody)
      .digest('hex');

    const isValid = verifyRazorpayWebhookSignature({
      rawBody,
      signature: expectedSignature,
      webhookSecret
    });

    assert.equal(isValid, true, 'Valid webhook signature must verify as true');
  });

  test('Cross-service HMAC handoff token generates verifiable hex signature', () => {
    const payload = { order_id: testOrderId, email: 'student@example.com' };
    const token = generateHmacHandoffToken({ payload, secret: testSecret });

    const expected = crypto
      .createHmac('sha256', testSecret)
      .update(JSON.stringify(payload))
      .digest('hex');

    assert.equal(token, expected);
  });
});
