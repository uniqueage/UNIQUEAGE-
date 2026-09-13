-- ===========================================================================
-- UAGE — 03. Trusted server-side operations
-- ---------------------------------------------------------------------------
-- Everything in this file runs inside the database. The browser NEVER sends a
-- price, a discount or a total that we trust: public.place_order() re-reads
-- every price from public.products / public.product_variants and recomputes
-- the whole order.
--
-- Both functions are SECURITY DEFINER with a pinned search_path, and EXECUTE
-- is granted only to authenticated users.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- place_order()
-- ---------------------------------------------------------------------------
-- One atomic transaction that:
--   1. requires an authenticated caller
--   2. validates the basket, delivery details and payment method
--   3. locks each product/variant row (SELECT … FOR UPDATE) so two shoppers
--      cannot oversell the same stock
--   4. verifies the product exists, is active, and has enough stock
--   5. prices every line from the DATABASE, then applies promo + delivery
--   6. inserts the order, its items, and decrements stock
--   7. returns the receipt
--
-- Any RAISE EXCEPTION rolls the whole thing back, so a half-written order is
-- impossible.
--
-- p_items:  [ { "product_id": "<uuid>", "quantity": 2 },
--             { "variant_id": "<uuid>", "quantity": 1 } ]
-- p_delivery: { "name": …, "phone": …, "email": …, "address": …, "city": …,
--               "notes": … }
-- ---------------------------------------------------------------------------
create or replace function public.place_order(
  p_items          jsonb,
  p_delivery       jsonb,
  p_payment_method text,
  p_promo_code     text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- business rules live here, on the server, in exactly one place
  c_delivery_fee    constant numeric(12,2) := 1500;   -- below the threshold
  c_free_delivery   constant numeric(12,2) := 10000;  -- free at/above this
  c_max_line_qty    constant integer       := 999;
  c_max_lines       constant integer       := 50;

  v_uid             uuid := auth.uid();
  v_lines           jsonb := '[]'::jsonb;
  v_item            jsonb;
  v_line            jsonb;
  v_subtotal        numeric(12,2) := 0;
  v_discount        numeric(12,2) := 0;
  v_delivery_fee    numeric(12,2) := 0;
  v_total           numeric(12,2) := 0;
  v_order_id        uuid;
  v_order_number    text;

  v_pid             uuid;
  v_vid             uuid;
  v_pname           text;
  v_vlabel          text;
  v_unit            numeric(12,2);
  v_stock           integer;
  v_active          boolean;
  v_qty             integer;

  v_promo           public.promo_codes%rowtype;

  v_d_name          text;
  v_d_phone         text;
  v_d_digits        text;
  v_d_email         text;
  v_d_address       text;
  v_d_city          text;
  v_d_notes         text;
begin
  -- 1. must be signed in ---------------------------------------------------
  if v_uid is null then
    raise exception 'Please sign in to place your order.' using errcode = '42501';
  end if;

  -- 2. basket shape --------------------------------------------------------
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Your cart is empty.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_items) > c_max_lines then
    raise exception 'Too many different items in a single order (max %).', c_max_lines
      using errcode = '22023';
  end if;
  if p_payment_method is null
     or p_payment_method not in ('Pay on delivery', 'Bank transfer', 'Card') then
    raise exception 'That payment method is not supported.' using errcode = '22023';
  end if;

  -- delivery details -------------------------------------------------------
  if p_delivery is null or jsonb_typeof(p_delivery) <> 'object' then
    raise exception 'Delivery details are required.' using errcode = '22023';
  end if;

  v_d_name    := btrim(coalesce(p_delivery ->> 'name', ''));
  v_d_phone   := btrim(coalesce(p_delivery ->> 'phone', ''));
  v_d_email   := lower(btrim(coalesce(p_delivery ->> 'email', '')));
  v_d_address := btrim(coalesce(p_delivery ->> 'address', ''));
  v_d_city    := btrim(coalesce(p_delivery ->> 'city', ''));
  v_d_notes   := nullif(btrim(coalesce(p_delivery ->> 'notes', '')), '');
  v_d_digits  := regexp_replace(v_d_phone, '\D', '', 'g');

  if char_length(v_d_name) < 2 or char_length(v_d_name) > 80 then
    raise exception 'Please enter your full name.' using errcode = '22023';
  end if;
  if char_length(v_d_digits) < 10 or char_length(v_d_digits) > 15 then
    raise exception 'Please enter a valid phone number.' using errcode = '22023';
  end if;
  if v_d_email <> ''
     and v_d_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Please enter a valid email address.' using errcode = '22023';
  end if;
  if char_length(v_d_address) < 5 or char_length(v_d_address) > 300 then
    raise exception 'Please enter your delivery address.' using errcode = '22023';
  end if;
  if char_length(v_d_city) < 2 or char_length(v_d_city) > 80 then
    raise exception 'Please enter your city.' using errcode = '22023';
  end if;
  if v_d_notes is not null and char_length(v_d_notes) > 300 then
    raise exception 'Your delivery note is too long (max 300 characters).'
      using errcode = '22023';
  end if;

  -- 3./4./5. validate + lock + price every line from the database ----------
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := nullif(btrim(coalesce(v_item ->> 'quantity', '')), '')::integer;

    if v_qty is null or v_qty < 1 or v_qty > c_max_line_qty then
      raise exception 'Each item needs a quantity between 1 and %.', c_max_line_qty
        using errcode = '22023';
    end if;

    -- guard the uuid casts so malformed input is a friendly error, not a 22P02
    if v_item ? 'variant_id' and nullif(btrim(coalesce(v_item ->> 'variant_id', '')), '') is not null then
      if (v_item ->> 'variant_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'One of the items in your cart is invalid.' using errcode = '22023';
      end if;
      v_vid := (v_item ->> 'variant_id')::uuid;
    else
      v_vid := null;
    end if;

    if v_vid is null then
      if not (v_item ? 'product_id')
         or nullif(btrim(coalesce(v_item ->> 'product_id', '')), '') is null then
        raise exception 'Each item needs a product.' using errcode = '22023';
      end if;
      if (v_item ->> 'product_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'One of the items in your cart is invalid.' using errcode = '22023';
      end if;
      v_pid := (v_item ->> 'product_id')::uuid;
    end if;

    if v_vid is not null then
      select pv.product_id, pv.label, pv.price, pv.stock_quantity, p.is_active, p.name
        into v_pid, v_vlabel, v_unit, v_stock, v_active, v_pname
        from public.product_variants pv
        join public.products p on p.id = pv.product_id
       where pv.id = v_vid
         for update of pv, p;

      if not found then
        raise exception 'An item in your cart is no longer available.'
          using errcode = '22023';
      end if;
    else
      v_vlabel := null;
      select p.price, p.stock_quantity, p.is_active, p.name
        into v_unit, v_stock, v_active, v_pname
        from public.products p
       where p.id = v_pid
         for update of p;

      if not found then
        raise exception 'An item in your cart is no longer available.'
          using errcode = '22023';
      end if;
      if v_unit is null then
        raise exception 'Please choose a size for "%".', v_pname
          using errcode = '22023';
      end if;
    end if;

    if not v_active then
      raise exception '"%" is no longer available.', v_pname using errcode = '22023';
    end if;
    if v_stock < v_qty then
      raise exception 'Only % left in stock for "%".', v_stock, v_pname
        using errcode = '22023';
    end if;

    v_lines := v_lines || jsonb_build_object(
      'product_id', v_pid,
      'variant_id', v_vid,
      'name',       v_pname,
      'label',      v_vlabel,
      'qty',        v_qty,
      'unit',       v_unit
    );

    v_subtotal := v_subtotal + (v_unit * v_qty);
  end loop;

  -- promo code, validated and locked on the server -------------------------
  if p_promo_code is not null and btrim(p_promo_code) <> '' then
    select *
      into v_promo
      from public.promo_codes pc
     where pc.code = upper(btrim(p_promo_code))
       and pc.is_active
       and (pc.expires_at is null or pc.expires_at > now())
       and (pc.max_uses is null or pc.uses < pc.max_uses)
       and pc.min_subtotal <= v_subtotal
       for update of pc;

    if not found then
      raise exception 'That promo code is not valid for this order.'
        using errcode = '22023';
    end if;

    v_discount := round(v_subtotal * v_promo.percent_off / 100.0, 2);
  end if;

  -- Nothing priced means nothing to deliver. Unreachable in practice, because
  -- every line is validated above, but kept identical to checkout_preview() so
  -- the quote and the charge can never drift apart.
  v_delivery_fee := case
    when v_subtotal <= 0 then 0
    when (v_subtotal - v_discount) >= c_free_delivery then 0
    else c_delivery_fee
  end;
  v_total := v_subtotal - v_discount + v_delivery_fee;

  -- 6. write the order, its items, and the stock movement -------------------
  v_order_number := public.generate_order_number();

  insert into public.orders (
    order_number, user_id, status, payment_status, payment_method,
    subtotal, discount, delivery_fee, total_amount, promo_code,
    delivery_name, delivery_phone, delivery_email,
    delivery_address, delivery_city, notes
  ) values (
    v_order_number, v_uid, 'pending', 'unpaid', p_payment_method,
    v_subtotal, v_discount, v_delivery_fee, v_total, v_promo.code,
    v_d_name, v_d_phone, nullif(v_d_email, ''),
    v_d_address, v_d_city, v_d_notes
  )
  returning id into v_order_id;

  for v_item in select * from jsonb_array_elements(v_lines) loop
    insert into public.order_items (
      order_id, product_id, variant_id, product_name, variant_label,
      quantity, unit_price
    ) values (
      v_order_id,
      (v_item ->> 'product_id')::uuid,
      (v_item ->> 'variant_id')::uuid,
      v_item ->> 'name',
      v_item ->> 'label',
      (v_item ->> 'qty')::integer,
      (v_item ->> 'unit')::numeric
    );

    if (v_item ->> 'variant_id') is not null then
      update public.product_variants
         set stock_quantity = stock_quantity - (v_item ->> 'qty')::integer
       where id = (v_item ->> 'variant_id')::uuid;
    else
      update public.products
         set stock_quantity = stock_quantity - (v_item ->> 'qty')::integer
       where id = (v_item ->> 'product_id')::uuid;
    end if;
  end loop;

  if v_promo.code is not null then
    update public.promo_codes
       set uses = uses + 1
     where code = v_promo.code;
  end if;

  -- 7. receipt -------------------------------------------------------------
  return jsonb_build_object(
    'order_id',      v_order_id,
    'order_number',  v_order_number,
    'status',        'pending',
    'subtotal',      v_subtotal,
    'discount',      v_discount,
    'delivery_fee',  v_delivery_fee,
    'total_amount',  v_total,
    'item_count',    jsonb_array_length(v_lines)
  );
end;
$$;

comment on function public.place_order(jsonb, jsonb, text, text) is
  'Creates an order atomically. Prices, discounts, delivery fees and stock are all resolved server-side.';

revoke all on function public.place_order(jsonb, jsonb, text, text) from public, anon;
grant execute on function public.place_order(jsonb, jsonb, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- admin_set_user_role()
-- ---------------------------------------------------------------------------
-- The only sanctioned way to grant or revoke the admin role through the API.
-- Guarded so that (a) only an existing admin can call it, and (b) the last
-- remaining administrator cannot be demoted.
--
-- The very first administrator has to be bootstrapped with SQL (see the seed
-- migration) — by design there is no self-service path to admin.
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_user_role(
  p_user_id uuid,
  p_role    public.user_role
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'Administrator access required.' using errcode = '42501';
  end if;

  if p_user_id is null then
    raise exception 'A user is required.' using errcode = '22023';
  end if;

  if not exists (select 1 from public.profiles p where p.id = p_user_id) then
    raise exception 'No such user.' using errcode = '22023';
  end if;

  if p_role = 'customer' then
    if exists (select 1 from public.user_roles r
                where r.user_id = p_user_id and r.role = 'admin')
       and (select count(*) from public.user_roles r where r.role = 'admin') <= 1 then
      raise exception 'You cannot remove the last administrator.'
        using errcode = '23514';
    end if;
  end if;

  insert into public.user_roles (user_id, role, granted_by)
  values (p_user_id, p_role, auth.uid())
  on conflict (user_id) do update
    set role = excluded.role,
        granted_at = now(),
        granted_by = auth.uid();
end;
$$;

comment on function public.admin_set_user_role(uuid, public.user_role) is
  'Admin-only, database-checked way to change a user role. Prevents removing the last admin.';

revoke all on function public.admin_set_user_role(uuid, public.user_role) from public, anon;
grant execute on function public.admin_set_user_role(uuid, public.user_role) to authenticated;

-- ---------------------------------------------------------------------------
-- set_order_payment_status()
-- ---------------------------------------------------------------------------
-- Admins record payment without being able to rewrite money amounts.
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_payment_status(
  p_order_id uuid,
  p_status   public.payment_status
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'Administrator access required.' using errcode = '42501';
  end if;

  update public.orders
     set payment_status = p_status
   where id = p_order_id;

  if not found then
    raise exception 'No such order.' using errcode = '22023';
  end if;
end;
$$;

revoke all on function public.admin_set_payment_status(uuid, public.payment_status) from public, anon;
grant execute on function public.admin_set_payment_status(uuid, public.payment_status) to authenticated;

-- ---------------------------------------------------------------------------
-- admin_dashboard_stats()
-- ---------------------------------------------------------------------------
-- Small read-only roll-up so the admin view does not need to pull every row.
-- ---------------------------------------------------------------------------
create or replace function public.admin_dashboard_stats()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'Administrator access required.' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'customers',     (select count(*) from public.profiles),
    'products',      (select count(*) from public.products where is_active),
    'all_products',  (select count(*) from public.products),
    'orders',        (select count(*) from public.orders),
    'pending',       (select count(*) from public.orders where status = 'pending'),
    'revenue',       (select coalesce(sum(total_amount), 0) from public.orders
                       where status <> 'cancelled'),
    'low_stock',     (
      select count(*) from (
        select p.id from public.products p
         where p.is_active and p.price is not null and p.stock_quantity <= 5
        union all
        select v.id from public.product_variants v
          join public.products p2 on p2.id = v.product_id
         where p2.is_active and v.stock_quantity <= 5
      ) low
    )
  );
end;
$$;

revoke all on function public.admin_dashboard_stats() from public, anon;
grant execute on function public.admin_dashboard_stats() to authenticated;
