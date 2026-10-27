import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type StorefrontOrder, type OrderStatus, transitionOrder } from '../order-state-machine.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Root directory for local durable storage
const DATA_DIR = process.env.STOREFRONT_DATA_DIR || path.join(__dirname, '../../../data');
const ORDERS_FILE = path.join(DATA_DIR, 'storefront-orders.json');

/**
 * Local Durable Order Repository with Atomic File Persistence and In-Memory Cache.
 * Prevents financial order data loss across process restarts.
 */
class LocalOrderRepository {
  private cache: Map<string, StorefrontOrder> = new Map();
  private initialized: boolean = false;
  private activeDataDir: string = DATA_DIR;
  private activeOrdersFile: string = ORDERS_FILE;

  private ensureInitialized() {
    if (this.initialized) return;

    try {
      if (!fs.existsSync(this.activeDataDir)) {
        try {
          fs.mkdirSync(this.activeDataDir, { recursive: true });
        } catch (mkErr: any) {
          if (mkErr.code === 'EPERM') {
            this.activeDataDir = '/tmp/peregrine-academy-storefront-data';
            this.activeOrdersFile = path.join(this.activeDataDir, 'storefront-orders.json');
            fs.mkdirSync(this.activeDataDir, { recursive: true });
          } else {
            throw mkErr;
          }
        }
      }

      if (fs.existsSync(this.activeOrdersFile)) {
        const raw = fs.readFileSync(this.activeOrdersFile, 'utf8');
        if (raw.trim()) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            for (const order of parsed) {
              if (order && order.id) {
                this.cache.set(order.id, order);
              }
            }
          }
        }
      }
    } catch (err) {
      console.error('[order-repository] Failed to initialize storage from disk:', err);
    }

    this.initialized = true;
  }

  private persistToDisk() {
    try {
      if (!fs.existsSync(this.activeDataDir)) {
        fs.mkdirSync(this.activeDataDir, { recursive: true });
      }

      const ordersArray = Array.from(this.cache.values());
      const tempPath = `${this.activeOrdersFile}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
      fs.writeFileSync(tempPath, JSON.stringify(ordersArray, null, 2), 'utf8');
      fs.renameSync(tempPath, this.activeOrdersFile); // Atomic replace
    } catch (err: any) {
      if (err.code === 'EPERM' && this.activeDataDir !== '/tmp/peregrine-academy-storefront-data') {
        this.activeDataDir = '/tmp/peregrine-academy-storefront-data';
        this.activeOrdersFile = path.join(this.activeDataDir, 'storefront-orders.json');
        this.persistToDisk();
        return;
      }
      console.error('[order-repository] Failed to persist orders to disk:', err);
    }
  }

  public getLiveCache(): Map<string, StorefrontOrder> {
    this.ensureInitialized();
    return this.cache;
  }

  public async save(order: StorefrontOrder): Promise<StorefrontOrder> {
    this.ensureInitialized();
    const updated = {
      ...order,
      updatedAt: new Date().toISOString()
    };
    this.cache.set(updated.id, updated);
    this.persistToDisk();
    return updated;
  }

  public async get(orderId: string): Promise<StorefrontOrder | null> {
    this.ensureInitialized();
    return this.cache.get(orderId) || null;
  }

  public async findByRazorpayOrderId(rzpOrderId: string): Promise<StorefrontOrder | null> {
    this.ensureInitialized();
    for (const order of this.cache.values()) {
      if (order.razorpayOrderId === rzpOrderId) {
        return order;
      }
    }
    return null;
  }

  public async findByOrderNumber(orderNumber: string): Promise<StorefrontOrder | null> {
    this.ensureInitialized();
    for (const order of this.cache.values()) {
      if (order.orderNumber === orderNumber) {
        return order;
      }
    }
    return null;
  }

  /**
   * Atomic Compare-And-Swap (CAS) transition to prevent concurrent race conditions
   * (e.g. simultaneous browser redirect and webhook delivery).
   */
  public async transitionStatusAtomic(
    orderId: string,
    expectedStatus: OrderStatus,
    targetStatus: OrderStatus,
    paymentProof?: { razorpayPaymentId?: string; razorpaySignature?: string }
  ): Promise<{ success: boolean; order?: StorefrontOrder; error?: string }> {
    this.ensureInitialized();
    const current = this.cache.get(orderId);
    if (!current) {
      return { success: false, error: `Order not found: ${orderId}` };
    }

    if (current.status !== expectedStatus) {
      return {
        success: false,
        error: `Atomic CAS failed: expected status '${expectedStatus}', but current status is '${current.status}'`,
        order: current
      };
    }

    if (paymentProof) {
      if (paymentProof.razorpayPaymentId) current.razorpayPaymentId = paymentProof.razorpayPaymentId;
      if (paymentProof.razorpaySignature) current.razorpaySignature = paymentProof.razorpaySignature;
    }

    const updated = transitionOrder(current, targetStatus);
    this.cache.set(updated.id, updated);
    this.persistToDisk();

    return { success: true, order: updated };
  }

  public async clearForTesting(): Promise<void> {
    this.ensureInitialized();
    this.cache.clear();
    try {
      if (fs.existsSync(this.activeOrdersFile)) {
        fs.unlinkSync(this.activeOrdersFile);
      }
    } catch {
      // Ignore in tests
    }
  }
}

export const orderRepository = new LocalOrderRepository();
