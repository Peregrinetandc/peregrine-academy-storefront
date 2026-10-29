import { type StorefrontOrder, type OrderItem, type OrderStatus, canTransitionOrder } from '../order-state-machine.ts';
import { type IOrderRepository, type TransitionResult, type SupabaseRepositoryConfig } from './types.ts';

/**
 * Server-Side Supabase Order Repository
 * 
 * Interacts directly with PostgreSQL via Supabase PostgREST endpoints.
 * SECURITY: Requires service-role key exclusively; NEVER expose to client/browser.
 * Enforces database-level conditional atomic updates (CAS) for concurrent payment/webhook safety.
 */
export class SupabaseOrderRepository implements IOrderRepository {
  private supabaseUrl: string;
  private serviceRoleKey: string;
  private fetchFn: typeof fetch;

  constructor(config: SupabaseRepositoryConfig) {
    if (!config.supabaseUrl || !config.supabaseUrl.startsWith('http')) {
      throw new Error('[SupabaseOrderRepository] A valid supabaseUrl is required.');
    }
    if (!config.serviceRoleKey || config.serviceRoleKey.trim().length === 0) {
      throw new Error('[SupabaseOrderRepository] SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SECRET_KEY is required for server repository.');
    }

    this.serviceRoleKey = config.serviceRoleKey.trim();

    // Defense-in-depth: If a JWT is provided, verify it is not an anon key
    if (this.serviceRoleKey.startsWith('ey') && this.serviceRoleKey.includes('.')) {
      try {
        const parts = this.serviceRoleKey.split('.');
        if (parts.length >= 2) {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
          if (payload.role && (payload.role === 'anon' || payload.role === 'authenticated')) {
            throw new Error(
              `[SupabaseOrderRepository] SECURITY VIOLATION: Expected 'service_role' key, but received role '${payload.role}'. Anonymous keys are strictly forbidden for repository operations.`
            );
          }
        }
      } catch (err: any) {
        if (err.message.includes('SECURITY VIOLATION')) throw err;
        // Non-JWT test key (like in mock unit tests) is accepted
      }
    }

    this.supabaseUrl = config.supabaseUrl.replace(/\/+$/, '');
    this.fetchFn = config.fetchFn || fetch;
  }

