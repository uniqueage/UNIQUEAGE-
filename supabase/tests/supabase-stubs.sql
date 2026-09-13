-- ===========================================================================
-- Minimal stand-ins for the pieces Supabase provides out of the box.
-- Used ONLY by the offline test harness so the real migrations can be executed
-- against a plain Postgres engine. These definitions mirror the real Supabase
-- objects closely enough for the schema, triggers, functions and RLS policies
-- to behave exactly as they will in production.
-- ===========================================================================

create schema if not exists auth;
create schema if not exists storage;

-- ---------------------------------------------------------------------------
-- Roles that Supabase creates for PostgREST
-- ---------------------------------------------------------------------------
do $$ begin create role anon nologin;          exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin;  exception when duplicate_object then null; end $$;

grant usage on schema public, auth, storage to anon, authenticated, service_role;

-- Supabase grants table/sequence privileges to these roles by default, and
-- RLS is what restricts the rows. Mirror that here, and do it BEFORE the
-- migrations so the defaults apply to the tables they create.
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on functions to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- auth.users  (only the columns our triggers touch)
-- ---------------------------------------------------------------------------
create table if not exists auth.users (
  id                  uuid primary key,
  email               text unique,
  raw_user_meta_data  jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now()
);

-- auth.uid() resolves the JWT subject exactly like Supabase does.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

-- ---------------------------------------------------------------------------
-- storage.buckets / storage.objects
-- ---------------------------------------------------------------------------
create table if not exists storage.buckets (
  id                 text primary key,
  name               text not null,
  public             boolean not null default false,
  file_size_limit    bigint,
  allowed_mime_types text[]
);

create table if not exists storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text references storage.buckets(id),
  name       text not null,
  owner      uuid,
  created_at timestamptz not null default now()
);

-- Returns every path segment except the last: 'uid/photo.png' -> {uid}
create or replace function storage.foldername(name text)
returns text[]
language sql
immutable
as $$
  select (string_to_array(name, '/'))[1 : greatest(array_length(string_to_array(name, '/'), 1) - 1, 0)];
$$;

-- Supabase ships the storage tables with RLS already ENABLED, and the
-- policies in migration 04 depend on that. Mirror it here, otherwise the
-- storage policies would appear to pass while enforcing nothing.
alter table storage.objects enable row level security;
alter table storage.buckets enable row level security;

-- Storage tables are granted explicitly (they live outside the `public` schema
-- so the default privileges above do not reach them).
grant all on storage.buckets, storage.objects to anon, authenticated, service_role;
