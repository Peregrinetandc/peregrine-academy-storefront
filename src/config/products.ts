/**
 * Peregrine Academy Authoritative Product Catalog & Pricing Definition
 * 
 * STREAMLINED THREE-PRODUCT LEARNING PACKAGE:
 * 1. Spoken Arabic LMS Course: ₹1,499 (SKU_LMS_SPOKEN_ARABIC)
 * 2. Spoken Arabic Book: ₹499 (SKU_BOOK_KHALIJI_STORIES)
 * 3. AI Speaking Partner: FREE for the first month (₹0 in package, non-recurring)
 * 
 * Proposed total payable: ₹1,998 (SKU_BUNDLE_ALL_IN_ONE)
 */

export interface ProductCatalogItem {
  sku: string;
  id: string;
  name: string;
  arabicName: string;
  badge?: string;
  headline: string;
  description: string;
  priceInr: number;
  compareAtPriceInr?: number;
  isBundle?: boolean;
  includedSkus?: string[];
  accessDurationMonths: number; // 0 = lifetime access
  accessDestination: string;
  features: string[];
  specs: { label: string; value: string }[];
  isLaunchReady: boolean;
  isBundlePaused?: boolean;
  pauseNotice?: string;
  termsPendingNotice?: string;
}

export const PRODUCT_CATALOG: Record<string, ProductCatalogItem> = {
  LMS_COURSE: {
    sku: 'SKU_LMS_SPOKEN_ARABIC',
    id: 'lms-course',
    name: 'Spoken Arabic LMS Course',
    arabicName: 'دورة المحادثة باللهجة الإماراتية',
    badge: '30 Contact Hours',
    headline: 'Structured 30-Hour Guided Video & Exercise Curriculum',
    description: 'Master authentic Emirati Arabic pronunciation, high-frequency syntax, and real-world cultural interactions across 30 guided contact hours aligned with NHEQF standards.',
    priceInr: 1499,
    compareAtPriceInr: 2499,
    isBundle: false,
    accessDurationMonths: 12,
    accessDestination: 'https://learn.peregrineacademy.in',
    features: [
      '30 Contact Hours of High-Definition Video Lessons',
      'NHEQF Credit-Aligned Structured Arabic Syllabus',
      'Interactive Dialogue Labs & Speaking Assessments',
      'Cultural Nuances & Etiquette for Professional Contexts in the UAE',
      'Personal LMS Dashboard with Certificate of Completion'
    ],
    specs: [
      { label: 'Platform', value: 'Peregrine LMS (Next.js)' },
      { label: 'Course ID', value: '23c9297a-a4c2-4237-baa7-244646de1662' },
      { label: 'Access', value: '1 Year Full Access' }
    ],
    isLaunchReady: true
  },
  BOOK_READER: {
    sku: 'SKU_BOOK_KHALIJI_STORIES',
    id: 'spoken-book',
    name: 'Spoken Arabic Book (Digital Reader)',
    arabicName: 'العربية الخليجية عبر القصص',
    badge: '40 Narrative Chapters',
    headline: '40 Narrative Chapters with 952 Synchronized Native Audio Clips',
    description: 'Immerse yourself in authentic Gulf Arabic storytelling. Click any sentence to hear crystal-clear native Emirati pronunciation with word-for-word glosses and grammar notes.',
    priceInr: 499,
    compareAtPriceInr: 999,
    isBundle: false,
    accessDurationMonths: 0, // Lifetime
    accessDestination: 'https://arabic.peregrineacademy.in',
    features: [
      '40 Comprehensive Story-Based Narrative Lessons',
      '952 High-Fidelity Native Audio Pronunciation Clips',
      'Interactive Flipbook & Reader Mode with Word-by-Word Breakdown',
      'Grammar Insights & Cultural Commentary for Gulf Life',
      'Lifetime Access across Desktop, Tablet, and Mobile'
    ],
    specs: [
      { label: 'Platform', value: 'Peregrine Arabic Reader (Vite SPA)' },
      { label: 'Total Audio', value: '952 High-Fidelity MP3s' },
      { label: 'Access', value: 'Lifetime Digital Access' }
    ],
    isLaunchReady: true
  },
  AIAS_PASS: {
    sku: 'SKU_AIAS_TUTOR_PASS',
    id: 'aias-tutor',
    name: 'AI Speaking Partner (Rashid & Maryam)',
    arabicName: 'المعلم الذكي للمحادثة الخليجية',
    badge: 'Preview on Reader App',
    headline: 'Emirati Speaking Practice Grounded in Academic Research',
    description: 'Practice spoken conversations with Rashid & Maryam grounded in textbook curriculum. Available in preview directly on the Reader app (30 days access, non-recurring, no auto-debit).',
    priceInr: 0,
    compareAtPriceInr: 79,
    isBundle: false,
    accessDurationMonths: 1, // 30-day initial access
    accessDestination: 'https://arabic.peregrineacademy.in/#ai-tutor',
    features: [
      'Interactive Spoken Emirati Dialogue Practice with Rashid & Maryam',
      'Real-time Pronunciation Evaluation & Phonetic Guidance',
      'Direct Grounding in 40 Textbook Chapters & Vocabulary',
      'Non-recurring 30-day preview; no stored cards, no auto-renewal'
    ],
    specs: [
      { label: 'AI Model', value: 'RAG Grounded Gulf Arabic LLM' },
      { label: 'Personas', value: 'Rashid & Maryam' },
      { label: 'Duration', value: '30 Days Preview (Non-recurring)' },
      { label: 'Availability', value: 'Direct on Reader App' }
    ],
    isLaunchReady: true,
    termsPendingNotice: 'Available in preview on https://arabic.peregrineacademy.in/#ai-tutor'
  },
  ALL_IN_ONE_BUNDLE: {
    sku: 'SKU_BUNDLE_ALL_IN_ONE',
    id: 'book-course-bundle',
    name: 'Complete Arabic Learning Package (Book + Course)',
    arabicName: 'الباقة المتكاملة: الكتاب ودورة المحادثة',
    badge: 'Best Value • ₹1,998',
    headline: 'Spoken Arabic LMS Course (₹1,499) + Spoken Arabic Digital Book (₹499)',
    description: 'Complete learning package combining the 30-Contact-Hour Spoken Arabic LMS Course and the 40-Chapter Spoken Arabic Digital Book with 952 native audio clips. Instant multi-platform activation.',
    priceInr: 1998,
    compareAtPriceInr: 2498,
    isBundle: true,
    includedSkus: ['SKU_LMS_SPOKEN_ARABIC', 'SKU_BOOK_KHALIJI_STORIES'],
    accessDurationMonths: 12,
    accessDestination: 'https://www.peregrineacademy.in',
    features: [
      'Full 30-Hour Spoken Arabic LMS Course (1 Year Access)',
      '40-Chapter Spoken Arabic Book with 952 Audio Recordings (Lifetime Access)',
      'Instant Digital Delivery: LMS enrollment & HMAC-signed Reader claim token',
      'One-time payment: No subscription, no recurring billing, no hidden fees'
    ],
    specs: [
      { label: 'LMS Course', value: '₹1,499 (1 Year Access)' },
      { label: 'Spoken Book', value: '₹499 (Lifetime Access)' },
      { label: 'Total Payable', value: '₹1,998 (One-time payment)' },
      { label: 'AI Partner', value: 'Free Preview on Reader' }
    ],
    isLaunchReady: true,
    isBundlePaused: false
  }
};

