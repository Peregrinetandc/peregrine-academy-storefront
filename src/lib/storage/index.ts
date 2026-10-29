import { type IOrderRepository } from './types.ts';
import { LocalOrderRepository } from './order-repository.ts';
import { SupabaseOrderRepository } from './supabase-order-repository.ts';

export * from './types.ts';
export { LocalOrderRepository } from './order-repository.ts';
export { SupabaseOrderRepository } from './supabase-order-repository.ts';

export interface RepositoryFactoryOptions {
  backend?: 'local' | 'supabase';
  supabaseUrl?: string;
  serviceRoleKey?: string;
  fetchFn?: typeof fetch;
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

/**
 * Creates an order repository with strict fail-closed safety.
 * In production: REQUIRES Supabase credentials; never silently falls back to local disk.
 * In development/test: Defaults to LocalOrderRepository unless explicitly configured.
 */
export function createOrderRepository(options?: RepositoryFactoryOptions): IOrderRepository {
  const isProd = isProductionEnvironment();
  const backend = options?.backend || process.env.STOREFRONT_STORAGE_BACKEND || (isProd ? 'supabase' : 'local');

  if (backend === 'supabase' || isProd) {
    const url = options?.supabaseUrl || process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = options?.serviceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

    if (!url || !key) {
      if (isProd) {
        throw new Error(
          '[StorageFactory] PRODUCTION SAFETY BLOCKER: Missing mandatory database credentials. ' +
          'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY) must be configured in production. ' +
          'Silent fallback to local JSON file storage is strictly forbidden in production.'
        );
      }
      throw new Error(
        '[StorageFactory] Supabase storage backend was requested, but SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY) is missing.'
      );
    }

    return new SupabaseOrderRepository({
      supabaseUrl: url,
      serviceRoleKey: key,
      fetchFn: options?.fetchFn
    });
  }

  // Development and test default
  return new LocalOrderRepository();
}

/**
 * Singleton repository instance used by storefront APIs.
 */
export { orderRepository } from './order-repository.ts';
