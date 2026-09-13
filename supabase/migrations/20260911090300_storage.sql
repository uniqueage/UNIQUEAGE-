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

-- Supabase enables RLS on storage.objects by default. This is idempotent and
-- guarantees the policies below are actually enforced regardless of the
-- project's dashboard state.
alter table storage.objects enable row level security;

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
