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
