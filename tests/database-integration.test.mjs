import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createOrderRepository,
  LocalOrderRepository,
  SupabaseOrderRepository
} from '../src/lib/storage/index.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Database Integration Architecture & Supabase Repository Tests', () => {
  const sampleOrder = {
    id: 'ord_db_test_001',
    orderNumber: 'PRGN-20261027-DB01',
    customerEmail: 'scholar@peregrineacademy.in',
    customerName: 'Amina Al-Falasi',
    customerPhone: '+971501112233',
    sku: 'SKU_BUNDLE_ALL_IN_ONE',
    items: [
      {
        id: 'item_01',
        sku: 'SKU_LMS_SPOKEN_ARABIC',
        name: 'Spoken Arabic LMS Course',
        targetPlatform: 'LMS',
        unitPriceInr: 1499,
        quantity: 1,
        provisioningStatus: 'pending',
        retryCount: 0
      },
      {
        id: 'item_02',
        sku: 'SKU_BOOK_KHALIJI_STORIES',
        name: 'Spoken Arabic Book',
        targetPlatform: 'BOOK_READER',
        unitPriceInr: 499,
        quantity: 1,
        provisioningStatus: 'pending',
        retryCount: 0
      }
    ],
    amountInr: 1998,
    currency: 'INR',
    status: 'pending_payment',
    razorpayOrderId: 'order_db_rzp_001',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: { source: 'meta_ads' }
  };

  describe('Repository Factory & Production Fail-Closed Rules', () => {
    test('Defaults to LocalOrderRepository in development/test', () => {
      const repo = createOrderRepository({ backend: 'local' });
      assert.ok(repo instanceof LocalOrderRepository);
    });

    test('Fails closed if production environment lacks Supabase credentials', () => {
      const origEnv = process.env.NODE_ENV;
      const origUrl = process.env.SUPABASE_URL;
      const origKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

      try {
        process.env.NODE_ENV = 'production';
        delete process.env.SUPABASE_URL;
        delete process.env.NEXT_PUBLIC_SUPABASE_URL;
        delete process.env.SUPABASE_SERVICE_ROLE_KEY;

        assert.throws(() => {
          createOrderRepository();
        }, /PRODUCTION SAFETY BLOCKER: Missing mandatory database credentials/);
      } finally {
        process.env.NODE_ENV = origEnv;
        if (origUrl) process.env.SUPABASE_URL = origUrl;
        if (origKey) process.env.SUPABASE_SERVICE_ROLE_KEY = origKey;
      }
    });

    test('Instantiates SupabaseOrderRepository when valid credentials are provided', () => {
      const repo = createOrderRepository({
        backend: 'supabase',
        supabaseUrl: 'https://test-project.supabase.co',
        serviceRoleKey: 'test_service_role_key_value'
      });
      assert.ok(repo instanceof SupabaseOrderRepository);
    });

    test('Rejects anonymous JWT key passed to SupabaseOrderRepository', () => {
      // Create a mock JWT with role = 'anon'
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64');
      const payload = Buffer.from(JSON.stringify({ role: 'anon', sub: '123' })).toString('base64');
      const anonJwt = `${header}.${payload}.signature`;

      assert.throws(() => {
        new SupabaseOrderRepository({
          supabaseUrl: 'https://test-project.supabase.co',
          serviceRoleKey: anonJwt
        });
      }, /SECURITY VIOLATION: Expected 'service_role' key, but received role 'anon'/);
    });
  });

  describe('SupabaseOrderRepository Offline Mock Simulation & Parity', () => {
    // In-memory mock database for PostgREST routes
    let mockDbOrders = new Map();
    let mockDbItems = new Map();

    const mockPostgrestFetch = async (url, options = {}) => {
      const parsedUrl = new URL(url);
      const pathname = parsedUrl.pathname;
      const method = options.method || 'GET';

      // 1. Orders table
      if (pathname === '/rest/v1/storefront_orders') {
        if (method === 'POST') {
          const body = JSON.parse(options.body);
          mockDbOrders.set(body.id, { ...body });
          return {
            ok: true,
            status: 201,
            json: async () => [body],
            text: async () => JSON.stringify([body])
          };
        }

        if (method === 'GET') {
          const idMatch = parsedUrl.searchParams.get('id');
          const rzpMatch = parsedUrl.searchParams.get('razorpay_order_id');
          const orderNumMatch = parsedUrl.searchParams.get('order_number');

          let found = null;
          if (idMatch && idMatch.startsWith('eq.')) {
            const id = idMatch.slice(3);
            found = mockDbOrders.get(id);
          } else if (rzpMatch && rzpMatch.startsWith('eq.')) {
            const rzp = rzpMatch.slice(3);
            found = Array.from(mockDbOrders.values()).find(o => o.razorpay_order_id === rzp);
          } else if (orderNumMatch && orderNumMatch.startsWith('eq.')) {
            const num = orderNumMatch.slice(3);
            found = Array.from(mockDbOrders.values()).find(o => o.order_number === num);
          }

          if (found) {
            const items = mockDbItems.get(found.id) || [];
            return {
              ok: true,
              status: 200,
              json: async () => [{ ...found, storefront_order_items: items }]
            };
          }

          return { ok: true, status: 200, json: async () => [] };
        }

        if (method === 'PATCH') {
          const idMatch = parsedUrl.searchParams.get('id');
          const statusMatch = parsedUrl.searchParams.get('status');
          const id = idMatch?.slice(3);
          const expectedStatus = statusMatch?.slice(3);

          const existing = mockDbOrders.get(id);
          if (existing && existing.status === expectedStatus) {
            const patch = JSON.parse(options.body);
            const updated = { ...existing, ...patch };
            mockDbOrders.set(id, updated);
            const items = mockDbItems.get(id) || [];
            return {
              ok: true,
              status: 200,
              json: async () => [{ ...updated, storefront_order_items: items }]
            };
          }

          // Zero rows modified if status did not match (Atomic CAS)
          return { ok: true, status: 200, json: async () => [] };
        }
      }

      // 2. Order items table
      if (pathname === '/rest/v1/storefront_order_items') {
        if (method === 'POST') {
          const body = JSON.parse(options.body);
          if (Array.isArray(body) && body.length > 0) {
            const orderId = body[0].order_id;
            mockDbItems.set(orderId, body);
          }
          return { ok: true, status: 201, json: async () => body };
        }
      }

      return { ok: false, status: 404, text: async () => 'Route not mocked' };
    };

    beforeEach(() => {
      mockDbOrders.clear();
      mockDbItems.clear();
    });

    test('Saves order and line items to database, retrieves with domain mapping parity', async () => {
      const repo = new SupabaseOrderRepository({
        supabaseUrl: 'https://test-project.supabase.co',
        serviceRoleKey: 'test_key',
        fetchFn: mockPostgrestFetch
      });

      await repo.save(sampleOrder);

      const retrieved = await repo.get(sampleOrder.id);
      assert.ok(retrieved);
      assert.equal(retrieved.id, sampleOrder.id);
      assert.equal(retrieved.orderNumber, sampleOrder.orderNumber);
      assert.equal(retrieved.customerEmail, sampleOrder.customerEmail);
      assert.equal(retrieved.amountInr, 1998);
      assert.equal(retrieved.items.length, 2);
      assert.equal(retrieved.items[0].sku, 'SKU_LMS_SPOKEN_ARABIC');
      assert.equal(retrieved.items[1].sku, 'SKU_BOOK_KHALIJI_STORIES');
    });

    test('Finds order by Razorpay order ID and Order Number', async () => {
      const repo = new SupabaseOrderRepository({
        supabaseUrl: 'https://test-project.supabase.co',
        serviceRoleKey: 'test_key',
        fetchFn: mockPostgrestFetch
      });

      await repo.save(sampleOrder);

      const byRzp = await repo.findByRazorpayOrderId(sampleOrder.razorpayOrderId);
      assert.ok(byRzp);
      assert.equal(byRzp.id, sampleOrder.id);

      const byNum = await repo.findByOrderNumber(sampleOrder.orderNumber);
      assert.ok(byNum);
      assert.equal(byNum.id, sampleOrder.id);
    });

    test('Database Atomic CAS: Concurrent race protection guarantees single winner', async () => {
      const repo = new SupabaseOrderRepository({
        supabaseUrl: 'https://test-project.supabase.co',
        serviceRoleKey: 'test_key',
        fetchFn: mockPostgrestFetch
      });

      await repo.save(sampleOrder);

      // Thread/Callback 1: Browser returns and transitions pending_payment -> paid
      const firstTransition = await repo.transitionStatusAtomic(
        sampleOrder.id,
        'pending_payment',
        'paid',
        { razorpayPaymentId: 'pay_concurrent_01' }
      );
      assert.equal(firstTransition.success, true);
      assert.equal(firstTransition.order?.status, 'paid');

      // Thread/Callback 2: Webhook arrives simultaneously expecting pending_payment
      const secondTransition = await repo.transitionStatusAtomic(
        sampleOrder.id,
        'pending_payment',
        'paid',
        { razorpayPaymentId: 'pay_concurrent_02' }
      );
      assert.equal(secondTransition.success, false);
      assert.match(secondTransition.error || '', /Atomic CAS failed/);
      assert.equal(secondTransition.order?.status, 'paid');
    });

    test('Rejects illegal status transition before hitting database', async () => {
      const repo = new SupabaseOrderRepository({
        supabaseUrl: 'https://test-project.supabase.co',
        serviceRoleKey: 'test_key',
        fetchFn: mockPostgrestFetch
      });

      await repo.save(sampleOrder);

      // Attempt illegal transition: pending_payment directly to fulfilled
      const illegalRes = await repo.transitionStatusAtomic(
        sampleOrder.id,
        'pending_payment',
        'fulfilled'
      );
      assert.equal(illegalRes.success, false);
      assert.match(illegalRes.error || '', /Illegal order state transition/);
    });

    test('Rejects transition to paid when razorpayPaymentId is missing', async () => {
      const repo = new SupabaseOrderRepository({
        supabaseUrl: 'https://test-project.supabase.co',
        serviceRoleKey: 'test_key',
        fetchFn: mockPostgrestFetch
      });

      await repo.save(sampleOrder);

      // Attempt transition to paid without payment ID
      const noPayIdRes = await repo.transitionStatusAtomic(
        sampleOrder.id,
        'pending_payment',
        'paid'
      );
      assert.equal(noPayIdRes.success, false);
      assert.match(noPayIdRes.error || '', /Transition to paid strictly requires a valid razorpayPaymentId/);
    });

    test('Propagates database HTTP errors cleanly without silent swallowing', async () => {
      const errorFetch = async () => ({
        ok: false,
        status: 500,
        text: async () => 'Internal Database Connection Timeout'
      });

      const repo = new SupabaseOrderRepository({
        supabaseUrl: 'https://test-project.supabase.co',
        serviceRoleKey: 'test_key',
        fetchFn: errorFetch
      });

      await assert.rejects(
        async () => { await repo.save(sampleOrder); },
        /Failed to save order: HTTP 500 Internal Database Connection Timeout/
      );

      const transitionRes = await repo.transitionStatusAtomic(
        sampleOrder.id,
        'pending_payment',
        'paid',
        { razorpayPaymentId: 'pay_123' }
      );
      assert.equal(transitionRes.success, false);
      assert.match(transitionRes.error || '', /Database transition failed: HTTP 500/);
    });

    test('Handles malformed JSON response from Supabase without crashing', async () => {
      const malformedFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => { throw new SyntaxError('Unexpected token < in JSON'); },
        text: async () => '<html>502 Bad Gateway</html>'
      });

      const repo = new SupabaseOrderRepository({
        supabaseUrl: 'https://test-project.supabase.co',
        serviceRoleKey: 'test_key',
        fetchFn: malformedFetch
      });

      await assert.rejects(
        async () => { await repo.get('some_order_id'); },
        /Malformed JSON response/
      );

      const transitionRes = await repo.transitionStatusAtomic(
        sampleOrder.id,
        'pending_payment',
        'paid',
        { razorpayPaymentId: 'pay_123' }
      );
      assert.equal(transitionRes.success, false);
      assert.match(transitionRes.error || '', /Malformed JSON response/);
    });

    test('Multi-step save failure: Compares and marks header failed if line items fail', async () => {
      let patchedOrderBody = null;
      const partialFailFetch = async (url, options = {}) => {
        const parsed = new URL(url);
        if (parsed.pathname === '/rest/v1/storefront_orders') {
          if (options.method === 'POST') {
            return { ok: true, status: 201, json: async () => [JSON.parse(options.body)] };
          }
          if (options.method === 'PATCH') {
            patchedOrderBody = JSON.parse(options.body);
            return { ok: true, status: 200, json: async () => [patchedOrderBody] };
          }
        }
        if (parsed.pathname === '/rest/v1/storefront_order_items') {
          return { ok: false, status: 400, text: async () => 'Foreign key constraint violation' };
        }
        return { ok: false, status: 404 };
      };

      const repo = new SupabaseOrderRepository({
        supabaseUrl: 'https://test-project.supabase.co',
        serviceRoleKey: 'test_key',
        fetchFn: partialFailFetch
      });

      await assert.rejects(
        async () => { await repo.save(sampleOrder); },
        /Failed to save order items: HTTP 400 Foreign key constraint violation/
      );

      // Verify compensation PATCH was sent
      assert.ok(patchedOrderBody, 'Must send compensation PATCH when order items fail');
      assert.equal(patchedOrderBody.status, 'failed');
    });
  });

  describe('Security & Migration Static Analysis (Note: Real DB testing requires active PostgreSQL)', () => {
    test('Migration enforces defense-in-depth security on tables and functions', () => {
      const migrationPath = path.join(__dirname, '../supabase/migrations/20261026150000_storefront_commerce.sql');
      const sqlContent = fs.readFileSync(migrationPath, 'utf8');

      // 1. Unsafe policy must be removed or explicitly dropped
      assert.ok(
        sqlContent.includes('DROP POLICY IF EXISTS "Public claim status access" ON public.storefront_orders;'),
        'Must explicitly drop the unsafe public claim status policy'
      );
      assert.ok(
        !sqlContent.includes('CREATE POLICY "Public claim status access"'),
        'Unsafe policy must not be re-created'
      );

      // 2. Table-level REVOKE of all permissions from untrusted roles
      assert.ok(sqlContent.includes('REVOKE ALL ON TABLE public.storefront_orders FROM PUBLIC, anon, authenticated;'));
      assert.ok(sqlContent.includes('REVOKE ALL ON TABLE public.storefront_order_items FROM PUBLIC, anon, authenticated;'));
      assert.ok(sqlContent.includes('REVOKE ALL ON TABLE public.storefront_provisioning_logs FROM PUBLIC, anon, authenticated;'));

      // 3. Service role table grants
      assert.ok(sqlContent.includes('GRANT ALL ON TABLE public.storefront_orders TO service_role;'));

      // 4. Stored procedures must set a safe search_path to prevent hijacking
      assert.ok(
        sqlContent.includes('SET search_path = public, pg_temp'),
        'Must set explicit safe search_path on SECURITY DEFINER functions'
      );

      // 5. Function EXECUTE must be revoked from PUBLIC, anon, and authenticated
      assert.ok(
        sqlContent.includes('REVOKE ALL ON FUNCTION public.storefront_transition_order_status(UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;'),
        'Must revoke EXECUTE on transition function from untrusted roles'
      );
      assert.ok(
        sqlContent.includes('GRANT EXECUTE ON FUNCTION public.storefront_transition_order_status(UUID, TEXT, TEXT, TEXT, TEXT) TO service_role;'),
        'Must grant EXECUTE on transition function strictly to service_role'
      );

      // 6. Validation of state transitions inside SQL function
      assert.ok(
        sqlContent.includes('Illegal state transition from'),
        'SQL function must enforce state machine transition validity'
      );
      assert.ok(
        sqlContent.includes('Transition to paid requires a valid razorpay_payment_id'),
        'SQL function must require payment ID for paid transitions'
      );

      // 7. Verify no syntax defect / dangling 'ready' string
      assert.ok(!sqlContent.includes("'''ready'"), 'Must not contain syntax defect in CAS error message');
    });

    test('.gitignore ensures customer data and secrets are never committed', () => {
      const gitignorePath = path.join(__dirname, '../.gitignore');
      const content = fs.readFileSync(gitignorePath, 'utf8');

      assert.ok(content.includes('.env'), 'Must ignore .env');
      assert.ok(content.includes('data/'), 'Must ignore data/ directory');
      assert.ok(content.includes('*.tmp*'), 'Must ignore temp files');
    });
  });
});
