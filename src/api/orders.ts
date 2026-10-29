import crypto from 'node:crypto';
import { PRODUCT_CATALOG } from '../config/products.ts';
import { type StorefrontOrder, type OrderItem, transitionOrder } from '../lib/order-state-machine.ts';
import {
  verifyRazorpayPaymentSignature,
  verifyRazorpayWebhookSignature,
  createRazorpayOrder,
  fetchRazorpayPayment,
  captureRazorpayPayment,
  type RazorpayOrderResponse
} from '../lib/razorpay.ts';
import {
  executeOrderProvisioning,
  retryOrderProvisioning,
  type ProvisioningOptions
} from '../lib/provisioning/orchestrator.ts';
import { orderRepository, LocalOrderRepository } from '../lib/storage/order-repository.ts';
import { SupabaseOrderRepository } from '../lib/storage/supabase-order-repository.ts';
import { type IOrderRepository } from '../lib/storage/types.ts';

// Live in-memory cache view backed durably by LocalOrderRepository / disk
export const memoryOrderLedger = orderRepository.getLiveCache();

let activeRepoOverride: IOrderRepository | null = null;

export function setOrderRepositoryForTesting(repo: IOrderRepository | null) {
  activeRepoOverride = repo;
}

let activeVerifyConfigOverride: Partial<OrderApiConfig> | null = null;

export function setVerifyConfigForTesting(config: Partial<OrderApiConfig> | null) {
  if (isProductionEnvironment()) {
    throw new Error('[Orders API] setVerifyConfigForTesting is strictly forbidden in production.');
  }
  activeVerifyConfigOverride = config;
}

export function isProductionEnvironment(): boolean {
  return Boolean(
    process.env.NODE_ENV === 'production' ||
    process.env.CONTEXT === 'production' ||
    process.env.CONTEXT === 'deploy-preview' ||
    process.env.CONTEXT === 'branch-deploy' ||
    process.env.NETLIFY === 'true' ||
    process.env.LAMBDA_TASK_ROOT ||
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.AWS_EXECUTION_ENV ||
    process.env.VERCEL === '1' ||
    process.env.STOREFRONT_REQUIRE_PERSISTENT_STORAGE === 'true' ||
    process.env.STOREFRONT_STORAGE_BACKEND === 'supabase'
  );
}

export function getActiveOrderRepository(): IOrderRepository {
  if (activeRepoOverride) return activeRepoOverride;
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (supabaseUrl && serviceRoleKey && !serviceRoleKey.startsWith('mock_')) {
    return new SupabaseOrderRepository({ supabaseUrl, serviceRoleKey });
  }
  const isProd = isProductionEnvironment();
  if (isProd) {
    throw new Error(
      '[Storage] PRODUCTION SAFETY BLOCKER: Missing mandatory database credentials. ' +
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured in production. ' +
      'Silent fallback to ephemeral /tmp storage is strictly forbidden for real payments.'
    );
  }
  return orderRepository;
}

export interface CreateOrderRequest {
  sku: string;
  customerEmail: string;
  customerName: string;
  customerPhone?: string;
  metadata?: Record<string, any>;
}

export interface VerifyPaymentRequest {
  orderId: string;
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
}

export interface OrderApiConfig {
  razorpayKeyId?: string;
  razorpayKeySecret?: string;
  webhookSecret?: string;
  allowUnreadyForTesting?: boolean;
  allowPausedBundleForTesting?: boolean;
  allowTestMockSignature?: boolean;
  skipGatewayFetch?: boolean;
  fetchFn?: typeof fetch;
  provisioningOptions?: ProvisioningOptions;
}

export function resolveProvisioningOptions(config?: OrderApiConfig): ProvisioningOptions {
  if (config?.provisioningOptions) return config.provisioningOptions;
  const isProd = isProductionEnvironment();
  return {
    lmsApiUrl: process.env.LMS_API_URL || 'https://learn.peregrineacademy.in',
    lmsApiKey: process.env.LMS_API_KEY,
    readerApiUrl: process.env.READER_API_URL,
    handoffSecret: process.env.BUNDLE_HANDOFF_SECRET,
    aiasApiUrl: process.env.AIAS_API_URL,
    aiasSecret: process.env.AIAS_SECRET,
    simulate: !isProd && !process.env.BUNDLE_HANDOFF_SECRET && !process.env.LMS_API_KEY
  };
}

