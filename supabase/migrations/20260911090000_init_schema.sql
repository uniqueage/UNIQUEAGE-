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
