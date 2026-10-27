import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { executeOrderProvisioning, retryOrderProvisioning } from '../src/lib/provisioning/orchestrator.ts';

describe('Provisioning Orchestrator & Multi-Product Fulfillment', () => {
  function createSampleBundleOrder() {
    const items = [
      {
        id: 'item-1',
        sku: 'SKU_LMS_SPOKEN_ARABIC',
        name: 'Spoken Emirati Arabic Masterclass',
        targetPlatform: 'LMS',
        unitPriceInr: 1499,
        quantity: 1,
        provisioningStatus: 'pending',
        retryCount: 0
      },
      {
        id: 'item-2',
        sku: 'SKU_BOOK_KHALIJI_STORIES',
        name: 'Khaliji Arabic Through Stories',
        targetPlatform: 'BOOK_READER',
        unitPriceInr: 499,
        quantity: 1,
        provisioningStatus: 'pending',
        retryCount: 0
      },
      {
        id: 'item-3',
        sku: 'SKU_AIAS_TUTOR_PASS',
        name: 'AI Speaking Partner (FREE 1st Month)',
        targetPlatform: 'AIAS',
        unitPriceInr: 0,
        quantity: 1,
        provisioningStatus: 'pending',
        retryCount: 0
      }
    ];

    return {
      id: 'ord_bundle_test_01',
      orderNumber: 'PRGN-20261026-BNDL',
      customerEmail: 'student@example.com',
      customerName: 'Fatima Al-Nuaimi',
      sku: 'SKU_BUNDLE_ALL_IN_ONE',
      items,
      amountInr: 1998,
      currency: 'INR',
      status: 'paid',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  test('All 3 bundle components provision successfully -> Order becomes fulfilled', async () => {
    const order = createSampleBundleOrder();
    const result = await executeOrderProvisioning(order, { simulate: true });

    assert.equal(result.allSucceeded, true);
    assert.equal(result.provisionedCount, 3);
    assert.equal(result.failedCount, 0);
    assert.equal(result.order.status, 'fulfilled');

    // Verify all items are granted
    for (const item of result.order.items) {
      assert.equal(item.provisioningStatus, 'granted');
      assert.ok(item.accessGrantedAt);
      if (item.targetPlatform === 'BOOK_READER') {
        assert.ok(item.claimToken);
        assert.ok(item.claimUrl);
      }
      if (item.targetPlatform === 'LMS') {
        assert.ok(item.externalRefId);
      }
      if (item.targetPlatform === 'AIAS') {
        assert.ok(item.claimToken);
        assert.ok(item.accessExpiresAt, 'AIAS must record accessExpiresAt date');
      }
    }
  });

  test('Idempotency: Re-running fulfilled order returns immediately without duplicate work', async () => {
    const order = createSampleBundleOrder();
    const firstRun = await executeOrderProvisioning(order, { simulate: true });
    assert.equal(firstRun.order.status, 'fulfilled');

    const secondRun = await executeOrderProvisioning(firstRun.order, { simulate: true });
    assert.equal(secondRun.allSucceeded, true);
    assert.equal(secondRun.order.status, 'fulfilled');
    // retry count should not increment on skipped items
    assert.equal(secondRun.order.items[0].retryCount, 1);
  });
});
