/**
 * UAGE backend — migration + RLS + order-logic test suite.
 *
 * Runs the real migration files against an embedded Postgres (PGlite) with
 * Supabase's auth/storage schemas stubbed, then asserts that:
 *
 *   1. every migration applies cleanly
 *   2. an anonymous visitor can only see the public catalog
 *   3. a customer can only ever touch their own data
 *   4. a customer cannot escalate to admin, change prices or alter stock
 *   5. orders can only be created through the trusted server-side function,
 *      with totals recomputed from the database
 *   6. administrators get their extra powers, and cannot drop the last admin
 *   7. storage buckets enforce per-user and admin-only writes
 *
 * Run:  cd supabase/tests && npm test
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, "..", "migrations");

// PGlite ships a bundled build, so an uncaught Postgres error would dump the
// whole module source. Report just the message instead.
for (const signal of ["uncaughtException", "unhandledRejection"]) {
  process.on(signal, (err) => {
    console.error(`\n\u001b[31mHARNESS ERROR\u001b[0m ${err?.message || err}`);
    if (err?.query) console.error(`  query: ${err.query}`);
    process.exit(1);
  });
}

/* ------------------------------------------------------------------ report */
let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  \u001b[32m✓\u001b[0m ${name}`);
  } else {
    failures.push(name);
    console.log(`  \u001b[31m✗ ${name}\u001b[0m${detail ? `\n      → ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n\u001b[1m${title}\u001b[0m`);
}

const eq = (name, actual, expected) =>
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

/* --------------------------------------------------------------- database */
const db = new PGlite();

async function applyFile(path, label) {
  const sql = readFileSync(path, "utf8");
  try {
    await db.exec(sql);
  } catch (err) {
    console.log(`\n\u001b[31mFAILED applying ${label}\u001b[0m\n${err.message}`);
    process.exit(1);
  }
}

/** Switch the active Postgres role and the simulated JWT subject. */
async function actAs(role, uid = null) {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [uid ?? ""]);
  await db.exec(`set role ${role}`);
}

/** Async lift of actAs so tests read as "as customer A, … then …". */
const asPostgres = () => actAs("postgres");
const asAnon = () => actAs("anon");
const asCustomer = (uid) => actAs("authenticated", uid);

async function expectFailure(name, fn, expectedFragment) {
  try {
    await fn();
    check(name, false, "expected an error but the statement succeeded");
  } catch (err) {
    const message = String(err.message || err);
    check(
      name,
      expectedFragment ? message.toLowerCase().includes(expectedFragment.toLowerCase()) : true,
      message
    );
  }
}

/* =========================================================== apply schema */
section("Migrations");

const migrationFiles = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
check(`found migration files (${migrationFiles.length})`, migrationFiles.length === 5);

await applyFile(join(HERE, "supabase-stubs.sql"), "supabase-stubs.sql");
console.log("  \u001b[32m✓\u001b[0m supabase-stubs.sql (auth/storage stand-ins)");

for (const file of migrationFiles) {
  await applyFile(join(MIGRATIONS_DIR, file), file);
  console.log(`  \u001b[32m✓\u001b[0m ${file}`);
}

/* ============================================================ seeded data */
section("Seed data");

const count = async (table, where = "") =>
  (await db.query(`select count(*)::int as n from ${table} ${where}`)).rows[0].n;

eq("4 categories seeded", await count("public.categories"), 4);
eq("22 products seeded", await count("public.products"), 22);
eq("39 size variants seeded", await count("public.product_variants"), 39);
eq("SPARKLE10 promo seeded", await count("public.promo_codes"), 1);
eq(
  "size-priced products carry no flat price",
  await count("public.products", "where price is null"),
  11
);
eq(
  "every price-less product has variants",
  await count(
    "public.products p",
    "where p.price is null and not exists (select 1 from public.product_variants v where v.product_id = p.id)"
  ),
  0
);

/* ================================================== create the test users */
section("Test fixtures");

const CUSTOMER_A = "11111111-1111-4111-8111-111111111111";
const CUSTOMER_B = "22222222-2222-4222-8222-222222222222";
const ADMIN_ID = "33333333-3333-4333-8333-333333333333";

await asPostgres();
await db.query(
  `insert into auth.users (id, email, raw_user_meta_data) values
     ($1, 'cust-a@example.com', '{"full_name":"Ada Customer","phone":"08030000001"}'::jsonb),
     ($2, 'cust-b@example.com', '{"full_name":"Bode Customer","phone":"08030000002"}'::jsonb),
     ($3, 'admin@example.com',  '{"full_name":"UAGE Admin"}'::jsonb)`,
  [CUSTOMER_A, CUSTOMER_B, ADMIN_ID]
);

eq("signup trigger created profiles", await count("public.profiles"), 3);
eq("signup trigger defaulted everyone to customer", await count("public.user_roles", "where role = 'customer'"), 3);
eq("nobody was made admin by signing up", await count("public.user_roles", "where role = 'admin'"), 0);

await db.query("update public.user_roles set role = 'admin' where user_id = $1", [ADMIN_ID]);

const productRow = async (slug, label) => {
  if (!label) {
    return (await db.query("select id from public.products where slug = $1", [slug])).rows[0];
  }
  return (
    await db.query(
      `select v.id from public.product_variants v
         join public.products p on p.id = v.product_id
        where p.slug = $1 and v.label = $2`,
      [slug, label]
    )
  ).rows[0];
};

const CRYSTAL_1L = await productRow("crystal-clean", "1L");
const VELVET_100ML = await productRow("velvet-musk", "100ml");
const BUTTER = await productRow("shea-body-butter");
const stockOf = async (variantId) =>
  (await db.query("select stock_quantity from public.product_variants where id = $1", [variantId]))
    .rows[0].stock_quantity;

/* ================================================== unauthenticated visitor */
section("Anonymous visitor");

await asAnon();
eq("can read the active catalog", await count("public.products"), 22);
eq("can read categories", await count("public.categories"), 4);
eq("can read size variants", await count("public.product_variants"), 39);
eq("cannot read any profile", await count("public.profiles"), 0);
eq("cannot read user_roles", await count("public.user_roles"), 0);
eq("cannot read orders", await count("public.orders"), 0);
eq("cannot enumerate promo codes", await count("public.promo_codes"), 0);
check("is_admin() is false for anon", (await db.query("select public.is_admin() as a")).rows[0].a === false);

await expectFailure(
  "cannot create a product",
  () =>
    db.query(
      `insert into public.products (slug, name, description, category, price, image_url)
       values ('hacked', 'Hacked', 'nope', 'dishwash', 1, 'https://x.test/a.png')`
    ),
  "row-level security"
);

await expectFailure(
  "cannot place an order",
  () => db.query("select public.place_order('[]'::jsonb, '{}'::jsonb, 'Card')"),
  "permission denied"
);

/* ============================================================== customer A */
section("Customer — own data only");

await asCustomer(CUSTOMER_A);
eq("sees exactly one profile (their own)", await count("public.profiles"), 1);
eq("sees exactly one role row (their own)", await count("public.user_roles"), 1);
check("is_admin() is false", (await db.query("select public.is_admin() as a")).rows[0].a === false);

await db.query(
  "update public.profiles set full_name = 'Ada Updated', phone = '08099999999' where id = $1",
  [CUSTOMER_A]
);
eq(
  "can update their own profile",
  (await db.query("select full_name from public.profiles where id = $1", [CUSTOMER_A])).rows[0].full_name,
  "Ada Updated"
);

const otherProfile = await db.query(
  "update public.profiles set full_name = 'Pwned' where id = $1",
  [CUSTOMER_B]
);
eq("cannot update another customer's profile", otherProfile.affectedRows, 0);

const escalate = await db.query(
  "update public.user_roles set role = 'admin' where user_id = $1",
  [CUSTOMER_A]
);
eq("cannot promote themselves via user_roles", escalate.affectedRows, 0);

await asPostgres();
eq(
  "role is still 'customer' after the escalation attempt",
  (await db.query("select role::text as r from public.user_roles where user_id = $1", [CUSTOMER_A])).rows[0].r,
  "customer"
);

await asCustomer(CUSTOMER_A);
await expectFailure(
  "cannot insert a product",
  () =>
    db.query(
      `insert into public.products (slug, name, description, category, price, image_url)
       values ('sneaky', 'Sneaky', 'x', 'dishwash', 1, 'https://x.test/a.png')`
    ),
  "row-level security"
);

// RLS hides those rows from the customer's UPDATE, so the statement becomes a
// silent no-op rather than an error. The thing that actually matters is that
// nothing changed — asserted immediately below.
const priceAttempt = await db.query(
  "update public.products set price = 1 where slug = 'shea-body-butter'"
);
eq("cannot change a product price (0 rows affected)", priceAttempt.affectedRows, 0);

const stockAttempt = await db.query(
  "update public.products set stock_quantity = 9999 where slug = 'shea-body-butter'"
);
eq("cannot change stock (0 rows affected)", stockAttempt.affectedRows, 0);

const deleteAttempt = await db.query(
  "delete from public.products where slug = 'shea-body-butter'"
);
eq("cannot delete a product (0 rows affected)", deleteAttempt.affectedRows, 0);

await expectFailure(
  "cannot insert a size variant",
  () =>
    db.query(
      "insert into public.product_variants (product_id, label, price) values ($1, '9L', 1)",
      [BUTTER.id]
    ),
  "row-level security"
);

// Prove the catalog actually survived those attempts.
await asPostgres();
const untouched = (
  await db.query("select price, stock_quantity from public.products where slug = 'shea-body-butter'")
).rows[0];
eq("price is untouched after the attempt", untouched.price, "6500.00");
eq("stock is untouched after the attempt", untouched.stock_quantity, 45);
await asCustomer(CUSTOMER_A);

await expectFailure(
  "cannot insert an order directly",
  () =>
    db.query(
      `insert into public.orders (user_id, payment_method, subtotal, total_amount,
                                  delivery_name, delivery_phone, delivery_address, delivery_city)
       values ($1, 'Card', 100, 100, 'Ada Customer', '08030000001', '1 Test Street', 'Lagos')`,
      [CUSTOMER_A]
    ),
  "permission denied"
);

/* ============================================================ order placing */
section("Order placement — trusted server-side flow");

const stockBefore = await stockOf(CRYSTAL_1L.id);

const orderRes = (
  await db.query("select public.place_order($1::jsonb, $2::jsonb, $3, $4) as res", [
    JSON.stringify([{ variant_id: CRYSTAL_1L.id, quantity: 1, unit_price: 1, price: 1 }]),
    JSON.stringify({
      name: "Ada Customer",
      phone: "08030000001",
      email: "cust-a@example.com",
      address: "1 Test Street, Ikeja",
      city: "Lagos",
      notes: "Call on arrival",
    }),
    "Pay on delivery",
    null,
  ])
).rows[0].res;

// 1 × 8,500 = 8,500 subtotal; below the ₦10,000 threshold → ₦1,500 delivery.
eq("subtotal is computed from the database", Number(orderRes.subtotal), 8500);
eq("delivery fee applied below the free threshold", Number(orderRes.delivery_fee), 1500);
eq("total is computed server-side", Number(orderRes.total_amount), 10000);
check("order number returned", /^UAGE-\d+$/.test(orderRes.order_number));
check(
  "browser-supplied prices were ignored",
  Number(orderRes.subtotal) === 8500,
  "client sent unit_price=1 and it was not trusted"
);
eq("stock was decremented", await stockOf(CRYSTAL_1L.id), stockBefore - 1);
eq("one order item was written", await count("public.order_items", `where order_id = '${orderRes.order_id}'`), 1);
eq(
  "the line item snapshots the real unit price",
  (await db.query("select unit_price from public.order_items where order_id = $1", [orderRes.order_id])).rows[0].unit_price,
  "8500.00"
);

const promoRes = (
  await db.query("select public.place_order($1::jsonb, $2::jsonb, $3, $4) as res", [
    JSON.stringify([{ product_id: BUTTER.id, quantity: 2 }]),
    JSON.stringify({
      name: "Ada Customer",
      phone: "08030000001",
      address: "1 Test Street, Ikeja",
      city: "Lagos",
    }),
    "Bank transfer",
    "SPARKLE10",
  ])
).rows[0].res;

// 2 × 6,500 = 13,000; 10% off = 1,300; over the threshold → free delivery.
eq("promo discount applied server-side", Number(promoRes.discount), 1300);
eq("free delivery over the threshold", Number(promoRes.delivery_fee), 0);
eq("promo total correct", Number(promoRes.total_amount), 11700);
// promo_codes is deliberately not customer-readable, so check it as the owner.
await asPostgres();
eq(
  "promo usage counter incremented",
  (await db.query("select uses from public.promo_codes where code = 'SPARKLE10'")).rows[0].uses,
  1
);
await asCustomer(CUSTOMER_A);

await expectFailure(
  "an invalid promo code is rejected",
  () =>
    db.query("select public.place_order($1::jsonb, $2::jsonb, $3, $4)", [
      JSON.stringify([{ product_id: BUTTER.id, quantity: 1 }]),
      JSON.stringify({ name: "Ada Customer", phone: "08030000001", address: "1 Test Street", city: "Lagos" }),
      "Card",
      "FREEBIE",
    ]),
  "not valid"
);

await expectFailure(
  "insufficient stock is rejected",
  () =>
    db.query("select public.place_order($1::jsonb, $2::jsonb, $3)", [
      JSON.stringify([{ variant_id: VELVET_100ML.id, quantity: 999 }]),
      JSON.stringify({ name: "Ada Customer", phone: "08030000001", address: "1 Test Street", city: "Lagos" }),
      "Card",
    ]),
  "left in stock"
);

await expectFailure(
  "a malformed product id gives a friendly error",
  () =>
    db.query("select public.place_order($1::jsonb, $2::jsonb, $3)", [
      JSON.stringify([{ variant_id: "not-a-uuid", quantity: 1 }]),
      JSON.stringify({ name: "Ada Customer", phone: "08030000001", address: "1 Test Street", city: "Lagos" }),
      "Card",
    ]),
  "invalid"
);

await expectFailure(
  "an empty basket is rejected",
  () => db.query("select public.place_order('[]'::jsonb, '{}'::jsonb, 'Card')"),
  "empty"
);

await expectFailure(
  "an unsupported payment method is rejected",
  () =>
    db.query("select public.place_order($1::jsonb, $2::jsonb, $3)", [
      JSON.stringify([{ product_id: BUTTER.id, quantity: 1 }]),
      JSON.stringify({ name: "Ada Customer", phone: "08030000001", address: "1 Test Street", city: "Lagos" }),
      "Crypto",
    ]),
  "payment method"
);

await expectFailure(
  "invalid delivery details are rejected",
  () =>
    db.query("select public.place_order($1::jsonb, $2::jsonb, $3)", [
      JSON.stringify([{ product_id: BUTTER.id, quantity: 1 }]),
      JSON.stringify({ name: "A", phone: "123", address: "x", city: "L" }),
      "Card",
    ]),
  "full name"
);

/* ================================================= customer B + isolation */
section("Cross-customer isolation");

// B places their own order — authenticated as B, not A.
await asCustomer(CUSTOMER_B);
const bOrder = (
  await db.query("select public.place_order($1::jsonb, $2::jsonb, $3) as res", [
    JSON.stringify([{ product_id: BUTTER.id, quantity: 1 }]),
    JSON.stringify({ name: "Bode Customer", phone: "08030000002", address: "9 Other Road", city: "Abuja" }),
    "Card",
  ])
).rows[0].res;
check("B placed their own order", /^UAGE-\d+$/.test(bOrder.order_number));

await asCustomer(CUSTOMER_B);
const bVisibleOrders = await db.query("select id from public.orders");
eq("B sees only their own order", bVisibleOrders.rows.length, 1);
eq("B sees only their own order items", await count("public.order_items"), 1);
eq("B sees only their own profile", await count("public.profiles"), 1);

await asCustomer(CUSTOMER_A);
const aOrders = await db.query("select id from public.orders");
eq("A sees only their own two orders", aOrders.rows.length, 2);
eq("A cannot see B's order", await count("public.orders", `where id = '${bOrder.order_id}'`), 0);
eq("A cannot see B's order items", await count("public.order_items", `where order_id = '${bOrder.order_id}'`), 0);

eq(
  "A cannot cancel B's order (0 rows affected)",
  (await db.query("update public.orders set status = 'cancelled' where id = $1", [bOrder.order_id]))
    .affectedRows,
  0
);

/* ================================================================== admin */
section("Administrator");

await asCustomer(ADMIN_ID);
check("is_admin() is true for the admin", (await db.query("select public.is_admin() as a")).rows[0].a === true);
eq("admin can see every order", (await db.query("select id from public.orders")).rows.length, 3);
eq("admin can see every profile", await count("public.profiles"), 3);

const newProduct = (
  await db.query(
    `insert into public.products (slug, name, description, category, price, image_url, stock_quantity)
     values ('admin-special', 'Admin Special', 'Created by an admin', 'air', 2500, 'https://x.test/a.png', 10)
     returning id`
  )
).rows[0];
check("admin can create a product", Boolean(newProduct.id));

await db.query("update public.products set price = 2750 where id = $1", [newProduct.id]);
eq(
  "admin can edit a product",
  (await db.query("select price from public.products where id = $1", [newProduct.id])).rows[0].price,
  "2750.00"
);

await db.query("update public.products set is_active = false where id = $1", [newProduct.id]);
eq("admin can deactivate a product", await count("public.products", "where is_active"), 22);

await db.query("update public.orders set status = 'confirmed' where id = $1", [orderRes.order_id]);
eq(
  "admin can move an order status",
  (await db.query("select status::text as s from public.orders where id = $1", [orderRes.order_id])).rows[0].s,
  "confirmed"
);

await expectFailure(
  "an illegal status jump is blocked",
  () => db.query("update public.orders set status = 'delivered' where id = $1", [orderRes.order_id]),
  "cannot move an order"
);

const stats = (await db.query("select public.admin_dashboard_stats() as s")).rows[0].s;
check("admin stats roll-up works", typeof stats.orders === "number" && Number(stats.orders) === 3);

await db.query("select public.admin_set_user_role($1, $2)", [CUSTOMER_A, "admin"]);
eq(
  "admin can promote another user",
  (await db.query("select role::text as r from public.user_roles where user_id = $1", [CUSTOMER_A])).rows[0].r,
  "admin"
);

await db.query("select public.admin_set_user_role($1, $2)", [CUSTOMER_A, "customer"]);
await expectFailure(
  "cannot demote the last administrator",
  () => db.query("select public.admin_set_user_role($1, $2)", [ADMIN_ID, "customer"]),
  "last administrator"
);

await asCustomer(CUSTOMER_A);
await expectFailure(
  "a customer cannot call admin functions",
  () => db.query("select public.admin_dashboard_stats()"),
  "administrator access required"
);
await expectFailure(
  "a customer cannot promote anyone",
  () => db.query("select public.admin_set_user_role($1, $2)", [CUSTOMER_A, "admin"]),
  "administrator access required"
);

/* ================================================================ storage */
section("Storage policies");

await asCustomer(CUSTOMER_A);
await db.query("insert into storage.objects (bucket_id, name) values ('avatars', $1)", [
  `${CUSTOMER_A}/avatar.png`,
]);
eq("a customer can upload their own avatar", await count("storage.objects"), 1);

await expectFailure(
  "a customer cannot write into another user's avatar folder",
  () =>
    db.query("insert into storage.objects (bucket_id, name) values ('avatars', $1)", [
      `${CUSTOMER_B}/avatar.png`,
    ]),
  "row-level security"
);

await expectFailure(
  "a customer cannot upload product images",
  () =>
    db.query("insert into storage.objects (bucket_id, name) values ('product-images', 'new.jpg')", []),
  "row-level security"
);

await asCustomer(ADMIN_ID);
await db.query("insert into storage.objects (bucket_id, name) values ('product-images', 'hero.jpg')");
eq(
  "an admin can upload product images",
  await count("storage.objects", "where bucket_id = 'product-images'"),
  1
);

await asCustomer(CUSTOMER_A);
eq(
  "a customer cannot see or delete an admin's product image",
  (await db.query("delete from storage.objects where bucket_id = 'product-images'")).affectedRows,
  0
);

// Bucket configuration is asserted as the owner: reading the buckets table
// directly is not something the storefront does (it uses the public URLs).
await asPostgres();
check(
  "both buckets exist and are public",
  (await db.query("select count(*)::int as n from storage.buckets where public")).rows[0].n === 2
);

/* ================================================================= report */
console.log(
  `\n\u001b[1m${passed} passed, ${failures.length} failed\u001b[0m` +
    (failures.length ? `\n\n\u001b[31mFailures:\u001b[0m\n${failures.map((f) => `  • ${f}`).join("\n")}` : "")
);

await db.close();
process.exit(failures.length ? 1 : 0);
