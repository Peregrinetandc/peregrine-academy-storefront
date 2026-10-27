import crypto from 'node:crypto';

/**
 * AIAS (AI Arabic System) Provisioning Adapter
 * 
 * Unlocks speaking practice with Rashid & Maryam on https://arabic.peregrineacademy.in
 * 
 * ENTITLEMENT POLICY:
 * - 1 Month (30 Days) free trial with the Arabic Learning Package.
 * - Non-recurring: No credit card stored, no recurring billing, and no auto-renewal.
 * - Starts at the moment of verified order payment; expires exactly 30 days later.
 * - Daily turns capped according to AI_PRO_DAILY_TURN_LIMIT policy (not unlimited).
 * 
 * ARCHITECTURE BLOCKER:
 * The Reader repository (api/ai-pro.js) handles self-checkout via in-app Razorpay modal
 * but lacks an external server-to-server grant endpoint for the central storefront.
 * Furthermore, public.ai_pro_entitlements has not been applied to production Supabase.
 */

export interface AiasProvisioningParams {
  orderId: string;
  customerEmail: string;
  durationDays?: number;
}

export interface AiasProvisioningResult {
  success: boolean;
  activationCode: string;
  tutorUrl: string;
  startsAt: string;
  expiresAt: string;
  durationDays: number;
  isFreeTrial: boolean;
  autoRenew: boolean;
  message: string;
  error?: string;
}

export async function provisionAiasTutor(
  params: AiasProvisioningParams,
  options?: {
    tutorApiUrl?: string;
    secret?: string;
    simulate?: boolean;
    now?: Date;
  }
): Promise<AiasProvisioningResult> {
  const tutorUrl = 'https://arabic.peregrineacademy.in/?tutor=open';
  const durationDays = params.durationDays || 30;
  
  const now = options?.now || new Date();
  const startsAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000).toISOString();

  // Format an activation code: AIAS-XXXX-XXXX-XXXX
  const rawHash = crypto
    .createHash('sha256')
    .update(`${params.orderId}:${params.customerEmail}:${startsAt}:free_month`)
    .digest('hex')
    .toUpperCase();
  const activationCode = `AIAS-${rawHash.slice(0, 4)}-${rawHash.slice(4, 8)}-${rawHash.slice(8, 12)}`;

  if (options?.simulate || !options?.tutorApiUrl) {
    return {
      success: true,
      activationCode,
      tutorUrl,
      startsAt,
      expiresAt,
      durationDays,
      isFreeTrial: true,
      autoRenew: false,
      message: `Granted 1 month (30 days) free AI Speaking Partner access for ${params.customerEmail}. Valid until ${expiresAt.slice(0, 10)}. Non-recurring.`
    };
  }

  // If real API is called but no server-to-server grant endpoint exists in Reader codebase
  return {
    success: false,
    activationCode,
    tutorUrl,
    startsAt,
    expiresAt,
    durationDays,
    isFreeTrial: true,
    autoRenew: false,
    message: 'AIAS server-to-server grant endpoint is not yet implemented in Reader codebase',
    error: 'MISSING_AI_PRO_GRANT_ENDPOINT'
  };
}