/**
 * Creates a new order in pending_payment status with authoritative server-calculated pricing.
 * Integrates with Razorpay Orders API server-to-server.
 * Enforces fail-closed commercial safety while the three-product bundle is paused.
 */
export async function handleCreateOrder(
  req: CreateOrderRequest,
  config?: OrderApiConfig
): Promise<{
  success: boolean;
  order: StorefrontOrder;
  razorpayOrderId: string;
  razorpayKeyId?: string;
  amountInSubunits?: number;
  currency?: string;
  testMode?: boolean;
  isPaused?: boolean;
  error?: string;
}> {
  if (!req.customerEmail || !req.customerEmail.includes('@')) {
    return { success: false, error: 'Valid customer email is required', order: null as any, razorpayOrderId: '' };
  }
  if (!req.customerName || req.customerName.trim().length === 0) {
    return { success: false, error: 'Customer name is required', order: null as any, razorpayOrderId: '' };
  }

  const catalogItem = Object.values(PRODUCT_CATALOG).find(p => p.sku === req.sku);
  if (!catalogItem) {
    return { success: false, error: `Invalid SKU: ${req.sku}`, order: null as any, razorpayOrderId: '' };
  }

  // Commercial Safety Gate: Check if product or bundle is explicitly paused
  if (catalogItem.isBundlePaused && !config?.allowPausedBundleForTesting) {
    return {
      success: false,
      error: catalogItem.pauseNotice || 'Checkout for this package is currently paused.',
      order: null as any,
      razorpayOrderId: '',
      isPaused: true
    };
  }

  // Safety Gate for unready products
  if (!catalogItem.isLaunchReady && !config?.allowUnreadyForTesting && !config?.allowPausedBundleForTesting) {
    return {
      success: false,
      error: catalogItem.termsPendingNotice || `Product ${catalogItem.name} is not launch-ready. Checkout is disabled.`,
      order: null as any,
      razorpayOrderId: ''
    };
  }

  const orderId = crypto.randomUUID();
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const randomSuffix = crypto.randomBytes(3).toString('hex').toUpperCase();
  const orderNumber = `PRGN-${dateStr}-${randomSuffix}`;

  // Build line items based on SKU
  const items: OrderItem[] = [];
  if (catalogItem.isBundle && catalogItem.includedSkus) {
    for (const subSku of catalogItem.includedSkus) {
      const subItem = Object.values(PRODUCT_CATALOG).find(p => p.sku === subSku);
      if (subItem) {
        let platform: 'LMS' | 'BOOK_READER' | 'AIAS' = 'LMS';
        if (subSku === 'SKU_BOOK_KHALIJI_STORIES') platform = 'BOOK_READER';
        else if (subSku === 'SKU_AIAS_TUTOR_PASS') platform = 'AIAS';

        let unitPriceInr = subItem.priceInr;
        if (subSku === 'SKU_AIAS_TUTOR_PASS') {
          unitPriceInr = 0; // FREE for first month in package
        }

        items.push({
          id: crypto.randomUUID(),
          sku: subItem.sku,
          name: subItem.name,
          targetPlatform: platform,
          unitPriceInr,
          quantity: 1,
          provisioningStatus: 'pending',
          retryCount: 0
        });
      }
    }
  } else {
    let platform: 'LMS' | 'BOOK_READER' | 'AIAS' = 'LMS';
    if (catalogItem.sku === 'SKU_BOOK_KHALIJI_STORIES') platform = 'BOOK_READER';
    else if (catalogItem.sku === 'SKU_AIAS_TUTOR_PASS') platform = 'AIAS';

    items.push({
      id: crypto.randomUUID(),
      sku: catalogItem.sku,
      name: catalogItem.name,
      targetPlatform: platform,
      unitPriceInr: catalogItem.priceInr,
      quantity: 1,
      provisioningStatus: 'pending',
      retryCount: 0
    });
  }

  const keyId = config?.razorpayKeyId || process.env.RAZORPAY_KEY_ID;
  const keySecret = config?.razorpayKeySecret || process.env.RAZORPAY_KEY_SECRET;
  const amountInSubunits = catalogItem.priceInr * 100;
  let razorpayOrderId = '';
  let isTestMode = false;

  // Real server-to-server Razorpay order creation (only for positive amount charges)
  if (amountInSubunits > 0 && keyId && keySecret && !keyId.startsWith('rzp_test_placeholder')) {
    try {
      const rzpOrder: RazorpayOrderResponse = await createRazorpayOrder({
        amountInSubunits,
        currency: 'INR',
        receipt: orderNumber,
        notes: {
          storefront_order_id: orderId,
          sku: catalogItem.sku,
          customer_email: req.customerEmail.trim().toLowerCase()
        },
        keyId,
        keySecret,
        fetchFn: config?.fetchFn
      });
      razorpayOrderId = rzpOrder.id;
    } catch (err: any) {
      return {
        success: false,
        error: `Payment gateway order creation failed: ${err.message}`,
        order: null as any,
        razorpayOrderId: ''
      };
    }
  } else if (amountInSubunits === 0) {
    // Zero-amount free activation
    razorpayOrderId = `order_free_${randomSuffix.toLowerCase()}_${Date.now().toString().slice(-6)}`;
  } else {
    // Fail closed in production if gateway credentials are missing
    if (isProductionEnvironment()) {
      return {
        success: false,
        error: 'Razorpay payment gateway credentials are not configured in production.',
        order: null as any,
        razorpayOrderId: ''
      };
    }
    // Local development fallback
    isTestMode = true;
    razorpayOrderId = `order_test_${randomSuffix.toLowerCase()}_${Date.now().toString().slice(-6)}`;
  }

  const order: StorefrontOrder = {
    id: orderId,
    orderNumber,
    customerEmail: req.customerEmail.trim().toLowerCase(),
    customerName: req.customerName.trim(),
    customerPhone: req.customerPhone?.trim(),
    sku: catalogItem.sku,
    items,
    amountInr: catalogItem.priceInr,
    currency: 'INR',
    status: 'pending_payment',
    razorpayOrderId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {
      ...(req.metadata || {}),
      allowPausedBundleForTesting: Boolean(config?.allowPausedBundleForTesting)
    }
  };

  // Persist order durably to active storage
  await getActiveOrderRepository().save(order);

  return {
    success: true,
    order,
    razorpayOrderId,
    razorpayKeyId: keyId || (isProductionEnvironment() ? '' : 'rzp_test_placeholder'),
    amountInSubunits,
    currency: 'INR',
    testMode: isTestMode
  };
}