  private getHeaders(): Record<string, string> {
    return {
      'apikey': this.serviceRoleKey,
      'Authorization': `Bearer ${this.serviceRoleKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
  }

  /**
   * Maps internal StorefrontOrder to database row format.
   */
  private toDbRow(order: StorefrontOrder): Record<string, any> {
    return {
      id: order.id,
      order_number: order.orderNumber,
      customer_email: order.customerEmail.toLowerCase().trim(),
      customer_name: order.customerName.trim(),
      customer_phone: order.customerPhone?.trim() || null,
      sku: order.sku,
      amount_inr: order.amountInr,
      currency: order.currency || 'INR',
      status: order.status,
      razorpay_order_id: order.razorpayOrderId || null,
      razorpay_payment_id: order.razorpayPaymentId || null,
      razorpay_signature: order.razorpaySignature || null,
      metadata: order.metadata || {},
      created_at: order.createdAt || new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
  }

  /**
   * Maps database row with joined items to internal StorefrontOrder domain entity.
   */
  private toDomain(row: any): StorefrontOrder {
    const rawItems = row.storefront_order_items || [];
    const items: OrderItem[] = Array.isArray(rawItems)
      ? rawItems.map((item: any) => ({
          id: item.id,
          sku: item.sku,
          name: item.name,
          targetPlatform: item.target_platform,
          unitPriceInr: Number(item.unit_price_inr),
          quantity: item.quantity,
          provisioningStatus: item.provisioning_status,
          claimToken: item.claim_token || undefined,
          claimUrl: item.claim_url || undefined,
          externalRefId: item.external_ref_id || undefined,
          lastError: item.last_error || undefined,
          accessGrantedAt: item.access_granted_at || undefined,
          accessExpiresAt: item.access_expires_at || undefined,
          retryCount: item.retry_count || 0
        }))
      : [];

    return {
      id: row.id,
      orderNumber: row.order_number,
      customerEmail: row.customer_email,
      customerName: row.customer_name,
      customerPhone: row.customer_phone || undefined,
      sku: row.sku,
      items,
      amountInr: Number(row.amount_inr),
      currency: row.currency || 'INR',
      status: row.status,
      razorpayOrderId: row.razorpay_order_id || undefined,
      razorpayPaymentId: row.razorpay_payment_id || undefined,
      razorpaySignature: row.razorpay_signature || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      metadata: row.metadata || {}
    };
  }

  public async save(order: StorefrontOrder): Promise<StorefrontOrder> {
    const dbRow = this.toDbRow(order);
    
    // 1. Upsert Order Header
    const orderRes = await this.fetchFn(
      `${this.supabaseUrl}/rest/v1/storefront_orders`,
      {
        method: 'POST',
        headers: {
          ...this.getHeaders(),
          'Prefer': 'resolution=merge-duplicates,return=representation'
        },
        body: JSON.stringify(dbRow)
      }
    );

    if (!orderRes.ok) {
      const errText = await orderRes.text().catch(() => '');
      throw new Error(`[SupabaseOrderRepository] Failed to save order: HTTP ${orderRes.status} ${errText}`);
    }

    // 2. Upsert Order Line Items
    if (order.items && order.items.length > 0) {
      const itemRows = order.items.map(item => ({
        id: item.id,
        order_id: order.id,
        sku: item.sku,
        name: item.name,
        target_platform: item.targetPlatform,
        unit_price_inr: item.unitPriceInr,
        quantity: item.quantity,
        provisioning_status: item.provisioningStatus,
        claim_token: item.claimToken || null,
        claim_url: item.claimUrl || null,
        external_ref_id: item.externalRefId || null,
        last_error: item.lastError || null,
        access_granted_at: item.accessGrantedAt || null,
        retry_count: item.retryCount || 0,
        updated_at: new Date().toISOString()
      }));

      const itemsRes = await this.fetchFn(
        `${this.supabaseUrl}/rest/v1/storefront_order_items`,
        {
          method: 'POST',
          headers: {
            ...this.getHeaders(),
            'Prefer': 'resolution=merge-duplicates'
          },
          body: JSON.stringify(itemRows)
        }
      );

      if (!itemsRes.ok) {
        const itemErrText = await itemsRes.text().catch(() => '');
        // Compensation: mark order header as failed in DB so incomplete order is never left in pending/invalid state
        await this.fetchFn(
          `${this.supabaseUrl}/rest/v1/storefront_orders?id=eq.${encodeURIComponent(order.id)}`,
          {
            method: 'PATCH',
            headers: this.getHeaders(),
            body: JSON.stringify({
              status: 'failed',
              metadata: { ...(order.metadata || {}), save_error: 'Failed to persist order items', details: itemErrText }
            })
          }
        ).catch(() => {});
        throw new Error(`[SupabaseOrderRepository] Failed to save order items: HTTP ${itemsRes.status} ${itemErrText}`);
      }
    }

    return order;
  }

  public async get(orderId: string): Promise<StorefrontOrder | null> {
    const res = await this.fetchFn(
      `${this.supabaseUrl}/rest/v1/storefront_orders?id=eq.${encodeURIComponent(orderId)}&select=*,storefront_order_items(*)`,
      {
        method: 'GET',
        headers: this.getHeaders()
      }
    );

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`[SupabaseOrderRepository] Error fetching order ${orderId}: HTTP ${res.status} ${errText}`);
    }

    let data: any;
    try {
      data = await res.json();
    } catch {
      throw new Error(`[SupabaseOrderRepository] Malformed JSON response received from database: HTTP ${res.status}`);
    }
    if (!Array.isArray(data) || data.length === 0) {
      return null;
    }

    return this.toDomain(data[0]);
  }

  public async findByRazorpayOrderId(rzpOrderId: string): Promise<StorefrontOrder | null> {
    const res = await this.fetchFn(
      `${this.supabaseUrl}/rest/v1/storefront_orders?razorpay_order_id=eq.${encodeURIComponent(rzpOrderId)}&select=*,storefront_order_items(*)`,
      {
        method: 'GET',
        headers: this.getHeaders()
      }
    );

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`[SupabaseOrderRepository] Error looking up rzp order ${rzpOrderId}: HTTP ${res.status} ${errText}`);
    }

    let data: any;
    try {
      data = await res.json();
    } catch {
      throw new Error(`[SupabaseOrderRepository] Malformed JSON response received from database: HTTP ${res.status}`);
    }
    if (!Array.isArray(data) || data.length === 0) {
      return null;
    }

    return this.toDomain(data[0]);
  }

  public async findByOrderNumber(orderNumber: string): Promise<StorefrontOrder | null> {
    const res = await this.fetchFn(
      `${this.supabaseUrl}/rest/v1/storefront_orders?order_number=eq.${encodeURIComponent(orderNumber)}&select=*,storefront_order_items(*)`,
      {
        method: 'GET',
        headers: this.getHeaders()
      }
    );

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`[SupabaseOrderRepository] Error looking up orderNumber ${orderNumber}: HTTP ${res.status} ${errText}`);
    }

    let data: any;
    try {
      data = await res.json();
    } catch {
      throw new Error(`[SupabaseOrderRepository] Malformed JSON response received from database: HTTP ${res.status}`);
    }
    if (!Array.isArray(data) || data.length === 0) {
      return null;
    }

    return this.toDomain(data[0]);
  }

  /**
   * Database-Level Atomic Compare-And-Swap (CAS) Status Transition
   * 
   * Validates state machine rules in application layer before database execution.
   * Uses conditional PostgREST update:
   *   PATCH /storefront_orders?id=eq.{id}&status=eq.{expectedStatus}
   * 
   * Guarantees that only ONE concurrent process (browser or webhook) can execute
   * the transition. The losing process receives an empty representation array,
   * indicating that status was already changed, preventing double-fulfillment.
   */
  public async transitionStatusAtomic(
    orderId: string,
    expectedStatus: OrderStatus,
    targetStatus: OrderStatus,
    paymentProof?: { razorpayPaymentId?: string; razorpaySignature?: string }
  ): Promise<TransitionResult> {
    // 1. Invariant: Prevent transition from 'failed' to 'draft' if payment evidence exists
    if (expectedStatus === 'failed' && targetStatus === 'draft') {
      const current = await this.get(orderId);
      if (current && (current.razorpayPaymentId || current.paymentVerifiedAt)) {
        return {
          success: false,
          error: `Cannot transition failed order to draft because payment proof exists (${current.razorpayPaymentId || 'verified'}). Reconcile payment or route to retry/refund.`
        };
      }
    }

    // 1b. Application-level state machine validation
    if (!canTransitionOrder(expectedStatus, targetStatus)) {
      return {
        success: false,
        error: `Illegal order state transition from '${expectedStatus}' to '${targetStatus}'`
      };
    }

    // 2. Transition to 'paid' strictly requires payment proof ID
    if (targetStatus === 'paid' && !paymentProof?.razorpayPaymentId) {
      return {
        success: false,
        error: 'Transition to paid strictly requires a valid razorpayPaymentId'
      };
    }

    const patchPayload: Record<string, any> = {
      status: targetStatus,
      updated_at: new Date().toISOString()
    };

    if (paymentProof?.razorpayPaymentId) {
      patchPayload.razorpay_payment_id = paymentProof.razorpayPaymentId;
    }
    if (paymentProof?.razorpaySignature) {
      patchPayload.razorpay_signature = paymentProof.razorpaySignature;
    }
    if (targetStatus === 'paid') {
      patchPayload.payment_verified_at = new Date().toISOString();
    }

    const patchUrl = `${this.supabaseUrl}/rest/v1/storefront_orders?id=eq.${encodeURIComponent(orderId)}&status=eq.${encodeURIComponent(expectedStatus)}&select=*,storefront_order_items(*)`;

    const res = await this.fetchFn(patchUrl, {
      method: 'PATCH',
      headers: {
        ...this.getHeaders(),
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(patchPayload)
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return {
        success: false,
        error: `[SupabaseOrderRepository] Database transition failed: HTTP ${res.status} ${errText}`
      };
    }

    let data: any;
    try {
      data = await res.json();
    } catch {
      return {
        success: false,
        error: `[SupabaseOrderRepository] Malformed JSON response received from database on transition: HTTP ${res.status}`
      };
    }

    if (!Array.isArray(data)) {
      return {
        success: false,
        error: `[SupabaseOrderRepository] Unexpected response structure from database on status transition (expected array, got ${typeof data})`
      };
    }
    
    // If exactly 1 record was modified, atomic CAS succeeded!
    if (data.length === 1) {
      return {
        success: true,
        order: this.toDomain(data[0])
      };
    }

    // CAS failed: Either order did not exist, or status was already changed by a concurrent call
    const current = await this.get(orderId);
    if (!current) {
      return { success: false, error: `Order not found: ${orderId}` };
    }

    return {
      success: false,
      error: `Atomic CAS failed: expected status '${expectedStatus}', but current status is '${current.status}'`,
      order: current
    };
  }

  public async clearForTesting(): Promise<void> {
    // Only permit clearing in test/mock environments
    if (process.env.NODE_ENV === 'production') {
      throw new Error('[SupabaseOrderRepository] clearForTesting is strictly forbidden in production.');
    }
    await this.fetchFn(`${this.supabaseUrl}/rest/v1/storefront_orders`, {
      method: 'DELETE',
      headers: this.getHeaders()
    }).catch(() => {});
  }
}
