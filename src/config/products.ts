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
    badge: 'FREE for 1st Month in Package',
    headline: 'Emirati Speaking Practice Grounded in Academic Research',
    description: 'Practice spoken conversations with Rashid & Maryam grounded in textbook curriculum. FREE for the first month (30 days) when purchased in the Arabic Learning Package. Non-recurring; no auto-debit.',
    priceInr: 0,
    compareAtPriceInr: 79,
    isBundle: false,
    accessDurationMonths: 1, // 30-day initial access
    accessDestination: 'https://arabic.peregrineacademy.in',
    features: [
      'Interactive Spoken Emirati Dialogue Practice with Rashid & Maryam',
      'Real-time Pronunciation Evaluation & Phonetic Guidance',
      'Direct Grounding in 40 Textbook Chapters & Vocabulary',
      'FREE for 30 days with package; non-recurring (no auto-renewal)'
    ],
    specs: [
      { label: 'AI Model', value: 'RAG Grounded Gulf Arabic LLM' },
      { label: 'Personas', value: 'Rashid & Maryam' },
      { label: 'Duration', value: '1 Month Free (30 Days, Non-recurring)' }
    ],
    isLaunchReady: true,
    termsPendingNotice: 'AI Speaking Partner is free for the first 30 days. No recurring subscription or auto-charges.'
  },
  ALL_IN_ONE_BUNDLE: {
    sku: 'SKU_BUNDLE_ALL_IN_ONE',
    id: 'all-in-one-bundle',
    name: 'Complete Arabic Learning Package (3-in-1)',
    arabicName: 'الباقة الشاملة لإتقان اللهجة الخليجية',
    badge: 'Proposed Total: ₹1,998',
    headline: 'LMS Course (₹1,499) + Book (₹499) + AI Speaking Partner (FREE 1st Month)',
    description: 'The unified Arabic Learning Package: Spoken Arabic LMS Course (₹1,499), Spoken Arabic Book (₹499), and AI Speaking Partner (FREE for the first month). Total payable: ₹1,998.',
    priceInr: 1998,
    compareAtPriceInr: 2077,
    isBundle: true,
    includedSkus: ['SKU_LMS_SPOKEN_ARABIC', 'SKU_BOOK_KHALIJI_STORIES', 'SKU_AIAS_TUTOR_PASS'],
    accessDurationMonths: 12,
    accessDestination: 'https://www.peregrineacademy.in/claim',
    features: [
      'Full 30-Hour Spoken Arabic LMS Course (₹1,499)',
      '40-Chapter Spoken Arabic Book with 952 Audio Clips (₹499)',
      'AI Speaking Partner: FREE for the first month (30 days, ₹0 today)',
      'Single-Click Multi-Platform Activation & Immediate Access',
      'No hidden fees, no auto-renewal, and no recurring charges'
    ],
    specs: [
      { label: 'LMS Course', value: '₹1,499' },
      { label: 'Spoken Book', value: '₹499' },
      { label: 'AI Partner', value: 'FREE for 1st Month (₹0)' },
      { label: 'Total Payable', value: '₹1,998' }
    ],
    isLaunchReady: false,
    isBundlePaused: true,
    pauseNotice: 'The Complete Arabic Learning Package checkout is temporarily paused while AI Speaking Partner entitlement policies and limits are finalized. Online payment is disabled.',
    termsPendingNotice: 'Includes 1 month free AI speaking partner. Commercial checkout paused pending final terms approval.'
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
