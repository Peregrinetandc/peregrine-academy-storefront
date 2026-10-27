import { type StorefrontOrder, type OrderItem, transitionOrder } from '../order-state-machine.ts';
import { provisionLmsCourse } from './lms-adapter.ts';
import { provisionBookReader } from './book-adapter.ts';
import { provisionAiasTutor } from './aias-adapter.ts';

export interface ProvisioningOptions {
  lmsApiUrl?: string;
  lmsApiKey?: string;
  readerApiUrl?: string;
  handoffSecret?: string;
  aiasApiUrl?: string;
  aiasSecret?: string;
  simulate?: boolean;
}

export interface OrchestrationResult {
  order: StorefrontOrder;
  allSucceeded: boolean;
  provisionedCount: number;
  failedCount: number;
  itemResults: {
    sku: string;
    targetPlatform: string;
    success: boolean;
    error?: string;
  }[];
}

/**
 * Orchestrates multi-product fulfillment across LMS, Digital Reader, and AIAS.
 * Idempotent: Skips items already in 'granted' status.
 */
export async function executeOrderProvisioning(
  order: StorefrontOrder,
  options?: ProvisioningOptions
): Promise<OrchestrationResult> {
  // Idempotency: If already fulfilled, return directly
  if (order.status === 'fulfilled') {
    return {
      order,
      allSucceeded: true,
      provisionedCount: order.items.length,
      failedCount: 0,
      itemResults: order.items.map(i => ({
        sku: i.sku,
        targetPlatform: i.targetPlatform,
        success: true
      }))
    };
  }

  // Must be in 'paid' or 'partially_provisioned' to start provisioning
  let currentOrder = transitionOrder(order, 'provisioning');
  const updatedItems: OrderItem[] = [];
  const itemResults: OrchestrationResult['itemResults'] = [];
  let provisionedCount = 0;
  let failedCount = 0;

  for (const item of currentOrder.items) {
    // If this item was already granted, preserve it
    if (item.provisioningStatus === 'granted') {
      updatedItems.push(item);
      provisionedCount++;
      itemResults.push({
        sku: item.sku,
        targetPlatform: item.targetPlatform,
        success: true
      });
      continue;
    }

    const itemCopy: OrderItem = {
      ...item,
      provisioningStatus: 'in_progress',
      retryCount: (item.retryCount || 0) + 1
    };

    try {
      if (item.targetPlatform === 'LMS') {
        const result = await provisionLmsCourse(
          {
            orderId: currentOrder.id,
            customerEmail: currentOrder.customerEmail,
            customerName: currentOrder.customerName
          },
          options
        );

        if (result.success) {
          itemCopy.provisioningStatus = 'granted';
          itemCopy.accessGrantedAt = new Date().toISOString();
          itemCopy.claimUrl = result.courseUrl;
          itemCopy.externalRefId = result.enrollmentId;
          itemCopy.lastError = undefined;
          provisionedCount++;
          itemResults.push({ sku: item.sku, targetPlatform: item.targetPlatform, success: true });
        } else {
          itemCopy.provisioningStatus = 'failed';
          itemCopy.lastError = result.error || result.message;
          failedCount++;
          itemResults.push({ sku: item.sku, targetPlatform: item.targetPlatform, success: false, error: itemCopy.lastError });
        }
      } else if (item.targetPlatform === 'BOOK_READER') {
        const result = await provisionBookReader(
          {
            orderId: currentOrder.id,
            customerEmail: currentOrder.customerEmail,
            customerName: currentOrder.customerName
          },
          options
        );

        if (result.success) {
          itemCopy.provisioningStatus = 'granted';
          itemCopy.accessGrantedAt = new Date().toISOString();
          itemCopy.claimToken = result.claimToken;
          itemCopy.claimUrl = result.claimUrl;
          itemCopy.lastError = undefined;
          provisionedCount++;
          itemResults.push({ sku: item.sku, targetPlatform: item.targetPlatform, success: true });
        } else {
          itemCopy.provisioningStatus = 'failed';
          itemCopy.lastError = result.error || result.message;
          failedCount++;
          itemResults.push({ sku: item.sku, targetPlatform: item.targetPlatform, success: false, error: itemCopy.lastError });
        }
      } else if (item.targetPlatform === 'AIAS') {
        const result = await provisionAiasTutor(
          {
            orderId: currentOrder.id,
            customerEmail: currentOrder.customerEmail
          },
          options
        );

        if (result.success) {
          itemCopy.provisioningStatus = 'granted';
          itemCopy.accessGrantedAt = result.startsAt || new Date().toISOString();
          itemCopy.accessExpiresAt = result.expiresAt;
          itemCopy.claimToken = result.activationCode;
          itemCopy.claimUrl = result.tutorUrl;
          itemCopy.lastError = undefined;
          provisionedCount++;
          itemResults.push({ sku: item.sku, targetPlatform: item.targetPlatform, success: true });
        } else {
          itemCopy.provisioningStatus = 'failed';
          itemCopy.lastError = result.error || result.message;
          failedCount++;
          itemResults.push({ sku: item.sku, targetPlatform: item.targetPlatform, success: false, error: itemCopy.lastError });
        }
      }
    } catch (err: any) {
      itemCopy.provisioningStatus = 'failed';
      itemCopy.lastError = err.message || String(err);
      failedCount++;
      itemResults.push({ sku: item.sku, targetPlatform: item.targetPlatform, success: false, error: itemCopy.lastError });
    }

    updatedItems.push(itemCopy);
  }

  currentOrder.items = updatedItems;

  // Determine final order status based on item statuses
  const totalItems = currentOrder.items.length;
  if (provisionedCount === totalItems) {
    currentOrder = transitionOrder(currentOrder, 'fulfilled');
  } else if (provisionedCount > 0 && failedCount > 0) {
    currentOrder = transitionOrder(currentOrder, 'partially_provisioned');
  } else {
    currentOrder = transitionOrder(currentOrder, 'failed');
  }

  return {
    order: currentOrder,
    allSucceeded: provisionedCount === totalItems,
    provisionedCount,
    failedCount,
    itemResults
  };
}

/**
 * Retries provisioning for orders in 'partially_provisioned' or 'failed' status.
 */
export async function retryOrderProvisioning(
  order: StorefrontOrder,
  options?: ProvisioningOptions
): Promise<OrchestrationResult> {
  if (order.status !== 'partially_provisioned' && order.status !== 'failed') {
    throw new Error(`Cannot retry order in status '${order.status}'. Only partially_provisioned or failed orders can be retried.`);
  }

  return executeOrderProvisioning(order, options);
}
