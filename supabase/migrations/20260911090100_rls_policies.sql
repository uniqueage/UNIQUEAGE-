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
