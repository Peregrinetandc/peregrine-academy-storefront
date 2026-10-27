import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PRODUCT_CATALOG, calculateOrderPrice } from '../src/config/products.ts';

describe('Product Catalog & Authoritative Server-Side Pricing', () => {
  test('Catalog contains all 4 required SKUs', () => {
    assert.ok(PRODUCT_CATALOG.LMS_COURSE, 'LMS Course must exist in catalog');
    assert.ok(PRODUCT_CATALOG.BOOK_READER, 'Book Reader must exist in catalog');
    assert.ok(PRODUCT_CATALOG.AIAS_PASS, 'AIAS Tutor Pass must exist in catalog');
    assert.ok(PRODUCT_CATALOG.ALL_IN_ONE_BUNDLE, 'All-in-One Bundle must exist in catalog');
  });

  test('LMS Course reflects commercial price of ₹1,499', () => {
    const lms = PRODUCT_CATALOG.LMS_COURSE;
    assert.equal(lms.sku, 'SKU_LMS_SPOKEN_ARABIC');
    assert.equal(lms.priceInr, 1499);
    assert.equal(lms.isBundle, false);
    assert.equal(lms.isLaunchReady, true);
    assert.equal(lms.accessDestination, 'https://learn.peregrineacademy.in');
  });

  test('Digital Reader reflects commercial price of ₹499 and audio count', () => {
    const book = PRODUCT_CATALOG.BOOK_READER;
    assert.equal(book.sku, 'SKU_BOOK_KHALIJI_STORIES');
    assert.equal(book.priceInr, 499);
    assert.equal(book.isBundle, false);
    assert.equal(book.isLaunchReady, true);
    assert.ok(book.features.some(f => f.includes('952')), 'Should highlight 952 native audio clips');
  });

  test('AIAS Speaking Partner reflects FREE for 1st Month (₹0 today, non-recurring)', () => {
    const aias = PRODUCT_CATALOG.AIAS_PASS;
    assert.equal(aias.sku, 'SKU_AIAS_TUTOR_PASS');
    assert.equal(aias.priceInr, 0);
    assert.equal(aias.accessDurationMonths, 1);
    assert.ok(aias.termsPendingNotice, 'Must disclose non-recurring 30-day access');
  });

  test('Complete Learning Package reflects proposed total of ₹1,998', () => {
    const bundle = PRODUCT_CATALOG.ALL_IN_ONE_BUNDLE;
    assert.equal(bundle.sku, 'SKU_BUNDLE_ALL_IN_ONE');
    assert.equal(bundle.priceInr, 1998);
    assert.equal(bundle.isBundle, true);
    assert.deepEqual(bundle.includedSkus, [
      'SKU_LMS_SPOKEN_ARABIC',
      'SKU_BOOK_KHALIJI_STORIES'
    ]);
    // 1499 + 499 = 1998
    const sum = PRODUCT_CATALOG.LMS_COURSE.priceInr + PRODUCT_CATALOG.BOOK_READER.priceInr;
    assert.equal(bundle.priceInr, sum, 'Package price must equal sum of the components: ₹1,499 + ₹499 = ₹1,998');
    assert.equal(bundle.isLaunchReady, true, 'Bundle checkout must be marked launch-ready');
    assert.equal(bundle.isBundlePaused, false, 'Bundle checkout must not be paused');
  });

  test('calculateOrderPrice correctly calculates single items using authoritative server pricing', () => {
    const bookResult = calculateOrderPrice([
      { sku: 'SKU_BOOK_KHALIJI_STORIES', quantity: 1 }
    ]);
    assert.equal(bookResult.totalInr, 499);
    assert.equal(bookResult.subtotalInr, 499);

    const lmsResult = calculateOrderPrice([
      { sku: 'SKU_LMS_SPOKEN_ARABIC', quantity: 1 }
    ]);
    assert.equal(lmsResult.totalInr, 1499);
    assert.equal(lmsResult.subtotalInr, 1499);

    const aiasResult = calculateOrderPrice([
      { sku: 'SKU_AIAS_TUTOR_PASS', quantity: 1 }
    ]);
    assert.equal(aiasResult.totalInr, 0);
    assert.equal(aiasResult.subtotalInr, 0);
  });

  test('calculateOrderPrice rejects invalid SKUs', () => {
    assert.throws(() => {
      calculateOrderPrice([{ sku: 'SKU_NON_EXISTENT_PROMO', quantity: 1 }]);
    }, /Invalid SKU/);
  });
});
