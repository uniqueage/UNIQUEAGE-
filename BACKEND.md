# UAGE — Backend

Supabase (Postgres + Auth + Storage) behind the existing static storefront.
The site keeps working with **no build step** and **no server of our own**:
the browser talks to Supabase with the publishable anon key, and *every*
security decision is enforced in the database by Row Level Security and
`SECURITY DEFINER` functions.

> **Status:** Stage 1 (database, RLS, storage, seed) is complete and tested —
> 80/80 assertions pass. Stage 2 (frontend wiring) is not applied yet.
> Nothing in the existing site has been modified.

---

## 1. Project structure

```
supabase/
├── migrations/
│   ├── 20260911090000_init_schema.sql     types, tables, constraints, indexes, triggers
│   ├── 20260911090100_rls_policies.sql    RLS for every table
│   ├── 20260911090200_functions.sql       place_order(), admin_set_user_role(), stats
│   ├── 20260911090300_storage.sql         buckets + storage policies
│   └── 20260911090400_seed_catalog.sql    4 categories, 22 products, 39 variants, SPARKLE10
└── tests/
    ├── supabase-stubs.sql                 auth/storage stand-ins for offline runs
    ├── rls.test.mjs                       80-assertion RLS + order-logic suite
    └── package.json                       `npm test`
env.example                                environment variable template
BACKEND.md                                 this file

tests/
└── api.test.mjs                          60-assertion data-layer suite

js/
├── supabase-config.js                     public URL + anon key only (publishable)
└── api.js                                 the ONLY module that talks to Supabase

admin.html + admin.css + js/admin.js       administrator dashboard
```

Migrations are **additive**. Nothing is dropped, and re-running is safe
(`if not exists` / `on conflict do update` / `drop policy if exists`).

---

## 2. Tables

| Table | Purpose | Key columns |
|---|---|---|
| `categories` | The 4 storefront categories | `slug` (PK), `name`, `icon`, `tag`, `blurb`, `features[]`, `sort_order` |
| `profiles` | 1:1 with `auth.users` | `id` (PK → `auth.users`), `full_name`, `phone`, `avatar_url`, `email`, timestamps |
| `user_roles` | Who is an administrator | `user_id` (PK → `auth.users`), `role`, `granted_at`, `granted_by` |
| `products` | Catalog items | `id` (PK), `slug` (UNIQUE), `name`, `description`, `category` (FK), `price`, `old_price`, `badge`, `rating`, `review_count`, `image_url`, `is_active`, `featured`, `stock_quantity` |
| `product_variants` | The sizes | `id` (PK), `product_id` (FK), `label`, `price`, `stock_quantity`, `sku`, `sort_order`, UNIQUE(`product_id`,`label`) |
| `promo_codes` | Server-owned discounts | `code` (PK), `percent_off`, `min_subtotal`, `max_uses`, `uses`, `is_active`, `expires_at` |
| `orders` | Order header | `id` (PK), `order_number` (UNIQUE), `user_id` (FK), `status`, `payment_status`, `payment_method`, `subtotal`, `discount`, `delivery_fee`, `total_amount`, `promo_code` (FK), delivery address fields, timestamps |
| `order_items` | Order lines | `id` (PK), `order_id` (FK), `product_id` (FK), `variant_id` (FK), `product_name`, `variant_label`, `quantity`, `unit_price`, `line_total` (generated) |

### Relationships

```
auth.users 1─1 profiles
auth.users 1─1 user_roles
auth.users 1─∞ orders 1─∞ order_items ∞─1 products 1─∞ product_variants
categories 1─∞ products
promo_codes 1─∞ orders
```

### Design decisions worth knowing

- **`product_variants`** is why prices are not duplicated. Dishwash and perfumes
  are priced *per size* (500ml ₦4,500 … 2L ₦15,500; 30ml … 100ml), so the size
  prices and per-size stock live in one normalised table instead of a JSON blob.
  A product must have a price **or** at least one variant — enforced by a
  deferred constraint trigger.
- **`order_items.product_name` / `variant_label`** are deliberate receipt
  snapshots. Renaming or deactivating a product must never rewrite what a
  customer already bought.
- **`orders_total_matches`** is a CHECK constraint: `total_amount` must always
  equal `subtotal − discount + delivery_fee`. Totals cannot drift.
