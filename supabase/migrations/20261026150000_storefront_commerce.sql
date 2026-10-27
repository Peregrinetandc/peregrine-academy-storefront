-- ============================================================================
-- Peregrine Academy Central Storefront Commerce & Provisioning Schema
-- ============================================================================
-- Stores central orders, individual order line items, fulfillment state across
-- LMS, Digital Book, and AIAS, along with complete audit trail of provisioning events.
-- 
-- DEFENSE-IN-DEPTH SECURITY POLICY:
-- 1. Table-level REVOKE: Zero permissions granted to PUBLIC, anon, or standard authenticated roles.
-- 2. Row Level Security: Enabled on all tables; service_role policy only.
-- 3. Stored Functions: SECURITY DEFINER with explicit search_path = public, pg_temp.
-- 4. Function Execution: EXECUTE explicitly revoked from PUBLIC/anon/authenticated; granted only to service_role.
-- 5. Verification Boundary: Cryptographic payment signature verification MUST be completed by the
--    trusted server application before calling state transition functions.

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

-- Performance Indexes
CREATE INDEX IF NOT EXISTS idx_storefront_orders_customer_email ON public.storefront_orders(customer_email);
CREATE INDEX IF NOT EXISTS idx_storefront_orders_status ON public.storefront_orders(status);
CREATE INDEX IF NOT EXISTS idx_storefront_orders_razorpay_order_id ON public.storefront_orders(razorpay_order_id);
CREATE INDEX IF NOT EXISTS idx_storefront_order_items_order_id ON public.storefront_order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_storefront_order_items_status ON public.storefront_order_items(provisioning_status);
CREATE INDEX IF NOT EXISTS idx_storefront_prov_logs_order_id ON public.storefront_provisioning_logs(order_id);

-- Automated updated_at Trigger Mechanism with safe search_path
CREATE OR REPLACE FUNCTION public.set_storefront_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_storefront_orders_updated_at ON public.storefront_orders;
CREATE TRIGGER trg_storefront_orders_updated_at
  BEFORE UPDATE ON public.storefront_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.set_storefront_updated_at();

DROP TRIGGER IF EXISTS trg_storefront_order_items_updated_at ON public.storefront_order_items;
CREATE TRIGGER trg_storefront_order_items_updated_at
  BEFORE UPDATE ON public.storefront_order_items
  FOR EACH ROW
  EXECUTE FUNCTION public.set_storefront_updated_at();

-- Defense-in-depth: Revoke all table permissions from untrusted roles
REVOKE ALL ON TABLE public.storefront_orders FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.storefront_order_items FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.storefront_provisioning_logs FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public.storefront_orders TO service_role;
GRANT ALL ON TABLE public.storefront_order_items TO service_role;
GRANT ALL ON TABLE public.storefront_provisioning_logs TO service_role;

-- Enable Row Level Security on all tables
ALTER TABLE public.storefront_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.storefront_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.storefront_provisioning_logs ENABLE ROW LEVEL SECURITY;

-- Idempotent Service Role Policies (Zero Public/Anonymous Access)
DO $$
BEGIN
  DROP POLICY IF EXISTS "Service role full access on orders" ON public.storefront_orders;
  CREATE POLICY "Service role full access on orders"
    ON public.storefront_orders
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

  DROP POLICY IF EXISTS "Service role full access on order items" ON public.storefront_order_items;
  CREATE POLICY "Service role full access on order items"
    ON public.storefront_order_items
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

  DROP POLICY IF EXISTS "Service role full access on provisioning logs" ON public.storefront_provisioning_logs;
  CREATE POLICY "Service role full access on provisioning logs"
    ON public.storefront_provisioning_logs
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

  -- Explicitly ensure unsafe anonymous policies do not exist
  DROP POLICY IF EXISTS "Public claim status access" ON public.storefront_orders;
  DROP POLICY IF EXISTS "Anon read access" ON public.storefront_orders;
END $$;

