/**
 * Vercel Serverless Function Handler for /api/*
 */

import crypto from 'node:crypto';
import { handleCreateOrder, handleVerifyPayment, handleRazorpayWebhook } from '../src/api/orders.ts';

function generateSupportRef(): string {
  return `PRGN-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

export default async function handler(req: any, res: any) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Razorpay-Signature');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  // Helper to read body if not pre-parsed
  let payload = req.body;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      payload = {};
    }
  }

  // POST /api/order/create
  if (req.method === 'POST' && pathname === '/api/order/create') {
    const supportRef = generateSupportRef();
    try {
      const result = await handleCreateOrder(payload || {}, {
        razorpayKeyId: process.env.RAZORPAY_KEY_ID || process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
        razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET
      });
      res.statusCode = result.success ? 200 : 400;
      res.setHeader('Content-Type', 'application/json');
      if (!result.success) {
        console.error(`[Storefront Diagnostic ${supportRef}] /api/order/create notice:`, result.error);
        res.end(JSON.stringify({ ...result, supportRef }));
      } else {
        res.end(JSON.stringify(result));
      }
    } catch (err: any) {
      console.error(`[Storefront Diagnostic ${supportRef}] /api/order/create exception:`, err.message);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: false, error: err.message, supportRef }));
    }
    return;
  }

  // POST /api/order/verify
  if (req.method === 'POST' && pathname === '/api/order/verify') {
    const supportRef = generateSupportRef();
    try {
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
      res.statusCode = result.success ? 200 : 400;
      res.setHeader('Content-Type', 'application/json');
      if (!result.success) {
        console.error(`[Storefront Diagnostic ${supportRef}] /api/order/verify notice:`, result.error);
        res.end(JSON.stringify({ ...result, supportRef }));
      } else {
        res.end(JSON.stringify(result));
      }
    } catch (err: any) {
      console.error(`[Storefront Diagnostic ${supportRef}] /api/order/verify exception:`, err.message);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: false, error: err.message, supportRef }));
    }
    return;
  }

  // POST /api/webhook/razorpay
  if (req.method === 'POST' && pathname === '/api/webhook/razorpay') {
    const supportRef = generateSupportRef();
    try {
      const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
      const signature = req.headers['x-razorpay-signature'] || '';
      const result = await handleRazorpayWebhook(rawBody, signature, {
        webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET
      });
      res.statusCode = result.success ? 200 : 400;
      res.setHeader('Content-Type', 'application/json');
      if (!result.success) {
        console.error(`[Storefront Diagnostic ${supportRef}] /api/webhook/razorpay notice:`, result.error);
        res.end(JSON.stringify({ ...result, supportRef }));
      } else {
        res.end(JSON.stringify(result));
      }
    } catch (err: any) {
      console.error(`[Storefront Diagnostic ${supportRef}] /api/webhook/razorpay exception:`, err.message);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: false, error: err.message, supportRef }));
    }
    return;
  }

  res.statusCode = 404;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: 'Endpoint Not Found' }));
}
