-- ===========================================================================
-- UAGE — 06. Checkout quote  (public.checkout_preview)
-- ---------------------------------------------------------------------------
-- The cart and checkout pages have to show a subtotal, a discount, a delivery
-- fee and a total. Those four numbers are MONEY, so the browser must not work
-- them out — a visitor can edit anything the page runs on. This function is the
-- read-only twin of public.place_order(): it takes the exact same basket
-- payload, applies the exact same rules, and writes nothing.
--
-- Relationship to place_order()
--   place_order()  = authorise, validate, quote, WRITE, decrement stock
--   checkout_preview() = validate, quote only
--
-- The two must always agree. The business constants below are deliberately
-- duplicated (a read-only function cannot share place_order's local variables),
-- and supabase/tests/rls.test.mjs asserts that both functions return identical
-- numbers for the same basket — so if one is ever changed without the other,
-- the test suite fails rather than the customer being mischarged.
--
-- Deliberate differences from place_order():
--   * callable ANONYMOUSLY (a guest can fill a cart before signing up)
--   * never raises for content problems (sold out, hidden, deleted). It marks
--     the line `available: false` with a `reason` so the cart can explain
--     itself; place_order() is still the one that refuses the order.
--   * does not lock rows (STABLE functions cannot take FOR UPDATE)
--
-- Security note: the SECURITY DEFINER grant is needed because public.promo_codes
-- is intentionally not readable by customers. It exposes only a yes/no answer
-- for a code the caller already supplied, using the same generic message as
-- place_order(), so it cannot be used to enumerate codes or to learn why one
-- was rejected.
-- ===========================================================================

create or replace function public.checkout_preview(
  p_items      jsonb,
  p_promo_code text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  -- Keep in sync with public.place_order().
  c_delivery_fee  constant numeric(12,2) := 1500;   -- below the threshold
  c_free_delivery constant numeric(12,2) := 10000;  -- free at/above this
  c_max_line_qty  constant integer       := 999;
  c_max_lines     constant integer       := 50;

  v_lines      jsonb := '[]'::jsonb;
  v_item       jsonb;
  v_subtotal   numeric(12,2) := 0;
  v_discount   numeric(12,2) := 0;
  v_delivery   numeric(12,2) := 0;
  v_total      numeric(12,2) := 0;
  v_promo      public.promo_codes%rowtype;
  v_promo_ok   boolean := false;
  v_promo_msg  text := null;
  v_issues     jsonb := '[]'::jsonb;

  v_pid    uuid;
  v_vid    uuid;
  v_pname  text;
  v_vlabel text;
  v_unit   numeric(12,2);
  v_stock  integer;
  v_active boolean;
  v_qty    integer;
  v_reason text;
begin
  -- Structural validation is the same as place_order(): bad input is a bug in
  -- the caller, not something the customer can fix, so it raises.
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'Your cart is empty.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_items) > c_max_lines then
    raise exception 'Too many different items in a single order (max %).', c_max_lines
      using errcode = '22023';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := nullif(btrim(coalesce(v_item ->> 'quantity', '')), '')::integer;

    if v_qty is null or v_qty < 1 or v_qty > c_max_line_qty then
      raise exception 'Each item needs a quantity between 1 and %.', c_max_line_qty
        using errcode = '22023';
    end if;

    -- Guard the uuid casts (mirrors place_order) so malformed input is a
    -- friendly error rather than a raw 22P02.
    v_vid := null;
    v_pid := null;

    if v_item ? 'variant_id'
       and nullif(btrim(coalesce(v_item ->> 'variant_id', '')), '') is not null then
      if (v_item ->> 'variant_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'One of the items in your cart is invalid.' using errcode = '22023';
      end if;
      v_vid := (v_item ->> 'variant_id')::uuid;
    else
      if not (v_item ? 'product_id')
         or nullif(btrim(coalesce(v_item ->> 'product_id', '')), '') is null then
        raise exception 'Each item needs a product.' using errcode = '22023';
      end if;
      if (v_item ->> 'product_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'One of the items in your cart is invalid.' using errcode = '22023';
      end if;
      v_pid := (v_item ->> 'product_id')::uuid;
    end if;

    v_pname := null; v_vlabel := null; v_unit := null; v_stock := 0; v_active := false;

    if v_vid is not null then
      select pv.product_id, p.name, pv.label, pv.price, pv.stock_quantity, p.is_active
        into v_pid, v_pname, v_vlabel, v_unit, v_stock, v_active
        from public.product_variants pv
        join public.products p on p.id = pv.product_id
       where pv.id = v_vid;
    else
      select p.name, p.price, p.stock_quantity, p.is_active
        into v_pname, v_unit, v_stock, v_active
        from public.products p
       where p.id = v_pid;
    end if;

    v_reason := case
      when v_pname is null   then 'This item is no longer available.'
      when not v_active      then 'This item is no longer available.'
      when v_unit is null    then 'Please choose a size for this item.'
      when v_stock < v_qty   then format('Only %s left in stock.', v_stock)
      else null
    end;

    v_lines := v_lines || jsonb_build_object(
      'product_id', v_pid,
      'variant_id', v_vid,
      'name',       coalesce(v_pname, 'Unavailable item'),
      'label',      v_vlabel,
      'quantity',   v_qty,
      'unit_price', coalesce(v_unit, 0),
      'line_total', coalesce(v_unit, 0) * v_qty,
      'stock',      coalesce(v_stock, 0),
      'available',  v_reason is null,
      'reason',     v_reason
    );

    if v_reason is not null then
      v_issues := v_issues || to_jsonb(v_reason);
    end if;

    -- Everything the customer can still see is counted, so the displayed total
    -- matches the items on the page. place_order() remains the authority on
    -- whether the order may be placed at all.
    if v_unit is not null then
      v_subtotal := v_subtotal + (v_unit * v_qty);
    end if;
  end loop;

  -- Promo: identical predicate to place_order(), and the same generic message
  -- so the caller cannot work out *why* a code failed (or probe which exist).
  if p_promo_code is not null and btrim(p_promo_code) <> '' then
    select *
      into v_promo
      from public.promo_codes pc
     where pc.code = upper(btrim(p_promo_code))
       and pc.is_active
       and (pc.expires_at is null or pc.expires_at > now())
       and (pc.max_uses is null or pc.uses < pc.max_uses)
       and pc.min_subtotal <= v_subtotal;

    if found then
      v_discount := round(v_subtotal * v_promo.percent_off / 100.0, 2);
      v_promo_ok := true;
    else
      v_promo_msg := 'That promo code is not valid for this order.';
    end if;
  end if;

  v_delivery := case
    when (v_subtotal - v_discount) >= c_free_delivery then 0
    else c_delivery_fee
  end;
  v_total := v_subtotal - v_discount + v_delivery;

  return jsonb_build_object(
    'subtotal',               v_subtotal,
    'discount',               v_discount,
    'delivery_fee',           v_delivery,
    'total_amount',           v_total,
    'standard_delivery_fee',  c_delivery_fee,
    'free_delivery_threshold', c_free_delivery,
    'promo_code',             case when v_promo_ok then v_promo.code else null end,
    'promo_percent_off',      case when v_promo_ok then v_promo.percent_off else null end,
    'promo_valid',            v_promo_ok,
    'promo_message',          v_promo_msg,
    'items',                  v_lines,
    'issues',                 v_issues
  );
end;
$$;

comment on function public.checkout_preview(jsonb, text) is
  'Read-only price quote for a basket: subtotal, promo discount, delivery fee and total, all computed server-side. Never writes.';

revoke all on function public.checkout_preview(jsonb, text) from public;
grant execute on function public.checkout_preview(jsonb, text) to anon, authenticated;
