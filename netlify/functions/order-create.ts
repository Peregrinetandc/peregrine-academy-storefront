import { handleCreateOrder } from '../../src/api/orders.ts';
import crypto from 'node:crypto';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

function generateSupportRef(): string {
  return `PRGN-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

export default async function handler(req: any, _context?: any) {
  if (req instanceof Request || (req && req.url && typeof req.text === 'function')) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405, headers: CORS_HEADERS });

    const supportRef = generateSupportRef();
    try {
      const body = await req.json();
      const result = await handleCreateOrder(body, {
        razorpayKeyId: process.env.RAZORPAY_KEY_ID || process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
        razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET
      });
      if (!result.success) {
        console.error(`[Storefront Diagnostic ${supportRef}] /api/order/create notice:`, result.error);
        return new Response(JSON.stringify({ ...result, supportRef }), {
          status: 400,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    } catch (err: any) {
      console.error(`[Storefront Diagnostic ${supportRef}] /api/order/create exception:`, err.message);
      return new Response(JSON.stringify({ success: false, error: err.message, supportRef }), {
        status: 500,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }
  }

  // Netlify V1 event interface fallback
  if (req.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  if (req.httpMethod !== 'POST') return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  const supportRef = generateSupportRef();
  try {
    const payload = JSON.parse(req.body || '{}');
    const result = await handleCreateOrder(payload, {
      razorpayKeyId: process.env.RAZORPAY_KEY_ID || process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
      razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET
    });
    if (!result.success) {
      console.error(`[Storefront Diagnostic ${supportRef}] /api/order/create notice:`, result.error);
      return {
        statusCode: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...result, supportRef })
      };
    }
    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify(result)
    };
  } catch (err: any) {
    console.error(`[Storefront Diagnostic ${supportRef}] /api/order/create exception:`, err.message);
    return {
      statusCode: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, error: err.message, supportRef })
    };
  }
}

export { handler };