- **`orders.payment_method`** accepts exactly the three values the checkout page
  already offers: `Pay on delivery`, `Bank transfer`, `Card`.
- **`profiles.email`** is a trigger-maintained copy of `auth.users.email`, so an
  administrator can list customers **without** the service-role key.
- **Money** is `numeric(12,2)` in NGN; **stock** and **quantities** are integers
  with `>= 0` / `1..999` guards.

---

## 3. Authentication

Supabase Auth (GoTrue) is the only authentication system — there is no
frontend-only fake login left in the design.

| Flow | Mechanism |
|---|---|
| Sign up | `supabase.auth.signUp({ email, password, options: { data: { full_name, phone } } })` |
| Login | `supabase.auth.signInWithPassword()` |
| Logout | `supabase.auth.signOut()` |
| Session persistence | `persistSession: true` — the client stores and refreshes the JWT itself |
| Password reset | `supabase.auth.resetPasswordForEmail()` then `updateUser({ password })` |
| Authenticated state | `supabase.auth.getSession()` + `onAuthStateChange()` |

On signup a trigger (`on_auth_user_created` → `handle_new_user()`) creates the
matching `profiles` row and a `user_roles` row defaulting to `customer`.
A user is **never** created as an administrator.

---

## 4. Authorization model

```
anon            → read active products, categories, variants; read storage files
authenticated   → the above, plus: own profile, own orders; write own avatar;
customer          place orders via place_order() ONLY
admin           → everything a customer can do, plus write products/variants/
                  categories/promos, move order status, manage product images
service_role    → migrations and bootstrapping only. NEVER in frontend code.
```

### How an administrator is identified

- Roles live in the `public.user_roles` table, **not** on the profile and **not**
  in the browser.
- `public.is_admin()` is a `STABLE SECURITY DEFINER` function that reads
  `user_roles` for `auth.uid()` and returns a boolean. `auth.uid()` comes from
  the signed JWT, so it cannot be forged from the client.
- The frontend never sends a role. Nothing anywhere reads `isAdmin` from
  request data or `localStorage`.
- **`user_roles` has no INSERT/UPDATE/DELETE policies at all** — not even for
  admins. A customer cannot promote themselves, and an admin cannot promote
  anyone through the REST API either. Promotion goes through the guarded
  `admin_set_user_role()` function (which refuses to demote the last admin).
- **The first administrator is bootstrapped in the Supabase SQL editor** after
  signing up — see the footer of `20260911090400_seed_catalog.sql`:

  ```sql
  update public.user_roles
     set role = 'admin', granted_at = now()
   where user_id = (select id from auth.users where email = 'owner@example.com');
  ```

---

## 5. RLS policies

RLS is enabled on every table, and every table has explicit policies. Enabling
RLS without policies is deliberately avoided.

| Table | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `profiles` | own row, or admin | own row | own row, or admin (cannot change `id`/`created_at`) | — |
| `user_roles` | own row, or admin | **none** | **none** | **none** |
| `categories` | anyone | admin | admin | admin |
| `products` | active, or all for admin | admin | admin | admin (blocked by FK if ordered) |
| `product_variants` | if parent product visible | admin | admin | admin |
| `promo_codes` | admin only | admin | admin | admin |
| `orders` | own rows, or admin | **none** (`revoke`d) | admin only | **none** (`revoke`d) |
| `order_items` | items of own orders, or admin | **none** (`revoke`d) | **none** (`revoke`d) | **none** (`revoke`d) |

**Why orders have no INSERT policy:** creating an order must go through
`place_order()`, which is the only code path that prices the basket from the
database. A hand-rolled `POST /orders` cannot forge a price or a total.

---

## 6. Order logic — `public.place_order(items, delivery, payment_method, promo_code)`

One atomic transaction, `SECURITY DEFINER`, `search_path` pinned, `EXECUTE`
granted to `authenticated` only:

1. Requires an authenticated caller (`auth.uid()`).
2. Validates the basket, quantity range, payment method and all delivery fields.
3. `SELECT … FOR UPDATE` on each product/variant — two shoppers cannot oversell
   the same stock.
4. Verifies each product exists, `is_active`, and has enough stock.
5. Prices every line **from the database**, applies the promo code and the
   delivery rule, and computes the total. **Any price sent by the browser is
   ignored.**