/**
 * Authoritatively verifies Razorpay payment signature server-side, validates payment proof,
 * and executes multi-system fulfillment only upon verified payment.
 * Uses atomic CAS locking to prevent duplicate fulfillment from concurrent redirect/webhooks.
 */
export async function handleVerifyPayment(
  req: VerifyPaymentRequest,
  config?: OrderApiConfig
): Promise<{
  success: boolean;
  order?: StorefrontOrder;
  paymentVerified?: boolean;
  fulfillmentStatus?: string;
  isDuplicate?: boolean;
  error?: string;
}> {
  const baseConfig: OrderApiConfig = { ...config };
  for (const k of Object.keys(baseConfig) as (keyof OrderApiConfig)[]) {
    if (baseConfig[k] === undefined) {
      delete baseConfig[k];
    }
  }

  const effectiveConfig: OrderApiConfig = {
    ...baseConfig,
    ...(!isProductionEnvironment() ? activeVerifyConfigOverride : {})
  };

  // Fail closed if testing mock signature requested in production
  if (isProductionEnvironment() && effectiveConfig.allowTestMockSignature) {
    throw new Error('Test mock signature verification is strictly forbidden in production.');
  }

  // Durable order lookup
  const repo = getActiveOrderRepository();
  const order = await repo.get(req.orderId);
  if (!order) {
    return { success: false, error: `Order not found: ${req.orderId}` };
  }

  // Idempotency & Replay Protection: If order already fulfilled, return existing order
  if (order.status === 'fulfilled') {
    if (order.razorpayPaymentId && order.razorpayPaymentId === req.razorpayPaymentId) {
      return {
        success: true,
        order,
        paymentVerified: true,
        fulfillmentStatus: 'fulfilled',
        isDuplicate: true
      };
    }
    return {
      success: false,
      error: 'Order has already been fulfilled with a different payment ID.'
    };
  }

  // If order was already marked paid or provisioning, handle replay gracefully
  if (order.status === 'paid' || order.status === 'provisioning') {
    if (order.razorpayPaymentId === req.razorpayPaymentId) {
      return {
        success: true,
        order,
        paymentVerified: true,
        fulfillmentStatus: order.status,
        isDuplicate: true
      };
    }
  }

  // Reject orders that are not in an allowable payment verification state
  if (order.status !== 'pending_payment') {
    return {
      success: false,
      error: `Order cannot be verified in current status '${order.status}'`
    };
  }

  // Commercial Safety Gate: Check if order was created as a paused bundle
  const isPausedOrder = Boolean((order.metadata as any)?.isPaused);
  const isAuthorizedTestBundle = Boolean(effectiveConfig.allowPausedBundleForTesting || (order.metadata as any)?.allowPausedBundleForTesting);

  if (isPausedOrder && !isAuthorizedTestBundle) {
    return {
      success: false,
      error: 'Payment verification forbidden: This bundle checkout is currently paused.'
    };
  }

  // Strict Order ID match: verify that the payment corresponds to this specific internal order
  if (req.razorpayOrderId !== order.razorpayOrderId) {
    return {
      success: false,
      error: `Razorpay order ID mismatch: expected ${order.razorpayOrderId}, received ${req.razorpayOrderId}`
    };
  }

  // Invariant: Synthetic test order references cannot be verified in production
  if (isProductionEnvironment() && order.razorpayOrderId?.startsWith('order_test_')) {
    return {
      success: false,
      error: 'Synthetic test order references cannot be verified in production mode. Genuine payment gateway order required.'
    };
  }

  const secret = effectiveConfig.razorpayKeySecret || process.env.RAZORPAY_KEY_SECRET;
  const keyId = effectiveConfig.razorpayKeyId || process.env.RAZORPAY_KEY_ID;

  // Strict cryptographic HMAC signature verification
  if (secret) {
    const isValid = verifyRazorpayPaymentSignature({
      orderId: req.razorpayOrderId,
      paymentId: req.razorpayPaymentId,
      signature: req.razorpaySignature,
      secret
    });

    if (!isValid) {
      return { success: false, error: 'Invalid Razorpay payment signature. Verification failed.' };
    }
  } else if (effectiveConfig.allowTestMockSignature) {
    // Controlled test mode when explicitly passed by test suite
    if (req.razorpaySignature !== 'test_valid_mock_signature') {
      return { success: false, error: 'Invalid mock test signature.' };
    }
  } else {
    // Secret missing and test mode not explicitly granted
    return { success: false, error: 'Razorpay secret key not configured for payment verification.' };
  }

  // Production must never fulfill orders using signature-only verification.
  if (
    isProductionEnvironment() &&
    (
      !keyId ||
      !secret ||
      effectiveConfig.skipGatewayFetch ||
      keyId.startsWith('rzp_test_placeholder')
    )
  ) {
    return {
      success: false,
      error: 'Production payment verification is not fully configured.'
    };
  }

  // Gateway verification may be bypassed only through the explicit non-production test option.
  if (
    !effectiveConfig.skipGatewayFetch &&
    (!keyId || !secret || keyId.startsWith('rzp_test_placeholder'))
  ) {
    return {
      success: false,
      error: 'Razorpay gateway verification is not fully configured.'
    };
  }

  // Gateway payment verification and capture enforcement.
  // An explicit skip is reserved for non-production tests; production is rejected above.
  if (!effectiveConfig.skipGatewayFetch) {
    try {
      let payment = await fetchRazorpayPayment({
        paymentId: req.razorpayPaymentId,
        keyId,
        keySecret: secret,
        fetchFn: effectiveConfig.fetchFn
      });

      if (payment.order_id !== order.razorpayOrderId) {
        return { success: false, error: 'Payment entity order_id does not match storefront order.' };
      }

      const expectedSubunits = order.amountInr * 100;
      if (payment.amount !== expectedSubunits) {
        return {
          success: false,
          error: `Payment amount mismatch: expected ₹${order.amountInr} (${expectedSubunits} subunits), got ${payment.amount}`
        };
      }

      if (payment.currency !== order.currency) {
        return {
          success: false,
          error: `Payment currency mismatch: expected ${order.currency}, got ${payment.currency}`
        };
      }

      // If payment is authorized but not yet captured, execute server-side capture
      if (payment.status === 'authorized') {
        try {
          payment = await captureRazorpayPayment({
            paymentId: req.razorpayPaymentId,
            amountInSubunits: expectedSubunits,
            currency: order.currency,
            keyId,
            keySecret: secret,
            fetchFn: effectiveConfig.fetchFn
          });
        } catch (capErr: any) {
          // Re-fetch to confirm whether capture succeeded despite network timeout/drop
          try {
            const refetched = await fetchRazorpayPayment({
              paymentId: req.razorpayPaymentId,
              keyId,
              keySecret: secret,
              fetchFn: effectiveConfig.fetchFn
            });
            if (refetched.status === 'captured') {
              payment = refetched;
            } else {
              return {
                success: false,
                error: `Payment is authorized but capture could not be completed: ${capErr.message}`
              };
            }
          } catch {
            return {
              success: false,
              error: `Payment capture failed: ${capErr.message}`
            };
          }
        }
      }

      // Validate the final gateway response after fetch/capture/refetch.
      if (
        payment.id !== req.razorpayPaymentId ||
        payment.order_id !== order.razorpayOrderId ||
        payment.amount !== expectedSubunits ||
        payment.currency !== order.currency
      ) {
        return {
          success: false,
          error: 'Final Razorpay payment details failed strict verification.'
        };
      }

      // STRICT INVARIANT: Digital fulfillment requires payment in 'captured' status!
      if (payment.status !== 'captured') {
        return {
          success: false,
          error: `Payment cannot trigger fulfillment because it is not captured (current status: ${payment.status})`
        };
      }
    } catch (err: any) {
      // Fail closed in every environment when gateway verification was attempted.
      return {
        success: false,
        error: `Failed to confirm payment status with Razorpay: ${err.message}`
      };
    }
  }

  // Atomic Compare-And-Swap transition from 'pending_payment' to 'paid'
  const atomicTransition = await repo.transitionStatusAtomic(
    order.id,
    'pending_payment',
    'paid',
    {
      razorpayPaymentId: req.razorpayPaymentId,
      razorpaySignature: req.razorpaySignature
    }
  );

  if (!atomicTransition.success || !atomicTransition.order) {
    // If CAS failed because order was already updated to paid/provisioning/fulfilled by a simultaneous webhook,
    // verify payment ownership and return truthful success indicating verified payment and in-flight/completed fulfillment
    const current = await repo.get(order.id);
    if (current && (current.status === 'paid' || current.status === 'fulfilled' || current.status === 'provisioning')) {
      if (current.razorpayPaymentId && current.razorpayPaymentId !== req.razorpayPaymentId) {
        return {
          success: false,
          error: 'Order was already marked paid with a different payment ID.'
        };
      }
      return {
        success: true,
        order: current,
        paymentVerified: true,
        fulfillmentStatus: current.status,
        isDuplicate: true
      };
    }
    return { success: false, error: atomicTransition.error || 'Failed to update order status atomically.' };
  }

  const paidOrder = atomicTransition.order;

  // Trigger provisioning orchestrator
  const orchestration = await executeOrderProvisioning(paidOrder, resolveProvisioningOptions(effectiveConfig));
  await repo.save(orchestration.order);

  // Crucial Rule: An order is ONLY fulfilled if all entitlements actually succeeded
  if (orchestration.allSucceeded) {
    return {
      success: true,
      order: orchestration.order,
      paymentVerified: true,
      fulfillmentStatus: 'fulfilled'
    };
  }

  return {
    success: false,
    order: orchestration.order,
    paymentVerified: true,
    fulfillmentStatus: orchestration.order.status,
    error: 'Payment was successfully verified, but one or more product entitlements failed to provision.'
  };
}

