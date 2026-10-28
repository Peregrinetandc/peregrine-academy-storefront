import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import server from '../server.js';

const modulePath = fileURLToPath(import.meta.url);
const moduleDir = path.dirname(modulePath);
const projectRoot = path.join(moduleDir, '..');

describe('Razorpay Website Verification Legal & Compliance Pages', () => {

  const POLICY_ROUTES = [
    {
      route: 'about-us',
      title: 'About Us',
      expectedKeywords: ['Dr. Muhammed Swalih T', 'Peregrine Academy', 'Emirati', 'PhD']
    },
    {
      route: 'contact-us',
      title: 'Contact Us',
      expectedKeywords: ['hello@peregrinehub.com', 'admin@peregrineacademy.in', '+91 7012756374', 'Edappatta, Melattur']
    },
    {
      route: 'pricing',
      title: 'Pricing',
      expectedKeywords: ['₹499', '₹1,499', '₹1,998', 'Complete Learning Package']
    },
    {
      route: 'terms-and-conditions',
      title: 'Terms & Conditions',
      expectedKeywords: ['Peregrine Training', 'Intellectual Property', 'single-user personal license']
    },
    {
      route: 'privacy-policy',
      title: 'Privacy Policy',
      expectedKeywords: ['Information We Collect', 'Razorpay', 'protection']
    },
    {
      route: 'refund-cancellation-policy',
      title: 'Refund & Cancellation Policy',
      expectedKeywords: ['48-hour', '100% Technical Delivery Guarantee', 'hello@peregrinehub.com']
    },
    {
      route: 'shipping-delivery-policy',
      title: 'Shipping & Delivery Policy',
      expectedKeywords: ['100% digital', '₹0.00', '1 to 5 minutes', 'arabic.peregrineacademy.in']
    },
    {
      route: 'disclaimer',
      title: 'Disclaimer',
      expectedKeywords: ['Emirati Arabic', 'Modern Standard Arabic', 'AI Speaking Partner', 'Limitation of Liability']
    },
    {
      route: 'grievance-redressal',
      title: 'Grievance Redressal',
      expectedKeywords: ['Grievance Officer', 'Dr. Muhammed Swalih T', 'admin@peregrineacademy.in', '48 hours', '15 business days']
    }
  ];

  async function fetchPath(urlPath) {
    const { Readable, Writable } = await import('node:stream');
    return new Promise((resolve) => {
      const req = new Readable();
      req._read = () => {};
      req.method = 'GET';
      req.url = urlPath;
      req.headers = { host: 'localhost:3000' };

      const res = new Writable();
      let resBody = '';
      res.headers = {};
      res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
      res.writeHead = (status, h) => {
        res.statusCode = status;
        if (h) {
          for (const [k, v] of Object.entries(h)) {
            res.headers[k.toLowerCase()] = v;
          }
        }
      };
      res._write = (chunk, enc, cb) => {
        resBody += chunk.toString();
        cb();
      };
      res.end = (chunk) => {
        if (chunk) resBody += chunk.toString();
        resolve({
          status: res.statusCode || 200,
          headers: res.headers,
          body: resBody
        });
      };
      server.emit('request', req, res);
      req.push(null);
    });
  }

  test('Public policy files and aliases exist on disk', () => {
    for (const item of POLICY_ROUTES) {
      const dirIndex = path.join(projectRoot, 'public', item.route, 'index.html');
      const directHtml = path.join(projectRoot, 'public', `${item.route}.html`);

      assert.ok(fs.existsSync(dirIndex), `Directory index missing: public/${item.route}/index.html`);
      assert.ok(fs.existsSync(directHtml), `Direct html missing: public/${item.route}.html`);

      const content = fs.readFileSync(dirIndex, 'utf8');
      assert.ok(content.includes('<!DOCTYPE html>'), `${item.route} must be valid HTML`);
      assert.ok(content.includes('Peregrine Academy'), `${item.route} must have Peregrine Academy branding`);

      for (const kw of item.expectedKeywords) {
        assert.ok(content.includes(kw), `${item.route} missing expected keyword: ${kw}`);
      }
    }
  });

  test('Public index.html links to all 9 policy pages in its footer', () => {
    const indexPath = path.join(projectRoot, 'public', 'index.html');
    const indexHtml = fs.readFileSync(indexPath, 'utf8');

    for (const item of POLICY_ROUTES) {
      assert.ok(indexHtml.includes(`href="/${item.route}"`), `index.html footer must link to /${item.route}`);
    }

    // Must also link to Terms, Privacy, Refund in checkout consent area
    assert.ok(indexHtml.includes('terms-and-conditions'), 'Checkout area must reference terms-and-conditions');
    assert.ok(indexHtml.includes('privacy-policy'), 'Checkout area must reference privacy-policy');
    assert.ok(indexHtml.includes('refund-cancellation-policy'), 'Checkout area must reference refund-cancellation-policy');
  });

  for (const item of POLICY_ROUTES) {
    test(`GET /${item.route} serves HTTP 200 HTML with proper headers`, async () => {
      const res = await fetchPath(`/${item.route}`);
      assert.equal(res.status, 200, `Expected 200 for /${item.route}`);
      assert.ok(res.headers['content-type']?.includes('text/html'), `Content-Type should be text/html for /${item.route}`);
      assert.ok(res.body.includes('<!DOCTYPE html>'), `Body should be HTML for /${item.route}`);
      assert.ok(res.body.includes(item.expectedKeywords[0]), `Body should contain keyword "${item.expectedKeywords[0]}"`);
    });

    test(`GET /${item.route}/ (with trailing slash) serves HTTP 200 HTML`, async () => {
      const res = await fetchPath(`/${item.route}/`);
      assert.equal(res.status, 200, `Expected 200 for /${item.route}/`);
      assert.ok(res.headers['content-type']?.includes('text/html'), `Content-Type should be text/html for /${item.route}/`);
      assert.ok(res.body.includes('<!DOCTYPE html>'));
    });

    test(`GET /${item.route}.html serves HTTP 200 HTML`, async () => {
      const res = await fetchPath(`/${item.route}.html`);
      assert.equal(res.status, 200, `Expected 200 for /${item.route}.html`);
      assert.ok(res.headers['content-type']?.includes('text/html'), `Content-Type should be text/html for /${item.route}.html`);
      assert.ok(res.body.includes('<!DOCTYPE html>'));
    });
  }

  test('Pricing page displays accurate and verified catalog values', async () => {
    const res = await fetchPath('/pricing');
    assert.equal(res.status, 200);
    // Check specific pricing items
    assert.ok(res.body.includes('₹499'), 'Pricing must list Book at ₹499');
    assert.ok(res.body.includes('₹1,499'), 'Pricing must list Course at ₹1,499');
    assert.ok(res.body.includes('₹1,998'), 'Pricing must list Bundle at ₹1,998');
    assert.ok(/Free 30-day preview/i.test(res.body), 'AI Speaking Partner should be accurately described as 30-day preview');
  });

  test('Contact Us and Grievance pages display verified operational contacts', async () => {
    const contactRes = await fetchPath('/contact-us');
    assert.equal(contactRes.status, 200);
    assert.ok(contactRes.body.includes('hello@peregrinehub.com'));
    assert.ok(contactRes.body.includes('admin@peregrineacademy.in'));
    assert.ok(contactRes.body.includes('+91 7012756374'));
    assert.ok(contactRes.body.includes('Edappatta, Melattur'));

    const grievanceRes = await fetchPath('/grievance-redressal');
    assert.equal(grievanceRes.status, 200);
    assert.ok(grievanceRes.body.includes('Dr. Muhammed Swalih T'));
    assert.ok(grievanceRes.body.includes('admin@peregrineacademy.in'));
    assert.ok(grievanceRes.body.includes('48 hours'));
    assert.ok(grievanceRes.body.includes('15 business days'));
  });
});