6. Inserts the order and its items, decrements stock, increments the promo counter.
7. Returns `{ order_id, order_number, status, subtotal, discount, delivery_fee, total_amount, item_count }`.

Any `RAISE EXCEPTION` rolls the entire transaction back, so a half-written order
is impossible.

Business rules currently live in the function as constants:

| Rule | Value |
|---|---|
| Delivery fee | ₦1,500 |
| Free delivery at or above | ₦10,000 |
| Promo | `SPARKLE10` = 10% off, `min_subtotal` 0, unlimited uses |
| Max quantity per line | 999 |
| Max distinct lines per order | 50 |

Changing a rule is a one-line migration, not a frontend deploy.

---

## 7. Storage

| Bucket | Public read | Write |
|---|---|---|
| `product-images` | yes | admins only (insert/update/delete) |
| `avatars` | yes | a user may only write inside `{their-uid}/…`; admins may write anywhere |

Limits: 5 MB / JPEG, PNG, WebP, AVIF for products; 2 MB / JPEG, PNG, WebP for
avatars. Images live in Storage — only the resulting public URL is stored in
`products.image_url` / `profiles.avatar_url`.

---

## 8. Data-access layer

```
js/supabase-config.js   public URL + anon key only — committed, publishable
js/api.js               the ONLY module that talks to Supabase
js/admin.js             the admin dashboard (uses UAGE_API, never Supabase directly)
```

`js/api.js` exposes `listCategories`, `listProducts`, `listAllProducts`,
`getProduct`, `signUp`, `signIn`, `signOut`, `getSession`, `getUser`,
`onAuthChange`, `sendPasswordReset`, `updatePassword`, `getProfile`,
`updateProfile`, `uploadAvatar`, `placeOrder`, `listMyOrders`, and `admin.*` —
each returning a normalised `{ data, error }` shape, so no UI code ever builds
a query itself.

It owns loading/error handling and translates Postgres error codes (`42501`,
`23505`, `PGRST116`, …) into user-facing messages. Technical detail (table
names, constraint names, RLS internals) is logged to the console and never
shown to the user. If the config is still placeholders, every call resolves to
a `NOT_CONFIGURED` error instead of throwing, so the `data.js` / `localStorage`
storefront keeps working untouched.

The `admin.*` surface is: `checkAccess`, `stats`, `createProduct`,
`updateProduct`, `setProductActive`, `deleteProduct`, `upsertVariant`,
`deleteVariant`, `uploadProductImage`, `listOrders`, `setOrderStatus`,
`setPaymentStatus`, `listCustomers`, `listRoles`, `setUserRole`,
`saveCategory`, `deleteCategory`, `listPromos`, `savePromo`, `setPromoActive`,
`deletePromo`.

Two implementation notes that matter:

- **`createProduct(product, variants)` performs a single nested insert**
  (`products` with an embedded `product_variants` array). PostgREST writes both
  tables in one transaction, which is required because a size-priced product
  has `price = NULL` and the deferred constraint `check_product_still_priced`
  is only satisfied once its variants exist. Two separate requests would fail
  at the first commit.
- **Product updates are ordered** (add/refresh sizes → write product + price →
  delete removed sizes) so that every individual request moves the row from one
  valid state to another.

Run the suite with `node tests/api.test.mjs` (60 assertions, no project needed).

---

## 9. Environment variables

See `env.example`. Copy it into place:

```bash
cp env.example .env.example && cp env.example .env
```

| Variable | Exposure | Purpose |
|---|---|---|
| `SUPABASE_URL` | public | Project URL |
| `SUPABASE_ANON_KEY` | public | RLS-protected client key — safe in the browser |
| `SUPABASE_SERVICE_ROLE_KEY` | **secret** | Bypasses RLS. Migrations/bootstrapping only. Never in `js/` |
| `SUPABASE_DB_URL` | **secret** | Direct Postgres connection for the CLI |
| `SUPABASE_PROJECT_REF` | secret-ish | CLI project reference |
| `UAGE_TEST_*` | secret | Test accounts for the RLS suite |

> **Note on a static site:** the browser cannot read `.env` at runtime, so the
> two *publishable* values are committed in `js/supabase-config.js`. That is
> safe by design — the anon key grants nothing without a matching RLS policy.
> The service-role key and DB URL stay in `.env` (gitignored) and never ship.

