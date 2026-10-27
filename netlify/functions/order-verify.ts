import { handleVerifyPayment } from '../../src/api/orders.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Razorpay-Signature'
};

export default async function handler(req: any, _context?: any) {
  if (req instanceof Request || (req && req.url && typeof req.text === 'function')) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405, headers: CORS_HEADERS });

    try {
      const body = await req.json();
      const result = await handleVerifyPayment(
        {
          orderId: body.orderId,
          razorpayOrderId: body.razorpayOrderId,
          razorpayPaymentId: body.razorpayPaymentId,
          razorpaySignature: body.razorpaySignature
        },
        {
          razorpayKeyId: process.env.RAZORPAY_KEY_ID || process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
          razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET
        }
      );
      return new Response(JSON.stringify(result), {
        status: result.success ? 200 : 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    } catch (err: any) {
      return new Response(JSON.stringify({ success: false, error: err.message }), {
        status: 500,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }
  }

  // Netlify V1 event interface fallback
  if (req.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  if (req.httpMethod !== 'POST') return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  try {
    const payload = JSON.parse(req.body || '{}');
    const result = await handleVerifyPayment(
      {
        orderId: payload.orderId,
        razorpayOrderId: payload.razorpayOrderId,
        razorpayPaymentId: payload.razorpayPaymentId,
        razorpaySignature: payload.razorpaySignature
      },
      {
        razorpayKeyId: process.env.RAZORPAY_KEY_ID || process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
        razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET
      }
    );
    return {
      statusCode: result.success ? 200 : 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify(result)
    };
  } catch (err: any) {
    return {
      statusCode: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, error: err.message })
    };
  }
}

export { handler };
