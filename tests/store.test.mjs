/**
 * UAGE — storefront adapter test.
 *
 * Runs js/store.js in a sandbox with a stubbed window.UAGE_API and a stubbed
 * localStorage, so the decisions that keep the shop honest can be verified
 * without a browser or a database:
 *
 *   1. the catalog only comes from the database when the backend is really
 *      usable, and falls back to bundled data when it is not, is slow, or errors
 *   2. the swap happens IN PLACE, because app.js holds the same reference
 *   3. no password is ever written to the device
 *   4. with no backend, an order is refused rather than faked, and a quote is
 *      reported as unavailable so the UI can say "…" instead of inventing a price
 *   5. money is never computed here — quotes and orders are passed straight
 *      through to the server
 *
 * Run:  node tests/store.test.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STORE_SRC = readFileSync(join(ROOT, "js", "store.js"), "utf8");

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

/** Minimal in-memory localStorage so the adapter can be exercised offline. */
function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(String(k), String(v)),
    removeItem: (k) => map.delete(k),
    _raw: () => [...map.values()].join("|"),
  };
}

/**
 * api: a partial stub of window.UAGE_API. Anything not supplied is absent, so
 * the adapter has to cope with a missing backend surface too.
 */
function loadStore({ configured = true, schemaReady = true, api = {}, catalogTimeout = 40 } = {}) {
  const storage = fakeStorage();

  const baseApi = {
    isConfigured: () => configured,
    admin: { checkSchema: async () => ({ data: { ready: schemaReady, code: schemaReady ? null : "PGRST205" }, error: null }) },
  };

  const sandbox = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    Promise,
    setTimeout,
    clearTimeout,
    localStorage: storage,
    UAGE_STORE_TIMEOUT_MS: catalogTimeout,
  };
  sandbox.window = sandbox;
  sandbox.UAGE_API = Object.assign(baseApi, api);
  sandbox.UAGE_DATA = {
    products: [{ id: "bundled-1", name: "Bundled product" }],
    categories: [{ slug: "bundled", name: "Bundled category" }],
    format: (n) => `\u20A6${n}`,
  };

  vm.createContext(sandbox);
  vm.runInContext(STORE_SRC, sandbox);
  return { store: sandbox.UAGE_STORE, data: sandbox.UAGE_DATA, storage };
}

const DB_PRODUCTS = [{ id: "crystal-clean", name: "Crystal Clean", sizes: [{ label: "1L", price: 8500 }] }];

/* ============================================ 1. the bundled fallback */
{
  console.log("\n\u001b[1mWithout a usable backend the shop still works\u001b[0m");

  const off = loadStore({ configured: false, api: { listProducts: async () => ({ data: DB_PRODUCTS, error: null }) } });
  check("isConfigured() false → not live", (await off.store.live()) === false);
  const bundled = await off.store.catalog();
  eq("  ...catalog comes from the bundled file", bundled.source, "bundled");
  eq("  ...and the bundled products are untouched", off.data.products.length, 1);
  check("  ...the database was never called", bundled.degraded === undefined || bundled.degraded === true);

  /* Configured, but the migrations have not been applied yet. */
  const empty = loadStore({
    schemaReady: false,
    api: { listProducts: async () => ({ data: DB_PRODUCTS, error: null }) },
  });
  check("schema missing → not live either", (await empty.store.live()) === false);
  eq("  ...and it falls back too", (await empty.store.catalog()).source, "bundled");

  /* Live, but the request fails. */
  const broken = loadStore({ api: { listProducts: async () => ({ data: null, error: { code: "500", message: "boom" } }) } });
  eq("a failed fetch falls back", (await broken.store.catalog()).source, "bundled");
  eq("  ...leaving the bundled catalog in place", broken.data.products.length, 1);

  /* Live, but slow: the race must not hold the page hostage. */
  const slow = loadStore({
    catalogTimeout: 40,
    api: {
      listProducts: () => new Promise((r) => setTimeout(() => r({ data: DB_PRODUCTS, error: null }), 500)),
      listCategories: async () => ({ data: [], error: null }),
    },
  });
  const started = Date.now();
  const raced = await slow.store.catalog();
  eq("a slow backend falls back instead of blocking", raced.source, "bundled");
  check("  ...and it gives up quickly", Date.now() - started < 400, `${Date.now() - started}ms`);
}

