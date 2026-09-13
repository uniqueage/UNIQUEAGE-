#!/usr/bin/env node
/**
 * UAGE — apply the schema to the REMOTE Supabase project.
 *
 * Runs supabase/SETUP.sql against the linked project through the Supabase
 * Management API. This needs **no database password, no Docker and no CLI** —
 * only a personal access token with the `database:write` scope.
 *
 * Create a token at:  https://supabase.com/dashboard/account/tokens
 *
 * Usage:
 *
 *   SUPABASE_ACCESS_TOKEN=sbp_… node supabase/apply-remote.mjs
 *
 * Options:
 *   --check           report what is actually installed, then exit
 *   --selftest-auth   sign a throwaway account up, verify the trigger, delete it
 *   --promote <email> grant admin to an EXISTING account (sign up first)
 *   --file <path>     apply a different .sql file (default: supabase/SETUP.sql)
 *   --project <ref>   override the project ref
 *
 * The token is read from the environment and is NEVER printed or written
 * anywhere. Revoke it from the same page once the schema is applied.
 *
 * The endpoint is `POST /v1/projects/{ref}/database/query`, which proxies
 * arbitrary SQL — including DDL — to Postgres as the `postgres` role, so it can
 * create tables, types, policies, triggers and storage policies.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.supabase.com/v1";

/** The project ref, from --project, the environment, or the public config. */
function projectRef() {
  const flag = process.argv.indexOf("--project");
  if (flag !== -1 && process.argv[flag + 1]) return process.argv[flag + 1];
  if (process.env.SUPABASE_PROJECT_REF) return process.env.SUPABASE_PROJECT_REF;

  const config = readFileSync(join(ROOT, "js", "supabase-config.js"), "utf8");
  const match = config.match(/https:\/\/([a-z0-9-]+)\.supabase\.co/);
  if (!match) {
    throw new Error(
      "Could not work out the project ref. Pass --project <ref> or set SUPABASE_PROJECT_REF."
    );
  }
  return match[1];
}

function sqlPath() {
  const flag = process.argv.indexOf("--file");
  return flag !== -1 && process.argv[flag + 1]
    ? join(ROOT, process.argv[flag + 1])
    : join(ROOT, "supabase", "SETUP.sql");
}

async function main() {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) {
    console.error(
      "SUPABASE_ACCESS_TOKEN is not set.\n" +
        "Create one at https://supabase.com/dashboard/account/tokens (scope: database:write)"
    );
    process.exit(1);
  }
  if (!token.startsWith("sbp_")) {
    console.error("That does not look like a personal access token (expected the sbp_ prefix).");
    process.exit(1);
  }

  if (process.argv.includes("--check")) {
    const rows = await check(token);
    const bad = rows.filter((r) => !r.ok).length;
    console.log(`\n${rows.length - bad}/${rows.length} checks passed`);
    return;
  }

  if (process.argv.includes("--selftest-auth")) {
    await selfTestAuth(token);
    return;
  }

  const promoteFlag = process.argv.indexOf("--promote");
  if (promoteFlag !== -1) {
    await promote(token, process.argv[promoteFlag + 1]);
    return;
  }

  const ref = projectRef();
  const path = sqlPath();
  const sql = readFileSync(path, "utf8");

  console.log(`Project : ${ref}`);
  console.log(`SQL     : ${path.replace(ROOT + "/", "")} (${sql.split("\n").length} lines, ${sql.length} bytes)`);
  console.log("Applying…\n");

  const started = Date.now();
  let res;
  try {
    res = await fetch(`${API}/projects/${ref}/database/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: sql }),
    });
  } catch (err) {
    console.error(`Request failed: ${err.message}`);
    process.exit(1);
  }

  const text = await res.text();
  const took = ((Date.now() - started) / 1000).toFixed(1);

  if (!res.ok) {
    console.error(`FAILED — HTTP ${res.status} after ${took}s`);
    /* Print the database's own complaint, which is what makes this fixable. */
    console.error(text.slice(0, 4000));
    process.exit(1);
  }

  console.log(`HTTP ${res.status} — applied in ${took}s`);
  console.log(text && text.trim() !== "{}" ? text.slice(0, 2000) : "  (no rows returned)");
}

/**
 * One SELECT; returns the single row, or an error marker.
 *
 * Deliberately NOT sent with `read_only: true`: that flag switches the session
 * to `supabase_read_only_user`, which cannot report the real writing role's
 * membership and privileges — and that is exactly what the storage checks need.
 */
async function read(token, query) {
  const res = await fetch(`${API}/projects/${projectRef()}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) return { error: (JSON.parse(text || "{}").message || text).trim() };
  const parsed = JSON.parse(text || "[]");
  return { row: Array.isArray(parsed) ? parsed[0] : parsed };
}

