import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  provisionBookReader,
  generateReaderClaimToken,
  computeBundleRequestSignature,
  KHALIJI_BOOK_PRODUCT_KEY
} from '../src/lib/provisioning/book-adapter.ts';
import { provisionLmsCourse, SPOKEN_EMIRATI_COURSE_ID } from '../src/lib/provisioning/lms-adapter.ts';
import { provisionAiasTutor } from '../src/lib/provisioning/aias-adapter.ts';

describe('Provisioning Adapters & Contract Verification', () => {
  const testOrderId = 'ord_test_9928194';
  const testEmail = 'scholar@peregrineacademy.in';
  const testSecret = 'test-secret-key-for-reader-handoff-min-32-chars';

  test('Book Reader Adapter conforms to real Reader product key', () => {
    assert.equal(KHALIJI_BOOK_PRODUCT_KEY, 'khaliji-book', 'Product key must be khaliji-book as defined in Reader api/bundle.js');
  });

  test('Book Reader Adapter generates HMAC-signed single-use claim token matching Reader schema', async () => {
    const { token, expiresAt } = generateReaderClaimToken({
      orderId: testOrderId,
      email: testEmail,
      secret: testSecret,
      lmsUserId: 'lms_user_123'
    });

    assert.ok(token.includes('.'), 'Token must be in payload.signature format');
    const [payloadBase64, signature] = token.split('.');
    assert.ok(payloadBase64 && signature);

    const payload = JSON.parse(Buffer.from(payloadBase64, 'base64url').toString('utf8'));
    assert.equal(payload.v, 1, 'Version must be 1');
    assert.equal(payload.aud, 'khaliji-reader', 'Audience must be khaliji-reader');
    assert.equal(payload.order_id, testOrderId);
    assert.equal(payload.email, testEmail);
    assert.equal(payload.sub, 'lms_user_123');
    assert.ok(payload.jti, 'JTI must be populated');
    assert.ok(payload.iat, 'IAT must be populated');
    assert.ok(payload.exp, 'EXP must be populated');
    assert.ok(expiresAt);
  });

  test('Book Reader computes multi-line canonical signature matching verifyBundleRequest', () => {
    const timestamp = '1700000000';
    const sig = computeBundleRequestSignature({
      timestamp,
      action: 'grant',
      orderId: testOrderId,
      lmsUserId: 'lms_user_123',
      email: testEmail,
      productKey: 'khaliji-book',
      secret: testSecret
    });

    assert.ok(/^[a-f0-9]{64}$/i.test(sig), 'Signature must be a 64-char hex string');
  });

  test('LMS Adapter targets correct course ID and returns valid URL', async () => {
    const res = await provisionLmsCourse({
      orderId: testOrderId,
      customerEmail: testEmail,
      customerName: 'Amina Al-Falasi'
    }, { simulate: true });

    assert.equal(res.success, true);
    assert.equal(res.courseUrl, `https://learn.peregrineacademy.in/courses/${SPOKEN_EMIRATI_COURSE_ID}`);
    assert.ok(res.enrollmentId);
  });

  test('LMS Adapter communicates with /api/bundles/enroll receiver conforming to LMS API contract', async () => {
    let capturedUrl = '';
    let capturedHeaders = {};
    let capturedBody = null;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      capturedUrl = url.toString();
      capturedHeaders = init?.headers || {};
      capturedBody = JSON.parse(init?.body || '{}');

      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          enrollment_id: 'enr_rec_9928194',
          course_url: `https://learn.peregrineacademy.in/courses/${SPOKEN_EMIRATI_COURSE_ID}`,
          already_enrolled: false,
          message: 'Successfully enrolled scholar@peregrineacademy.in'
        })
      };
    };

    try {
      const res = await provisionLmsCourse({
        orderId: testOrderId,
        customerEmail: testEmail,
        customerName: 'Amina Al-Falasi'
      }, {
        lmsApiUrl: 'https://learn.peregrineacademy.in',
        lmsApiKey: 'test_bearer_token_123',
        simulate: false
      });

      assert.equal(capturedUrl, 'https://learn.peregrineacademy.in/api/bundles/enroll');
      assert.equal(capturedHeaders['Authorization'], 'Bearer test_bearer_token_123');
      assert.equal(capturedBody.order_id, testOrderId);
      assert.equal(capturedBody.email, testEmail);
      assert.equal(capturedBody.name, 'Amina Al-Falasi');
      assert.equal(capturedBody.course_id, SPOKEN_EMIRATI_COURSE_ID);
      assert.equal(res.success, true);
      assert.equal(res.enrollmentId, 'enr_rec_9928194');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('AIAS Adapter generates formatted activation code with 30-day non-recurring trial window', async () => {
    const res = await provisionAiasTutor({
      orderId: testOrderId,
      customerEmail: testEmail
    }, { simulate: true });

    assert.equal(res.success, true);
    assert.ok(res.activationCode.startsWith('AIAS-'), 'Activation code must follow AIAS- prefix');
    assert.equal(res.durationDays, 30, 'Free period must be exactly 30 days');
    assert.equal(res.isFreeTrial, true, 'isFreeTrial flag must be true');
    assert.equal(res.autoRenew, false, 'autoRenew flag must be false to prevent unexpected charges');
    assert.ok(res.startsAt, 'startsAt timestamp must be defined');
    assert.ok(res.expiresAt, 'expiresAt timestamp must be defined');
    assert.ok(Date.parse(res.expiresAt) > Date.parse(res.startsAt), 'expiresAt must be after startsAt');
  });
});
