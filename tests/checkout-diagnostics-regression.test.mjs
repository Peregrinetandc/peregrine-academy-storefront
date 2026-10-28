import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  handleCreateOrder,
  handleVerifyPayment,
  handleRazorpayWebhook,
  getActiveOrderRepository,
  setOrderRepositoryForTesting,
  isProductionEnvironment
} from '../src/api/orders.ts';
import {
  createRazorpayOrder,
  fetchRazorpayPayment,
  captureRazorpayPayment
} from '../src/lib/razorpay.ts';
import { orderRepository, LocalOrderRepository } from '../src/lib/storage/order-repository.ts';
import { SupabaseOrderRepository } from '../src/lib/storage/supabase-order-repository.ts';

describe('Live Checkout Failure Diagnostics & Regression Invariants Suite', () => {
  const originalEnv = { ...process.env };
  const mockKeyId = 'rzp_test_diag_suite_01';
  const mockKeySecret = 'test_secret_for_diag_suite_998877';
  const mockWebhookSecret = 'whsec_test_diag_suite_445566';

  beforeEach(async () => {
    process.env = { ...originalEnv };
    setOrderRepositoryForTesting(null);
    await orderRepository.clearForTesting();
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    setOrderRepositoryForTesting(null);
    await orderRepository.clearForTesting();
  });

  // 1. Missing Gateway Credentials Invariant
  test('1. Missing gateway credentials in production strictly fails closed and never returns synthetic order', async () => {
    // Simulate Netlify production environment
    process.env.CONTEXT = 'production';
    process.env.NETLIFY = 'true';
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;

    // Supabase credentials present to isolate gateway check
    process.env.SUPABASE_URL = 'https://mock.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service_role_test_key';
    const mockRepo = new LocalOrderRepository();
    setOrderRepositoryForTesting(mockRepo);

    const res = await handleCreateOrder({
      sku: 'SKU_BOOK_KHALIJI_STORIES',
      customerEmail: 'missing.creds@peregrineacademy.in',
      customerName: 'Missing Creds Test'
    });

    assert.equal(res.success, false, 'Must fail closed when credentials missing in production');
    assert.match(res.error || '', /Razorpay payment gateway credentials are not configured in production/i);
    assert.equal(res.razorpayOrderId, '', 'Must not return synthetic order ID');
    assert.equal(res.testMode, undefined, 'Must not report testMode success');
  });

  // 2. Gateway Order-Creation Failure Invariant
  test('2. Gateway order-creation failure from Razorpay API is safely caught and fails closed', async () => {
    const mockFetch401 = async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({
        error: {
          code: 'BAD_REQUEST_ERROR',
          description: 'The id provided does not exist or invalid credentials'
        }
      })
    });

    const res = await handleCreateOrder(
      {
        sku: 'SKU_BOOK_KHALIJI_STORIES',
        customerEmail: 'api.error@peregrineacademy.in',
        customerName: 'API Error Scholar'
      },
      {
        razorpayKeyId: 'rzp_live_invalid_key_example',
        razorpayKeySecret: 'invalid_secret_example',
        fetchFn: mockFetch401
      }
    );

    assert.equal(res.success, false, 'Must fail closed when gateway returns error');
    assert.match(res.error || '', /Payment gateway order creation failed/i);
    assert.match(res.error || '', /Razorpay Order Creation Failed \(401\)/i);
    assert.equal(res.razorpayOrderId, '', 'Must not return order ID on gateway failure');
  });

  // 3. Database Unavailable Invariant
  test('3. Database unavailable or unconfigured in production blocks orders and prevents ephemeral fallback', async () => {
    process.env.CONTEXT = 'production';
    delete process.env.SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    assert.throws(
      () => {
        getActiveOrderRepository();
      },
      /PRODUCTION SAFETY BLOCKER: Missing mandatory database credentials/
    );
  });

  test('3b. Database HTTP failure propagates cleanly without swallowing during order save', async () => {
    const mockDbFetchError = async () => ({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      text: async () => 'Database maintenance mode'
    });

    const supabaseRepo = new SupabaseOrderRepository({
      supabaseUrl: 'https://test-prod-project.supabase.co',
      serviceRoleKey: 'test_service_role_key_value',
      fetchFn: mockDbFetchError
    });

    await assert.rejects(
      async () => {
        await supabaseRepo.save({
          id: 'test_order_fail',
          orderNumber: 'PRGN-TEST-503',
          customerEmail: 'student@example.com',
          customerName: 'Student',
          sku: 'SKU_BOOK_KHALIJI_STORIES',
          items: [],
          amountInr: 499,
          currency: 'INR',
          status: 'pending_payment',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
      },
      /HTTP 503/
    );
  });

  // 4. Order Not Found During Verification Invariant
  test('4. Order not found during verification returns 400 with sanitized error', async () => {
    const nonExistentOrderId = '00000000-0000-0000-0000-000000000000';
    const verifyRes = await handleVerifyPayment(
      {
        orderId: nonExistentOrderId,
        razorpayOrderId: 'order_nonexistent_12345',
        razorpayPaymentId: 'pay_nonexistent_12345',
        razorpaySignature: 'dummy_sig_12345'
      },
      {
        razorpayKeyId: mockKeyId,
        razorpayKeySecret: mockKeySecret
      }
    );

    assert.equal(verifyRes.success, false);
    assert.equal(verifyRes.error, `Order not found: ${nonExistentOrderId}`);
  });

  // 5. Invalid Signature Invariant
  test('5. Invalid or tampered signature is strictly rejected and keeps order pending', async () => {
    const createRes = await handleCreateOrder(
      {
        sku: 'SKU_BOOK_KHALIJI_STORIES',
        customerEmail: 'tamper@peregrineacademy.in',
        customerName: 'Tamper Scholar'
      },
      {
        razorpayKeyId: mockKeyId,
        razorpayKeySecret: mockKeySecret,
        fetchFn: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ id: 'order_rzp_valid_sig_test', entity: 'order', status: 'created' })
        })
      }
    );

    assert.equal(createRes.success, true);
    const orderId = createRes.order.id;
    const rzpOrderId = createRes.razorpayOrderId;

    const verifyRes = await handleVerifyPayment(
      {
        orderId,
        razorpayOrderId: rzpOrderId,
        razorpayPaymentId: 'pay_valid_attempt_01',
        razorpaySignature: 'invalid_forged_signature_00000000000000000000000000000000'
      },
      {
        razorpayKeyId: mockKeyId,
        razorpayKeySecret: mockKeySecret,
        skipGatewayFetch: true
      }
    );

    assert.equal(verifyRes.success, false);
    assert.match(verifyRes.error || '', /Invalid Razorpay payment signature/);

    const storedOrder = await orderRepository.get(orderId);
    assert.equal(storedOrder?.status, 'pending_payment', 'Order must remain unpaid');
  });

  // 6. Uncaptured Payment Invariant
  test('6. Uncaptured payment (authorized but capture failed) strictly rejects fulfillment', async () => {
    const createRes = await handleCreateOrder(
      {
        sku: 'SKU_BOOK_KHALIJI_STORIES',
        customerEmail: 'uncaptured@peregrineacademy.in',
        customerName: 'Uncaptured Scholar'
      },
      {
        razorpayKeyId: mockKeyId,
        razorpayKeySecret: mockKeySecret,
        fetchFn: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ id: 'order_uncaptured_test', entity: 'order', status: 'created' })
        })
      }
    );

    const orderId = createRes.order.id;
    const rzpOrderId = createRes.razorpayOrderId;
    const paymentId = 'pay_authorized_not_captured';

    const validSig = crypto
      .createHmac('sha256', mockKeySecret)
      .update(`${rzpOrderId}|${paymentId}`)
      .digest('hex');

    // Gateway mock returning payment in authorized status, capture failing
    const mockFetchUncaptured = async (url, opts) => {
      const urlStr = url.toString();
      if (urlStr.includes('/capture')) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: { description: 'Auto-capture window elapsed' } })
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
          status: 'authorized', // NOT captured!
          order_id: rzpOrderId,
          captured: false
        })
      };
    };

    const verifyRes = await handleVerifyPayment(
      {
        orderId,
        razorpayOrderId: rzpOrderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: validSig
      },
      {
        razorpayKeyId: mockKeyId,
        razorpayKeySecret: mockKeySecret,
        skipGatewayFetch: false,
        fetchFn: mockFetchUncaptured
      }
    );

    assert.equal(verifyRes.success, false);
    assert.match(verifyRes.error || '', /Payment is authorized but capture could not be completed/);

    const storedOrder = await orderRepository.get(orderId);
    assert.equal(storedOrder?.status, 'pending_payment', 'Order must NOT be marked paid or fulfilled');
  });

  // 7. Duplicate Webhook or Callback Idempotency Invariant
  test('7. Duplicate callbacks and webhooks succeed idempotently without duplicate entitlements', async () => {
    const createRes = await handleCreateOrder(
      {
        sku: 'SKU_BOOK_KHALIJI_STORIES',
        customerEmail: 'idempotent@peregrineacademy.in',
        customerName: 'Idempotency Scholar'
      },
      {
        razorpayKeyId: mockKeyId,
        razorpayKeySecret: mockKeySecret,
        fetchFn: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ id: 'order_idempotent_test', entity: 'order', status: 'created' })
        })
      }
    );

    const orderId = createRes.order.id;
    const rzpOrderId = createRes.razorpayOrderId;
    const paymentId = 'pay_idempotent_test_01';

    const validSig = crypto
      .createHmac('sha256', mockKeySecret)
      .update(`${rzpOrderId}|${paymentId}`)
      .digest('hex');

    // 1st Callback: transitions to fulfilled
    const firstCall = await handleVerifyPayment(
      {
        orderId,
        razorpayOrderId: rzpOrderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: validSig
      },
      {
        razorpayKeyId: mockKeyId,
        razorpayKeySecret: mockKeySecret,
        skipGatewayFetch: true
      }
    );
    assert.equal(firstCall.success, true);
    assert.equal(firstCall.fulfillmentStatus, 'fulfilled');
    assert.equal(firstCall.isDuplicate, undefined);

    // 2nd Duplicate Callback: returns idempotent success
    const secondCall = await handleVerifyPayment(
      {
        orderId,
        razorpayOrderId: rzpOrderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: validSig
      },
      {
        razorpayKeyId: mockKeyId,
        razorpayKeySecret: mockKeySecret,
        skipGatewayFetch: true
      }
    );
    assert.equal(secondCall.success, true);
    assert.equal(secondCall.isDuplicate, true);
    assert.equal(secondCall.fulfillmentStatus, 'fulfilled');

    // 3rd Duplicate Webhook: returns idempotent success
    const webhookPayload = JSON.stringify({
      entity: 'event',
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
    const webhookSig = crypto
      .createHmac('sha256', mockWebhookSecret)
      .update(webhookPayload)
      .digest('hex');

    const webhookRes = await handleRazorpayWebhook(webhookPayload, webhookSig, {
      webhookSecret: mockWebhookSecret
    });
    assert.equal(webhookRes.success, true);
    assert.equal(webhookRes.isDuplicate, true);
  });

  // 8. Product Purchase Journey: Book-only ₹499 purchase & Reader claim token entitlement
  test('8. Book-only ₹499 purchase creates real gateway order and grants Reader entitlement', async () => {
    const createRes = await handleCreateOrder(
      {
        sku: 'SKU_BOOK_KHALIJI_STORIES',
        customerEmail: 'book.only@peregrineacademy.in',
        customerName: 'Book Scholar'
      },
      {
        razorpayKeyId: mockKeyId,
        razorpayKeySecret: mockKeySecret,
        fetchFn: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ id: 'order_book_only_499', entity: 'order', status: 'created', amount: 49900 })
        })
      }
    );

    assert.equal(createRes.success, true);
    assert.equal(createRes.order.amountInr, 499);
    assert.equal(createRes.order.items.length, 1);
    assert.equal(createRes.order.items[0].targetPlatform, 'BOOK_READER');

    const paymentId = 'pay_book_only_succ';
    const validSig = crypto
      .createHmac('sha256', mockKeySecret)
      .update(`${createRes.razorpayOrderId}|${paymentId}`)
      .digest('hex');

    const verifyRes = await handleVerifyPayment(
      {
        orderId: createRes.order.id,
        razorpayOrderId: createRes.razorpayOrderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: validSig
      },
      {
        razorpayKeyId: mockKeyId,
        razorpayKeySecret: mockKeySecret,
        skipGatewayFetch: true
      }
    );

    assert.equal(verifyRes.success, true);
    assert.equal(verifyRes.order?.status, 'fulfilled');
    const bookItem = verifyRes.order?.items.find(i => i.targetPlatform === 'BOOK_READER');
    assert.equal(bookItem?.provisioningStatus, 'granted');
    assert.ok(bookItem?.claimToken, 'Must generate book claim token');
    assert.ok(bookItem?.claimUrl?.includes('/claim?token='), 'Must generate book claim URL');
  });

  // 9. Product Purchase Journey: Course-only ₹1,499 purchase & LMS enrollment
  test('9. Course-only ₹1,499 purchase creates real gateway order and enrolls in LMS', async () => {
    const createRes = await handleCreateOrder(
      {
        sku: 'SKU_LMS_SPOKEN_ARABIC',
        customerEmail: 'course.only@peregrineacademy.in',
        customerName: 'Course Scholar'
      },
      {
        razorpayKeyId: mockKeyId,
        razorpayKeySecret: mockKeySecret,
        fetchFn: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ id: 'order_course_only_1499', entity: 'order', status: 'created', amount: 149900 })
        })
      }
    );

    assert.equal(createRes.success, true);
    assert.equal(createRes.order.amountInr, 1499);
    assert.equal(createRes.order.items.length, 1);
    assert.equal(createRes.order.items[0].targetPlatform, 'LMS');

    const paymentId = 'pay_course_only_succ';
    const validSig = crypto
      .createHmac('sha256', mockKeySecret)
      .update(`${createRes.razorpayOrderId}|${paymentId}`)
      .digest('hex');

    const verifyRes = await handleVerifyPayment(
      {
        orderId: createRes.order.id,
        razorpayOrderId: createRes.razorpayOrderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: validSig
      },
      {
        razorpayKeyId: mockKeyId,
        razorpayKeySecret: mockKeySecret,
        skipGatewayFetch: true
      }
    );

    assert.equal(verifyRes.success, true);
    assert.equal(verifyRes.order?.status, 'fulfilled');
    const lmsItem = verifyRes.order?.items.find(i => i.targetPlatform === 'LMS');
    assert.equal(lmsItem?.provisioningStatus, 'granted');
    assert.ok(lmsItem?.claimUrl?.includes('learn.peregrineacademy.in'), 'Must generate LMS course access URL');
  });

  // 10. Product Purchase Journey: Bundle ₹1,998 purchase & multi-platform fulfillment
  test('10. Bundle ₹1,998 purchase creates real gateway order and fulfills both LMS and Reader', async () => {
    const createRes = await handleCreateOrder(
      {
        sku: 'SKU_BUNDLE_ALL_IN_ONE',
        customerEmail: 'bundle.full@peregrineacademy.in',
        customerName: 'Bundle Full Scholar'
      },
      {
        razorpayKeyId: mockKeyId,
        razorpayKeySecret: mockKeySecret,
        fetchFn: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ id: 'order_bundle_pkg_1998', entity: 'order', status: 'created', amount: 199800 })
        })
      }
    );

    assert.equal(createRes.success, true);
    assert.equal(createRes.order.amountInr, 1998);
    assert.equal(createRes.order.items.length, 2);

    const paymentId = 'pay_bundle_full_succ';
    const validSig = crypto
      .createHmac('sha256', mockKeySecret)
      .update(`${createRes.razorpayOrderId}|${paymentId}`)
      .digest('hex');

    const verifyRes = await handleVerifyPayment(
      {
        orderId: createRes.order.id,
        razorpayOrderId: createRes.razorpayOrderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: validSig
      },
      {
        razorpayKeyId: mockKeyId,
        razorpayKeySecret: mockKeySecret,
        skipGatewayFetch: true
      }
    );

    assert.equal(verifyRes.success, true);
    assert.equal(verifyRes.order?.status, 'fulfilled');
    const lmsItem = verifyRes.order?.items.find(i => i.targetPlatform === 'LMS');
    const bookItem = verifyRes.order?.items.find(i => i.targetPlatform === 'BOOK_READER');
    assert.equal(lmsItem?.provisioningStatus, 'granted');
    assert.equal(bookItem?.provisioningStatus, 'granted');
    assert.ok(bookItem?.claimToken);
    assert.ok(lmsItem?.claimUrl);
  });

  // 11. Production Environment Indicator Accuracy
  test('11. isProductionEnvironment accurately detects Netlify, Vercel, NODE_ENV, and storage flags', () => {
    // Clean slate
    delete process.env.NODE_ENV;
    delete process.env.CONTEXT;
    delete process.env.NETLIFY;
    delete process.env.VERCEL;
    delete process.env.LAMBDA_TASK_ROOT;
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    delete process.env.AWS_EXECUTION_ENV;
    delete process.env.STOREFRONT_REQUIRE_PERSISTENT_STORAGE;
    delete process.env.STOREFRONT_STORAGE_BACKEND;

    assert.equal(isProductionEnvironment(), false, 'Default clean state is development');

    process.env.CONTEXT = 'production';
    assert.equal(isProductionEnvironment(), true, 'Netlify CONTEXT=production');
    delete process.env.CONTEXT;

    process.env.NETLIFY = 'true';
    assert.equal(isProductionEnvironment(), true, 'Netlify NETLIFY=true');
    delete process.env.NETLIFY;

    process.env.LAMBDA_TASK_ROOT = '/var/task';
    assert.equal(isProductionEnvironment(), true, 'Netlify AWS Lambda task root');
    delete process.env.LAMBDA_TASK_ROOT;

    process.env.AWS_LAMBDA_FUNCTION_NAME = 'peregrine-order-create';
    assert.equal(isProductionEnvironment(), true, 'Netlify AWS Lambda function name');
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;

    process.env.NODE_ENV = 'production';
    assert.equal(isProductionEnvironment(), true, 'NODE_ENV=production');
    delete process.env.NODE_ENV;

    process.env.VERCEL = '1';
    assert.equal(isProductionEnvironment(), true, 'Vercel VERCEL=1');
    delete process.env.VERCEL;

    process.env.STOREFRONT_STORAGE_BACKEND = 'supabase';
    assert.equal(isProductionEnvironment(), true, 'Explicit supabase storage backend');
    delete process.env.STOREFRONT_STORAGE_BACKEND;
  });
});