/**
 * Handles incoming Razorpay Webhook events (e.g. payment.captured).
 * Provides asynchronous verification and idempotent fulfillment.
 */
export async function handleRazorpayWebhook(
  rawBody: string | Buffer,
  signature: string,
  config?: { webhookSecret?: string; provisioningOptions?: ProvisioningOptions }
): Promise<{
  success: boolean;
  event?: string;
  orderId?: string;
  isDuplicate?: boolean;
  error?: string;
}> {
  const webhookSecret = config?.webhookSecret || process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return { success: false, error: 'RAZORPAY_WEBHOOK_SECRET is not configured.' };
  }

  const isValid = verifyRazorpayWebhookSignature({
    rawBody,
    signature,
    webhookSecret
  });

  if (!isValid) {
    return { success: false, error: 'Invalid webhook signature.' };
  }

  let eventData: any;
  try {
    eventData = JSON.parse(typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'));
  } catch {
    return { success: false, error: 'Malformed webhook JSON payload.' };
  }

  if (eventData.event === 'payment.captured') {
    const payment = eventData.payload?.payment?.entity;
    if (!payment) {
      return { success: false, error: 'Missing payment entity in webhook payload.' };
    }

    const rzpOrderId = payment.order_id;
    // Find matching order in durable repository by razorpayOrderId
    const repo = getActiveOrderRepository();
    const matchedOrder = await repo.findByRazorpayOrderId(rzpOrderId);

    if (!matchedOrder) {
      return { success: false, error: `No internal order found for Razorpay order ID ${rzpOrderId}` };
    }

    // Safety Gate: Reject webhook provisioning if order was marked paused
    const isPausedOrder = Boolean((matchedOrder.metadata as any)?.isPaused);
    const isAuthorizedTestBundle = Boolean((matchedOrder.metadata as any)?.allowPausedBundleForTesting);

    if (isPausedOrder && !isAuthorizedTestBundle) {
      return {
        success: false,
        error: 'Webhook fulfillment rejected: This bundle checkout is currently paused.'
      };
    }

    // Validate critical fields before fulfillment or duplicate acknowledgement.
    if (
      !payment.id ||
      !payment.order_id ||
      payment.order_id !== matchedOrder.razorpayOrderId ||
      payment.currency !== matchedOrder.currency ||
      payment.status !== 'captured'
    ) {
      return {
        success: false,
        error: 'Webhook payment details failed strict verification.'
      };
    }

    // Validate amount.
    const expectedSubunits = matchedOrder.amountInr * 100;
    if (payment.amount !== expectedSubunits) {
      return {
        success: false,
        error: `Webhook amount mismatch: expected ${expectedSubunits}, received ${payment.amount}`
      };
    }

    // A duplicate is valid only when it matches the stored payment ID.
    if (
      matchedOrder.status === 'fulfilled' ||
      matchedOrder.status === 'paid' ||
      matchedOrder.status === 'provisioning'
    ) {
      if (
        !matchedOrder.razorpayPaymentId ||
        matchedOrder.razorpayPaymentId !== payment.id
      ) {
        return {
          success: false,
          error: 'Duplicate webhook payment ID does not match the stored order payment.'
        };
      }

      return {
        success: true,
        event: eventData.event,
        orderId: matchedOrder.id,
        isDuplicate: true
      };
    }

    // Atomic CAS transition
    const atomicTransition = await repo.transitionStatusAtomic(
      matchedOrder.id,
      'pending_payment',
      'paid',
      { razorpayPaymentId: payment.id }
    );

    if (!atomicTransition.success || !atomicTransition.order) {
      return { success: true, event: eventData.event, orderId: matchedOrder.id, isDuplicate: true };
    }

    const paidOrder = atomicTransition.order;
    const orchestration = await executeOrderProvisioning(paidOrder, resolveProvisioningOptions(config));
    await repo.save(orchestration.order);

    return {
      success: orchestration.allSucceeded,
      event: eventData.event,
      orderId: orchestration.order.id,
      isDuplicate: false
    };
  }

  return { success: true, event: eventData.event };
}