-- 4. Atomic Status Transition Stored Procedure (Database-level CAS & State Validation)
-- NOTE: Cryptographic Razorpay signature verification MUST be performed by the trusted
-- server application BEFORE invoking this function. This function enforces row locking,
-- state transition validity, and payment ID requirements, but cannot verify HMAC secrets.
CREATE OR REPLACE FUNCTION public.storefront_transition_order_status(
  p_order_id UUID,
  p_expected_status TEXT,
  p_target_status TEXT,
  p_razorpay_payment_id TEXT DEFAULT NULL,
  p_razorpay_signature TEXT DEFAULT NULL
)
RETURNS TABLE (
  success BOOLEAN,
  error_message TEXT,
  order_id UUID,
  order_number TEXT,
  current_status TEXT,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_current public.storefront_orders;
  v_is_valid_transition BOOLEAN := false;
BEGIN
  -- Row-level lock to prevent concurrent races
  SELECT * INTO v_current
  FROM public.storefront_orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, ('Order not found: ' || p_order_id::text)::TEXT, NULL::UUID, NULL::TEXT, NULL::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  -- Verify expected status (Compare-And-Swap)
  IF v_current.status != p_expected_status THEN
    RETURN QUERY SELECT 
      false, 
      ('Atomic CAS failed: expected status ''' || p_expected_status || ''', but current status is ''' || v_current.status || '''')::TEXT,
      v_current.id,
      v_current.order_number,
      v_current.status,
      v_current.updated_at;
    RETURN;
  END IF;

  -- Validate state machine transition matrix
  IF p_expected_status = p_target_status THEN
    v_is_valid_transition := true;
  ELSIF p_expected_status = 'draft' AND p_target_status IN ('pending_payment', 'failed') THEN
    v_is_valid_transition := true;
  ELSIF p_expected_status = 'pending_payment' AND p_target_status IN ('paid', 'failed') THEN
    v_is_valid_transition := true;
  ELSIF p_expected_status = 'paid' AND p_target_status IN ('provisioning', 'refund_pending') THEN
    v_is_valid_transition := true;
  ELSIF p_expected_status = 'provisioning' AND p_target_status IN ('fulfilled', 'partially_provisioned', 'failed') THEN
    v_is_valid_transition := true;
  ELSIF p_expected_status = 'partially_provisioned' AND p_target_status IN ('provisioning', 'fulfilled', 'refund_pending') THEN
    v_is_valid_transition := true;
  ELSIF p_expected_status = 'fulfilled' AND p_target_status = 'refund_pending' THEN
    v_is_valid_transition := true;
  ELSIF p_expected_status = 'failed' AND p_target_status = 'draft' THEN
    -- Invariant: Forbid transition to draft if payment proof is already attached to prevent double charges
    IF v_current.razorpay_payment_id IS NOT NULL OR v_current.payment_verified_at IS NOT NULL THEN
      RETURN QUERY SELECT 
        false, 
        ('Cannot transition failed order ' || v_current.order_number || ' to draft because payment proof exists (' || COALESCE(v_current.razorpay_payment_id, 'verified') || '). Reconcile payment or route to retry/refund.')::TEXT,
        v_current.id,
        v_current.order_number,
        v_current.status,
        v_current.updated_at;
      RETURN;
    END IF;
    v_is_valid_transition := true;
  ELSIF p_expected_status = 'refund_pending' AND p_target_status IN ('refunded', 'fulfilled') THEN
    v_is_valid_transition := true;
  ELSE
    v_is_valid_transition := false;
  END IF;

  IF NOT v_is_valid_transition THEN
    RETURN QUERY SELECT 
      false, 
      ('Illegal state transition from ''' || p_expected_status || ''' to ''' || p_target_status || '''')::TEXT,
      v_current.id,
      v_current.order_number,
      v_current.status,
      v_current.updated_at;
    RETURN;
  END IF;

  -- Transition to 'paid' strictly requires a razorpay_payment_id
  IF p_target_status = 'paid' AND COALESCE(p_razorpay_payment_id, v_current.razorpay_payment_id) IS NULL THEN
    RETURN QUERY SELECT 
      false, 
      'Transition to paid requires a valid razorpay_payment_id'::TEXT,
      v_current.id,
      v_current.order_number,
      v_current.status,
      v_current.updated_at;
    RETURN;
  END IF;

  -- Execute state transition
  UPDATE public.storefront_orders
  SET
    status = p_target_status,
    razorpay_payment_id = COALESCE(p_razorpay_payment_id, v_current.razorpay_payment_id),
    razorpay_signature = COALESCE(p_razorpay_signature, v_current.razorpay_signature),
    payment_verified_at = CASE WHEN p_target_status = 'paid' THEN NOW() ELSE v_current.payment_verified_at END,
    updated_at = NOW()
  WHERE id = p_order_id
  RETURNING * INTO v_current;

  RETURN QUERY SELECT 
    true, 
    NULL::TEXT, 
    v_current.id, 
    v_current.order_number, 
    v_current.status, 
    v_current.updated_at;
END;
$$;

-- Explicitly revoke execution on functions from untrusted roles and grant only to service_role
REVOKE ALL ON FUNCTION public.storefront_transition_order_status(UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.storefront_transition_order_status(UUID, TEXT, TEXT, TEXT, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.set_storefront_updated_at() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_storefront_updated_at() TO service_role;
