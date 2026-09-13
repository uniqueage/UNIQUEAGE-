/**
 * UAGE — data-access layer smoke test.
 *
 * Runs js/api.js inside a sandbox with a stubbed Supabase client, so the
 * layer's behaviour can be verified without a live project. Covers the things
 * that are easy to get wrong and expensive in production:
 *
 *   1. an unconfigured site degrades quietly instead of throwing
 *   2. a secret/service-role key in public config is BLOCKED
 *   3. database errors are translated, and never leak table/RLS internals
 *   4. our own validation messages pass through intact
 *   5. the cart is resolved to database uuids without sending any price
 *   6. raw jsonb/rows map onto the shape the existing UI already renders
 *
 * Run:  node tests/api.test.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_SRC = readFileSync(join(ROOT, "js", "supabase-config.js"), "utf8");
const API_SRC = readFileSync(join(ROOT, "js", "api.js"), "utf8");

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
const eq = (name, actual, expected) =>
  check(
    name,
    JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  );

/** Fresh sandbox per scenario so the module's cached client does not leak. */
function loadApi({ config, client, onError }) {
  const consoleStub = {
    log: () => {},
    warn: () => {},
    error: (...a) => { if (onError) onError(...a); },
  };

  const sandbox = {
    console: consoleStub,
    Promise,
    setTimeout,
    clearTimeout,
    document: {
      head: { appendChild: () => {} },
      createElement: () => ({ set src(_) {}, set async(_) {}, onload: null, onerror: null }),
    },
    location: { origin: "https://uage.test", pathname: "/signup.html" },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);

  vm.runInContext(CONFIG_SRC, sandbox);
  Object.assign(sandbox.UAGE_SUPABASE_CONFIG, config);
  if (client) sandbox.supabase = { createClient: () => client };
  // Preload so loadLibrary() resolves without a real <script>
  vm.runInContext(API_SRC, sandbox);
  return sandbox.UAGE_API;
}