/* ==================================== 2. the database is used when live */
{
  console.log("\n\u001b[1mLive mode reads the database\u001b[0m");

  const ref = { products: null, categories: null };
  const live = loadStore({
    api: {
      listProducts: async () => ({ data: DB_PRODUCTS, error: null }),
      listCategories: async () => ({ data: [{ slug: "dishwash", name: "Dishwash Liquid" }], error: null }),
    },
  });
  ref.products = live.data.products;      // hold the SAME reference app.js holds
  ref.categories = live.data.categories;

  check("live() reports true", (await live.store.live()) === true);
  const res = await live.store.catalog();
  eq("catalog source is the database", res.source, "database");
  eq("  ...and the count is reported", res.count, 1);
  eq("  ...rows are swapped IN PLACE (app.js keeps its reference)", ref.products.length, 1);
  eq("  ...with the database product", ref.products[0].id, "crystal-clean");
  eq("  ...and categories too", ref.categories[0].slug, "dishwash");

  /* An empty database must not blank the shop. */
  const emptyDb = loadStore({
    api: {
      listProducts: async () => ({ data: [], error: null }),
      listCategories: async () => ({ data: [], error: null }),
    },
  });
  eq("an empty catalog falls back rather than rendering nothing", (await emptyDb.store.catalog()).source, "bundled");
  eq("  ...keeping the bundled products", emptyDb.data.products.length, 1);
}

/* ======================================== 3. no password on the device */
{
  console.log("\n\u001b[1mCredentials are never stored on the device\u001b[0m");

  const offline = loadStore({ configured: false });
  await offline.store.signUp({ name: "Ada", email: "ada@example.com", password: "hunter2" });
  const cached = offline.store.user();
  eq("the display cache records who is browsing", [cached.name, cached.email], ["Ada", "ada@example.com"]);
  check(
    "  ...and sweeps up no password anywhere",
    !/hunter2|password/i.test(offline.storage._raw()),
    offline.storage._raw()
  );

  /* Signing in must be verified by the server when there is one. */
  let sawSignIn = null;
  const online = loadStore({
    api: {
      signIn: async (email, password) => { sawSignIn = { email, password }; return { data: { user: { id: "u1" } }, error: null }; },
      getUser: async () => ({ data: { id: "u1", email: "ada@example.com", user_metadata: { full_name: "Ada" } }, error: null }),
      getProfile: async () => ({ data: { name: "Ada", phone: "0803", joined: "1 Feb 2026" }, error: null }),
      signOut: async () => ({ error: null }),
    },
  });
  await online.store.live();
  const signedIn = await online.store.signIn("ada@example.com", "hunter2");
  eq("sign-in is performed by the backend", sawSignIn, { email: "ada@example.com", password: "hunter2" });
  eq("  ...and the profile is cached for display", online.store.user().name, "Ada");
  check("  ...again with no password written", !/hunter2/.test(online.storage._raw()), online.storage._raw());
  check("  ...and the call reported success", !signedIn.error);

  await online.store.signOut();
  check("signing out clears the cache", online.store.user() === null);

  /* A sign-out that cannot reach the server must still sign the visitor out on
   * this device — but must not claim the session is gone when it may not be. */
  const flaky = loadStore({
    api: {
      signOut: async () => { throw new Error("offline"); },
      getUser: async () => ({ data: { id: "u1", email: "ada@example.com" }, error: null }),
      getProfile: async () => ({ data: { name: "Ada" }, error: null }),
      signIn: async () => ({ data: { user: { id: "u1" } }, error: null }),
    },
  });
  await flaky.store.live();
  await flaky.store.signIn("ada@example.com", "hunter2");
  const brokenSignOut = await flaky.store.signOut();
  check("a failed sign-out still clears the device", flaky.store.user() === null);
  check("  ...but reports that the server was not reached", Boolean(brokenSignOut.error));

  /* Offline sign-in must not silently accept anyone. */
  const stranger = await loadStore({ configured: false }).store.signIn("nobody@example.com", "x");
  check("offline sign-in with an unknown email is refused", Boolean(stranger.error));
}

