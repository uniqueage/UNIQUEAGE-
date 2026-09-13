/**
 * UAGE — LIVE backend test.
 *
 * Everything else in this repository is verified against an embedded Postgres.
 * That cannot prove anything about the project you actually deployed to: the
 * real `auth` schema, the real storage ownership rules and the real PostgREST
 * layer only exist on the hosted project. This suite talks to the deployed
 * project over its REST API using ONLY the publishable anon key — the exact key
 * every visitor already has in their browser — and asserts that it cannot reach
 * anything private.
 *
 * It needs no secret and no token. It is deliberately read-only, except for
 * writes that MUST fail: those are the security assertions, and a failed write
 * changes nothing.
 *
 * Run:  node tests/live.test.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = readFileSync(join(ROOT, "js", "supabase-config.js"), "utf8");
const URL_BASE = (config.match(/url:\s*"([^"]+)"/) || [])[1];
const ANON = (config.match(/anonKey:\s*"([^"]+)"/) || [])[1];

if (!URL_BASE || !ANON) {
  console.error("Could not read the public Supabase config from js/supabase-config.js");
  process.exit(1);
}

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

const section = (t) => console.log(`\n\u001b[1m${t}\u001b[0m`);

/** A REST call with the anon key — exactly what a visitor's browser sends. */
async function rest(path, init = {}) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${ANON}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, ok: res.ok, body };
}

const rpc = (fn, args) =>
  rest(`rpc/${fn}`, { method: "POST", body: JSON.stringify(args ?? {}) });

/* ------------------------------------------------------------- reachability */

section("Reachability");
const probe = await rest("products?select=slug");
check(`live project reachable (HTTP ${probe.status})`, probe.status < 500, JSON.stringify(probe.body).slice(0, 200));
check("anon key is accepted (not rejected as invalid)", probe.status !== 401, JSON.stringify(probe.body));

/* ---------------------------------------------------------------- catalogue */

section("Anonymous visitor — the public catalogue");
const products = await rest("products?select=slug,name&is_active=eq.true");
check(
  `public catalog readable (${Array.isArray(products.body) ? products.body.length : "?"} products)`,
  Array.isArray(products.body) && products.body.length === 22,
  JSON.stringify(products.body).slice(0, 200)
);
check(
  "every product carries a name (products and prices are aligned)",
  Array.isArray(products.body) && products.body.every((p) => typeof p.name === "string" && p.name.length > 0)
);

const variants = await rest("product_variants?select=label,price,product_id");
check(
  `size variants readable (${Array.isArray(variants.body) ? variants.body.length : "?"} sizes)`,
  Array.isArray(variants.body) && variants.body.length === 39
);
check(
  "every size has its own price (no null prices)",
  Array.isArray(variants.body) && variants.body.every((v) => v.price !== null && Number(v.price) > 0)
);

const categories = await rest("categories?select=slug");
check(
  `categories readable (${Array.isArray(categories.body) ? categories.body.length : "?"})`,
  Array.isArray(categories.body) && categories.body.length === 4
);

/* ------------------------------------------------------------ private data */

