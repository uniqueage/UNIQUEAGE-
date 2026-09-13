-- ===========================================================================
-- UAGE — COMPLETE DATABASE SETUP (generated file — do not edit by hand)
-- ===========================================================================
--
-- Paste this WHOLE file into the Supabase SQL editor and run it once:
--
--   https://supabase.com/dashboard/project/<your-project-ref>/sql/new
--
-- It creates every type, table, constraint, index, trigger, Row Level
-- Security policy, the trusted order function, the storage buckets and your
-- full product catalogue — in the correct dependency order.
--
-- Safe to re-run: nothing is ever dropped, and existing rows are untouched.
--
-- Source of truth: supabase/migrations/*.sql
-- Regenerate with: node supabase/build-setup.mjs
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 20260911090000_init_schema.sql
-- ---------------------------------------------------------------------------
-- ===========================================================================
-- UAGE — 01. Core schema
-- ---------------------------------------------------------------------------
-- Additive only. This migration CREATES types/tables/indexes/triggers and
-- drops nothing. Safe to run on a fresh Supabase project.
--
-- Money is stored as numeric(12,2) in NGN. Quantities are integers.
-- Products either carry a flat `price` (single-size items) OR one or more
-- `product_variants` rows (500ml / 750ml / 1L / 2L, 30ml / 50ml / 100ml …).
-- That keeps per-size pricing and per-size stock normalised instead of
-- duplicating prices in JSON blobs.
-- ===========================================================================

-- gen_random_uuid() has been in Postgres core since v13; pgcrypto is only
-- needed for older engines. Kept tolerant so this migration also applies to
-- plain Postgres (e.g. the offline test harness).
do $$ begin
  create extension if not exists pgcrypto;
exception when others then
  raise notice 'pgcrypto unavailable — relying on core gen_random_uuid()';
end $$;

-- ---------------------------------------------------------------------------
-- Enumerated types
-- ---------------------------------------------------------------------------
do $$ begin
  create type public.user_role as enum ('customer', 'admin');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.order_status as enum
    ('pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.payment_status as enum ('unpaid', 'paid', 'refunded');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

-- Keeps updated_at honest on every table that has it.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Human-readable, collision-free order numbers: UAGE-100001, UAGE-100002, …
create sequence if not exists public.order_number_seq start with 100001;

create or replace function public.generate_order_number()
returns text
language sql
volatile
as $$
  select 'UAGE-' || nextval('public.order_number_seq')::text;
$$;

-- ---------------------------------------------------------------------------
-- categories
-- ---------------------------------------------------------------------------
create table if not exists public.categories (
  slug        text primary key check (slug ~ '^[a-z0-9-]{2,40}$'),
  name        text not null check (char_length(name) between 2 and 80),
  icon        text not null default 'fa-tag',
  tag         text check (tag is null or char_length(tag) <= 60),
  blurb       text check (blurb is null or char_length(blurb) <= 160),
  features    text[] not null default '{}',
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- profiles  (1:1 with auth.users)
-- `email` is an intentional, trigger-maintained copy of auth.users.email so
-- administrators can list customers without needing the service-role key.
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null check (char_length(full_name) between 2 and 80),
  phone       text check (phone is null or phone ~ '^[0-9+() -]{7,20}$'),
  avatar_url  text check (avatar_url is null or char_length(avatar_url) <= 500),
  email       text check (email is null or email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- user_roles  (separate table => the role can never be set from the browser)
-- ---------------------------------------------------------------------------
create table if not exists public.user_roles (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  role        public.user_role not null default 'customer',
  granted_at  timestamptz not null default now(),
  granted_by  uuid references auth.users(id) on delete set null
);

-- THE single source of truth for "is the caller an administrator?".
-- Defined after public.user_roles because a SQL-bodied function is validated
-- when it is created. SECURITY DEFINER so it can read public.user_roles
-- regardless of the caller's own policies, and so it always reads the
-- *database* — never anything the browser sent. Because the function is owned
-- by the table owner, RLS on user_roles is bypassed inside the body, which is
-- what prevents infinite recursion when user_roles' own policies call it.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.user_roles r
    where r.user_id = auth.uid()
      and r.role = 'admin'
  );
$$;

-- ---------------------------------------------------------------------------
-- products
-- ---------------------------------------------------------------------------
create table if not exists public.products (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique check (slug ~ '^[a-z0-9-]{2,60}$'),
  name            text not null check (char_length(name) between 2 and 120),
  description     text not null default '' check (char_length(description) <= 2000),
  category        text not null references public.categories(slug)
                    on update cascade on delete restrict,
  price           numeric(12,2) check (price is null or price >= 0),
  old_price       numeric(12,2) check (old_price is null or old_price >= 0),
  badge           text check (badge is null or char_length(badge) <= 40),
  rating          numeric(2,1) not null default 0 check (rating >= 0 and rating <= 5),
  review_count    integer not null default 0 check (review_count >= 0),
  image_url       text not null check (char_length(image_url) between 4 and 500),
  is_active       boolean not null default true,
  featured        boolean not null default false,
  stock_quantity  integer not null default 0 check (stock_quantity >= 0),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- a "was" price must never be lower than the real price
  constraint products_old_price_ge_price
    check (old_price is null or price is null or old_price >= price)
);

-- ---------------------------------------------------------------------------
-- product_variants  (the sizes: 500ml / 750ml / 1L / 2L, 30ml / 50ml / 100ml)
-- ---------------------------------------------------------------------------
create table if not exists public.product_variants (
  id              uuid primary key default gen_random_uuid(),
  product_id      uuid not null references public.products(id) on delete cascade,
  label           text not null check (char_length(label) between 1 and 30),
  price           numeric(12,2) not null check (price >= 0),
  stock_quantity  integer not null default 0 check (stock_quantity >= 0),
  sku             text unique,
  sort_order      integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (product_id, label)
);

-- ---------------------------------------------------------------------------
-- promo_codes  (discounts must be server-owned, never a client constant)
-- ---------------------------------------------------------------------------
create table if not exists public.promo_codes (
  code          text primary key check (code = upper(code) and code ~ '^[A-Z0-9-]{3,24}$'),
  percent_off   numeric(5,2) not null check (percent_off > 0 and percent_off <= 90),
  min_subtotal  numeric(12,2) not null default 0 check (min_subtotal >= 0),
  max_uses      integer check (max_uses is null or max_uses > 0),
  uses          integer not null default 0 check (uses >= 0),
  is_active     boolean not null default true,
  expires_at    timestamptz,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- orders
-- ---------------------------------------------------------------------------
create table if not exists public.orders (
  id                uuid primary key default gen_random_uuid(),
  order_number      text not null unique default public.generate_order_number(),
  user_id           uuid not null references auth.users(id) on delete restrict,
  status            public.order_status not null default 'pending',
  payment_status    public.payment_status not null default 'unpaid',
  payment_method    text not null
                      check (payment_method in ('Pay on delivery', 'Bank transfer', 'Card')),
  subtotal          numeric(12,2) not null check (subtotal >= 0),
  discount          numeric(12,2) not null default 0 check (discount >= 0),
  delivery_fee      numeric(12,2) not null default 0 check (delivery_fee >= 0),
  total_amount      numeric(12,2) not null check (total_amount >= 0),
  promo_code        text references public.promo_codes(code)
                      on update cascade on delete set null,
  delivery_name     text not null check (char_length(delivery_name) between 2 and 80),
  delivery_phone    text not null check (char_length(delivery_phone) between 7 and 20),
  delivery_email    text check (delivery_email is null
                      or delivery_email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  delivery_address  text not null check (char_length(delivery_address) between 5 and 300),
  delivery_city     text not null check (char_length(delivery_city) between 2 and 80),
  notes             text check (notes is null or char_length(notes) <= 300),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- database-level guard: totals can never drift from their components
  constraint orders_total_matches
    check (total_amount = subtotal - discount + delivery_fee)
);

-- ---------------------------------------------------------------------------
-- order_items
-- product_name / variant_label are immutable receipt snapshots: renaming or
-- deactivating a product must not rewrite what a customer already bought.
-- ---------------------------------------------------------------------------
create table if not exists public.order_items (
  id             uuid primary key default gen_random_uuid(),
  order_id       uuid not null references public.orders(id) on delete cascade,
  product_id     uuid not null references public.products(id) on delete restrict,
  variant_id     uuid references public.product_variants(id) on delete restrict,
  product_name   text not null check (char_length(product_name) between 1 and 120),
  variant_label  text check (variant_label is null or char_length(variant_label) <= 30),
  quantity       integer not null check (quantity between 1 and 999),
  unit_price     numeric(12,2) not null check (unit_price >= 0),
  line_total     numeric(12,2) generated always as (quantity * unit_price) stored,
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes for the queries the storefront actually runs
-- ---------------------------------------------------------------------------
create index if not exists products_category_active_idx
  on public.products (category, is_active);
create index if not exists products_active_featured_idx
  on public.products (is_active, featured) where is_active;
create index if not exists products_created_at_idx
  on public.products (created_at desc);
create index if not exists product_variants_product_idx
  on public.product_variants (product_id, sort_order);
create index if not exists orders_user_created_idx
  on public.orders (user_id, created_at desc);
create index if not exists orders_status_created_idx
  on public.orders (status, created_at desc);
create index if not exists order_items_order_idx
  on public.order_items (order_id);
create index if not exists order_items_product_idx
  on public.order_items (product_id);
create index if not exists profiles_email_idx
  on public.profiles (lower(email));

-- ---------------------------------------------------------------------------
-- Triggers — updated_at
-- ---------------------------------------------------------------------------
drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

drop trigger if exists products_set_updated_at on public.products;
create trigger products_set_updated_at
  before update on public.products
  for each row execute function public.set_updated_at();

drop trigger if exists product_variants_set_updated_at on public.product_variants;
create trigger product_variants_set_updated_at
  before update on public.product_variants
  for each row execute function public.set_updated_at();

drop trigger if exists orders_set_updated_at on public.orders;
create trigger orders_set_updated_at
  before update on public.orders
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Trigger — profiles are immutable where it matters
-- created_at can never be rewritten; nothing else about a profile can be
-- used to escalate (there is no role column here at all).
-- ---------------------------------------------------------------------------
create or replace function public.protect_profile_columns()
returns trigger
language plpgsql
as $$
begin
  new.created_at := old.created_at;
  new.id := old.id;
  return new;
end;
$$;

drop trigger if exists profiles_protect_columns on public.profiles;
create trigger profiles_protect_columns
  before update on public.profiles
  for each row execute function public.protect_profile_columns();

-- ---------------------------------------------------------------------------
-- Trigger — a product must always be priced *somewhere*
-- Either it has its own price, or it has at least one size variant.
--
-- Both pricing rules are CONSTRAINT triggers declared DEFERRABLE INITIALLY
-- DEFERRED, so they are evaluated at COMMIT instead of statement-by-statement.
-- That lets a product and its size variants be written in one atomic step
-- without tripping over an intermediate, still-incomplete state — while the
-- final state is still guaranteed to be valid. A price-less product inserted
-- on its own still fails, because its transaction ends immediately.
-- ---------------------------------------------------------------------------
create or replace function public.check_product_pricing()
returns trigger
language plpgsql
as $$
begin
  if new.price is null
     and not exists (select 1 from public.product_variants v where v.product_id = new.id) then
    raise exception 'Product "%" needs either a price or at least one size variant', new.slug
      using errcode = '23514';
  end if;
  return null;   -- AFTER trigger: the return value is ignored
end;
$$;

drop trigger if exists products_check_pricing on public.products;
create constraint trigger products_check_pricing
  after insert or update on public.products
  deferrable initially deferred
  for each row execute function public.check_product_pricing();

-- Deleting the final variant of a price-less product would leave it unpriced.
create or replace function public.check_product_still_priced()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1 from public.products p
    where p.id = old.product_id
      and p.price is null
      and not exists (select 1 from public.product_variants v where v.product_id = p.id)
  ) then
    raise exception 'Cannot remove the last size variant of an unpriced product'
      using errcode = '23514';
  end if;
  return null;
end;
$$;

drop trigger if exists product_variants_check_priced on public.product_variants;
create constraint trigger product_variants_check_priced
  after delete on public.product_variants
  deferrable initially deferred
  for each row execute function public.check_product_still_priced();

-- ---------------------------------------------------------------------------
-- Trigger — order status may only be moved along legal paths, by an admin
-- ---------------------------------------------------------------------------
create or replace function public.check_order_status_transition()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  allowed text[];
begin
  if new.status = old.status then
    return new;
  end if;

  if not public.is_admin() then
    raise exception 'Only administrators may change an order status'
      using errcode = '42501';
  end if;

  case old.status
    when 'pending'    then allowed := array['confirmed', 'cancelled'];
    when 'confirmed'  then allowed := array['processing', 'cancelled'];
    when 'processing' then allowed := array['shipped', 'cancelled'];
    when 'shipped'    then allowed := array['delivered'];
    else                   allowed := array[]::text[];
  end case;

  if not (new.status::text = any (allowed)) then
    raise exception 'Cannot move an order from "%" to "%"', old.status, new.status
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists orders_check_status_transition on public.orders;
create trigger orders_check_status_transition
  before update of status on public.orders
  for each row execute function public.check_order_status_transition();

-- ---------------------------------------------------------------------------
-- Trigger — every new auth user gets a profile + a customer role row
-- Runs with definer rights because it fires on auth.users.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text;
begin
  v_name := coalesce(
    nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(btrim(split_part(coalesce(new.email, ''), '@', 1)), ''),
    'UAGE Customer'
  );
  if char_length(v_name) < 2 then
    v_name := 'UAGE Customer';
  end if;

  insert into public.profiles (id, full_name, phone, email)
  values (
    new.id,
    left(v_name, 80),
    nullif(btrim(coalesce(new.raw_user_meta_data ->> 'phone', '')), ''),
    new.email
  )
  on conflict (id) do nothing;

  -- Default role is always 'customer'. Admin is never assigned here.
  insert into public.user_roles (user_id, role)
  values (new.id, 'customer')
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Keep the profiles.email copy in step with auth.users.email.
create or replace function public.handle_user_email_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.profiles set email = new.email where id = new.id;
  return new;
end;
$$;

drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row execute function public.handle_user_email_change();


-- ---------------------------------------------------------------------------
-- 20260911090100_rls_policies.sql
-- ---------------------------------------------------------------------------
-- ===========================================================================
-- UAGE — 02. Row Level Security
-- ---------------------------------------------------------------------------
-- Every table that holds private or business-critical data gets RLS enabled
-- WITH explicit policies. Enabling RLS without policies is never enough, so
-- each table below has a deliberate set of grants.
--
-- Model
--   * anonymous + customer  -> read active products / categories / variants
--   * customer              -> read & update ONLY their own profile, read ONLY
--                              their own orders and order items
--   * customer              -> cannot insert orders directly; the secure
--                              SECURITY DEFINER function public.place_order()
--                              is the only way to create one
--   * admin                 -> may write products/variants/categories/promos
--                              and move order status, checked in the database
--                              via public.is_admin()
--
-- Note: nothing here trusts a value sent by the browser. public.is_admin()
-- reads public.user_roles, and public.user_roles has NO write policies at
-- all, so a customer can never promote themselves.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Callers must be able to execute the helper used *inside* the policies.
-- ---------------------------------------------------------------------------
grant execute on function public.is_admin() to anon, authenticated;

-- ===========================================================================
-- profiles
-- ===========================================================================
alter table public.profiles enable row level security;
-- NOTE: intentionally NOT forcing RLS, so the SECURITY DEFINER helpers can
-- read trusted tables as the owner without recursion.

drop policy if exists profiles_select_own_or_admin on public.profiles;
create policy profiles_select_own_or_admin
  on public.profiles for select
  to authenticated
  using (id = auth.uid() or public.is_admin());

drop policy if exists profiles_insert_self on public.profiles;
create policy profiles_insert_self
  on public.profiles for insert
  to authenticated
  with check (id = auth.uid());

drop policy if exists profiles_update_own_or_admin on public.profiles;
create policy profiles_update_own_or_admin
  on public.profiles for update
  to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

-- No DELETE policy: profiles are removed only when the auth user is deleted
-- (ON DELETE CASCADE).

-- ===========================================================================
-- user_roles   (the escalation surface — read-only for everybody)
-- ===========================================================================
alter table public.user_roles enable row level security;

drop policy if exists user_roles_select_own_or_admin on public.user_roles;
create policy user_roles_select_own_or_admin
  on public.user_roles for select
  to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- Deliberately no INSERT / UPDATE / DELETE policies:
--   a customer cannot grant themselves 'admin', and neither can an admin
--   through the API. Roles move only via direct SQL or the guarded
--   public.admin_set_user_role() function.

-- ===========================================================================
-- categories
-- ===========================================================================
alter table public.categories enable row level security;

drop policy if exists categories_public_read on public.categories;
create policy categories_public_read
  on public.categories for select
  to anon, authenticated
  using (true);

drop policy if exists categories_admin_insert on public.categories;
create policy categories_admin_insert
  on public.categories for insert
  to authenticated
  with check (public.is_admin());

drop policy if exists categories_admin_update on public.categories;
create policy categories_admin_update
  on public.categories for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists categories_admin_delete on public.categories;
create policy categories_admin_delete
  on public.categories for delete
  to authenticated
  using (public.is_admin());

-- ===========================================================================
-- products   (public sees ACTIVE only; admins see everything)
-- ===========================================================================
alter table public.products enable row level security;

drop policy if exists products_read_active_or_admin on public.products;
create policy products_read_active_or_admin
  on public.products for select
  to anon, authenticated
  using (is_active or public.is_admin());

drop policy if exists products_admin_insert on public.products;
create policy products_admin_insert
  on public.products for insert
  to authenticated
  with check (public.is_admin());

drop policy if exists products_admin_update on public.products;
create policy products_admin_update
  on public.products for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Hard delete is allowed for admins, but order_items references products with
-- ON DELETE RESTRICT, so a product that has ever been ordered can only be
-- deactivated — purchase history can never be destroyed.
drop policy if exists products_admin_delete on public.products;
create policy products_admin_delete
  on public.products for delete
  to authenticated
  using (public.is_admin());

-- ===========================================================================
-- product_variants
-- ===========================================================================
alter table public.product_variants enable row level security;

drop policy if exists product_variants_read_visible on public.product_variants;
create policy product_variants_read_visible
  on public.product_variants for select
  to anon, authenticated
  using (
    exists (
      select 1 from public.products p
      where p.id = product_id
        and (p.is_active or public.is_admin())
    )
  );

drop policy if exists product_variants_admin_insert on public.product_variants;
create policy product_variants_admin_insert
  on public.product_variants for insert
  to authenticated
  with check (public.is_admin());

drop policy if exists product_variants_admin_update on public.product_variants;
create policy product_variants_admin_update
  on public.product_variants for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists product_variants_admin_delete on public.product_variants;
create policy product_variants_admin_delete
  on public.product_variants for delete
  to authenticated
  using (public.is_admin());

-- ===========================================================================
-- promo_codes   (never publicly enumerable — a visitor must not be able to
-- list valid discount codes)
-- ===========================================================================
alter table public.promo_codes enable row level security;

drop policy if exists promo_codes_admin_read on public.promo_codes;
create policy promo_codes_admin_read
  on public.promo_codes for select
  to authenticated
  using (public.is_admin());

drop policy if exists promo_codes_admin_insert on public.promo_codes;
create policy promo_codes_admin_insert
  on public.promo_codes for insert
  to authenticated
  with check (public.is_admin());

drop policy if exists promo_codes_admin_update on public.promo_codes;
create policy promo_codes_admin_update
  on public.promo_codes for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists promo_codes_admin_delete on public.promo_codes;
create policy promo_codes_admin_delete
  on public.promo_codes for delete
  to authenticated
  using (public.is_admin());

-- ===========================================================================
-- orders
-- ===========================================================================
alter table public.orders enable row level security;

drop policy if exists orders_select_own_or_admin on public.orders;
create policy orders_select_own_or_admin
  on public.orders for select
  to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- Only administrators may update (status / payment status). Customers get
-- their changes through the guarded functions instead.
drop policy if exists orders_admin_update on public.orders;
create policy orders_admin_update
  on public.orders for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- No INSERT policy on purpose: placing an order must go through
-- public.place_order(), which recomputes prices server-side.
-- No DELETE policy on purpose: orders are never destroyed from the client.
revoke insert, delete on public.orders from anon, authenticated;

-- ===========================================================================
-- order_items
-- ===========================================================================
alter table public.order_items enable row level security;

drop policy if exists order_items_select_own_or_admin on public.order_items;
create policy order_items_select_own_or_admin
  on public.order_items for select
  to authenticated
  using (
    exists (
      select 1 from public.orders o
      where o.id = order_id
        and (o.user_id = auth.uid() or public.is_admin())
    )
  );

-- No INSERT / UPDATE / DELETE policies: line items are written only by
-- public.place_order(), and unit prices are snapshots that must never change.
revoke insert, update, delete on public.order_items from anon, authenticated;


-- ---------------------------------------------------------------------------
-- 20260911090200_functions.sql
-- ---------------------------------------------------------------------------
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


-- ---------------------------------------------------------------------------
-- 20260911090300_storage.sql
-- ---------------------------------------------------------------------------
-- ===========================================================================
-- UAGE — 04. Storage
-- ---------------------------------------------------------------------------
-- Two buckets:
--   product-images : public read, admin-only write
--   avatars        : public read, each user writes ONLY inside their own
--                    folder named after their auth uid ({uid}/avatar.webp)
--
-- Images never go inside Postgres. Only the resulting public URL is stored in
-- products.image_url / profiles.avatar_url.
-- ===========================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'product-images', 'product-images', true, 5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/avif']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatars', 'avatars', true, 2097152,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- RLS is ALREADY enabled on storage.objects on hosted Supabase, and since
-- April 2025 Supabase blocks `alter table` on the storage schema even for the
-- postgres role. An unconditional ALTER therefore aborts the entire migration
-- with:
--
--     ERROR: 42501: must be owner of table objects
--
-- while `create policy` on the same table is permitted. So enable RLS only when
-- it is genuinely off (a local or stubbed database), and never let a missing
-- privilege take the rest of this script down with it.
do $$
begin
  if not (select c.relrowsecurity
            from pg_class c
           where c.oid = 'storage.objects'::regclass) then
    begin
      alter table storage.objects enable row level security;
    exception
      when insufficient_privilege then
        raise notice
          'Skipping ENABLE ROW LEVEL SECURITY on storage.objects (insufficient privilege). On hosted Supabase this is already managed for you.';
    end;
  end if;
end $$;

-- ===========================================================================
-- product-images
-- ===========================================================================
drop policy if exists uage_product_images_public_read on storage.objects;
create policy uage_product_images_public_read
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'product-images');

drop policy if exists uage_product_images_admin_insert on storage.objects;
create policy uage_product_images_admin_insert
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'product-images' and public.is_admin());

drop policy if exists uage_product_images_admin_update on storage.objects;
create policy uage_product_images_admin_update
  on storage.objects for update
  to authenticated
  using (bucket_id = 'product-images' and public.is_admin())
  with check (bucket_id = 'product-images' and public.is_admin());

drop policy if exists uage_product_images_admin_delete on storage.objects;
create policy uage_product_images_admin_delete
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'product-images' and public.is_admin());

-- ===========================================================================
-- avatars
-- ===========================================================================
drop policy if exists uage_avatars_public_read on storage.objects;
create policy uage_avatars_public_read
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'avatars');

-- A user may only write into the folder that matches their own uid.
drop policy if exists uage_avatars_owner_insert on storage.objects;
create policy uage_avatars_owner_insert
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists uage_avatars_owner_update on storage.objects;
create policy uage_avatars_owner_update
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'avatars'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
  )
  with check (
    bucket_id = 'avatars'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
  );

drop policy if exists uage_avatars_owner_delete on storage.objects;
create policy uage_avatars_owner_delete
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'avatars'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
  );


-- ---------------------------------------------------------------------------
-- 20260911090400_seed_catalog.sql
-- ---------------------------------------------------------------------------
-- ===========================================================================
-- UAGE — 05. Seed the live catalog
-- ---------------------------------------------------------------------------
-- Brings the 22 products that currently live in data.js into the database,
-- keeping the exact same slugs so every existing product.html?id=… URL and
-- every shared link keeps working.
--
-- Idempotent: re-running updates the existing rows instead of duplicating.
--
-- Stock note: seeded stock is placeholder stock so the store is orderable
-- immediately. Real stock is managed by an administrator.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Categories
-- ---------------------------------------------------------------------------
insert into public.categories (slug, name, icon, tag, blurb, features, sort_order) values
  ('dishwash', 'Dishwash Liquid', 'fa-soap', 'Kitchen care', '500ml to 2L jugs',
   array[
     'Cuts 100% of grease on contact',
     'Plant-based, biodegradable formula',
     'Gentle on hands — no harsh residue',
     'Fresh scent that lingers after rinsing'
   ], 1),
  ('cosmetics', 'Body Cosmetics', 'fa-spa', 'Skin & body', 'Butters, scrubs, creams',
   array[
     'Formulated for all skin types',
     'Deep, long-lasting moisture',
     'Paraben-free & cruelty-free',
     'Lightweight, fast-absorbing texture'
   ], 2),
  ('perfume', 'Perfumes', 'fa-spray-can-sparkles', 'Signature scents', 'Eau de parfum',
   array[
     'Long-lasting eau de parfum concentration',
     'Rich sillage that lingers all day',
     'Alcohol-based, skin-safe blend',
     'Available in 30ml, 50ml and 100ml'
   ], 3),
  ('air', 'Air Fresheners', 'fa-wind', 'Home & car', 'Mists, candles & more',
   array[
     'Neutralises odours — doesn''t just mask them',
     'Long-lasting fresh scent',
     'Safe for home, office and car',
     'Quality you can smell from the first spray'
   ], 4)
on conflict (slug) do update
  set name       = excluded.name,
      icon       = excluded.icon,
      tag        = excluded.tag,
      blurb      = excluded.blurb,
      features   = excluded.features,
      sort_order = excluded.sort_order;

-- ---------------------------------------------------------------------------
-- Products
-- `price` is NULL for size-priced ranges (their prices live in
-- product_variants); single-size items carry their price directly.
-- ---------------------------------------------------------------------------
insert into public.products (
  slug, name, description, category, price, old_price, badge,
  rating, review_count, image_url, featured, stock_quantity
) values
  -- Dishwash liquid — priced per size
  ('crystal-clean', 'Crystal Clean',
   'Grease destroyer with a fresh citrus scent. Concentrated, streak-free shine.',
   'dishwash', null, null, 'Bestseller', 4.9, 312,
   'https://images.unsplash.com/photo-1563453392212-326f5e854473?auto=format&fit=crop&w=800&q=80',
   true, 0),

  ('fresh-zest', 'Fresh Zest',
   'Lemon & lavender power that cuts 100% of grease. Gentle on hands, bold on dishes.',
   'dishwash', null, null, 'Lemon & Lavender', 4.8, 196,
   'https://images.unsplash.com/photo-1584622650111-993a426fbf0a?auto=format&fit=crop&w=800&q=80',
   true, 0),

  ('silky-foam', 'Silky Foam',
   'Cloud-like foam, tough on oil yet extra mild on skin. No harsh residue.',
   'dishwash', null, null, 'Gentle care', 4.9, 258,
   'https://images.unsplash.com/photo-1585421514738-01798e348b17?auto=format&fit=crop&w=800&q=80',
   false, 0),

  ('lemon-burst', 'Lemon Burst',
   'Zingy lemon gel that lifts burnt-on food fast. Refreshing scent after every rinse.',
   'dishwash', null, null, 'Fresh citrus', 4.7, 141,
   'https://images.unsplash.com/photo-1610557892470-55d9e80c0bce?auto=format&fit=crop&w=800&q=80',
   false, 0),

  ('berry-blast', 'Berry Blast',
   'Berry-fresh gel with antibacterial power. Sparkling glasses, happy kitchen.',
   'dishwash', null, null, 'Antibacterial', 4.6, 98,
   'https://images.unsplash.com/photo-1556911220-e15b29be8c8f?auto=format&fit=crop&w=800&q=80',
   false, 0),

  ('aloe-soft', 'Aloe Soft',
   'Aloe-enriched formula that pampers hands while it powers through oil and grime.',
   'dishwash', null, null, 'Skin friendly', 4.8, 173,
   'https://images.unsplash.com/photo-1522673607200-164d1b6ce486?auto=format&fit=crop&w=800&q=80',
   false, 0),

  -- Body cosmetics — single price
  ('shea-body-butter', 'Shea Body Butter',
   'Rich whipped shea & cocoa butter for deep, all-day moisture. 200ml jar.',
   'cosmetics', 6500, 7500, 'Best for dry skin', 4.9, 231,
   'https://images.unsplash.com/photo-1611930022073-b7a4ba5fcccd?auto=format&fit=crop&w=800&q=80',
   true, 45),

  ('coconut-body-wash', 'Coconut Body Wash',
   'Creamy coconut milk wash that cleanses softly and keeps skin smooth. 400ml.',
   'cosmetics', 5800, null, 'Hydrating', 4.7, 164,
   'https://images.unsplash.com/photo-1595425970377-c9703cf48b6d?auto=format&fit=crop&w=800&q=80',
   false, 60),

  ('sugar-body-scrub', 'Sugar Body Scrub',
   'Brown sugar & lime crystals that buff away dullness for baby-soft skin. 250ml.',
   'cosmetics', 7200, null, 'Exfoliating', 4.8, 142,
   'https://images.unsplash.com/photo-1556228578-8c89e6adf883?auto=format&fit=crop&w=800&q=80',
   false, 38),

  ('aloe-hand-cream', 'Aloe Hand Cream',
   'Fast-absorbing aloe cream that repairs dry, cracked hands. 100ml tube.',
   'cosmetics', 3900, null, 'Non-greasy', 4.6, 87,
   'https://images.unsplash.com/photo-1598440947619-2c35fc9aa908?auto=format&fit=crop&w=800&q=80',
   false, 72),

  ('vanilla-body-lotion', 'Vanilla Body Lotion',
   'Silky vanilla-scented lotion for everyday glow and 24-hour softness. 350ml.',
   'cosmetics', 5200, null, 'Daily glow', 4.7, 118,
   'https://images.unsplash.com/photo-1556228720-195a672e8a03?auto=format&fit=crop&w=800&q=80',
   false, 55),

  ('glow-body-oil', 'Glow Body Oil',
   'Nourishing botanical oil that leaves skin luminous and lightly scented. 150ml.',
   'cosmetics', 8900, null, 'Radiance', 4.8, 76,
   'https://images.unsplash.com/photo-1567721913486-6585f069b332?auto=format&fit=crop&w=800&q=80',
   false, 24),

  -- Perfumes — priced per size
  ('oud-royale', 'Oud Royale',
   'Smoky oud blended with amber and saffron. A long-lasting evening statement.',
   'perfume', null, null, 'Signature', 4.9, 204,
   'https://images.unsplash.com/photo-1541643600914-78b084683601?auto=format&fit=crop&w=800&q=80',
   true, 0),

  ('citrus-bloom', 'Citrus Bloom',
   'Bright bergamot, neroli and white florals. Fresh, airy and effortlessly chic.',
   'perfume', null, null, 'Daytime fresh', 4.8, 167,
   'https://images.unsplash.com/photo-1596462502278-27bfdc403348?auto=format&fit=crop&w=800&q=80',
   false, 0),

  ('amber-nights', 'Amber Nights',
   'Warm amber, vanilla and musk for cozy evenings. Rich, addictive trail.',
   'perfume', null, null, 'Evening', 4.8, 189,
   'https://images.unsplash.com/photo-1615634260167-c8cdede054de?auto=format&fit=crop&w=800&q=80',
   false, 0),

  ('rose-elegance', 'Rose Élégance',
   'Damask rose with soft peony and clean musk. Romantic and timeless.',
   'perfume', null, null, 'Floral', 4.7, 133,
   'https://images.unsplash.com/photo-1547887537-6158d64c35b3?auto=format&fit=crop&w=800&q=80',
   false, 0),

  ('velvet-musk', 'Velvet Musk',
   'Powdery musk with iris and sandalwood. Soft, sensual and unisex.',
   'perfume', null, null, 'Unisex', 4.9, 221,
   'https://images.unsplash.com/photo-1608571423902-eed4a5ad8108?auto=format&fit=crop&w=800&q=80',
   false, 0),

  -- Air fresheners — single price
  ('citrus-room-mist', 'Citrus Room Mist',
   'Instant fresh citrus burst for kitchens, living rooms and offices. 300ml spray.',
   'air', 3500, null, 'Kitchen fresh', 4.7, 154,
   'https://images.unsplash.com/photo-1585771724684-38269d6639fd?auto=format&fit=crop&w=800&q=80',
   true, 80),

  ('lavender-spray', 'Lavender Room Spray',
   'Calming lavender mist that neutralises odours and relaxes the room. 250ml.',
   'air', 3200, null, 'Calming', 4.8, 126,
   'https://images.unsplash.com/photo-1615397349754-cfa2066a298e?auto=format&fit=crop&w=800&q=80',
   false, 64),

  ('ocean-car-fresh', 'Ocean Car Freshener',
   'Fresh ocean breeze scent that lasts weeks in any car. Clip-on spray, 100ml.',
   'air', 2800, null, 'Car essential', 4.6, 203,
   'https://images.unsplash.com/photo-1625772299848-391b6a87d7b3?auto=format&fit=crop&w=800&q=80',
   false, 90),

  ('vanilla-candle', 'Vanilla Scent Candle',
   'Hand-poured vanilla soy candle with a cosy 40-hour burn. 200g.',
   'air', 4500, null, 'Hand-poured', 4.9, 96,
   'https://images.unsplash.com/photo-1603006905003-be475563bc59?auto=format&fit=crop&w=800&q=80',
   false, 30),

  ('floral-aroma-candle', 'Floral Aroma Candle',
   'Jasmine & peony candle that fills the room with soft garden florals. 200g.',
   'air', 4900, null, 'Floral', 4.8, 84,
   'https://images.unsplash.com/photo-1562157873-818bc0726f68?auto=format&fit=crop&w=800&q=80',
   false, 26)
on conflict (slug) do update
  set name          = excluded.name,
      description   = excluded.description,
      category      = excluded.category,
      price         = excluded.price,
      old_price     = excluded.old_price,
      badge         = excluded.badge,
      rating        = excluded.rating,
      review_count  = excluded.review_count,
      image_url     = excluded.image_url,
      featured      = excluded.featured;

-- ---------------------------------------------------------------------------
-- Size variants
-- ---------------------------------------------------------------------------
insert into public.product_variants (product_id, label, price, stock_quantity, sort_order)
select p.id, v.label, v.price, v.stock, v.ord
from (values
  -- Crystal Clean
  ('crystal-clean', '500ml',  4500, 60, 1),
  ('crystal-clean', '750ml',  6200, 45, 2),
  ('crystal-clean', '1L',     8500, 35, 3),
  ('crystal-clean', '2L',    15500, 20, 4),
  -- Fresh Zest
  ('fresh-zest', '500ml',     5200, 55, 1),
  ('fresh-zest', '750ml',     7000, 40, 2),
  ('fresh-zest', '1L',        9500, 30, 3),
  ('fresh-zest', '2L',       17500, 18, 4),
  -- Silky Foam
  ('silky-foam', '500ml',     4900, 58, 1),
  ('silky-foam', '750ml',     6700, 42, 2),
  ('silky-foam', '1L',        9200, 32, 3),
  ('silky-foam', '2L',       16800, 19, 4),
  -- Lemon Burst
  ('lemon-burst', '500ml',    4200, 70, 1),
  ('lemon-burst', '750ml',    5800, 50, 2),
  ('lemon-burst', '1L',       8000, 36, 3),
  ('lemon-burst', '2L',      14800, 22, 4),
  -- Berry Blast
  ('berry-blast', '500ml',    4600, 48, 1),
  ('berry-blast', '750ml',    6400, 34, 2),
  ('berry-blast', '1L',       8800, 26, 3),
  ('berry-blast', '2L',      16000, 14, 4),
  -- Aloe Soft
  ('aloe-soft', '500ml',      4800, 52, 1),
  ('aloe-soft', '750ml',      6600, 38, 2),
  ('aloe-soft', '1L',         9000, 28, 3),
  ('aloe-soft', '2L',        16400, 16, 4),
  -- Oud Royale
  ('oud-royale', '30ml',     14900, 40, 1),
  ('oud-royale', '50ml',     24500, 26, 2),
  ('oud-royale', '100ml',    42500, 12, 3),
  -- Citrus Bloom
  ('citrus-bloom', '30ml',    9800, 44, 1),
  ('citrus-bloom', '50ml',   15800, 30, 2),
  ('citrus-bloom', '100ml',  26800, 15, 3),
  -- Amber Nights
  ('amber-nights', '30ml',   12400, 38, 1),
  ('amber-nights', '50ml',   19900, 24, 2),
  ('amber-nights', '100ml',  34500, 11, 3),
  -- Rose Élégance
  ('rose-elegance', '30ml',  11000, 36, 1),
  ('rose-elegance', '50ml',  17500, 23, 2),
  ('rose-elegance', '100ml', 29800, 10, 3),
  -- Velvet Musk
  ('velvet-musk', '30ml',    16800, 30, 1),
  ('velvet-musk', '50ml',    28000, 18, 2),
  ('velvet-musk', '100ml',   48000,  8, 3)
) as v(slug, label, price, stock, ord)
join public.products p on p.slug = v.slug
on conflict (product_id, label) do update
  set price     = excluded.price,
      sort_order = excluded.sort_order;

-- ---------------------------------------------------------------------------
-- Promo codes
-- ---------------------------------------------------------------------------
insert into public.promo_codes (code, percent_off, min_subtotal, max_uses, is_active)
values
  ('SPARKLE10', 10.00, 0, null, true)
on conflict (code) do update
  set percent_off  = excluded.percent_off,
      min_subtotal = excluded.min_subtotal,
      is_active    = excluded.is_active;

-- ===========================================================================
-- BOOTSTRAPPING THE FIRST ADMINISTRATOR
-- ---------------------------------------------------------------------------
-- There is intentionally no API path to admin, so the first one is created
-- directly in the Supabase SQL editor AFTER that person has signed up:
--
--   update public.user_roles
--      set role = 'admin', granted_at = now()
--    where user_id = (select id from auth.users where email = 'owner@example.com');
--
-- Verify with:
--
--   select u.email, r.role
--     from public.user_roles r
--     join auth.users u on u.id = r.user_id
--    order by r.role, u.email;
--
-- After that, additional administrators can be promoted from the admin page,
-- which calls the guarded public.admin_set_user_role() function.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 20260911090500_checkout_preview.sql
-- ---------------------------------------------------------------------------
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

  -- Nothing priced means nothing to deliver: a basket whose only lines are
  -- unavailable has a subtotal of 0, and quoting a delivery fee on top of that
  -- would show a total the customer cannot make sense of. Free delivery over
  -- the threshold is applied first. Keep in sync with place_order().
  v_delivery := case
    when v_subtotal <= 0 then 0
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
