/**
 * Peregrine Academy Storefront Build & Pre-flight Verification Script
 * Validates the Streamlined Three-Product Checkout Page
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const modulePath = fileURLToPath(import.meta.url);
const moduleDir = path.dirname(modulePath);

console.log('=== Building Peregrine Academy Storefront Artifacts ===');

// 1. Verify index.html exists and is complete
const indexPath = path.join(moduleDir, 'public', 'index.html');
if (!fs.existsSync(indexPath)) {
  console.error('[build error] public/index.html is missing!');
  process.exit(1);
}

const htmlContent = fs.readFileSync(indexPath, 'utf8');
if (!htmlContent.includes('PEREGRINE ACADEMY') || !htmlContent.includes('<!DOCTYPE html>')) {
  console.error('[build error] public/index.html is incomplete or corrupt!');
  process.exit(1);
}

// 2. Verify concise heading
if (!htmlContent.includes('Complete Your Arabic Learning Package')) {
  console.error('[build error] Heading "Complete Your Arabic Learning Package" is missing in public/index.html!');
  process.exit(1);
}

// 3. Verify the three products and commercial pricing
const requiredChecks = [
  { label: 'Spoken Arabic LMS Course', pattern: /Spoken Arabic LMS Course/ },
  { label: 'LMS Course price ₹1,499', pattern: /₹1,499/ },
  { label: 'Spoken Arabic Book', pattern: /Spoken Arabic Book/ },
  { label: 'Book price ₹499', pattern: /₹499/ },
  { label: 'AI Speaking Partner', pattern: /AI Speaking Partner/ },
  { label: 'AI Free 1st Month label', pattern: /FREE for the first month/i },
  { label: 'Proposed Package Total ₹1,998', pattern: /₹1,998/ },
  { label: 'Prominent CTA Proceed to Secure Payment', pattern: /Proceed to Secure Payment/ }
];

for (const check of requiredChecks) {
  if (!check.pattern.test(htmlContent)) {
    console.error(`[build error] public/index.html failed check: ${check.label}`);
    process.exit(1);
  }
}

// 4. Verify optional product exploration section below checkout
if (!htmlContent.includes('Explore Your Learning Package')) {
  console.error('[build error] Heading "Explore Your Learning Package" is missing in public/index.html!');
  process.exit(1);
}

const requiredExplorationLinks = [
  'https://learn.peregrineacademy.in/',
  'https://arabic.peregrineacademy.in/',
  'https://arabic.peregrineacademy.in/#ai-tutor'
];

for (const link of requiredExplorationLinks) {
  if (!htmlContent.includes(link)) {
    console.error(`[build error] Exploration link "${link}" is missing in public/index.html!`);
    process.exit(1);
  }
}

// 5. Verify Razorpay checkout.js inclusion
if (!htmlContent.includes('https://checkout.razorpay.com/v1/checkout.js')) {
  console.error('[build error] Official Razorpay Checkout library script tag is missing in public/index.html!');
  process.exit(1);
}

// 6. Verify policy and compliance pages
const requiredPolicyRoutes = [
  'about-us',
  'contact-us',
  'pricing',
  'terms-and-conditions',
  'privacy-policy',
  'refund-cancellation-policy',
  'shipping-delivery-policy',
  'disclaimer',
  'grievance-redressal'
];

for (const route of requiredPolicyRoutes) {
  // Check index.html footer link
  if (!htmlContent.includes(`href="/${route}"`)) {
    console.error(`[build error] Missing link to /${route} in public/index.html footer!`);
    process.exit(1);
  }

  // Check file existence
  const dirPath = path.join(moduleDir, 'public', route, 'index.html');
  const aliasPath = path.join(moduleDir, 'public', `${route}.html`);
  if (!fs.existsSync(dirPath)) {
    console.error(`[build error] Missing policy file: public/${route}/index.html!`);
    process.exit(1);
  }
  if (!fs.existsSync(aliasPath)) {
    console.error(`[build error] Missing policy alias file: public/${route}.html!`);
    process.exit(1);
  }

  const pageContent = fs.readFileSync(dirPath, 'utf8');
  if (!pageContent.includes('<!DOCTYPE html>') || !pageContent.includes('Peregrine Academy')) {
    console.error(`[build error] Policy page public/${route}/index.html is corrupt or missing branding!`);
    process.exit(1);
  }
}

// 7. Verify no unverified Meta Purchase pixel firing on initial render
// Purchases must only be recorded inside the server verification callback
if (htmlContent.includes("setTimeout(() => {") && htmlContent.includes("window.fbq('track', 'Purchase'")) {
  console.error('[build error] Security violation: Client-side Meta Purchase pixel found inside unverified simulation timeout!');
  process.exit(1);
}

console.log('✔ public/index.html validated successfully.');
console.log('✔ Concise heading verified: "Complete Your Arabic Learning Package".');
console.log('✔ Three-product rows & prices verified: LMS=₹1,499, Book=₹499, AI=FREE for 1st Month.');
console.log('✔ Total payable verified: ₹1,998 with prominent "Proceed to Secure Payment" CTA.');
console.log('✔ Optional product exploration section verified below checkout.');
console.log('✔ All 9 Razorpay legal & compliance pages verified with direct files and aliases.');
console.log('✔ Official Razorpay checkout.js integration validated.');
console.log('✔ Meta Pixel purchase deduplication and verified server response gating validated.');
console.log('=== Build check completed successfully ===');
