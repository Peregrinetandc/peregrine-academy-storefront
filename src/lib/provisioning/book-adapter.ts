import crypto from 'node:crypto';

/**
 * Reader & Digital Book Provisioning Adapter
 * 
 * Interacts with https://arabic.peregrineacademy.in
 * Conforms EXACTLY to the Reader contract defined in api/bundle.js:
 * - Product Key: "khaliji-book"
 * - Action: "grant"
 * - Canonical signature: [timestamp, action, orderId, lmsUserId, normalizeEmail(email), productKey].join("\n")
 * - Header: x-bundle-timestamp, x-bundle-signature
 * - Single-use token: payload format with { v: 1, aud: "khaliji-reader", ... }
 */

export interface BookProvisioningParams {
  orderId: string;
  customerEmail: string;
  customerName?: string;
  lmsUserId?: string;
  productKey?: string;
}

export interface BookProvisioningResult {
  success: boolean;
  claimToken: string;
  claimUrl: string;
  readerUrl: string;
  message: string;
  error?: string;
}

export const KHALIJI_BOOK_PRODUCT_KEY = 'khaliji-book';

function normalizeEmail(email: string): string {
  return (email ?? '').trim().toLowerCase();
}

/**
 * Creates a cryptographically signed handoff claim token conforming to
 * verifyBundleHandoffToken in khaliji-arabic-through-stories/api/bundle.js.
 */
export function generateReaderClaimToken(params: {
  orderId: string;
  email: string;
  secret: string;
  lmsUserId?: string;
  expiresInDays?: number;
}): { token: string; expiresAt: string } {
  const expiresInDays = params.expiresInDays || 365;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expSeconds = nowSeconds + expiresInDays * 86400;
  const expiresAt = new Date(expSeconds * 1000).toISOString();
  
  const payload = {
    v: 1,
    aud: 'khaliji-reader',
    sub: params.lmsUserId || params.orderId,
    order_id: params.orderId,
    email: normalizeEmail(params.email),
    jti: crypto.randomUUID(),
    iat: nowSeconds,
    exp: expSeconds
  };

  const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', params.secret)
    .update(payloadBase64)
    .digest('hex');

  const token = `${payloadBase64}.${signature}`;
  return { token, expiresAt };
}

/**
 * Computes canonical request signature string for /api/bundle?action=grant
 */
export function computeBundleRequestSignature(params: {
  timestamp: string;
  action: string;
  orderId: string;
  lmsUserId: string;
  email: string;
  productKey: string;
  secret: string;
}): string {
  const canonical = [
    params.timestamp,
    params.action,
    params.orderId,
    params.lmsUserId,
    normalizeEmail(params.email),
    params.productKey
  ].join('\n');

  return crypto.createHmac('sha256', params.secret).update(canonical).digest('hex');
}

export async function provisionBookReader(
  params: BookProvisioningParams,
  options?: {
    readerApiUrl?: string;
    handoffSecret?: string;
    simulate?: boolean;
  }
): Promise<BookProvisioningResult> {
  const secret = options?.handoffSecret || 'storefront-development-handoff-secret-key-32b-min';
  const readerBaseUrl = options?.readerApiUrl || 'https://arabic.peregrineacademy.in';
  const productKey = params.productKey || KHALIJI_BOOK_PRODUCT_KEY;
  const lmsUserId = params.lmsUserId || `storefront_${params.orderId.slice(0, 12)}`;
  const normalizedEmail = normalizeEmail(params.customerEmail);

  const { token } = generateReaderClaimToken({
    orderId: params.orderId,
    email: normalizedEmail,
    secret,
    lmsUserId
  });

  const claimUrl = `${readerBaseUrl}/claim?token=${encodeURIComponent(token)}`;
  const readerUrl = `${readerBaseUrl}/stories`;

  // Simulation mode for tests / offline preview
  if (options?.simulate || !options?.readerApiUrl) {
    return {
      success: true,
      claimToken: token,
      claimUrl,
      readerUrl,
      message: `Generated reader claim token for ${normalizedEmail}`
    };
  }

  try {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = computeBundleRequestSignature({
      timestamp,
      action: 'grant',
      orderId: params.orderId,
      lmsUserId,
      email: normalizedEmail,
      productKey,
      secret
    });

    const res = await fetch(`${readerBaseUrl}/api/bundle?action=grant`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bundle-timestamp': timestamp,
        'x-bundle-signature': signature
      },
      body: JSON.stringify({
        order_id: params.orderId,
        lms_user_id: lmsUserId,
        email: normalizedEmail,
        product_key: productKey
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      return {
        success: false,
        claimToken: token,
        claimUrl,
        readerUrl,
        message: 'Reader grant API failed',
        error: `HTTP ${res.status}: ${errText}`
      };
    }

    const data = await res.json();
    return {
      success: true,
      claimToken: data.claim_token || token,
      claimUrl: data.claim_url || claimUrl,
      readerUrl,
      message: 'Successfully provisioned digital book access'
    };
  } catch (err: any) {
    return {
      success: false,
      claimToken: token,
      claimUrl,
      readerUrl,
      message: 'Failed to contact reader API',
      error: err.message || String(err)
    };
  }
}
