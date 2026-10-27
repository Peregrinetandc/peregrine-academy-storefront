/**
 * Netlify Serverless API Function Handler
 * Supports both Netlify Functions V2 (standard Web Request/Response)
 * and Netlify Functions V1 (event, context) interfaces.
 */

import { handleCreateOrder, handleVerifyPayment, handleRazorpayWebhook } from '../../src/api/orders.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Razorpay-Signature'
};

async function handleStandardRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname.replace(/^\/\.netlify\/functions\/api/, '/api');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // POST /api/order/create
  if (req.method === 'POST' && pathname === '/api/order/create') {
    try {
      const body = await req.json();
      const result = await handleCreateOrder(body, {
        razorpayKeyId: process.env.RAZORPAY_KEY_ID || process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
        razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET
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

  // POST /api/order/verify
  if (req.method === 'POST' && pathname === '/api/order/verify') {
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

  // POST /api/webhook/razorpay
  if (req.method === 'POST' && pathname === '/api/webhook/razorpay') {
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

  return new Response(JSON.stringify({ error: 'Endpoint Not Found' }), {
    status: 404,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
  });
}

async function handleEventRequest(event: any, _context: any) {
  const pathname = (event.path || '').replace(/^\/\.netlify\/functions\/api/, '/api');

  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: CORS_HEADERS,
      body: ''
    };
  }

  if (event.httpMethod === 'POST' && pathname === '/api/order/create') {
    try {
      const payload = JSON.parse(event.body || '{}');
      const result = await handleCreateOrder(payload, {
        razorpayKeyId: process.env.RAZORPAY_KEY_ID || process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
        razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET
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

  if (event.httpMethod === 'POST' && pathname === '/api/order/verify') {
    try {
      const payload = JSON.parse(event.body || '{}');
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

  if (event.httpMethod === 'POST' && pathname === '/api/webhook/razorpay') {
    try {
      const rawBody = event.isBase64Encoded 
        ? Buffer.from(event.body, 'base64').toString('utf8')
        : (event.body || '');
      const signature = event.headers['x-razorpay-signature'] || event.headers['X-Razorpay-Signature'] || '';
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

  return {
    statusCode: 404,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: 'Endpoint Not Found' })
  };
}

export default async function (req: any, context: any) {
  if (req instanceof Request || (req && req.url && typeof req.text === 'function')) {
    return handleStandardRequest(req);
  }
  return handleEventRequest(req, context);
}

export const handler = handleEventRequest;

export const config = {
  path: ['/api/*', '/.netlify/functions/api/*']
};