section("Anonymous visitor — private data must be unreachable");
for (const [table, label] of [
  ["profiles", "customer profiles"],
  ["user_roles", "roles"],
  ["orders", "orders"],
  ["order_items", "order items"],
  ["promo_codes", "promo codes"],
]) {
  const r = await rest(`${table}?select=*&limit=1`);
  const empty = Array.isArray(r.body) && r.body.length === 0;
  /* Either RLS returns nothing, or the table is not exposed at all. Both are
   * safe; returning a row is not. */
  check(`${label} leak nothing to anon`, empty || r.status >= 400, `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
}

section("Anonymous visitor — writes must be refused");
const ins = await rest("products", {
  method: "POST",
  body: JSON.stringify({ slug: "anon-should-not-exist", name: "x", category: "dishwash", price: 1 }),
});
check("cannot insert a product", ins.status >= 400, `HTTP ${ins.status}`);

const del = await rest("products?slug=eq.crystal-clean", { method: "DELETE" });
const deleted = Array.isArray(del.body) ? del.body.length : 0;
check("cannot delete a product", del.status >= 400 || deleted === 0, `HTTP ${del.status}, removed ${deleted}`);

const price = await rest("products?slug=eq.crystal-clean", {
  method: "PATCH",
  body: JSON.stringify({ price: 1 }),
});
const changed = Array.isArray(price.body) ? price.body.length : 0;
check("cannot change a price", price.status >= 400 || changed === 0, `HTTP ${price.status}, changed ${changed}`);

const role = await rest("user_roles", { method: "POST", body: JSON.stringify({ user_id: ANON.slice(0, 36), role: "admin" }) });
check("cannot grant itself admin", role.status >= 400, `HTTP ${role.status}`);

/* ------------------------------------------------------------ server-side */

section("Server-side functions");

/*
 * A refusal must be a REFUSAL, not a "function not found". PostgREST answers a
 * genuinely missing RPC with 404 + PGRST202, which would otherwise sail through
 * a naive `status >= 400` assertion — so every check below first proves the
 * function is reachable, then proves the caller was turned away.
 */
const notFound = (r) =>
  r.status === 404 || /PGRST202/.test(JSON.stringify(r.body || ""));
const firstRow = (r) => (Array.isArray(r.body) ? r.body[0] : r.body);

const isAdmin = await rpc("is_admin");
check("is_admin() is reachable and says false for anon", isAdmin.body === false, JSON.stringify(isAdmin.body));

/*
 * Resolve real ids from the PUBLIC catalog and send the same payload the
 * browser sends. js/api.js resolveCart() turns a cart line {id, size, qty} into
 * { variant_id, quantity } — so that is what is sent here, with p_ prefixed
 * argument names, because PostgREST matches RPC arguments by name.
 */
const productRes = await rest("products?select=id,slug,name&slug=eq.crystal-clean");
const product = Array.isArray(productRes.body) ? productRes.body[0] : null;
check("found a real product to price", Boolean(product && product.id), JSON.stringify(productRes.body).slice(0, 200));

const variantRes = await rest(
  `product_variants?select=id,label,price,stock_quantity&product_id=eq.${product.id}&label=eq.1L`
);
const variant = Array.isArray(variantRes.body) ? variantRes.body[0] : null;
check("found its 1L variant", Boolean(variant && variant.id), JSON.stringify(variantRes.body).slice(0, 200));

const QTY = 2;
const unitPrice = Number(variant.price);
const line = { variant_id: variant.id, quantity: QTY };

const quote = await rpc("checkout_preview", { p_items: [line] });
const q = firstRow(quote);
check("checkout_preview() is reachable", !notFound(quote) && quote.status === 200, JSON.stringify(quote.body).slice(0, 200));
check(
  `  ...pricing it from the database, not the client (₦${unitPrice} × ${QTY})`,
  Boolean(q && Number(q.subtotal) === unitPrice * QTY),
  `expected ${unitPrice * QTY}, got ${q && q.subtotal}`
);
check(
  "  ...with the total being the server's own arithmetic",
  Boolean(q && Number(q.total_amount) === Number(q.subtotal) + Number(q.delivery_fee) - Number(q.discount)),
  JSON.stringify(q).slice(0, 300)
);

/*
 * CONTRACT TEST. js/api.js reads these exact snake_case keys off the jsonb
 * result and maps them to the camelCase shape the UI renders. Renaming any of
 * them in SQL would silently blank the cart, so the contract is pinned here.
 * Keep in sync with previewCheckout() in js/api.js.
 */
const CONTRACT = [
  "subtotal", "discount", "delivery_fee", "total_amount",
  "standard_delivery_fee", "free_delivery_threshold",
  "promo_code", "promo_percent_off", "promo_valid", "promo_message",
  "items", "issues",
];
const missing = CONTRACT.filter((k) => !(q && Object.prototype.hasOwnProperty.call(q, k)));
check("checkout_preview() honours the jsonb contract js/api.js reads", missing.length === 0, `missing: ${missing.join(", ")}`);

const ITEM_CONTRACT = ["name", "label", "quantity", "unit_price", "line_total", "stock", "available", "reason"];
const item = q && Array.isArray(q.items) ? q.items[0] : null;
const missingItem = ITEM_CONTRACT.filter((k) => !(item && Object.prototype.hasOwnProperty.call(item, k)));
check("  ...including every per-line field", missingItem.length === 0, `missing: ${missingItem.join(", ")}`);
check(
  "  ...with unit_price straight from the database",
  Boolean(item && Number(item.unit_price) === unitPrice && Number(item.line_total) === unitPrice * QTY),
  JSON.stringify(item)
);

/* Free delivery over the threshold is a rule the shop advertises on every page. */
check(
  `  ...applying free delivery above ₦${q && q.free_delivery_threshold}`,
  Boolean(q && Number(q.subtotal) >= Number(q.free_delivery_threshold) && Number(q.delivery_fee) === 0),
  `subtotal ${q && q.subtotal}, threshold ${q && q.free_delivery_threshold}, fee ${q && q.delivery_fee}`
);

/* A browser that sends its own price must be ignored entirely. */
const spoofed = await rpc("checkout_preview", {
  p_items: [{ ...line, price: 1, unit_price: 1, line_total: 2, total: 2, total_amount: 2 }],
});
const sp = firstRow(spoofed);
check(
  "  ...and ignores a price injected by the client",
  Boolean(sp && Number(sp.total_amount) === Number(q.total_amount) && Number(sp.items[0].unit_price) === unitPrice),
  `sent price=1 → total ${sp && sp.total_amount}, expected ${q && q.total_amount}`
);

const promo = await rpc("checkout_preview", { p_items: [line], p_promo_code: "SPARKLE10" });
const pr = firstRow(promo);
check(
  "  ...and applies the seeded promo code server-side",
  Boolean(pr && pr.promo_valid === true && Number(pr.discount) > 0),
  JSON.stringify(pr).slice(0, 300)
);
check(
  "  ...discounting the basket below the price without the code",
  Boolean(pr && q && Number(pr.total_amount) < Number(q.total_amount)),
  `${pr && pr.total_amount} vs ${q && q.total_amount}`
);

const bogusPromo = await rpc("checkout_preview", { p_items: [line], p_promo_code: "NOT-A-REAL-CODE" });
const bp = firstRow(bogusPromo);
check(
  "  ...and rejects an invented promo code without discounting",
  Boolean(bp && bp.promo_valid === false && Number(bp.discount) === 0 && !bp.promo_code),
  JSON.stringify(bp).slice(0, 300)
);

/*
 * An item that has gone away is reported as unavailable rather than thrown —
 * the cart renders the reason next to the line instead of failing wholesale.
 */
const badQuote = await rpc("checkout_preview", {
  p_items: [{ variant_id: "00000000-0000-0000-0000-000000000000", quantity: 1 }],
});
const bq = firstRow(badQuote);
check("  ...reporting an unknown variant as unavailable", Boolean(bq && bq.items[0].available === false && bq.items[0].line_total === 0), JSON.stringify(bq).slice(0, 300));
check(
  "  ...and giving it zero total rather than inventing a price",
  Boolean(bq && Number(bq.total_amount) === 0),
  `total_amount ${bq && bq.total_amount}`
);

const tooMany = await rpc("checkout_preview", { p_items: [{ ...line, quantity: 0 }] });
check(
  "  ...and refuses an invalid quantity",
  !notFound(tooMany) && tooMany.status >= 400,
  `HTTP ${tooMany.status} ${JSON.stringify(tooMany.body).slice(0, 200)}`
);

const order = await rpc("place_order", {
  p_items: [line],
  p_delivery: { name: "Anon", phone: "08000000000", address: "nowhere", city: "Lagos" },
  p_payment_method: "Pay on delivery",
});
check("place_order() is reachable", !notFound(order), JSON.stringify(order.body).slice(0, 200));
check(
  "place_order() refuses an anonymous caller",
  order.status === 401 || order.status === 403 || /permission|not authenticated|sign in/i.test(JSON.stringify(order.body)),
  `HTTP ${order.status} ${JSON.stringify(order.body).slice(0, 200)}`
);

const admin = await rpc("admin_dashboard_stats");
check("admin_dashboard_stats() is reachable", !notFound(admin), JSON.stringify(admin.body).slice(0, 200));
check(
  "admin_dashboard_stats() refuses an anonymous caller",
  admin.status === 401 || admin.status === 403 || /permission|admin/i.test(JSON.stringify(admin.body)),
  `HTTP ${admin.status} ${JSON.stringify(admin.body).slice(0, 200)}`
);

/* ------------------------------------------------------------------ storage */

section("Storage");
const bucketRes = await fetch(`${URL_BASE}/storage/v1/bucket`, {
  headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
});
const bucketBody = await bucketRes.text();
check(
  "storage refuses bucket enumeration to anon",
  bucketRes.status >= 400 || bucketBody.trim() === "[]",
  `HTTP ${bucketRes.status} ${bucketBody.slice(0, 160)}`
);

/* The product-images bucket is public: an anon visitor must be able to READ an
 * image URL, which is the whole point of a public bucket. */
const publicBucket = await fetch(`${URL_BASE}/storage/v1/object/public/product-images/__uage_probe__`, {
  headers: { apikey: ANON },
});
check(
  "a public bucket is readable without a key (missing file → 400/404, not 403)",
  [400, 404].includes(publicBucket.status),
  `HTTP ${publicBucket.status}`
);

/* ------------------------------------------------------------------- report */

console.log(
  `\n\u001b[1m${passed} passed, ${failures.length} failed\u001b[0m` +
    (failures.length ? `\n\n\u001b[31mFailures:\u001b[0m\n${failures.map((f) => `  • ${f}`).join("\n")}` : "")
);
process.exit(failures.length ? 1 : 0);
