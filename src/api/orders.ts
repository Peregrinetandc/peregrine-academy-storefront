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
import { orderRepository } from '../lib/storage/order-repository.ts';

// Live in-memory cache view backed durably by LocalOrderRepository / disk
export const memoryOrderLedger = orderRepository.getLiveCache();

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

  // Commercial Safety Gate: Complete Arabic Learning Package checkout is PAUSED
  if ((catalogItem.sku === 'SKU_BUNDLE_ALL_IN_ONE' || catalogItem.isBundlePaused) && !config?.allowPausedBundleForTesting) {
    return {
      success: false,
      error: catalogItem.pauseNotice || 'Because AIAS access limits and duration are undecided, bundle checkout cannot safely operate and is temporarily paused. Online payment is disabled.',
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

  // Real server-to-server Razorpay order creation
  if (keyId && keySecret && !keyId.startsWith('rzp_test_placeholder_unconfigured')) {
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
  } else {
    // Fail closed in production if gateway credentials are missing
    if (process.env.NODE_ENV === 'production') {
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

  // Persist order durably to local storage
  await orderRepository.save(order);

  return {
    success: true,
    order,
    razorpayOrderId,
    razorpayKeyId: keyId || 'rzp_test_placeholder',
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
  // Fail closed if testing mock signature requested in production
  if (process.env.NODE_ENV === 'production' && config?.allowTestMockSignature) {
    throw new Error('Test mock signature verification is strictly forbidden in production.');
  }

  // Durable order lookup
  const order = await orderRepository.get(req.orderId);
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

  // Commercial Safety Gate: Complete Arabic Learning Package verification & fulfillment is PAUSED
  const isBundleOrder = order.sku === 'SKU_BUNDLE_ALL_IN_ONE' ||
    order.items.some(i => i.sku === 'SKU_BUNDLE_ALL_IN_ONE' || i.sku === 'SKU_AIAS_TUTOR_PASS');
  const isAuthorizedTestBundle = Boolean(config?.allowPausedBundleForTesting || (order.metadata as any)?.allowPausedBundleForTesting);

  if (isBundleOrder && !isAuthorizedTestBundle) {
    return {
      success: false,
      error: 'Payment verification forbidden: Because AIAS access limits and duration are undecided, bundle checkout cannot safely operate and is paused. Online payment is disabled.'
    };
  }

  // Strict Order ID match: verify that the payment corresponds to this specific internal order
  if (req.razorpayOrderId !== order.razorpayOrderId) {
    return {
      success: false,
      error: `Razorpay order ID mismatch: expected ${order.razorpayOrderId}, received ${req.razorpayOrderId}`
    };
  }

  const secret = config?.razorpayKeySecret || process.env.RAZORPAY_KEY_SECRET;
  const keyId = config?.razorpayKeyId || process.env.RAZORPAY_KEY_ID;

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
  } else if (config?.allowTestMockSignature) {
    // Controlled test mode when explicitly passed by test suite
    if (req.razorpaySignature !== 'test_valid_mock_signature') {
      return { success: false, error: 'Invalid mock test signature.' };
    }
  } else {
    // Secret missing and test mode not explicitly granted
    return { success: false, error: 'Razorpay secret key not configured for payment verification.' };
  }

  // Gateway payment verification and capture enforcement
  if (keyId && secret && !config?.skipGatewayFetch && !keyId.startsWith('rzp_test_placeholder_mock')) {
    try {
      let payment = await fetchRazorpayPayment({
        paymentId: req.razorpayPaymentId,
        keyId,
        keySecret: secret,
        fetchFn: config?.fetchFn
      });

      if (payment.order_id && payment.order_id !== order.razorpayOrderId) {
        return { success: false, error: 'Payment entity order_id does not match storefront order.' };
      }

      const expectedSubunits = order.amountInr * 100;
      if (payment.amount && payment.amount !== expectedSubunits) {
        return {
          success: false,
          error: `Payment amount mismatch: expected ₹${order.amountInr} (${expectedSubunits} subunits), got ${payment.amount}`
        };
      }

      if (payment.currency && payment.currency !== order.currency) {
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
            fetchFn: config?.fetchFn
          });
        } catch (capErr: any) {
          // Re-fetch to confirm whether capture succeeded despite network timeout/drop
          try {
            const refetched = await fetchRazorpayPayment({
              paymentId: req.razorpayPaymentId,
              keyId,
              keySecret: secret,
              fetchFn: config?.fetchFn
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

      // STRICT INVARIANT: Digital fulfillment requires payment in 'captured' status!
      if (payment.status !== 'captured') {
        return {
          success: false,
          error: `Payment cannot trigger fulfillment because it is not captured (current status: ${payment.status})`
        };
      }
    } catch (err: any) {
      if (process.env.NODE_ENV === 'production') {
        return { success: false, error: `Failed to confirm payment status with Razorpay: ${err.message}` };
      }
    }
  }

  // Atomic Compare-And-Swap transition from 'pending_payment' to 'paid'
  const atomicTransition = await orderRepository.transitionStatusAtomic(
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
    const current = await orderRepository.get(order.id);
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
  const orchestration = await executeOrderProvisioning(paidOrder, config?.provisioningOptions || { simulate: true });
  await orderRepository.save(orchestration.order);

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
    const matchedOrder = await orderRepository.findByRazorpayOrderId(rzpOrderId);

    if (!matchedOrder) {
      return { success: false, error: `No internal order found for Razorpay order ID ${rzpOrderId}` };
    }

    // Safety Gate: Reject webhook provisioning for paused bundle orders
    const isBundleOrder = matchedOrder.sku === 'SKU_BUNDLE_ALL_IN_ONE' ||
      matchedOrder.items.some(i => i.sku === 'SKU_BUNDLE_ALL_IN_ONE' || i.sku === 'SKU_AIAS_TUTOR_PASS');
    const isAuthorizedTestBundle = Boolean((matchedOrder.metadata as any)?.allowPausedBundleForTesting);

    if (isBundleOrder && !isAuthorizedTestBundle) {
      return {
        success: false,
        error: 'Webhook fulfillment rejected: Because AIAS access limits and duration are undecided, bundle checkout cannot safely operate and is paused.'
      };
    }

    // Idempotency: If already paid or fulfilled, do not re-provision
    if (matchedOrder.status === 'fulfilled' || matchedOrder.status === 'paid' || matchedOrder.status === 'provisioning') {
      return {
        success: true,
        event: eventData.event,
        orderId: matchedOrder.id,
        isDuplicate: true
      };
    }

    // Validate amount
    const expectedSubunits = matchedOrder.amountInr * 100;
    if (payment.amount !== expectedSubunits) {
      return {
        success: false,
        error: `Webhook amount mismatch: expected ${expectedSubunits}, received ${payment.amount}`
      };
    }

    // Atomic CAS transition
    const atomicTransition = await orderRepository.transitionStatusAtomic(
      matchedOrder.id,
      'pending_payment',
      'paid',
      { razorpayPaymentId: payment.id }
    );

    if (!atomicTransition.success || !atomicTransition.order) {
      return { success: true, event: eventData.event, orderId: matchedOrder.id, isDuplicate: true };
    }

    const paidOrder = atomicTransition.order;
    const orchestration = await executeOrderProvisioning(paidOrder, config?.provisioningOptions || { simulate: true });
    await orderRepository.save(orchestration.order);

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
  const order = await orderRepository.get(orderId);
  if (!order) {
    return { success: false, error: `Order not found: ${orderId}` };
  }

  try {
    const orchestration = await retryOrderProvisioning(order, options || { simulate: true });
    await orderRepository.save(orchestration.order);
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
  const order = await orderRepository.get(orderId);
  if (!order) {
    return { reconciled: false, order: null, status: 'not_found', error: `Order not found: ${orderId}` };
  }

  // Safety Gate: Reject reconciliation/fulfillment for paused bundle orders
  const isBundleOrder = order.sku === 'SKU_BUNDLE_ALL_IN_ONE' ||
    order.items.some(i => i.sku === 'SKU_BUNDLE_ALL_IN_ONE' || i.sku === 'SKU_AIAS_TUTOR_PASS');
  const isAuthorizedTestBundle = Boolean(config?.allowPausedBundleForTesting || (order.metadata as any)?.allowPausedBundleForTesting);

  if (isBundleOrder && !isAuthorizedTestBundle) {
    return {
      reconciled: false,
      order,
      status: order.status,
      error: 'Reconciliation forbidden: Bundle checkout is paused while AI Speaking Partner terms are undecided.'
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
          const transitioned = await orderRepository.transitionStatusAtomic(
            order.id,
            'pending_payment',
            'paid',
            { razorpayPaymentId: payment.id }
          );
          if (transitioned.success && transitioned.order) {
            const orchestration = await executeOrderProvisioning(
              transitioned.order,
              config?.provisioningOptions || { simulate: true }
            );
            await orderRepository.save(orchestration.order);
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