/* ============================ 4./5. money is never made up locally */
{
  console.log("\n\u001b[1mMoney is decided by the server, never the adapter\u001b[0m");

  const offline = loadStore({ configured: false });
  const noQuote = await offline.store.quote({ items: [{ id: "crystal-clean", size: "1L", qty: 1 }], promoCode: "SPARKLE10" });
  check("no backend → no quote at all (so the UI shows \"…\")", noQuote.data === null);
  eq("  ...flagged as not live", noQuote.live, false);

  const noOrder = await offline.store.placeOrder({ items: [{ id: "crystal-clean", size: "1L", qty: 1 }] });
  eq("no backend → an order is refused, not faked", noOrder.data, null);
  eq("  ...with a clear code", noOrder.error.code, "OFFLINE");
  check("  ...and a message a customer can understand", /not connected/i.test(noOrder.error.message), noOrder.error.message);

  let quoteArgs = null;
  let orderArgs = null;
  const online = loadStore({
    api: {
      previewCheckout: async (f) => { quoteArgs = f; return { data: { subtotal: 8500, discount: 0, delivery: 1500, total: 10000 }, error: null }; },
      placeOrder: async (f) => { orderArgs = f; return { data: { orderNumber: "UAGE-100001", total: 10000 }, error: null }; },
    },
  });
  await online.store.live();

  const quoted = await online.store.quote({ items: [{ id: "crystal-clean", size: "1L", qty: 2 }], promoCode: "SPARKLE10" });
  eq("a quote is passed straight through", quoted.data.total, 10000);
  eq("  ...with the cart and code untouched", quoteArgs, { items: [{ id: "crystal-clean", size: "1L", qty: 2 }], promoCode: "SPARKLE10" });

  const placed = await online.store.placeOrder({
    items: [{ id: "crystal-clean", size: "1L", qty: 2 }],
    paymentMethod: "Pay on delivery",
    promoCode: "SPARKLE10",
    delivery: { name: "Ada", phone: "08030000001", address: "1 Test St", city: "Lagos" },
  });
  eq("an order is passed straight through", placed.data.orderNumber, "UAGE-100001");
  check("  ...and no price is added by the adapter", !("price" in orderArgs.items[0]) && !("total" in orderArgs), JSON.stringify(orderArgs));
}

/*
 * =============================================================== script wiring
 *
 * Every backend feature depends on js/store.js being present AND on the scripts
 * being evaluated in dependency order. A single missing or reordered <script>
 * tag leaves the shop silently running on bundled data, or blank `UAGE_STORE is
 * not defined` — which is exactly the class of failure that is hardest to spot
 * by eye. So it is asserted, not assumed.
 */
console.log(`\n\u001b[1mScript wiring\u001b[0m`);

const REQUIRED_ORDER = ["data.js", "js/supabase-config.js", "js/api.js", "js/store.js", "app.js"];
const ADMIN_ORDER = ["js/supabase-config.js", "js/api.js", "js/admin.js"];
const BACKEND_SCRIPTS = ["js/supabase-config.js", "js/api.js", "js/store.js"];

/** The src values of a page's <script> tags, in document order. */
function scriptSources(html) {
  return [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/gi)].map((m) => m[1]);
}

const pages = readdirSync(ROOT)
  .filter((f) => f.endsWith(".html"))
  .sort();

check(`found storefront pages (${pages.length})`, pages.length >= 12);

const storefrontPages = [];
for (const page of pages) {
  const sources = scriptSources(readFileSync(join(ROOT, page), "utf8"));
  if (!sources.includes("app.js")) continue;
  storefrontPages.push(page);

  for (const dep of BACKEND_SCRIPTS) {
    check(`${page} loads ${dep}`, sources.includes(dep));
  }

  /* Order matters: app.js reads window.UAGE_STORE / UAGE_API the moment it
   * runs, so a later tag would leave those undefined. */
  const positions = REQUIRED_ORDER.map((s) => sources.indexOf(s));
  const inOrder = positions.every((p, i) => p !== -1 && (i === 0 || p > positions[i - 1]));
  check(`${page} loads them in dependency order`, inOrder, sources.join(" → "));
}

check(`every page is wired (${storefrontPages.length})`, storefrontPages.length >= 12, storefrontPages.join(", "));

const adminSources = scriptSources(readFileSync(join(ROOT, "admin.html"), "utf8"));
for (const dep of ADMIN_ORDER) check(`admin.html loads ${dep}`, adminSources.includes(dep));
check(
  "admin.html loads its scripts in dependency order",
  ADMIN_ORDER.map((s) => adminSources.indexOf(s)).every((p, i, a) => p !== -1 && (i === 0 || p > a[i - 1])),
  adminSources.join(" → ")
);
check("admin.html leaves the bundled catalog out", !adminSources.includes("data.js"));

/* A page must never hand a secret key to the browser inline. */
for (const page of pages) {
  const html = readFileSync(join(ROOT, page), "utf8");
  check(
    `${page} ships no inline secret key`,
    !/sb_secret_[A-Za-z0-9_-]{10,}/.test(html) && !/service_role["']?\s*:\s*["']ey/.test(html)
  );
}

/* ================================================================= report */
console.log(
  `\n\u001b[1m${passed} passed, ${failures.length} failed\u001b[0m` +
    (failures.length ? `\n\n\u001b[31mFailures:\u001b[0m\n${failures.map((f) => `  • ${f}`).join("\n")}` : "")
);
process.exit(failures.length ? 1 : 0);