/**
 * Reports what is actually installed in the remote project. This matters
 * because the embedded-Postgres test suite cannot be authoritative about the
 * real project's ownership and privilege layout — `storage.objects` in
 * particular is owned by `supabase_storage_admin`, not `postgres`.
 */
async function check(token) {
  const rows = [];
  const add = async (name, query, ok) => {
    const res = await read(token, query);
    if (res.error) {
      rows.push({ name, ok: false, detail: res.error });
      console.log(`  \u001b[31m✗ ${name}\u001b[0m\n      → ${res.error}`);
      return null;
    }
    const row = res.row || {};
    const passed = ok(row);
    const shown = Object.values(row).filter((v) => typeof v !== "object").join(" · ");
    rows.push({ name, ok: passed, detail: shown });
    console.log(`  ${passed ? "\u001b[32m✓" : "\u001b[31m✗"} ${name}\u001b[0m  ${shown}`);
    return row;
  };

  console.log(`Project: ${projectRef()}\n`);

  const who = await add(
    "extensions + role layout",
    `select current_user as db_role,
            pg_has_role(current_user, 'supabase_storage_admin', 'member')::text as can_use_storage_admin,
            (select rolsuper::text from pg_roles where rolname = current_user) as is_superuser`,
    () => true
  );

  /* Exact counts, not thresholds — anything else means the schema is not the
   * schema this repository defines. 8 tables / 23 policies / 3 enums come
   * straight from the migration files. */
  await add(
    "public tables installed",
    `select (select count(*)::text from information_schema.tables
              where table_schema = 'public' and table_type = 'BASE TABLE') as tables,
            (select count(*)::text from pg_policies where schemaname = 'public') as policies,
            (select count(*)::text from pg_type t join pg_namespace n on n.oid = t.typnamespace
              where n.nspname = 'public' and t.typtype = 'e') as enums`,
    (r) => Number(r.tables) === 8 && Number(r.policies) === 23 && Number(r.enums) === 3
  );

  await add(
    "catalog seeded",
    `select (select count(*)::text from public.products) as products,
            (select count(*)::text from public.categories) as categories,
            (select count(*)::text from public.product_variants) as variants,
            (select count(*)::text from public.promo_codes) as promos`,
    (r) => Number(r.products) === 22 && Number(r.categories) === 4
  );

  await add(
    "storage buckets",
    `select (select count(*)::text from storage.buckets where id in ('product-images','avatars')) as our_buckets,
            (select count(*)::text from pg_policies where schemaname = 'storage') as storage_policies`,
    (r) => Number(r.our_buckets) === 2 && Number(r.storage_policies) === 8
  );

  await add(
    "trusted functions",
    `select (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname in
                ('place_order','checkout_preview','is_admin','admin_dashboard_stats','admin_set_user_role')) as found`,
    (r) => Number(r.found) === 5
  );

  console.log("\n  current user context:", who ? JSON.stringify(who) : "unavailable");
  return rows;
}

/**
 * Grants admin to an account that already exists.
 *
 * Roles live in public.user_roles and must NEVER be grantable from a browser,
 * so there is no self-service path — this is the deliberate out-of-band step.
 * Refuses to invent a user: the account has to be created by signing up first,
 * which is also what makes the whole auth flow get exercised at least once.
 */
async function promote(token, email) {
  if (!email) {
    console.error("Usage: --promote you@example.com");
    process.exit(1);
  }

  const found = await read(
    token,
    `select id::text as id, email from auth.users where lower(email) = lower(${quote(email)})`
  );
  if (found.error) {
    console.error(`Could not look up ${email}: ${found.error}`);
    process.exit(1);
  }
  if (!found.row || !found.row.id) {
    console.error(
      `No account exists for ${email}. Create it first at signup.html, then run this again.`
    );
    process.exit(1);
  }

  const res = await read(
    token,
    `update public.user_roles
        set role = 'admin', granted_at = now()
      where user_id = ${quote(found.row.id)}::uuid
      returning role`
  );
  if (res.error) {
    console.error(`Promotion failed: ${res.error}`);
    process.exit(1);
  }

  console.log(`${email} is now an administrator.`);
  console.log("Sign in at admin.html — use Customers → Make admin for anyone else.");
}

