import { handleRazorpayWebhook } from '../../src/api/orders.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Razorpay-Signature'
};

export default async function handler(req: any, _context?: any) {
  if (req instanceof Request || (req && req.url && typeof req.text === 'function')) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405, headers: CORS_HEADERS });

    try {
      const rawBody = await req.text();
      const signature = req.headers.get('x-razorpay-signature') || '';
      const result = await handleRazorpayWebhook(rawBody, signature, {
        webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET
      });
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
    const rawBody = req.isBase64Encoded 
      ? Buffer.from(req.body, 'base64').toString('utf8')
      : (req.body || '');
    const signature = req.headers['x-razorpay-signature'] || req.headers['X-Razorpay-Signature'] || '';
    const result = await handleRazorpayWebhook(rawBody, signature, {
      webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET
    });
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