/** Minimal chainable query builder that reports whatever the test configures. */
function fakeClient(opts = {}) {
  const calls = { rpc: [], uploads: [], inserts: [], updates: [], upserts: [], deletes: [], eq: [] };

  function builder(table) {
    const response = () => ({
      data: opts.rows && opts.rows[table] !== undefined ? opts.rows[table] : [],
      error: opts.error || null,
    });
    const b = {
      select: () => b,
      eq: (col, val) => { calls.eq.push({ table, col, val }); return b; },
      order: () => b,
      limit: () => b,
      insert: (payload) => { calls.inserts.push({ table, payload }); return b; },
      update: (payload) => { calls.updates.push({ table, payload }); return b; },
      delete: () => { calls.deletes.push({ table }); return b; },
      upsert: (payload, o) => { calls.upserts.push({ table, payload, opts: o }); return b; },
      maybeSingle: () => Promise.resolve({ ...response(), data: (response().data || [])[0] ?? null }),
      then: (resolve) => Promise.resolve(response()).then(resolve),
    };
    return b;
  }

  const client = {
    auth: {
      getUser: async () => ({ data: { user: opts.user ?? { id: "user-1" } } }),
      getSession: async () => ({ data: { session: { access_token: "t" } } }),
      signInWithPassword: async () => ({ data: { user: { id: "user-1" }, session: {} }, error: null }),
      signUp: async () => ({ data: { user: { id: "user-1" }, session: null }, error: null }),
      signOut: async () => ({ error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      updateUser: async () => ({ data: { user: {} }, error: null }),
      resetPasswordForEmail: async () => ({ error: null }),
    },
    from: builder,
    rpc: async (name, args) => {
      calls.rpc.push({ name, args });
      return { data: opts.rpcResult || null, error: opts.error || null };
    },
    storage: {
      from: () => ({
        upload: async (path) => {
          calls.uploads.push(path);
          return { data: { path }, error: null };
        },
        getPublicUrl: (path) => ({ data: { publicUrl: `https://cdn.test/${path}` } }),
      }),
    },
  };
  return { client, calls };
}

/* A SYNTHETIC string that only *looks like* a Supabase secret key, so the
 * guard in js/api.js has something to reject. Never put a real key — even a
 * rotated one — in a test, a fixture or anything else that gets committed. */
const SECRET = "sb_secret_FAKE_KEY_FOR_TESTS_ONLY_do_not_use";
const PUBLIC_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.public-anon-key";
const CONFIGURED = { url: "https://demo.supabase.co", anonKey: PUBLIC_KEY };

/* ================================================== 1. unconfigured site */
{
  console.log("\n\u001b[1mUnconfigured site degrades quietly\u001b[0m");
  const api = loadApi({ config: {} });          // placeholder values from the file
  check("isConfigured() is false", api.isConfigured() === false);

  const res = await api.listProducts();
  check("listProducts resolves instead of throwing", Boolean(res));
  eq("  ...with a NOT_CONFIGURED code", res.error && res.error.code, "NOT_CONFIGURED");
  check("  ...and no data", res.data === null);
  check("  ...and a safe message", typeof res.error.message === "string" && res.error.message.length > 0);

  const order = await api.placeOrder({ items: [{ id: "wet-wipes", size: "", qty: 1 }], paymentMethod: "Card" });
  check("placeOrder also degrades quietly", order.error && order.error.code === "NOT_CONFIGURED");
}

/* ================================== 2. secret key must never be accepted */
{
  console.log("\n\u001b[1mSecret / service-role key is blocked\u001b[0m");
  let logged = "";
  const api = loadApi({
    config: { url: "https://demo.supabase.co", anonKey: SECRET },
    client: fakeClient().client,
    onError: (...a) => { logged += a.join(" "); },
  });
  const res = await api.listProducts();
  check("a secret key is refused", Boolean(res.error));
  check("  ...and the block is logged loudly", /BLOCKED/.test(logged), logged.slice(0, 120));
  check("  ...and the key is never echoed back", !logged.includes(SECRET));
}

/* ============================================ 3. error translation + 4. pass-through */
{
  console.log("\n\u001b[1mErrors are translated, never leaked\u001b[0m");
  const rlsErr = {
    code: "42501",
    message: 'new row violates row-level security policy for table "products"',
  };
  const api = loadApi({ config: CONFIGURED, client: fakeClient({ error: rlsErr }).client });
  const res = await api.listProducts();
  eq("RLS violation becomes a friendly message", res.error.message, "You don't have permission to do that.");
  check("  ...and the table name is not shown", !res.error.message.includes("products"));
  check("  ...and the raw message is not shown", !res.error.message.includes("row-level security"));

  const validationErr = { code: "22023", message: 'Only 8 left in stock for "Velvet Musk".' };
  const api2 = loadApi({ config: CONFIGURED, client: fakeClient({ error: validationErr, rpcResult: null }).client });
  const placed = await api2.placeOrder({
    items: [{ id: "velvet-musk", size: "100ml", qty: 999 }],
    paymentMethod: "Card",
    delivery: {},
    _noResolve: true,
  });
  check("our own validation message passes through", Boolean(placed.error));

  const badLogin = loadApi({ config: CONFIGURED, client: fakeClient().client });
  const bogus = fakeClient();
  bogus.client.auth.signInWithPassword = async () => ({
    data: null,
    error: { code: "invalid_credentials", message: "Invalid login credentials" },
  });
  const api3 = loadApi({ config: CONFIGURED, client: bogus.client });
  const login = await api3.signIn("a@b.co", "wrong");
  eq("bad credentials do not reveal whether the email exists", login.error.message, "That email and password don't match an account.");
  void badLogin;
}

/* ================================== 5. cart resolution sends no prices */
{
  console.log("\n\u001b[1mCart resolves to database uuids, with no prices sent\u001b[0m");

  const rows = {
    products: [
      {
        id: "p-uuid-1", slug: "crystal-clean", name: "Crystal Clean", description: "d",
        category: "dishwash", price: null, old_price: null, badge: "Bestseller",
        rating: 4.9, review_count: 312, image_url: "https://i/1.jpg",
        is_active: true, featured: true, stock_quantity: 0, created_at: "2026-01-01T00:00:00Z",
        product_variants: [
          { id: "v-1l", product_id: "p-uuid-1", label: "1L", price: "8500.00", stock_quantity: 35, sort_order: 3 },
          { id: "v-500", product_id: "p-uuid-1", label: "500ml", price: "4500.00", stock_quantity: 60, sort_order: 1 },
        ],
      },
      {
        id: "p-uuid-2", slug: "shea-body-butter", name: "Shea Body Butter", description: "d",
        category: "cosmetics", price: "6500.00", old_price: "7500.00", badge: null,
        rating: 4.9, review_count: 231, image_url: "https://i/2.jpg",
        is_active: true, featured: true, stock_quantity: 45, created_at: "2026-01-02T00:00:00Z",
        product_variants: [],
      },
    ],
  };

  const { client, calls } = fakeClient({
    rows,
    rpcResult: {
      order_id: "o-1", order_number: "UAGE-100001", status: "pending",
      subtotal: "8500.00", discount: "0.00", delivery_fee: "1500.00",
      total_amount: "10000.00", item_count: 1,
    },
  });

  const api = loadApi({ config: CONFIGURED, client });
  const res = await api.placeOrder({
    items: [
      { id: "crystal-clean", size: "1L", qty: 2, price: 1, unitPrice: 1 },
      { id: "shea-body-butter", size: "", qty: 1, price: 1 },
    ],
    paymentMethod: "Pay on delivery",
    promoCode: "SPARKLE10",
    delivery: { name: "Ada", phone: "08030000001", address: "1 Test St", city: "Lagos" },
  });

  check("placeOrder succeeds through rpc", res.error === null, JSON.stringify(res.error));
  eq("  ...calls the place_order function", calls.rpc[0].name, "place_order");
  eq("  ...a sized item is sent as variant_id", calls.rpc[0].args.p_items[0], { variant_id: "v-1l", quantity: 2 });
  eq("  ...a flat-priced item is sent as product_id", calls.rpc[0].args.p_items[1], { product_id: "p-uuid-2", quantity: 1 });

  const wire = JSON.stringify(calls.rpc[0].args);
  check("  ...no price is ever transmitted", !wire.includes("price"));
  eq("  ...payment method is forwarded", calls.rpc[0].args.p_payment_method, "Pay on delivery");
  eq("  ...promo code is forwarded", calls.rpc[0].args.p_promo_code, "SPARKLE10");

  eq("totals come back mapped for the UI", res.data.total, 10000);
  eq("  ...with the order number", res.data.orderNumber, "UAGE-100001");
  eq("  ...and the delivery fee", res.data.delivery, 1500);

  /* --- shape mapping: the existing cardHtml()/initProduct() contract --- */
  const mapped = api._map.product(rows.products[0], rows.products[0].product_variants);
  eq("product id is the slug (keeps product.html?id=… working)", mapped.id, "crystal-clean");
  eq("  ...and the uuid is preserved for backend calls", mapped.uuid, "p-uuid-1");
  eq("  ...sizes are sorted by sort_order", mapped.sizes.map((s) => s.label), ["500ml", "1L"]);
  eq("  ...prices are numbers, not strings", mapped.sizes[0].price, 4500);
  eq("  ...and image maps to the UI's `image` key", mapped.image, "https://i/1.jpg");

  /* --- rejecting a size that does not exist for that product --- */
  const bad = await api.placeOrder({
    items: [{ id: "crystal-clean", size: "9L", qty: 1 }],
    paymentMethod: "Card",
    delivery: {},
  });
  check("an unknown size is rejected before hitting the server", Boolean(bad.error));
  check("  ...with a helpful message", /size/i.test(bad.error.message), bad.error && bad.error.message);
}

/* ================================================ 6. admin write filtering */
{
  console.log("\n\u001b[1mAdmin writes are always row-filtered\u001b[0m");
  const { client } = fakeClient({ rows: { profiles: [{ id: "user-1", full_name: "Ada", email: "a@b.co", phone: "", created_at: "2026-01-01T00:00:00Z" }] } });
  const api = loadApi({ config: CONFIGURED, client });

  const prof = await api.getProfile();
  check("getProfile resolves for the signed-in user", prof.error === null, JSON.stringify(prof.error));
  eq("  ...mapped to the UI profile shape", prof.data.name, "Ada");

  const upd = await api.updateProfile({ name: "Ada Updated", phone: "08030000001" });
  check("updateProfile succeeds", upd.error === null, JSON.stringify(upd.error));

  const av = await api.uploadAvatar({ name: "me.png" });
  check("avatar upload succeeds", av.error === null, JSON.stringify(av.error));
  eq("  ...inside the user's own folder", av.data.url, "https://cdn.test/user-1/avatar.png");
}

/* =================================== 7. admin dashboard data paths */
{
  console.log("\n\u001b[1mAdmin dashboard data paths\u001b[0m");

  /* --- access check is answered by the database, not by the browser --- */
  {
    const yes = loadApi({ config: CONFIGURED, client: fakeClient({ rpcResult: true }).client });
    const access = await yes.admin.checkAccess();
    check("checkAccess() reports true for a database-confirmed admin", access.data === true);

    const no = loadApi({ config: CONFIGURED, client: fakeClient({ rpcResult: false }).client });
    check("  ...and false for everyone else", (await no.admin.checkAccess()).data === false);

    /* A permission error must look like "not an admin", never like success. */
    const denied = loadApi({
      config: CONFIGURED,
      client: fakeClient({ error: { code: "42501", message: "Administrator access required." } }).client,
    });
    check("  ...and a permission error fails closed", (await denied.admin.checkAccess()).data === false);
  }

  /* --- creating a product with sizes is ONE atomic nested insert --- */
  {
    const { client, calls } = fakeClient({ rows: { products: [] } });
    const api = loadApi({ config: CONFIGURED, client });

    await api.admin.createProduct(
      {
        slug: "crystal-clean", name: "Crystal Clean", description: "d", category: "dishwash",
        price: null, oldPrice: null, badge: "Bestseller", imageUrl: "https://i/1.jpg",
        isActive: true, featured: true, stockQuantity: 0, rating: 4.9,
      },
      [
        { label: "500ml", price: 4500, stockQuantity: 60, sortOrder: 0 },
        { label: "2L", price: 15500, stockQuantity: 12, sortOrder: 1 },
      ]
    );

    eq("one insert is issued for product + sizes", calls.inserts.length, 1);
    eq("  ...against products", calls.inserts[0].table, "products");
    const payload = calls.inserts[0].payload;
    eq("  ...with the sizes nested in the same write", payload.product_variants.length, 2);
    eq("  ...each size carrying its own price", payload.product_variants[0].price, 4500);
    eq("  ...and its own stock", payload.product_variants[1].stock_quantity, 12);
    check("  ...and the flat price stays NULL for a sized product", payload.price === null);

    const single = fakeClient({ rows: { products: [] } });
    const api2 = loadApi({ config: CONFIGURED, client: single.client });
    await api2.admin.createProduct({ slug: "x", name: "X", category: "air", price: 4900, imageUrl: "https://i/x.jpg" }, []);
    check(
      "a product without sizes sends no nested key",
      !("product_variants" in single.calls.inserts[0].payload)
    );
    eq("  ...and keeps its own price", single.calls.inserts[0].payload.price, 4900);
  }

  /* --- role changes go through the guarded function, never a table write --- */
  {
    const { client, calls } = fakeClient();
    const api = loadApi({ config: CONFIGURED, client });
    await api.admin.setUserRole("u-2", "admin");
    eq("setUserRole calls admin_set_user_role", calls.rpc[0].name, "admin_set_user_role");
    eq("  ...with the role as an argument", calls.rpc[0].args, { p_user_id: "u-2", p_role: "admin" });

    const pay = fakeClient();
    const api2 = loadApi({ config: CONFIGURED, client: pay.client });
    await api2.admin.setPaymentStatus("o-1", "paid");
    eq("setPaymentStatus calls admin_set_payment_status", pay.calls.rpc[0].name, "admin_set_payment_status");
    check(
      "  ...so no order amount is ever rewritten from the dashboard",
      pay.calls.updates.length === 0
    );
  }

  /* --- roles are joined from user_roles, not assumed to be a profile column --- */
  {
    const { client } = fakeClient({
      rows: { user_roles: [{ user_id: "u-1", role: "admin" }, { user_id: "u-2", role: "customer" }] },
    });
    const api = loadApi({ config: CONFIGURED, client });
    const roles = await api.admin.listRoles();
    eq("listRoles maps user_id -> role", roles.data, { "u-1": "admin", "u-2": "customer" });
  }

  /* --- a promo code is normalised before it reaches the database --- */
  {
    const { client, calls } = fakeClient({ rows: { promo_codes: [] } });
    const api = loadApi({ config: CONFIGURED, client });
    await api.admin.savePromo({ code: " sparkle10 ", percentOff: 10, minSubtotal: 0, maxUses: "", isActive: true });
    const promo = calls.upserts[0].payload;
    eq("promo codes are upper-cased and trimmed", promo.code, "SPARKLE10");
    check("  ...an empty max-uses becomes NULL (unlimited), not 0", promo.max_uses === null);
    eq("  ...and upsert conflicts on the code", calls.upserts[0].opts.onConflict, "code");
  }

  /* --- the admin-shaped order keeps every field the storefront already uses --- */
  {
    const api = loadApi({ config: CONFIGURED, client: fakeClient().client });
    const order = api._map.order({
      id: "o-uuid", order_number: "UAGE-100001", user_id: "u-1", status: "pending",
      payment_status: "unpaid", payment_method: "Pay on delivery",
      subtotal: "8500.00", discount: "0.00", delivery_fee: "1500.00", total_amount: "10000.00",
      promo_code: null, delivery_name: "Ada", delivery_phone: "08030000001",
      delivery_email: "ada@b.co", delivery_address: "1 Test St", delivery_city: "Lagos",
      notes: "Call first", created_at: "2026-02-01T10:00:00Z",
      order_items: [{ product_name: "Crystal Clean", variant_label: "1L", quantity: 2, unit_price: "4250.00" }],
    });

    eq("the storefront contract is unchanged (id/date/total/items)", [order.id, order.total, order.items[0].price], ["UAGE-100001", 10000, 4250]);
    eq("  ...and admin fields are added", [order.customer, order.phone, order.userId], ["Ada", "08030000001", "u-1"]);
    eq("  ...with the fulfilment address", [order.address, order.city, order.notes], ["1 Test St", "Lagos", "Call first"]);
    eq("  ...and an item count that sums quantities", order.itemCount, 2);
    eq("  ...plus a per-line total", order.items[0].lineTotal, 8500);
  }
}

/* ================================================================= report */
console.log(
  `\n\u001b[1m${passed} passed, ${failures.length} failed\u001b[0m` +
    (failures.length ? `\n\n\u001b[31mFailures:\u001b[0m\n${failures.map((f) => `  • ${f}`).join("\n")}` : "")
);
process.exit(failures.length ? 1 : 0);
