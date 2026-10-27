/**
 * Order State Machine for Peregrine Academy Storefront
 * 
 * Defines all allowable states and transitions for orders, items, and provisioning jobs.
 */

export type OrderStatus =
  | 'draft'
  | 'pending_payment'
  | 'paid'
  | 'provisioning'
  | 'fulfilled'
  | 'partially_provisioned'
  | 'failed'
  | 'refund_pending'
  | 'refunded';

export type ProvisioningItemStatus =
  | 'pending'
  | 'in_progress'
  | 'granted'
  | 'failed'
  | 'revoked';

export interface OrderItem {
  id: string;
  sku: string;
  name: string;
  targetPlatform: 'LMS' | 'BOOK_READER' | 'AIAS';
  unitPriceInr: number;
  quantity: number;
  provisioningStatus: ProvisioningItemStatus;
  accessGrantedAt?: string;
  accessExpiresAt?: string;
  claimToken?: string;
  claimUrl?: string;
  externalRefId?: string;
  lastError?: string;
  retryCount: number;
}

export interface StorefrontOrder {
  id: string;
  orderNumber: string;
  customerEmail: string;
  customerName: string;
  customerPhone?: string;
  sku: string; // Primary SKU purchased (or ALL_IN_ONE_BUNDLE)
  items: OrderItem[];
  amountInr: number;
  currency: string;
  status: OrderStatus;
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  razorpaySignature?: string;
  paymentVerifiedAt?: string;
  provisionedAt?: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, any>;
}

const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  draft: ['pending_payment', 'failed'],
  pending_payment: ['paid', 'failed'],
  paid: ['provisioning', 'refund_pending'],
  provisioning: ['fulfilled', 'partially_provisioned', 'failed'],
  partially_provisioned: ['provisioning', 'fulfilled', 'refund_pending'], // Allows retry
  fulfilled: ['refund_pending'],
  failed: ['draft'], // Can restart as new attempt
  refund_pending: ['refunded', 'fulfilled'], // If refund rejected, returns to fulfilled
  refunded: [] // Terminal state
};

/**
 * Validates whether an order state transition is permitted.
 */
export function canTransitionOrder(currentStatus: OrderStatus, targetStatus: OrderStatus): boolean {
  if (currentStatus === targetStatus) return true;
  const allowed = ALLOWED_TRANSITIONS[currentStatus];
  return !!allowed && allowed.includes(targetStatus);
}

/**
 * Performs a validated state transition on an order.
 */
export function transitionOrder(order: StorefrontOrder, nextStatus: OrderStatus): StorefrontOrder {
  if (!canTransitionOrder(order.status, nextStatus)) {
    throw new Error(`Illegal order state transition from '${order.status}' to '${nextStatus}'`);
  }

  const updated: StorefrontOrder = {
    ...order,
    status: nextStatus,
    updatedAt: new Date().toISOString()
  };

  if (nextStatus === 'paid' && !updated.paymentVerifiedAt) {
    updated.paymentVerifiedAt = new Date().toISOString();
  }

  if (nextStatus === 'fulfilled' && !updated.provisionedAt) {
    updated.provisionedAt = new Date().toISOString();
  }

  return updated;
}