/**
 * Calculates order price server-side to prevent client tampering.
 */
export function calculateOrderPrice(items: { sku: string; quantity: number }[]): {
  subtotalInr: number;
  totalInr: number;
  savingsInr: number;
  verifiedItems: { sku: string; name: string; priceInr: number; quantity: number; isLaunchReady: boolean }[];
} {
  let subtotalInr = 0;
  let savingsInr = 0;
  const verifiedItems: { sku: string; name: string; priceInr: number; quantity: number; isLaunchReady: boolean }[] = [];

  for (const item of items) {
    const catalogItem = Object.values(PRODUCT_CATALOG).find(p => p.sku === item.sku);
    if (!catalogItem) {
      throw new Error(`Invalid SKU: ${item.sku}`);
    }
    const qty = Math.max(1, Math.floor(item.quantity || 1));
    const itemTotal = catalogItem.priceInr * qty;
    subtotalInr += itemTotal;
    
    if (catalogItem.compareAtPriceInr) {
      savingsInr += (catalogItem.compareAtPriceInr - catalogItem.priceInr) * qty;
    }

    verifiedItems.push({
      sku: catalogItem.sku,
      name: catalogItem.name,
      priceInr: catalogItem.priceInr,
      quantity: qty,
      isLaunchReady: catalogItem.isLaunchReady
    });
  }

  return {
    subtotalInr,
    totalInr: subtotalInr,
    savingsInr,
    verifiedItems
  };
}