`.gitignore` already excludes `.env`, `.env.*`, `node_modules/`.

---

## 10. Applying the migrations

> **Status.** `js/supabase-config.js` is wired to the project
> `dfijuptbuhshmdsalbnm` with its **publishable anon key** (verified to decode
> as `role: "anon"`). The schema has **not** been applied yet — every table
> returns `PGRST205`. Until the migrations below run, the storefront keeps
> working from `data.js`/`localStorage` and `admin.html` shows a
> "Database setup needed" panel that links straight to the SQL editor.

**Option A — Supabase CLI (recommended, reproducible):**

```bash
npx supabase login
npx supabase link --project-ref "$SUPABASE_PROJECT_REF"
npx supabase db push          # applies everything in supabase/migrations, in order
```

**Option B — dashboard SQL editor:** paste each file from `supabase/migrations/`
in filename order and run it. They are written to be safe in that context too —
there are no bare `begin;`/`commit;` statements, so a file can be pasted whole.
Open the editor at
`https://supabase.com/dashboard/project/<project-ref>/sql/new`.

Then bootstrap your own administrator with the `update public.user_roles …`
statement from §4 (or press **Copy SQL** in the dashboard's Connection tab).

---

## 11. Testing

```bash
cd supabase/tests
npm install
npm test
```

The suite boots an embedded Postgres (PGlite) with `auth`/`storage` stubbed,
applies all five migrations, then asserts **80 invariants** covering:

- migrations apply cleanly; seed counts (4 / 22 / 39 / 1)
- signup triggers create a profile and a **customer** role (never admin)
- anonymous visitor: sees the catalog, sees no profiles/roles/orders/promos,
  cannot create a product, cannot place an order
- customer: reads and updates only their own profile; cannot touch another
  customer's profile; **cannot change their own role**; cannot change prices,
  stock or delete products; cannot insert an order directly
- `place_order`: totals computed from the database, browser prices ignored,
  stock decremented, unit price snapshotted, promo math, free-delivery
  threshold, and rejection of bad promos / bad payment method / insufficient
  stock / malformed ids / empty basket / invalid delivery details
- cross-customer isolation: B sees only their own order; A cannot see or cancel B's
- admin: sees all orders and profiles, can create/edit/deactivate products,
  move order status (illegal jumps blocked), read stats, promote users, and
  **cannot demote the last administrator**
- storage: own-avatar uploads allowed, cross-user and product-image uploads
  denied for customers, product-image uploads allowed for admins

Run it after any migration change — it is the regression net for the
authorization model.

There is a second, faster suite for the JavaScript data layer:

```bash
node tests/api.test.mjs          # 60 assertions, no project or install needed
```

It runs `js/api.js` against a stubbed Supabase client and covers the paths that
are expensive to get wrong: an unconfigured site degrading quietly, a
service-role key in public config being blocked, error translation that never
leaks table/RLS detail, cart resolution that sends **no prices**, the
admin-shaped order keeping every field the storefront already renders, and the
admin dashboard's data paths — `checkAccess()` failing closed, the single
nested product+variant insert, role changes going through
`admin_set_user_role()` (never a table write), `listRoles()` joining
`user_roles`, and promo-code normalisation.

---

## 12. Security review — this implementation

| Risk | Mitigation |
|---|---|
| Service-role key in frontend | Not needed by the site at all; RLS + `SECURITY DEFINER` cover admin work. Only `.env` (gitignored) holds it. |
| Missing RLS policies | RLS enabled on all 8 tables + both storage tables, each with explicit policies. |
| Overly permissive policies | No `using (true)` on private data. `user_roles`, `orders` INSERT and `order_items` writes have **no** permissive policy at all. |
| Insecure admin authorization | Role stored in the database; `is_admin()` reads it via `auth.uid()`; no client value trusted; `user_roles` is write-locked. |
| Trusting browser prices | `place_order()` ignores client prices entirely and re-reads every price. |
| Price/stock tampering by customers | Products/variants are admin-write-only; customer UPDATEs affect 0 rows (asserted in tests). |
| Cross-customer data access | Policies filter by `auth.uid()`; proven by the isolation tests. |
| Missing server-side validation | Constraints + `place_order()` validation on every field, including enum/status values. |
| Insecure file uploads | Per-bucket MIME allow-lists and size limits; avatars scoped to the owner's own folder. |
| Error detail leakage | Frontend will map error codes to friendly messages (Stage 2). |
| Privilege escalation to last-admin loss | `admin_set_user_role()` refuses to demote the final administrator. |

---

## 13. Admin dashboard (`admin.html`)

A single self-contained page that manages the store through the database. It
loads `styles.css` (design tokens) plus its own `admin.css`, and talks only to
`window.UAGE_API` — no direct Supabase client, and no privileged key anywhere.

### Sections

| Section | What it does | Backed by |
|---|---|---|
| **Dashboard** | Revenue, orders, customers, low-stock and unpaid roll-ups plus recent orders | `admin_dashboard_stats()` + reads |
| **Products** | Create / edit / hide / delete, size variants with their own price and stock, image upload to Storage, CSV export | `products`, `product_variants`, `product-images` bucket |
| **Inventory** | Units on hand, stock value, low/out-of-stock counts, inline stock adjustment | same tables |
| **Orders** | Search and filter, full order detail, legal status transitions, payment status | `orders`, `order_items`, `admin_set_payment_status()` |
| **Customers** | Accounts, order counts, lifetime spend, promote/demote administrator | `profiles`, `user_roles`, `admin_set_user_role()` |
| **Categories** | Create / edit / delete the shop categories | `categories` |
| **Promo codes** | Percentage discounts, minimum subtotal, use limits, expiry, pause/activate | `promo_codes` |
| **Connection** | Which project it is talking to, what is enforced where, and the SQL to bootstrap an administrator | — |

### How it decides you are an administrator

1. It asks Supabase Auth for the session. No session → an inline sign-in form.
2. It calls `admin.checkAccess()`, which invokes **`public.is_admin()` in the
database**. Roles are read from `public.user_roles`, never from the browser.
3. Only if the database says yes does it load any admin data.

Editing `js/admin.js`, flipping a local variable or calling the endpoints by
hand achieves nothing: every read and write is separately gated by RLS, and a
permission error fails closed (it is reported as *not an administrator*, never
as success).

### Guardrails visible in the UI

- **Prices are never trusted.** Product writes are admin-gated by RLS, and order
  totals are recomputed inside `place_order()`; the dashboard cannot edit an
  order's amounts at all.
- **Status follows the database.** Only the transitions the
  `check_order_status_transition` trigger permits are offered, and the trigger
  rejects anything else server-side.
- **The last administrator is protected.** `admin_set_user_role()` refuses to
  demote the final admin, and you cannot change your own role from the page.
- **Deletion is bounded.** Products that have ever been ordered can only be
  hidden (`ON DELETE RESTRICT`); categories still in use cannot be deleted.
- **A secret key in the browser is refused.** `js/api.js` hard-stops and logs
  loudly if a `service_role` / `sb_secret_` key appears in public config.

### Getting in

1. Create an account in the shop (`signup.html`).
2. Promote it once in the Supabase SQL editor — the dashboard's **Connection**
   tab shows the exact statement with your email already filled in, and copies it:

   ```sql
   update public.user_roles
      set role = 'admin', granted_at = now()
    where user_id = (select id from auth.users where email = 'you@example.com');
   ```

3. Reload `admin.html` and sign in. After that, use **Customers → Make admin**
   for everyone else.

A discreet **Staff dashboard** link is in the shared footer. The page is marked
`noindex, nofollow`, and its URL is not a secret — the database is the gate.

---

## 14. What is NOT done yet (Stage 2)

The database is ready and verified; the storefront still uses `data.js` and
`localStorage`. Remaining work, pending your Supabase project URL + anon key:

1. `js/supabase-config.js` + `js/api.js` (the data-access layer).
2. Replace the fake `localStorage` auth in `app.js` with Supabase Auth.
3. Load products/categories from the database, falling back to `data.js` if
   Supabase is unreachable, so the site never breaks.
4. Send checkout through `place_order()` instead of computing totals client-side.
5. Account page: real profile + real order history, avatar upload.
6. ~~Admin page~~ — **built** (`admin.html`, see §13); it comes alive as soon as
   the config is filled in.
7. Sign-in and account pages still use the `localStorage` demo path; they need
   pointing at Supabase Auth (`js/api.js` already supports it).
8. Send checkout through `place_order()` instead of computing totals client-side,
   so the cart/checkout flow uses the server-authoritative totals.
