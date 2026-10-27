-- ============================================================================
-- Peregrine Academy Central Storefront Commerce & Provisioning Schema
-- ============================================================================
-- Stores central orders, individual order line items, fulfillment state across
-- LMS, Digital Book, and AIAS, along with complete audit trail of provisioning events.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Central Orders Table
CREATE TABLE IF NOT EXISTS public.storefront_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number TEXT NOT NULL UNIQUE,
  customer_email TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  customer_phone TEXT,
  sku TEXT NOT NULL,
  amount_inr NUMERIC(10, 2) NOT NULL CHECK (amount_inr >= 0),
  currency TEXT NOT NULL DEFAULT 'INR',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (
    status IN (
      'draft',
      'pending_payment',
      'paid',
      'provisioning',
      'fulfilled',
      'partially_provisioned',
      'failed',
      'refund_pending',
      'refunded'
    )
  ),
  razorpay_order_id TEXT UNIQUE,
  razorpay_payment_id TEXT UNIQUE,
  razorpay_signature TEXT,
  payment_verified_at TIMESTAMPTZ,
  provisioned_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Order Line Items (Per-Product Entitlement Tracking)
CREATE TABLE IF NOT EXISTS public.storefront_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES public.storefront_orders(id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  target_platform TEXT NOT NULL CHECK (target_platform IN ('LMS', 'BOOK_READER', 'AIAS')),
  unit_price_inr NUMERIC(10, 2) NOT NULL CHECK (unit_price_inr >= 0),
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  provisioning_status TEXT NOT NULL DEFAULT 'pending' CHECK (
    provisioning_status IN ('pending', 'in_progress', 'granted', 'failed', 'revoked')
  ),
  access_granted_at TIMESTAMPTZ,
  claim_token TEXT,
  claim_url TEXT,
  external_ref_id TEXT,
  last_error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Provisioning Audit Logs
CREATE TABLE IF NOT EXISTS public.storefront_provisioning_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES public.storefront_orders(id) ON DELETE CASCADE,
  item_id UUID REFERENCES public.storefront_order_items(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('grant', 'retry', 'revoke', 'claim')),
  target_platform TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'failure', 'skipped')),
  response_payload JSONB DEFAULT '{}'::jsonb,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_storefront_orders_customer_email ON public.storefront_orders(customer_email);
CREATE INDEX IF NOT EXISTS idx_storefront_orders_status ON public.storefront_orders(status);
CREATE INDEX IF NOT EXISTS idx_storefront_orders_razorpay_order_id ON public.storefront_orders(razorpay_order_id);
CREATE INDEX IF NOT EXISTS idx_storefront_order_items_order_id ON public.storefront_order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_storefront_order_items_status ON public.storefront_order_items(provisioning_status);
CREATE INDEX IF NOT EXISTS idx_storefront_prov_logs_order_id ON public.storefront_provisioning_logs(order_id);

-- Enable RLS
ALTER TABLE public.storefront_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.storefront_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.storefront_provisioning_logs ENABLE ROW LEVEL SECURITY;

-- Service Role Policy (Full Access)
CREATE POLICY "Service role full access on orders"
  ON public.storefront_orders
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Service role full access on order items"
  ON public.storefront_order_items
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Service role full access on provisioning logs"
  ON public.storefront_provisioning_logs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Public Read Policy (for Claim / Order Status by matching Order Number and Email)
CREATE POLICY "Public claim status access"
  ON public.storefront_orders
  FOR SELECT
  TO anon, authenticated
  USING (status IN ('paid', 'provisioning', 'fulfilled', 'partially_provisioned'));
