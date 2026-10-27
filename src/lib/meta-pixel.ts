/**
 * Meta Pixel & Conversion Tracking for Peregrine Academy Storefront
 * 
 * Standard events for Meta Ads (Facebook/Instagram) traffic optimization.
 */

declare global {
  interface Window {
    fbq?: (...args: any[]) => void;
    _fbq?: any;
  }
}

export const META_PIXEL_ID = process.env.NEXT_PUBLIC_META_PIXEL_ID || 'PENDING_PIXEL_ID';

export function trackPixelEvent(eventName: string, data?: Record<string, any>) {
  if (typeof window !== 'undefined' && window.fbq) {
    window.fbq('track', eventName, data);
  } else {
    // Console debugging in dev mode
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[Meta Pixel Event: ${eventName}]`, data);
    }
  }
}

export function trackPageView() {
  trackPixelEvent('PageView');
}

export function trackViewContent(product: {
  sku: string;
  name: string;
  priceInr: number;
  isBundle?: boolean;
}) {
  trackPixelEvent('ViewContent', {
    content_ids: [product.sku],
    content_name: product.name,
    content_category: product.isBundle ? 'Bundle' : 'Course/Book',
    value: product.priceInr,
    currency: 'INR'
  });
}

export function trackInitiateCheckout(product: {
  sku: string;
  name: string;
  priceInr: number;
}) {
  trackPixelEvent('InitiateCheckout', {
    content_ids: [product.sku],
    content_name: product.name,
    value: product.priceInr,
    currency: 'INR',
    num_items: 1
  });
}

export function trackPurchase(order: {
  orderNumber: string;
  sku: string;
  amountInr: number;
}) {
  trackPixelEvent('Purchase', {
    content_ids: [order.sku],
    value: order.amountInr,
    currency: 'INR',
    order_id: order.orderNumber
  });
}