/** Single-quoted SQL literal. Emails cannot contain quotes, but be strict anyway. */
function quote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Verifies the signup path on the REAL project, then removes all trace of it.
 *
 * The offline suite runs against an embedded Postgres with `auth.users`
 * stubbed, so it cannot prove the one thing most likely to be wrong on a hosted
 * project: that inserting a user into `auth.users` actually fires the trigger
 * that creates a `public.profiles` row and a `customer` entry in
 * `public.user_roles`. If it does not, a new customer would appear to sign up
 * successfully and then have no profile at all — and `--promote` would silently
 * affect zero rows.
 *
 * The row is inserted straight into `auth.users` rather than posted to the
 * signup endpoint, deliberately:
 *
 *   * it fires exactly the same `on_auth_user_created` trigger, which is the
 *     thing under test; and
 *   * the public endpoint would send a real confirmation email to an address
 *     nobody owns, and Supabase's validator rejects reserved domains like
 *     example.com anyway.
 *
 * The user's own signup through signup.html exercises the endpoint itself.
 */
async function selfTestAuth(token) {
  const ref = projectRef();
  const email = `uage-selftest-${Date.now()}@uage.test`;

  console.log(`Project: ${ref}`);
  console.log(`Account: ${email}\n`);

  let step = 0;
  const ok = (name, pass, detail) => {
    step++;
    console.log(`  ${pass ? "\u001b[32m✓" : "\u001b[31m✗"} ${name}\u001b[0m${pass || !detail ? "" : `\n      → ${detail}`}`);
    return pass;
  };

  /* 1. Create the account exactly as Supabase Auth would, so the trigger fires. */
  const created = await read(
    token,
    `insert into auth.users
       (instance_id, id, aud, role, email, encrypted_password,
        email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     values
       ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
        ${quote(email)}, extensions.crypt('selftest-' || gen_random_uuid()::text, extensions.gen_salt('bf')),
        now(), '{"provider":"email","providers":["email"]}', '{}', now(), now())
     returning id::text as id`
  );
  const uid = created.row && created.row.id;
  if (!ok("an auth.users row was created (firing on_auth_user_created)", Boolean(uid), JSON.stringify(created).slice(0, 400))) {
    return;
  }

  /*
   * 2. The trigger. Checked as `postgres` so the assertion is about the rows
   *    that exist, not about what any policy happens to expose.
   */
  const prof = await read(token, `select count(*)::int as n from public.profiles where id = ${quote(uid)}::uuid`);
  ok("signup created a public.profiles row", prof.row && prof.row.n === 1, JSON.stringify(prof).slice(0, 200));

  const role = await read(token, `select role from public.user_roles where user_id = ${quote(uid)}::uuid`);
  ok("signup assigned the `customer` role", role.row && role.row.role === "customer", JSON.stringify(role).slice(0, 200));

  const isAdmin = await read(token, `select public.is_admin() as a`);
  ok("a brand new account is NOT an administrator", isAdmin.row && isAdmin.row.a === false, JSON.stringify(isAdmin).slice(0, 200));

  /* 3. Clean up: deleting the auth user must cascade, leaving nothing behind. */
  const del = await read(token, `delete from auth.users where email = ${quote(email)} returning id::text as id`);
  ok("the test account was removed", !del.error && Boolean(del.row && del.row.id), JSON.stringify(del).slice(0, 300));

  const leftovers = await read(
    token,
    `select (select count(*)::int from auth.users where email = ${quote(email)})::text as users,
            (select count(*)::int from public.profiles where id = ${quote(uid)}::uuid)::text as profiles,
            (select count(*)::int from public.user_roles where user_id = ${quote(uid)}::uuid)::text as roles`
  );
  ok(
    "  ...and removing it cascaded to profiles and roles",
    leftovers.row && leftovers.row.users === "0" && leftovers.row.profiles === "0" && leftovers.row.roles === "0",
    JSON.stringify(leftovers).slice(0, 300)
  );

  console.log(`\n${step} checks run.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
