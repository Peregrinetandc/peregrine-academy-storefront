import { type StorefrontOrder, type OrderStatus } from '../order-state-machine.ts';

export interface TransitionResult {
  success: boolean;
  order?: StorefrontOrder;
  error?: string;
}

export interface IOrderRepository {
  save(order: StorefrontOrder): Promise<StorefrontOrder>;
  get(orderId: string): Promise<StorefrontOrder | null>;
  findByRazorpayOrderId(rzpOrderId: string): Promise<StorefrontOrder | null>;
  findByOrderNumber(orderNumber: string): Promise<StorefrontOrder | null>;
  transitionStatusAtomic(
    orderId: string,
    expectedStatus: OrderStatus,
    targetStatus: OrderStatus,
    paymentProof?: { razorpayPaymentId?: string; razorpaySignature?: string }
  ): Promise<TransitionResult>;
  clearForTesting(): Promise<void>;
  getLiveCache?(): Map<string, StorefrontOrder>;
}

export interface SupabaseRepositoryConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
  fetchFn?: typeof fetch;
}