/**
 * Retries provisioning for an unfulfilled or partially provisioned order.
 */
export async function handleRetryProvisioning(
  orderId: string,
  options?: ProvisioningOptions
): Promise<{
  success: boolean;
  order?: StorefrontOrder;
  error?: string;
}> {
  const repo = getActiveOrderRepository();
  const order = await repo.get(orderId);
  if (!order) {
    return { success: false, error: `Order not found: ${orderId}` };
  }

  try {
    const orchestration = await retryOrderProvisioning(order, options || { simulate: true });
    await repo.save(orchestration.order);
    return {
      success: orchestration.allSucceeded,
      order: orchestration.order
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || String(err)
    };
  }
}

/**
 * Reconciles an ambiguous order directly against Razorpay gateway status before allowing retries or refunds.
 * Prevents double-charging customers when client responses were lost or ambiguous.
 */
export async function reconcileOrderPayment(
  orderId: string,
  config?: OrderApiConfig
): Promise<{
  reconciled: boolean;
  order: StorefrontOrder | null;
  status: string;
  paymentId?: string;
  error?: string;
}> {
  const repo = getActiveOrderRepository();
  const order = await repo.get(orderId);
  if (!order) {
    return { reconciled: false, order: null, status: 'not_found', error: `Order not found: ${orderId}` };
  }

  // Safety Gate: Reject reconciliation for paused bundle orders
  const isPausedOrder = Boolean((order.metadata as any)?.isPaused);
  const isAuthorizedTestBundle = Boolean(config?.allowPausedBundleForTesting || (order.metadata as any)?.allowPausedBundleForTesting);

  if (isPausedOrder && !isAuthorizedTestBundle) {
    return {
      reconciled: false,
      order,
      status: order.status,
      error: 'Reconciliation forbidden: This bundle checkout is currently paused.'
    };
  }

  const keyId = config?.razorpayKeyId || process.env.RAZORPAY_KEY_ID;
  const secret = config?.razorpayKeySecret || process.env.RAZORPAY_KEY_SECRET;

  if (order.status === 'fulfilled') {
    return { reconciled: true, order, status: 'fulfilled', paymentId: order.razorpayPaymentId };
  }

  if (!order.razorpayOrderId || !keyId || !secret) {
    return { reconciled: true, order, status: order.status, paymentId: order.razorpayPaymentId };
  }

  try {
    if (order.razorpayPaymentId) {
      let payment = await fetchRazorpayPayment({
        paymentId: order.razorpayPaymentId,
        keyId,
        keySecret: secret,
        fetchFn: config?.fetchFn
      });

      // If authorized, attempt capture
      if (payment.status === 'authorized') {
        try {
          payment = await captureRazorpayPayment({
            paymentId: order.razorpayPaymentId,
            amountInSubunits: order.amountInr * 100,
            currency: order.currency,
            keyId,
            keySecret: secret,
            fetchFn: config?.fetchFn
          });
        } catch {
          // Keep current status if capture fails
        }
      }

      if (payment.status === 'captured') {
        if (order.status === 'pending_payment') {
          const transitioned = await repo.transitionStatusAtomic(
            order.id,
            'pending_payment',
            'paid',
            { razorpayPaymentId: payment.id }
          );
          if (transitioned.success && transitioned.order) {
            const orchestration = await executeOrderProvisioning(
              transitioned.order,
              resolveProvisioningOptions(config)
            );
            await repo.save(orchestration.order);
            return {
              reconciled: true,
              order: orchestration.order,
              status: orchestration.order.status,
              paymentId: payment.id
            };
          }
        }
      }
    }
    return { reconciled: true, order, status: order.status, paymentId: order.razorpayPaymentId };
  } catch (err: any) {
    return { reconciled: false, order, status: order.status, error: err.message };
  }
}
