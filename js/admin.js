/* ===========================================================================
 * UAGE — Admin dashboard
 * ---------------------------------------------------------------------------
 * Powers admin.html. Everything privileged goes through window.UAGE_API
 * (js/api.js); there is no direct Supabase access here, and no admin flag is
 * ever read from or written to the browser.
 *
 * Security model
 *   * "Am I an admin?" is answered by the DATABASE (public.is_admin() via the
 *     admin.checkAccess() RPC). A customer who edits this file, flips a
 *     variable or calls the API by hand still gets an RLS permission error.
 *   * Prices, stock and totals are never trusted from this page — product
 *     writes are admin-gated by RLS, and order totals are computed inside
 *     public.place_order() on the server.
 *   * Customer-visible errors are short and safe; technical detail only ever
 *     reaches the console (see js/api.js).
 * =========================================================================== */
(function () {
  "use strict";

  var API = window.UAGE_API;
  var PER_PAGE = 10;

  /* Statuses an order may legally move to next (mirrors the database trigger
   * public.check_order_status_transition — the database is the real gate). */
  var NEXT_STATUS = {
    pending: ["confirmed", "cancelled"],
    confirmed: ["processing", "cancelled"],
    processing: ["shipped", "cancelled"],
    shipped: ["delivered"],
    delivered: [],
    cancelled: []
  };

  var SECTIONS = {
    overview: {
      title: "Dashboard",
      icon: "fa-gauge-high",
      subtitle: function () {
        var first = firstName();
        return first ? "Welcome back, " + first + ". Here's how the store is doing." :
          "Here's how the store is doing today.";
      }
    },
    products: { title: "Products", icon: "fa-box-open", subtitle: function () { return "Create, edit, price and retire everything you sell."; } },
    inventory: { title: "Inventory", icon: "fa-warehouse", subtitle: function () { return "Stock levels across every product and size."; } },
    orders: { title: "Orders", icon: "fa-receipt", subtitle: function () { return "Track, confirm and fulfil customer orders."; } },
    customers: { title: "Customers", icon: "fa-users", subtitle: function () { return "Registered accounts, spend and access levels."; } },
    categories: { title: "Categories", icon: "fa-tags", subtitle: function () { return "How the catalog is grouped across the shop."; } },
    promos: { title: "Promo codes", icon: "fa-ticket", subtitle: function () { return "Discounts customers can enter at checkout."; } },
    connection: { title: "Connection", icon: "fa-plug", subtitle: function () { return "How this dashboard talks to your Supabase project."; } }
  };

  /* ------------------------------------------------------------------ state */

  var S = {
    section: "overview",
    user: null,
    profile: null,
    access: false,
    stats: null,
    products: [],
    categories: [],
    orders: [],
    customers: [],
    promos: [],
    roles: {},
    loadErrors: [],
    f: {
      productSearch: "", productCategory: "all", productStatus: "all", productPage: 1,
      inventoryOnly: "all",
      orderSearch: "", orderStatus: "all", orderPage: 1,
      customerSearch: ""
    }
  };

  var els = {};

  /* ---------------------------------------------------------------- helpers */

  function $(id) { return document.getElementById(id); }

  function esc(v) {
    return String(v === null || v === undefined ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function money(n) {
    return "\u20A6" + Number(n || 0).toLocaleString("en-NG", { maximumFractionDigits: 2 });
  }

  function num(v) {
    if (v === "" || v === null || v === undefined) return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  function initials(name) {
    if (!name) return "U";
    var parts = String(name).trim().split(/\s+/);
    return ((parts[0] || "U")[0] + (parts[1] ? parts[1][0] : "")).toUpperCase();
  }

  function firstName() {
    var n = (S.profile && S.profile.name) ||
      (S.user && S.user.user_metadata && S.user.user_metadata.full_name) || "";
    return n ? String(n).trim().split(/\s+/)[0] : "";
  }

  function shortDate(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" });
  }

  function dateTime(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleString("en-NG", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function slugify(text) {
    return String(text || "").toLowerCase().trim()
      .replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").slice(0, 60);
  }

  /** Every mutation funnels through here: toast on error, reload + re-render on success. */
  function finish(res, successMsg) {
    if (res && res.error) {
      toast(res.error.message || "That didn't work. Please try again.", true);
      return false;
    }
    if (successMsg) toast(successMsg, false);
    return true;
  }

  function toast(message, isError) {
    if (!els.toast) return;
    var icon = els.toast.querySelector("i");
    els.toast.querySelector("span").textContent = message;
    els.toast.classList.toggle("is-error", Boolean(isError));
    if (icon) icon.className = isError ? "fas fa-triangle-exclamation" : "fas fa-circle-check";
    els.toast.classList.add("show");
    clearTimeout(els.toast._t);
    els.toast._t = setTimeout(function () { els.toast.classList.remove("show"); }, 2600);
  }

  function busy(btn, isBusy) {
    if (!btn) return;
    if (isBusy) {
      btn.dataset.label = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i>Working…';
    } else {
      btn.disabled = false;
      if (btn.dataset.label) btn.innerHTML = btn.dataset.label;
    }
  }

  /* ------------------------------------------------------------------ modal */

  function openModal(opts) {
    els.modalTitle.textContent = opts.title || "";
    els.modalSubtitle.textContent = opts.subtitle || "";
    els.modalSubtitle.hidden = !opts.subtitle;
    els.modalBody.innerHTML = opts.body || "";
    els.modalFoot.innerHTML = opts.foot || "";
    els.modalCard.classList.toggle("is-wide", Boolean(opts.wide));
    els.modal.classList.add("open");
    document.body.style.overflow = "hidden";
    var firstInput = els.modalBody.querySelector("input, select, textarea");
    if (firstInput) setTimeout(function () { firstInput.focus(); }, 60);
  }

  function closeModal() {
    els.modal.classList.remove("open");
    els.modalBody.innerHTML = "";
    els.modalFoot.innerHTML = "";
    document.body.style.overflow = "";
  }

  /* -------------------------------------------------------------- csv export */

  function downloadCsv(filename, headers, rows) {
    function cell(v) {
      var s = v === null || v === undefined ? "" : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    var csv = [headers.map(cell).join(",")]
      .concat(rows.map(function (r) { return r.map(cell).join(","); }))
      .join("\n");
    var blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast("Exported " + filename, false);
  }

  /* ------------------------------------------------------------- derived data */

  function productStock(p) {
    if (p.sizes && p.sizes.length) {
      return p.sizes.reduce(function (sum, v) { return sum + Number(v.stock || 0); }, 0);
    }
    return Number(p.stock || 0);
  }

  function productPriceLabel(p) {
    if (p.sizes && p.sizes.length) {
      var prices = p.sizes.map(function (v) { return Number(v.price); });
      var min = Math.min.apply(null, prices);
      var max = Math.max.apply(null, prices);
      return min === max ? money(min) : money(min) + " – " + money(max);
    }
    if (p.price === null || p.price === undefined) return "—";
    return money(p.price);
  }

  function productValue(p) {
    if (p.sizes && p.sizes.length) {
      return p.sizes.reduce(function (sum, v) { return sum + Number(v.price) * Number(v.stock || 0); }, 0);
    }
    return Number(p.price || 0) * Number(p.stock || 0);
  }

  function stockTone(stock) {
    if (stock <= 0) return "is-danger";
    if (stock <= 5) return "is-danger";
    if (stock <= 20) return "is-warn";
    return "is-ok";
  }

  function stockBar(stock) {
    var pct = Math.max(3, Math.min(100, (Number(stock) / 40) * 100));
    return '<div class="adm-bar ' + stockTone(stock).replace("is-ok", "") + '"><span style="width:' + pct.toFixed(0) + '%"></span></div>';
  }

  function ordersForUser(uuid) {
    return S.orders.filter(function (o) { return o.userId === uuid; });
  }

  function spentForUser(uuid) {
    return ordersForUser(uuid).reduce(function (sum, o) {
      return sum + (o.status === "cancelled" ? 0 : o.total);
    }, 0);
  }

  function countBy(list, key) {
    var out = {};
    list.forEach(function (item) { out[item[key]] = (out[item[key]] || 0) + 1; });
    return out;
  }

  /* ============================================================ AUTH GATES */

  function viewShell(inner) {
    els.view.innerHTML = '<div class="adm-panel"><div class="adm-state">' + inner + "</div></div>";
  }

  function renderNotConfigured() {
    els.title.textContent = "Setup needed";
    els.subtitle.textContent = "Connect the storefront to your Supabase project.";
    viewShell(
      '<i class="fas fa-plug-circle-xmark"></i>' +
      "<h3>This store isn't connected to Supabase yet</h3>" +
      "<p>The dashboard reads and writes your database, so it needs your project's URL and publishable " +
      "(anon) key first. Open <code>js/supabase-config.js</code> and replace the two placeholder values — " +
      "both are safe to commit, because Row Level Security protects the data, not the key.</p>" +
      '<div class="adm-alert is-info" style="text-align:left;margin-top:.6rem">' +
        '<i class="fas fa-circle-info"></i><div>The <strong>service-role / secret</strong> key must never go in that file — ' +
        "it bypasses every security policy. This page refuses to start if it detects one there.</div>" +
      "</div>" +
      '<a class="adm-btn adm-btn-primary" href="index.html"><i class="fas fa-store"></i>Back to the store</a>'
    );
  }

  /**
   * Runs `fn` only once the database schema is actually installed.
   *
   * Without this, a project that has not had the migrations applied looks
   * exactly like "you are not an administrator": every admin call fails closed,
   * which is correct but badly misleading while you are still setting up. The
   * probe reads one public table, so it needs no privileges.
   */
  function requireSchema(fn) {
    API.admin.checkSchema().then(function (probe) {
      if (probe.data && probe.data.ready) { fn(); return; }
      renderSchemaMissing();
    });
  }

  function renderSchemaMissing() {
    var cfg = window.UAGE_SUPABASE_CONFIG || {};
    var ref = (String(cfg.url || "").match(/^https:\/\/([a-z0-9-]+)\.supabase\./) || [])[1] || "";
    var editor = ref
      ? "https://supabase.com/dashboard/project/" + ref + "/sql/new"
      : "https://supabase.com/dashboard";

    var files = [
      ["20260911090000_init_schema.sql", "types, tables, constraints, indexes, triggers"],
      ["20260911090100_rls_policies.sql", "Row Level Security for every table"],
      ["20260911090200_functions.sql", "place_order(), admin_set_user_role(), dashboard stats"],
      ["20260911090300_storage.sql", "image buckets + storage policies"],
      ["20260911090400_seed_catalog.sql", "4 categories, 22 products, their sizes, SPARKLE10"]
    ];

    els.title.textContent = "Database setup needed";
    els.subtitle.textContent = "The project is connected, but its tables don't exist yet.";

    viewShell(
      '<i class="fas fa-database"></i>' +
      "<h3>Connected to Supabase \u2014 but the database is still empty</h3>" +
      "<p>Your project is reachable and the key is valid, so this is the last step: apply the five " +
        "migrations below, in order. They create every table, the security policies and your full " +
        "catalog. Nothing is ever dropped, and re-running them is safe.</p>" +
      '<ol style="text-align:left;max-width:54ch;font-size:.86rem;line-height:1.7;margin:.8rem auto 0">' +
        files.map(function (f) {
          return "<li><code>supabase/migrations/" + f[0] + "</code><br>" +
            '<span class="adm-small adm-muted">' + f[1] + "</span></li>";
        }).join("") +
      "</ol>" +
      '<div style="display:flex;gap:.5rem;flex-wrap:wrap;justify-content:center;margin-top:1.2rem">' +
        '<a class="adm-btn adm-btn-primary" href="' + esc(editor) + '" target="_blank" rel="noopener">' +
          '<i class="fas fa-arrow-up-right-from-square"></i>Open the SQL editor</a>' +
        '<button class="adm-btn" type="button" id="admSchemaRecheck"><i class="fas fa-rotate"></i>I\'ve applied them \u2014 recheck</button>' +
      "</div>" +
      '<p class="adm-hint" style="margin-top:1rem">Prefer the command line? Copy <code>env.example</code> to ' +
        "<code>.env</code>, fill in <code>SUPABASE_DB_URL</code>, then run <code>supabase db push</code>.</p>"
    );

    $("admSchemaRecheck").addEventListener("click", function () { boot(); });
  }

  function renderSignIn() {
    /* Ask for a password only once there is a database to sign in to. */
    requireSchema(renderSignInForm);
  }

  function renderSignInForm() {
    els.title.textContent = "Sign in";
    els.subtitle.textContent = "Administrator access is required.";
    els.view.innerHTML =
      '<div class="adm-panel" style="max-width:460px;margin-inline:auto;width:100%">' +
        '<div class="adm-panel-head"><h3><i class="fas fa-shield-halved"></i>Administrator sign in</h3></div>' +
        '<div class="adm-panel-body">' +
          '<form id="admLoginForm" novalidate>' +
            '<div class="adm-form-grid" style="grid-template-columns:1fr">' +
              '<div class="adm-field"><label class="adm-label" for="admEmail">Email</label>' +
                '<input class="adm-input" id="admEmail" type="email" autocomplete="email" placeholder="you@example.com" />' +
                '<div class="adm-hint" id="admLoginHint"></div></div>' +
              '<div class="adm-field"><label class="adm-label" for="admPassword">Password</label>' +
                '<input class="adm-input" id="admPassword" type="password" autocomplete="current-password" placeholder="Your password" />' +
                '<div class="adm-hint"></div></div>' +
            "</div>" +
            '<button class="adm-btn adm-btn-primary adm-btn-block" id="admLoginBtn" type="submit" style="margin-top:1rem">' +
              '<i class="fas fa-right-to-bracket"></i>Sign in</button>' +
          "</form>" +
          '<p class="adm-hint" style="margin-top:.8rem">Need an account? ' +
            '<a href="signup.html">Create one</a> — new accounts start as customers and must be promoted by an existing administrator.</p>' +
        "</div>" +
      "</div>";

    var form = $("admLoginForm");
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var btn = $("admLoginBtn");
      var email = $("admEmail").value.trim();
      var pass = $("admPassword").value;
      var hint = $("admLoginHint");
      hint.textContent = "";
      hint.classList.remove("is-error");

      if (!email || !pass) {
        hint.textContent = "Enter your email and password.";
        hint.classList.add("is-error");
        return;
      }

      busy(btn, true);
      API.signIn(email, pass).then(function (r) {
        busy(btn, false);
        if (r.error) {
          hint.textContent = r.error.message;
          hint.classList.add("is-error");
          return;
        }
        toast("Signed in.");
        boot();
      });
    });
  }

  function renderNoAccess() {
    requireSchema(renderNoAccessPanel);
  }

  function renderNoAccessPanel() {
    els.title.textContent = "Not authorised";
    els.subtitle.textContent = "This account is not an administrator.";
    var email = (S.user && S.user.email) || "";
    viewShell(
      '<i class="fas fa-lock"></i>' +
      "<h3>You're signed in, but you're not an administrator</h3>" +
      "<p>Signed in as <strong>" + esc(email) + "</strong>. Roles live in the database " +
      "(<code>public.user_roles</code>), so they can't be granted from the browser — an existing " +
      "administrator has to promote this account.</p>" +
      '<div class="adm-alert is-warn" style="text-align:left;margin-top:.6rem">' +
        '<i class="fas fa-triangle-exclamation"></i><div>If this is your store, run this once in the ' +
        "Supabase SQL editor (Dashboard → SQL editor), then reload:</div></div>" +
      '<pre style="text-align:left;overflow:auto;background:rgba(6,42,63,.06);padding:.8rem;border-radius:12px;font-size:.76rem;max-width:100%">' +
        esc("update public.user_roles\n   set role = 'admin', granted_at = now()\n where user_id = (select id from auth.users where email = '" + email + "');") +
      "</pre>" +
      '<div style="display:flex;gap:.5rem;flex-wrap:wrap;justify-content:center">' +
        '<button class="adm-btn" id="admNoAccessRefresh" type="button"><i class="fas fa-rotate"></i>I\'ve done that — reload</button>' +
        '<button class="adm-btn adm-btn-danger" id="admNoAccessOut" type="button"><i class="fas fa-right-from-bracket"></i>Sign out</button>' +
      "</div>"
    );
    $("admNoAccessRefresh").addEventListener("click", function () { boot(); });
    $("admNoAccessOut").addEventListener("click", signOut);
  }

  function signOut() {
    API.signOut().then(function () {
      toast("Signed out.");
      S.user = null; S.profile = null; S.access = false;
      els.user.hidden = true;
      els.signOut.hidden = true;
      boot();
    });
  }

  function showUserChrome() {
    var name = (S.profile && S.profile.name) ||
      (S.user && S.user.user_metadata && S.user.user_metadata.full_name) || "Administrator";
    var email = (S.user && S.user.email) || "";
    els.user.hidden = false;
    els.signOut.hidden = false;
    els.avatar.textContent = initials(name);
    els.userName.textContent = name;
    els.userEmail.textContent = email;
  }

  /* ============================================================ DATA LOADING */

  function loadData() {
    els.view.innerHTML = '<div class="adm-panel"><div class="adm-skeleton"><span></span><span></span><span></span></div></div>';
    return Promise.all([
      API.listAllProducts(),
      API.listCategories(),
      API.admin.listOrders(),
      API.admin.listCustomers(),
      API.admin.listPromos(),
      API.admin.stats(),
      API.admin.listRoles()
    ]).then(function (res) {
      S.loadErrors = [];
      if (res[0].error) S.loadErrors.push("products: " + res[0].error.message); else S.products = res[0].data || [];
      if (res[1].error) S.loadErrors.push("categories: " + res[1].error.message); else S.categories = res[1].data || [];
      if (res[2].error) S.loadErrors.push("orders: " + res[2].error.message); else S.orders = res[2].data || [];
      if (res[3].error) S.loadErrors.push("customers: " + res[3].error.message); else S.customers = res[3].data || [];
      if (res[4].error) S.loadErrors.push("promos: " + res[4].error.message); else S.promos = res[4].data || [];
      if (res[5].error) S.loadErrors.push("stats: " + res[5].error.message); else S.stats = res[5].data || null;
      if (res[6].error) S.loadErrors.push("roles: " + res[6].error.message); else S.roles = res[6].data || {};

      /* Role lives in public.user_roles, not on the profile, so it is merged in
       * here rather than being (incorrectly) assumed to be a profile column. */
      S.customers.forEach(function (c) { c.role = S.roles[c.uuid] || "customer"; });

      updateNavCounts();
      if (S.loadErrors.length) {
        console.warn("[UAGE_ADMIN] some data failed to load", S.loadErrors);
        toast(S.loadErrors[0], true);
      }
    });
  }

  function updateNavCounts() {
    $("navCountProducts").textContent = S.products.length;
    $("navCountOrders").textContent = S.orders.length;
    $("navCountCustomers").textContent = S.customers.length;
    var low = lowStockItems().length;
    $("navCountLow").textContent = low;
  }

  function lowStockItems() {
    var items = [];
    S.products.forEach(function (p) {
      /* Hidden products are not sellable, so they are not stock alerts. */
      if (p.active === false) return;
      if (p.sizes && p.sizes.length) {
        p.sizes.forEach(function (v) {
          if (Number(v.stock || 0) <= 5) {
            items.push({ kind: "variant", product: p, label: v.label, stock: Number(v.stock || 0), price: Number(v.price), uuid: v.uuid });
          }
        });
      } else if (Number(p.stock || 0) <= 5) {
        items.push({ kind: "product", product: p, label: "", stock: Number(p.stock || 0), price: Number(p.price || 0), uuid: p.uuid });
      }
    });
    return items.sort(function (a, b) { return a.stock - b.stock; });
  }

  /* ================================================================= ROUTER */

  function currentSection() {
    var hash = (window.location.hash || "").replace("#", "");
    return SECTIONS[hash] ? hash : "overview";
  }

  function route() {
    S.section = currentSection();
    var meta = SECTIONS[S.section];
    els.title.textContent = meta.title;
    els.subtitle.textContent = meta.subtitle();

    Array.prototype.forEach.call(document.querySelectorAll(".adm-nav-link"), function (a) {
      a.classList.toggle("active", a.dataset.section === S.section);
    });

    closeDrawer();
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function render() {
    switch (S.section) {
      case "products": return renderProducts();
      case "inventory": return renderInventory();
      case "orders": return renderOrders();
      case "customers": return renderCustomers();
      case "categories": return renderCategories();
      case "promos": return renderPromos();
      case "connection": return renderConnection();
      default: return renderOverview();
    }
  }

  /* =============================================================== OVERVIEW */

  function statCard(opts) {
    return '<div class="adm-card">' +
      '<div class="adm-card-top">' +
        '<span class="adm-card-icon ' + (opts.tone || "") + '"><i class="fas ' + opts.icon + '"></i></span>' +
        '<span class="adm-card-label">' + esc(opts.label) + "</span>" +
      "</div>" +
      '<div class="adm-card-value">' + opts.value + "</div>" +
      (opts.foot ? '<div class="adm-card-foot">' + opts.foot + "</div>" : "") +
    "</div>";
  }

  function renderOverview() {
    var st = S.stats || {};
    var recent = S.orders.slice(0, 5);
    var low = lowStockItems().slice(0, 6);
    var activeCount = S.products.filter(function (p) { return p.active !== false; }).length;

    var html =
      '<section class="adm-hero">' +
        "<div>" +
          "<h2>Welcome back" + (firstName() ? ", <em>" + esc(firstName()) + "</em>" : "") + ".</h2>" +
          "<p>" + esc(shortDate(new Date().toISOString())) + " · " +
            esc(S.products.length + " products") + " · " + esc(S.orders.length + " orders") +
            " · " + esc(S.customers.length + " customers") + "</p>" +
        "</div>" +
        '<div class="adm-hero-actions">' +
          '<button class="adm-btn adm-btn-primary" type="button" data-action="product-new"><i class="fas fa-plus"></i>Add product</button>' +
          '<button class="adm-btn" type="button" data-action="goto" data-id="orders"><i class="fas fa-receipt"></i>View orders</button>' +
        "</div>" +
      "</section>" +

      '<section class="adm-cards">' +
        statCard({ label: "Revenue", icon: "fa-naira-sign", tone: "is-deep", value: money(st.revenue || 0), foot: "All non-cancelled orders" }) +
        statCard({ label: "Orders", icon: "fa-receipt", value: st.orders || 0, foot: (st.pending || 0) + " waiting to be confirmed" }) +
        statCard({ label: "Customers", icon: "fa-users", tone: "is-deep", value: st.customers || 0, foot: "Registered accounts" }) +
        statCard({ label: "Active products", icon: "fa-box-open", value: activeCount, foot: (S.products.length - activeCount) + " hidden" }) +
        statCard({ label: "Low stock", icon: "fa-triangle-exclamation", tone: (st.low_stock ? "is-citrus" : ""), value: st.low_stock || 0, foot: "5 units or fewer" }) +
        statCard({ label: "Payment due", icon: "fa-wallet", tone: "is-citrus", value: S.orders.filter(function (o) { return o.paymentStatus === "unpaid" && o.status !== "cancelled"; }).length, foot: "Orders marked unpaid" }) +
      "</section>" +

      '<div class="adm-split">' +
        '<div class="adm-panel">' +
          '<div class="adm-panel-head"><h3><i class="fas fa-clock-rotate-left"></i>Recent orders</h3>' +
            '<button class="adm-btn adm-btn-sm adm-btn-ghost" type="button" data-action="goto" data-id="orders">See all</button></div>' +
          (recent.length ? '<div class="adm-table-wrap"><table class="adm-table"><thead><tr>' +
            "<th>Order</th><th>Customer</th><th class=\"adm-right\">Total</th><th>Status</th>" +
            "</tr></thead><tbody>" +
            recent.map(function (o) {
              return "<tr><td><strong>" + esc(o.id) + "</strong><br><span class=\"adm-small adm-muted\">" + esc(o.date) + "</span></td>" +
                "<td>" + esc(o.customer || "—") + "<br><span class=\"adm-small adm-muted\">" + esc(o.phone || "") + "</span></td>" +
                '<td class="adm-right adm-money">' + money(o.total) + "</td>" +
                "<td>" + statusBadge(o.status) + "</td></tr>";
            }).join("") + "</tbody></table></div>"
            : '<div class="adm-state" style="padding:1.6rem"><i class="fas fa-receipt"></i><p>No orders yet. New orders will appear here.</p></div>') +
        "</div>" +

        '<div class="adm-panel">' +
          '<div class="adm-panel-head"><h3><i class="fas fa-triangle-exclamation"></i>Low stock alerts</h3>' +
            '<button class="adm-btn adm-btn-sm adm-btn-ghost" type="button" data-action="goto" data-id="inventory">Manage</button></div>' +
          (low.length ? '<div class="adm-panel-body" style="display:flex;flex-direction:column;gap:.55rem">' +
            low.map(function (i) {
              return '<div class="adm-line"><img class="adm-thumb" style="width:38px;height:38px" src="' + esc(i.product.image) + '" alt="" />' +
                '<div class="adm-grow"><strong>' + esc(i.product.name) + (i.label ? " · " + esc(i.label) : "") + "</strong>" +
                '<span class="adm-small adm-muted">' + esc(i.product.category) + "</span></div>" +
                '<span class="adm-badge ' + (i.stock <= 0 ? "is-danger" : "is-warn") + '">' + (i.stock <= 0 ? "Out of stock" : i.stock + " left") + "</span></div>";
            }).join("") + "</div>"
            : '<div class="adm-state" style="padding:1.6rem"><i class="fas fa-circle-check"></i><p>Every item has healthy stock levels.</p></div>') +
        "</div>" +
      "</div>";

    els.view.innerHTML = html;
  }

  function statusBadge(status) {
    var tone = {
      pending: "is-warn", confirmed: "is-info", processing: "is-info",
      shipped: "is-info", delivered: "is-ok", cancelled: "is-danger"
    }[status] || "is-muted";
    return '<span class="adm-badge ' + tone + '">' + esc(status) + "</span>";
  }

  function paymentBadge(status) {
    var tone = { paid: "is-ok", unpaid: "is-warn", refunded: "is-muted" }[status] || "is-muted";
    return '<span class="adm-badge ' + tone + '">' + esc(status) + "</span>";
  }

  /* =============================================================== PRODUCTS */

  function filteredProducts() {
    var q = S.f.productSearch.toLowerCase();
    return S.products.filter(function (p) {
      if (S.f.productCategory !== "all" && p.category !== S.f.productCategory) return false;
      if (S.f.productStatus === "active" && p.active === false) return false;
      if (S.f.productStatus === "hidden" && p.active !== false) return false;
      if (!q) return true;
      return (p.name + " " + p.id + " " + p.category + " " + (p.desc || "")).toLowerCase().indexOf(q) !== -1;
    });
  }

  function renderProducts() {
    var list = filteredProducts();
    var pages = Math.max(1, Math.ceil(list.length / PER_PAGE));
    if (S.f.productPage > pages) S.f.productPage = pages;
    var start = (S.f.productPage - 1) * PER_PAGE;
    var pageItems = list.slice(start, start + PER_PAGE);

    var catOptions = '<option value="all">All categories</option>' + S.categories.map(function (c) {
      return '<option value="' + esc(c.slug) + '"' + (S.f.productCategory === c.slug ? " selected" : "") + ">" + esc(c.name) + "</option>";
    }).join("");

    els.view.innerHTML =
      '<div class="adm-panel">' +
        '<div class="adm-panel-head">' +
          '<h3><i class="fas fa-box-open"></i>All products <span class="adm-badge is-muted">' + S.products.length + "</span></h3>" +
          '<div class="adm-toolbar">' +
            '<select class="adm-select" data-filter="productCategory">' + catOptions + "</select>" +
            '<select class="adm-select" data-filter="productStatus">' +
              '<option value="all"' + (S.f.productStatus === "all" ? " selected" : "") + ">All statuses</option>" +
              '<option value="active"' + (S.f.productStatus === "active" ? " selected" : "") + ">Live only</option>" +
              '<option value="hidden"' + (S.f.productStatus === "hidden" ? " selected" : "") + ">Hidden only</option>" +
            "</select>" +
            '<button class="adm-btn adm-btn-sm" type="button" data-action="export-products"><i class="fas fa-file-csv"></i>Export</button>' +
            '<button class="adm-btn adm-btn-sm adm-btn-primary" type="button" data-action="product-new"><i class="fas fa-plus"></i>New product</button>' +
          "</div>" +
        "</div>" +
        '<div class="adm-panel-head" style="border-top:0">' +
          '<div class="adm-search adm-grow"><i class="fas fa-magnifying-glass"></i>' +
            '<input type="search" data-filter="productSearch" value="' + esc(S.f.productSearch) + '" placeholder="Search by name, slug or category…" /></div>' +
        "</div>" +
        (pageItems.length ? productTable(pageItems) : emptyBlock("fa-box-open", "No products match", "Try a different search or filter, or add a new product.")) +
        (list.length > PER_PAGE ? pager(S.f.productPage, pages, list.length, start, "productPage") : "") +
      "</div>";
  }

  function productTable(items) {
    return '<div class="adm-table-wrap"><table class="adm-table"><thead><tr>' +
      "<th>Product</th><th>Category</th><th>Price</th><th>Stock</th><th>Status</th><th class=\"adm-right\">Actions</th>" +
      "</tr></thead><tbody>" +
      items.map(function (p) {
        var stock = productStock(p);
        var sizeCount = (p.sizes || []).length;
        return "<tr>" +
          '<td><div class="adm-cell-main">' +
            '<img class="adm-thumb" src="' + esc(p.image) + '" alt="" loading="lazy" onerror="this.style.opacity=.25" />' +
            '<div class="adm-cell-text"><strong>' + esc(p.name) + "</strong>" +
              "<span>" + esc(p.id) + (p.featured ? " · featured" : "") + "</span></div>" +
          "</div></td>" +
          "<td>" + esc(categoryName(p.category)) + "</td>" +
          '<td><span class="adm-money">' + esc(productPriceLabel(p)) + "</span>" +
            (sizeCount ? ' <span class="adm-chip">' + sizeCount + " sizes</span>" : "") +
            (p.oldPrice ? '<br><span class="adm-small adm-muted" style="text-decoration:line-through">' + money(p.oldPrice) + "</span>" : "") +
          "</td>" +
          '<td><span class="adm-badge ' + (stock <= 0 ? "is-danger" : stock <= 5 ? "is-warn" : "is-ok") + '">' + stock + " in stock</span>" + stockBar(stock) + "</td>" +
          "<td>" + (p.active === false ? '<span class="adm-badge is-muted">Hidden</span>' : '<span class="adm-badge is-ok">Live</span>') + "</td>" +
          '<td><div class="adm-row-actions">' +
            '<button class="adm-btn adm-btn-sm" type="button" data-action="product-edit" data-id="' + esc(p.uuid) + '"><i class="fas fa-pen"></i>Edit</button>' +
            '<button class="adm-btn adm-btn-sm" type="button" data-action="product-toggle" data-id="' + esc(p.uuid) + '" data-active="' + (p.active === false ? "false" : "true") + '">' +
              '<i class="fas ' + (p.active === false ? "fa-eye" : "fa-eye-slash") + '"></i>' + (p.active === false ? "Show" : "Hide") + "</button>" +
            '<button class="adm-btn adm-btn-sm adm-btn-danger" type="button" data-action="product-delete" data-id="' + esc(p.uuid) + '"><i class="fas fa-trash"></i></button>' +
          "</div></td>" +
        "</tr>";
      }).join("") + "</tbody></table></div>";
  }

  function categoryName(slug) {
    for (var i = 0; i < S.categories.length; i++) {
      if (S.categories[i].slug === slug) return S.categories[i].name;
    }
    return slug;
  }

  function emptyBlock(icon, title, text) {
    return '<div class="adm-state"><i class="fas ' + icon + '"></i><h3>' + esc(title) + "</h3><p>" + esc(text) + "</p></div>";
  }

  function pager(page, pages, total, start, filterKey) {
    var from = total ? start + 1 : 0;
    var to = Math.min(start + PER_PAGE, total);
    return '<div class="adm-pager">' +
      "<span>Showing " + from + "–" + to + " of " + total + "</span>" +
      '<div class="adm-pager-btns">' +
        '<button class="adm-btn adm-btn-sm" type="button" data-page="' + (page - 1) + '" data-pagekey="' + filterKey + '"' + (page <= 1 ? " disabled" : "") + '><i class="fas fa-chevron-left"></i>Prev</button>' +
        '<span class="adm-btn adm-btn-sm" style="pointer-events:none">' + page + " / " + pages + "</span>" +
        '<button class="adm-btn adm-btn-sm" type="button" data-page="' + (page + 1) + '" data-pagekey="' + filterKey + '"' + (page >= pages ? " disabled" : "") + '>Next<i class="fas fa-chevron-right"></i></button>' +
      "</div></div>";
  }

  /* ---------------------------------------------------------- product modal */

  function openProductModal(uuid) {
    var p = null;
    if (uuid) {
      p = S.products.filter(function (x) { return x.uuid === uuid; })[0] || null;
      if (!p) { toast("That product could not be found.", true); return; }
    }
    var isEdit = Boolean(p);
    var sizes = (p && p.sizes) ? p.sizes : [];

    var catOptions = S.categories.map(function (c) {
      return '<option value="' + esc(c.slug) + '"' + (p && p.category === c.slug ? " selected" : "") + ">" + esc(c.name) + "</option>";
    }).join("");

    var body =
      '<form id="admProductForm" novalidate>' +
        '<div class="adm-form-grid">' +
          '<div class="adm-field"><label class="adm-label" for="pfName">Name <span class="adm-req">*</span></label>' +
            '<input class="adm-input" id="pfName" value="' + esc(p ? p.name : "") + '" placeholder="e.g. Crystal Clean" />' +
            '<div class="adm-hint"></div></div>' +

          '<div class="adm-field"><label class="adm-label" for="pfSlug">Slug (URL) <span class="adm-req">*</span></label>' +
            '<input class="adm-input" id="pfSlug" value="' + esc(p ? p.id : "") + '" placeholder="crystal-clean" />' +
            '<div class="adm-hint">Used by product.html?id=… — lowercase letters, numbers and dashes.</div></div>' +

          '<div class="adm-field"><label class="adm-label" for="pfCategory">Category <span class="adm-req">*</span></label>' +
            '<select class="adm-select" id="pfCategory" style="max-width:none">' + catOptions + "</select>" +
            '<div class="adm-hint"></div></div>' +

          '<div class="adm-field"><label class="adm-label" for="pfBadge">Badge</label>' +
            '<input class="adm-input" id="pfBadge" value="' + esc(p ? p.badge : "") + '" placeholder="e.g. Bestseller" />' +
            '<div class="adm-hint">Short label shown on the product photo.</div></div>' +

          '<div class="adm-field full"><label class="adm-label" for="pfDesc">Description</label>' +
            '<textarea class="adm-textarea" id="pfDesc" placeholder="What makes this product great?">' + esc(p ? p.desc : "") + "</textarea>" +
            '<div class="adm-hint">Up to 2000 characters.</div></div>' +

          '<div class="adm-field full">' +
            '<label class="adm-label">Product image <span class="adm-req">*</span></label>' +
            '<div class="adm-image-preview">' +
              '<img id="pfImagePreview" src="' + esc(p ? p.image : "") + '" alt="" onerror="this.style.opacity=.2" />' +
              '<div class="adm-grow">' +
                '<input class="adm-input" id="pfImage" value="' + esc(p ? p.image : "") + '" placeholder="https://… image URL" />' +
                '<div style="display:flex;gap:.4rem;flex-wrap:wrap;align-items:center">' +
                  '<label class="adm-btn adm-btn-sm" style="cursor:pointer"><i class="fas fa-upload"></i>Upload' +
                    '<input type="file" id="pfImageFile" accept="image/*" hidden /></label>' +
                  '<span class="adm-hint" id="pfImageHint">or paste an image URL. Uploads go to Supabase Storage.</span>' +
                "</div>" +
              "</div>" +
            "</div>" +
          "</div>" +

          '<div class="adm-field"><label class="adm-label" for="pfPrice">Price (₦)</label>' +
            '<input class="adm-input" id="pfPrice" type="number" min="0" step="50" value="' + (p && p.price !== null && p.price !== undefined ? p.price : "") + '" placeholder="Leave empty if you use sizes" />' +
            '<div class="adm-hint">Only for single-price products.</div></div>' +

          '<div class="adm-field"><label class="adm-label" for="pfOldPrice">Was-price (₦)</label>' +
            '<input class="adm-input" id="pfOldPrice" type="number" min="0" step="50" value="' + (p && p.oldPrice !== null && p.oldPrice !== undefined ? p.oldPrice : "") + '" placeholder="Optional" />' +
            '<div class="adm-hint">Must be higher than the price.</div></div>' +

          '<div class="adm-field"><label class="adm-label" for="pfStock">Stock (no sizes)</label>' +
            '<input class="adm-input" id="pfStock" type="number" min="0" step="1" value="' + (p ? p.stock : 0) + '" />' +
            '<div class="adm-hint">Ignored when sizes are used.</div></div>' +

          '<div class="adm-field"><label class="adm-label" for="pfRating">Rating (0–5)</label>' +
            '<input class="adm-input" id="pfRating" type="number" min="0" max="5" step="0.1" value="' + (p ? p.rating : 5) + '" />' +
            '<div class="adm-hint">Displayed on the storefront.</div></div>' +
        "</div>" +

        '<div style="display:flex;gap:1.2rem;flex-wrap:wrap;margin-top:1rem">' +
          '<label class="adm-switch"><input type="checkbox" id="pfFeatured"' + (p && p.featured ? " checked" : "") + ' />' +
            '<span class="adm-track"></span>Featured on the home page</label>' +
          '<label class="adm-switch"><input type="checkbox" id="pfActive"' + (!p || p.active !== false ? " checked" : "") + ' />' +
            '<span class="adm-track"></span>Visible in the shop</label>' +
        "</div>" +

        '<div style="margin-top:1.4rem">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;gap:.7rem;flex-wrap:wrap">' +
            "<label class=\"adm-label\">Sizes &amp; prices</label>" +
            '<button class="adm-btn adm-btn-sm" type="button" id="pfAddVariant"><i class="fas fa-plus"></i>Add size</button>' +
          "</div>" +
          '<p class="adm-hint" style="margin:.35rem 0 .7rem">Leave empty for a single-price product. If you add sizes, ' +
            "each size carries its own price and stock — and the product price above must stay empty.</p>" +
          '<div class="adm-variant-head"><span>Size label</span><span>Price (₦)</span><span>Stock</span><span></span></div>' +
          '<div class="adm-variants" id="pfVariants">' +
            sizes.map(variantRow).join("") +
          "</div>" +
        "</div>" +
      "</form>";

    var foot =
      '<button class="adm-btn" type="button" id="pfCancel">Cancel</button>' +
      '<button class="adm-btn adm-btn-primary" type="button" id="pfSave"><i class="fas fa-floppy-disk"></i>' +
        (isEdit ? "Save changes" : "Create product") + "</button>";

    openModal({
      title: isEdit ? "Edit product" : "New product",
      subtitle: isEdit ? p.name + " · " + p.id : "Fill in the details below — the database validates them again on save.",
      body: body,
      foot: foot,
      wide: true
    });

    var slugField = $("pfSlug");
    var nameField = $("pfName");
    if (!isEdit) {
      nameField.addEventListener("input", function () {
        if (!slugField.dataset.touched) slugField.value = slugify(nameField.value);
      });
      slugField.addEventListener("input", function () { slugField.dataset.touched = "1"; });
    }

    $("pfImage").addEventListener("input", function () {
      $("pfImagePreview").src = this.value;
      $("pfImagePreview").style.opacity = 1;
    });

    $("pfImageFile").addEventListener("change", function () {
      var file = this.files && this.files[0];
      if (!file) return;
      var hint = $("pfImageHint");
      hint.textContent = "Uploading…";
      hint.classList.remove("is-error");
      API.admin.uploadProductImage(file).then(function (r) {
        if (r.error) {
          hint.textContent = r.error.message;
          hint.classList.add("is-error");
          return;
        }
        $("pfImage").value = r.data.url;
        $("pfImagePreview").src = r.data.url;
        $("pfImagePreview").style.opacity = 1;
        hint.textContent = "Uploaded to storage.";
        toast("Image uploaded.");
      });
    });

    $("pfAddVariant").addEventListener("click", function () {
      $("pfVariants").insertAdjacentHTML("beforeend", variantRow(null));
    });

    $("pfVariants").addEventListener("click", function (e) {
      var del = e.target.closest("[data-vdel]");
      if (del) del.closest(".adm-variant-row").remove();
    });

    $("pfCancel").addEventListener("click", closeModal);
    $("pfSave").addEventListener("click", function () { saveProduct(p, this); });
  }

  function variantRow(v) {
    v = v || {};
    return '<div class="adm-variant-row">' +
      '<input class="adm-input" data-vfield="label" placeholder="500ml" value="' + esc(v.label || "") + '" />' +
      '<input class="adm-input" data-vfield="price" type="number" min="0" step="50" placeholder="Price ₦" value="' + (v.price !== undefined && v.price !== null ? v.price : "") + '" />' +
      '<input class="adm-input" data-vfield="stock" type="number" min="0" step="1" placeholder="Stock" value="' + (v.stock !== undefined && v.stock !== null ? v.stock : 0) + '" />' +
      '<button class="adm-btn adm-btn-sm adm-btn-danger adm-variant-del" type="button" data-vdel aria-label="Remove size"><i class="fas fa-trash"></i></button>' +
    "</div>";
  }

  function collectVariants() {
    var rows = Array.prototype.slice.call(document.querySelectorAll("#pfVariants .adm-variant-row"));
    var out = [];
    var bad = null;

    rows.forEach(function (row, index) {
      var label = row.querySelector('[data-vfield="label"]').value.trim();
      var price = num(row.querySelector('[data-vfield="price"]').value);
      var stock = num(row.querySelector('[data-vfield="stock"]').value);

      /* A row the admin never filled in is simply ignored. */
      if (!label && price === null && (stock === null || stock === 0)) return;

      if (!label) bad = "Size " + (index + 1) + " needs a label (e.g. 500ml).";
      else if (price === null || price < 0) bad = "Size “" + label + "” needs a price.";
      else if (stock === null || stock < 0) bad = "Size “" + label + "” needs a valid stock number.";

      if (!bad) out.push({ label: label, price: price, stockQuantity: stock || 0, sortOrder: out.length });
    });

    if (bad) return { error: bad, variants: [] };
    return { error: null, variants: out };
  }

  function saveProduct(existing, btn) {
    var name = $("pfName").value.trim();
    var slug = slugify($("pfSlug").value);
    var category = $("pfCategory").value;
    var imageUrl = $("pfImage").value.trim();
    var price = num($("pfPrice").value);
    var oldPrice = num($("pfOldPrice").value);
    var stock = num($("pfStock").value);
    var rating = num($("pfRating").value);
    var collected = collectVariants();

    function fail(msg, field) {
      toast(msg, true);
      if (field) { field.focus(); }
    }

    if (name.length < 2) return fail("Please enter a product name.", $("pfName"));
    if (!/^[a-z0-9-]{2,60}$/.test(slug)) return fail("The slug needs 2–60 lowercase letters, numbers or dashes.", $("pfSlug"));
    if (!category) return fail("Please choose a category.");
    if (imageUrl.length < 4) return fail("Please add a product image (upload or URL).", $("pfImage"));
    if (collected.error) return fail(collected.error);
    if (!collected.variants.length && (price === null || price < 0)) {
      return fail("Enter a price, or add at least one size with its own price.", $("pfPrice"));
    }
    if (oldPrice !== null && price !== null && oldPrice < price) {
      return fail("The was-price cannot be lower than the price.", $("pfOldPrice"));
    }

    var fields = {
      name: name,
      slug: slug,
      category: category,
      description: $("pfDesc").value.trim(),
      badge: $("pfBadge").value.trim() || null,
      imageUrl: imageUrl,
      /* A size-priced product keeps price NULL — prices live on the variants. */
      price: collected.variants.length ? null : price,
      oldPrice: oldPrice,
      featured: $("pfFeatured").checked,
      isActive: $("pfActive").checked,
      stockQuantity: collected.variants.length ? 0 : (stock || 0),
      rating: rating === null ? 0 : Math.max(0, Math.min(5, rating))
    };

    busy(btn, true);

    var work;
    if (!existing) {
      /* Product + sizes are inserted in ONE request so the "must be priced
       * somewhere" constraint never sees an intermediate, unpriced product. */
      work = API.admin.createProduct(fields, collected.variants);
    } else {
      work = updateExistingProduct(existing, fields, collected.variants);
    }

    work.then(function (r) {
      busy(btn, false);
      if (!finish(r, existing ? "Product updated." : "Product created.")) return;
      closeModal();
      loadData().then(render);
    });
  }

  /**
   * Update order matters. Each supabase-js call is its own transaction, and the
   * deferred pricing constraint is checked at commit, so we always move from a
   * valid state to a valid state:
   *   1. add/refresh submitted sizes   (product is still priced, or gains sizes)
   *   2. write product fields + price  (price may become NULL now that sizes exist)
   *   3. delete sizes that were removed (price is already correct if all are gone)
   */
  function updateExistingProduct(existing, fields, variants) {
    var byLabel = {};
    (existing.sizes || []).forEach(function (s) { byLabel[s.label] = s; });

    var chain = Promise.resolve({ data: null, error: null });

    variants.forEach(function (v) {
      chain = chain.then(function (prev) {
        if (prev && prev.error) return prev;
        return API.admin.upsertVariant(existing.uuid, v);
      });
    });

    chain = chain.then(function (prev) {
      if (prev && prev.error) return prev;
      return API.admin.updateProduct(existing.uuid, {
        name: fields.name,
        slug: fields.slug,
        category: fields.category,
        description: fields.description,
        badge: fields.badge,
        image_url: fields.imageUrl,
        price: fields.price,
        old_price: fields.oldPrice,
        featured: fields.featured,
        is_active: fields.isActive,
        stock_quantity: fields.stockQuantity,
        rating: fields.rating
      });
    });

    var keptLabels = {};
    variants.forEach(function (v) { keptLabels[v.label] = true; });

    (existing.sizes || []).forEach(function (s) {
      if (keptLabels[s.label]) return;
      chain = chain.then(function (prev) {
        if (prev && prev.error) return prev;
        return API.admin.deleteVariant(s.uuid);
      });
    });

    return chain;
  }

  function confirmAction(opts) {
    openModal({
      title: opts.title,
      subtitle: opts.subtitle || "",
      body: '<p style="font-size:.9rem;line-height:1.65">' + opts.message + "</p>" +
        (opts.detail ? '<div class="adm-alert is-warn" style="margin-top:.9rem"><i class="fas fa-triangle-exclamation"></i><div>' + opts.detail + "</div></div>" : ""),
      foot: '<button class="adm-btn" type="button" id="cafCancel">Cancel</button>' +
        '<button class="adm-btn ' + (opts.danger ? "adm-btn-danger" : "adm-btn-primary") + '" type="button" id="cafGo">' + esc(opts.confirmLabel || "Confirm") + "</button>"
    });
    $("cafCancel").addEventListener("click", closeModal);
    $("cafGo").addEventListener("click", function () {
      var btn = this;
      busy(btn, true);
      opts.run().then(function (r) {
        busy(btn, false);
        if (!finish(r, opts.successMsg)) return;
        closeModal();
        loadData().then(render);
      });
    });
  }

  /* ============================================================== INVENTORY */

  function renderInventory() {
    var totalUnits = 0, value = 0, out = 0, low = 0;
    var rows = [];

    S.products.forEach(function (p) {
      if (p.sizes && p.sizes.length) {
        p.sizes.forEach(function (v) {
          var stock = Number(v.stock || 0);
          totalUnits += stock;
          value += stock * Number(v.price);
          if (stock <= 0) out++; else if (stock <= 5) low++;
          rows.push({ kind: "variant", product: p, uuid: v.uuid, label: v.label, price: Number(v.price), stock: stock, sortOrder: 0 });
        });
      } else {
        var stock = Number(p.stock || 0);
        totalUnits += stock;
        value += stock * Number(p.price || 0);
        if (stock <= 0) out++; else if (stock <= 5) low++;
        rows.push({ kind: "product", product: p, uuid: p.uuid, label: "", price: Number(p.price || 0), stock: stock });
      }
    });

    rows.sort(function (a, b) { return a.stock - b.stock; });
    var visible = S.f.inventoryOnly === "low"
      ? rows.filter(function (r) { return r.stock <= 5; })
      : rows;

    els.view.innerHTML =
      '<section class="adm-cards">' +
        statCard({ label: "Total units", icon: "fa-cubes", value: totalUnits, foot: rows.length + " tracked lines" }) +
        statCard({ label: "Stock value", icon: "fa-naira-sign", tone: "is-deep", value: money(value), foot: "Price × units on hand" }) +
        statCard({ label: "Low stock", icon: "fa-triangle-exclamation", tone: "is-citrus", value: low, foot: "5 units or fewer" }) +
        statCard({ label: "Out of stock", icon: "fa-ban", tone: "is-danger", value: out, foot: "Cannot be ordered" }) +
      "</section>" +

      '<div class="adm-panel">' +
        '<div class="adm-panel-head">' +
          "<h3><i class=\"fas fa-warehouse\"></i>Stock by item</h3>" +
          '<div class="adm-toolbar">' +
            '<select class="adm-select" data-filter="inventoryOnly">' +
              '<option value="all"' + (S.f.inventoryOnly === "all" ? " selected" : "") + ">All items</option>" +
              '<option value="low"' + (S.f.inventoryOnly === "low" ? " selected" : "") + ">Needs restocking</option>" +
            "</select>" +
            '<button class="adm-btn adm-btn-sm" type="button" data-action="export-inventory"><i class="fas fa-file-csv"></i>Export</button>' +
          "</div>" +
        "</div>" +
        (visible.length ? '<div class="adm-table-wrap"><table class="adm-table"><thead><tr>' +
          "<th>Item</th><th>Price</th><th>Stock</th><th>Value</th><th class=\"adm-right\">Adjust</th>" +
          "</tr></thead><tbody>" +
          visible.map(function (r) {
            return "<tr>" +
              '<td><div class="adm-cell-main"><img class="adm-thumb" src="' + esc(r.product.image) + '" alt="" loading="lazy" />' +
                '<div class="adm-cell-text"><strong>' + esc(r.product.name) + (r.label ? " · " + esc(r.label) : "") + "</strong>" +
                "<span>" + esc(categoryName(r.product.category)) + "</span></div></div></td>" +
              '<td class="adm-money">' + money(r.price) + "</td>" +
              '<td><span class="adm-badge ' + (r.stock <= 0 ? "is-danger" : r.stock <= 5 ? "is-warn" : "is-ok") + '">' + r.stock + "</span>" + stockBar(r.stock) + "</td>" +
              '<td class="adm-money">' + money(r.stock * r.price) + "</td>" +
              '<td><div class="adm-row-actions">' +
                '<input class="adm-input" style="width:5.5rem" type="number" min="0" step="1" value="' + r.stock + '" data-stock-input="' + esc(r.uuid) + '" />' +
                '<button class="adm-btn adm-btn-sm adm-btn-primary" type="button" data-action="stock-save" data-id="' + esc(r.uuid) + '" ' +
                  'data-kind="' + r.kind + '" data-product="' + esc(r.product.uuid) + '" data-label="' + esc(r.label) + '" ' +
                  'data-price="' + r.price + '" data-sort="' + (r.sortOrder || 0) + '"><i class="fas fa-check"></i>Save</button>' +
              "</div></td>" +
            "</tr>";
          }).join("") + "</tbody></table></div>"
          : emptyBlock("fa-circle-check", "Nothing to restock", "Every item is above the low-stock threshold.")) +
      "</div>";
  }

  /* ================================================================= ORDERS */

  function filteredOrders() {
    var q = S.f.orderSearch.toLowerCase();
    return S.orders.filter(function (o) {
      if (S.f.orderStatus !== "all" && o.status !== S.f.orderStatus) return false;
      if (!q) return true;
      return (o.id + " " + (o.customer || "") + " " + (o.phone || "") + " " + (o.email || "") + " " + (o.city || "")).toLowerCase().indexOf(q) !== -1;
    });
  }

  function renderOrders() {
    var list = filteredOrders();
    var pages = Math.max(1, Math.ceil(list.length / PER_PAGE));
    if (S.f.orderPage > pages) S.f.orderPage = pages;
    var start = (S.f.orderPage - 1) * PER_PAGE;
    var pageItems = list.slice(start, start + PER_PAGE);

    var byStatus = countBy(S.orders, "status");
    var revenue = S.orders.reduce(function (sum, o) { return sum + (o.status === "cancelled" ? 0 : o.total); }, 0);

    var statusOptions = ["all", "pending", "confirmed", "processing", "shipped", "delivered", "cancelled"].map(function (s) {
      return '<option value="' + s + '"' + (S.f.orderStatus === s ? " selected" : "") + ">" + (s === "all" ? "All statuses" : s.charAt(0).toUpperCase() + s.slice(1)) + "</option>";
    }).join("");

    els.view.innerHTML =
      '<section class="adm-cards">' +
        statCard({ label: "Total orders", icon: "fa-receipt", value: S.orders.length }) +
        statCard({ label: "Pending", icon: "fa-hourglass-half", tone: "is-citrus", value: byStatus.pending || 0, foot: "Awaiting confirmation" }) +
        statCard({ label: "In progress", icon: "fa-truck-fast", tone: "is-deep", value: (byStatus.confirmed || 0) + (byStatus.processing || 0) + (byStatus.shipped || 0) }) +
        statCard({ label: "Delivered", icon: "fa-circle-check", value: byStatus.delivered || 0 }) +
        statCard({ label: "Revenue", icon: "fa-naira-sign", tone: "is-deep", value: money(revenue), foot: "Excludes cancelled orders" }) +
        statCard({ label: "Cancelled", icon: "fa-ban", tone: "is-danger", value: byStatus.cancelled || 0 }) +
      "</section>" +

      '<div class="adm-panel">' +
        '<div class="adm-panel-head">' +
          "<h3><i class=\"fas fa-receipt\"></i>Customer orders</h3>" +
          '<div class="adm-toolbar">' +
            '<select class="adm-select" data-filter="orderStatus">' + statusOptions + "</select>" +
            '<button class="adm-btn adm-btn-sm" type="button" data-action="export-orders"><i class="fas fa-file-csv"></i>Export CSV</button>' +
          "</div>" +
        "</div>" +
        '<div class="adm-panel-head" style="border-top:0">' +
          '<div class="adm-search adm-grow"><i class="fas fa-magnifying-glass"></i>' +
            '<input type="search" data-filter="orderSearch" value="' + esc(S.f.orderSearch) + '" placeholder="Search order number, customer, phone or city…" /></div>' +
        "</div>" +
        (pageItems.length ? '<div class="adm-table-wrap"><table class="adm-table"><thead><tr>' +
          "<th>Order</th><th>Customer</th><th>Items</th><th class=\"adm-right\">Total</th><th>Payment</th><th>Status</th><th class=\"adm-right\">Manage</th>" +
          "</tr></thead><tbody>" +
          pageItems.map(function (o) {
            var summary = o.items.slice(0, 2).map(function (i) {
              return i.qty + "× " + i.name + (i.size ? " (" + i.size + ")" : "");
            }).join(", ");
            if (o.items.length > 2) summary += " +" + (o.items.length - 2) + " more";
            return "<tr>" +
              "<td class=\"adm-nowrap\"><strong>" + esc(o.id) + "</strong><br><span class=\"adm-small adm-muted\">" + esc(shortDate(o.createdAt)) + "</span></td>" +
              "<td>" + esc(o.customer || "—") + "<br><span class=\"adm-small adm-muted\">" + esc(o.phone || "") + "</span></td>" +
              '<td><span class="adm-small">' + esc(summary || "—") + "</span><br><span class=\"adm-chip\">" + o.itemCount + " items</span></td>" +
              '<td class="adm-right adm-money">' + money(o.total) + "</td>" +
              "<td>" + esc(o.paymentMethod) + "<br>" + paymentBadge(o.paymentStatus) + "</td>" +
              "<td>" + statusBadge(o.status) + "</td>" +
              '<td><div class="adm-row-actions">' +
                '<button class="adm-btn adm-btn-sm adm-btn-primary" type="button" data-action="order-manage" data-id="' + esc(o.uuid) + '">' +
                  '<i class="fas fa-sliders"></i>Manage</button>' +
              "</div></td></tr>";
          }).join("") + "</tbody></table></div>"
          : emptyBlock("fa-receipt", "No orders found", S.orders.length ? "Try a different search or status filter." : "Orders placed in the shop will appear here.")) +
        (list.length > PER_PAGE ? pager(S.f.orderPage, pages, list.length, start, "orderPage") : "") +
      "</div>";
  }

  function openOrderModal(uuid) {
    var o = S.orders.filter(function (x) { return x.uuid === uuid; })[0];
    if (!o) { toast("That order could not be found.", true); return; }

    var next = NEXT_STATUS[o.status] || [];

    var body =
      '<div class="adm-split">' +
        "<div>" +
          '<div class="adm-detail-list">' +
            row("Order", esc(o.id)) +
            row("Placed", esc(dateTime(o.createdAt))) +
            row("Customer", esc(o.customer || "—")) +
            row("Phone", esc(o.phone || "—")) +
            row("Email", esc(o.email || "—")) +
            row("Deliver to", esc(o.address || "—") + (o.city ? ", " + esc(o.city) : "")) +
            (o.notes ? row("Notes", esc(o.notes)) : "") +
          "</div>" +
        "</div>" +
        "<div>" +
          '<div class="adm-lines">' +
            o.items.map(function (i) {
              return '<div class="adm-line"><div class="adm-grow"><strong>' + esc(i.name) + (i.size ? " · " + esc(i.size) : "") + "</strong>" +
                "<span>" + i.qty + " × " + money(i.price) + "</span></div>" +
                '<strong>' + money(i.lineTotal) + "</strong></div>";
            }).join("") +
          "</div>" +
          '<div class="adm-detail-list" style="margin-top:1rem">' +
            row("Subtotal", money(o.subtotal)) +
            row("Discount" + (o.promoCode ? " (" + esc(o.promoCode) + ")" : ""), o.discount ? "−" + money(o.discount) : "—") +
            row("Delivery", money(o.delivery)) +
            row("<strong>Total</strong>", "<strong>" + money(o.total) + "</strong>") +
            row("Payment", esc(o.paymentMethod)) +
          "</div>" +
        "</div>" +
      "</div>" +

      '<div style="margin-top:1.4rem">' +
        '<label class="adm-label">Order status</label>' +
        '<div style="display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;margin-top:.5rem">' +
          statusBadge(o.status) +
          (next.length
            ? next.map(function (s) {
                return '<button class="adm-btn adm-btn-sm' + (s === "cancelled" ? " adm-btn-danger" : " adm-btn-primary") + '" type="button" ' +
                  'data-action="order-status" data-id="' + esc(o.uuid) + '" data-status="' + esc(s) + '">' +
                  '<i class="fas ' + (s === "cancelled" ? "fa-ban" : "fa-arrow-right") + '"></i>' + esc(s) + "</button>";
              }).join("")
            : '<span class="adm-small adm-muted">This order has reached a final state — no further changes are allowed.</span>') +
        "</div>" +
        '<p class="adm-hint" style="margin-top:.5rem">The database only permits these transitions; illegal jumps are rejected server-side.</p>' +
      "</div>" +

      '<div style="margin-top:1.2rem">' +
        '<label class="adm-label">Payment status</label>' +
        '<div style="display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;margin-top:.5rem">' +
          paymentBadge(o.paymentStatus) +
          ["unpaid", "paid", "refunded"].filter(function (s) { return s !== o.paymentStatus; }).map(function (s) {
            return '<button class="adm-btn adm-btn-sm" type="button" data-action="order-payment" data-id="' + esc(o.uuid) + '" data-status="' + s + '">' +
              '<i class="fas fa-flag"></i>Mark ' + s + "</button>";
          }).join("") +
        "</div>" +
        '<p class="adm-hint" style="margin-top:.5rem">Recorded through the admin-only <code>admin_set_payment_status</code> function — ' +
          "order amounts themselves can never be edited.</p>" +
      "</div>";

    openModal({
      title: "Order " + o.id,
      subtitle: "Placed " + dateTime(o.createdAt) + " · " + o.itemCount + " items",
      body: body,
      foot: '<button class="adm-btn" type="button" id="ordClose">Close</button>',
      wide: true
    });
    $("ordClose").addEventListener("click", closeModal);
  }

  function row(label, value) {
    return '<div class="adm-row"><span>' + label + "</span><span>" + value + "</span></div>";
  }

  /* ============================================================== CUSTOMERS */

  function renderCustomers() {
    var q = S.f.customerSearch.toLowerCase();
    var list = S.customers.filter(function (c) {
      if (!q) return true;
      return ((c.name || "") + " " + (c.email || "") + " " + (c.phone || "")).toLowerCase().indexOf(q) !== -1;
    });

    var myId = (S.user && S.user.id) || "";
    var monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    var newThisMonth = S.customers.filter(function (c) {
      var joined = c.joinedAt ? new Date(c.joinedAt) : null;
      return joined && joined >= monthStart;
    }).length;

    els.view.innerHTML =
      '<section class="adm-cards">' +
        statCard({ label: "Customers", icon: "fa-users", value: S.customers.length }) +
        statCard({ label: "New this month", icon: "fa-user-plus", tone: "is-deep", value: newThisMonth }) +
        statCard({ label: "Admins", icon: "fa-user-shield", tone: "is-citrus", value: S.customers.filter(function (c) { return c.role === "admin"; }).length, foot: "Promoted in the database" }) +
        statCard({ label: "Total spend", icon: "fa-naira-sign", value: money(S.customers.reduce(function (sum, c) { return sum + spentForUser(c.uuid); }, 0)) }) +
      "</section>" +

      '<div class="adm-panel">' +
        '<div class="adm-panel-head">' +
          "<h3><i class=\"fas fa-users\"></i>Registered accounts</h3>" +
          '<div class="adm-toolbar">' +
            '<button class="adm-btn adm-btn-sm" type="button" data-action="export-customers"><i class="fas fa-file-csv"></i>Export CSV</button>' +
          "</div>" +
        "</div>" +
        '<div class="adm-panel-head" style="border-top:0">' +
          '<div class="adm-search adm-grow"><i class="fas fa-magnifying-glass"></i>' +
            '<input type="search" data-filter="customerSearch" value="' + esc(S.f.customerSearch) + '" placeholder="Search name, email or phone…" /></div>' +
        "</div>" +
        (list.length ? '<div class="adm-table-wrap"><table class="adm-table"><thead><tr>' +
          "<th>Customer</th><th>Phone</th><th>Joined</th><th>Orders</th><th class=\"adm-right\">Spent</th><th>Access</th><th class=\"adm-right\">Role</th>" +
          "</tr></thead><tbody>" +
          list.map(function (c) {
            var isMe = c.uuid === myId;
            var isAdmin = c.role === "admin";
            return "<tr>" +
              '<td><div class="adm-cell-main"><span class="adm-avatar">' + esc(initials(c.name)) + "</span>" +
                '<div class="adm-cell-text"><strong>' + esc(c.name || "—") + (isMe ? ' <span class="adm-chip">You</span>' : "") + "</strong>" +
                "<span>" + esc(c.email || "—") + "</span></div></div></td>" +
              "<td>" + esc(c.phone || "—") + "</td>" +
              '<td class="adm-nowrap">' + esc(c.joined || "—") + "</td>" +
              "<td>" + ordersForUser(c.uuid).length + "</td>" +
              '<td class="adm-right adm-money">' + money(spentForUser(c.uuid)) + "</td>" +
              "<td>" + (isAdmin ? '<span class="adm-badge is-ok"><i class="fas fa-user-shield"></i>Admin</span>' : '<span class="adm-badge is-muted">Customer</span>') + "</td>" +
              '<td><div class="adm-row-actions">' +
                (isMe
                  ? '<span class="adm-small adm-muted">Your own account</span>'
                  : '<button class="adm-btn adm-btn-sm' + (isAdmin ? "" : " adm-btn-primary") + '" type="button" data-action="customer-role" ' +
                    'data-id="' + esc(c.uuid) + '" data-role="' + (isAdmin ? "customer" : "admin") + '" data-name="' + esc(c.name || c.email) + '">' +
                    '<i class="fas ' + (isAdmin ? "fa-user-minus" : "fa-user-shield") + '"></i>' + (isAdmin ? "Make customer" : "Make admin") + "</button>") +
              "</div></td></tr>";
          }).join("") + "</tbody></table></div>"
          : emptyBlock("fa-users", "No customers found", S.customers.length ? "Try a different search." : "Accounts created in the shop will appear here.")) +
      "</div>";
  }

  /* ============================================================= CATEGORIES */

  function renderCategories() {
    var counts = countBy(S.products, "category");
    els.view.innerHTML =
      '<div class="adm-panel">' +
        '<div class="adm-panel-head">' +
          "<h3><i class=\"fas fa-tags\"></i>Catalog categories</h3>" +
          '<button class="adm-btn adm-btn-sm adm-btn-primary" type="button" data-action="category-new"><i class="fas fa-plus"></i>New category</button>' +
        "</div>" +
        (S.categories.length ? '<div class="adm-table-wrap"><table class="adm-table"><thead><tr>' +
          "<th>Category</th><th>Tagline</th><th>Products</th><th>Order</th><th class=\"adm-right\">Actions</th>" +
          "</tr></thead><tbody>" +
          S.categories.map(function (c) {
            return "<tr>" +
              '<td><div class="adm-cell-text"><strong><i class="fas ' + esc(c.icon) + '"></i> ' + esc(c.name) + "</strong>" +
                "<span>" + esc(c.slug) + "</span></div></td>" +
              "<td>" + esc(c.tag || "—") + "<br><span class=\"adm-small adm-muted\">" + esc(c.blurb || "") + "</span></td>" +
              '<td><span class="adm-chip">' + (counts[c.slug] || 0) + " products</span></td>" +
              "<td>" + (c.sortOrder === undefined || c.sortOrder === null ? "—" : c.sortOrder) + "</td>" +
              '<td><div class="adm-row-actions">' +
                '<button class="adm-btn adm-btn-sm" type="button" data-action="category-edit" data-id="' + esc(c.slug) + '"><i class="fas fa-pen"></i>Edit</button>' +
                (counts[c.slug]
                  ? ""
                  : '<button class="adm-btn adm-btn-sm adm-btn-danger" type="button" data-action="category-delete" data-id="' + esc(c.slug) + '"><i class="fas fa-trash"></i></button>') +
              "</div></td></tr>";
          }).join("") + "</tbody></table></div>"
          : emptyBlock("fa-tags", "No categories yet", "Create one to group your products in the shop.")) +
        '<div class="adm-panel-body" style="border-top:1px solid var(--line)">' +
          '<p class="adm-hint">A category can only be deleted when no product uses it — the database enforces ' +
            "this so the catalog can never be orphaned. The icon uses Font Awesome class names.</p>" +
        "</div>" +
      "</div>";
  }

  function openCategoryModal(slug) {
    var c = slug ? S.categories.filter(function (x) { return x.slug === slug; })[0] : null;
    var isEdit = Boolean(c);

    openModal({
      title: isEdit ? "Edit category" : "New category",
      subtitle: isEdit ? c.slug : "Groups products in the shop and on the home page.",
      body:
        '<form id="admCategoryForm" novalidate><div class="adm-form-grid">' +
          field("cfName", "Name", "text", c ? c.name : "", "e.g. Body Cosmetics", true) +
          field("cfSlug", "Slug", "text", c ? c.slug : "", "body-cosmetics", true, "Lowercase letters, numbers and dashes. Used in category.html?cat=…") +
          field("cfIcon", "Font Awesome icon", "text", c ? c.icon : "fa-tag", "fa-tag") +
          field("cfTag", "Tagline", "text", c ? c.tag : "", "Skin & body") +
          field("cfBlurb", "Short blurb", "text", c ? c.blurb : "", "Butters, scrubs, creams") +
          field("cfSort", "Sort order", "number", c ? c.sortOrder : S.categories.length + 1, "1") +
          '<div class="adm-field full"><label class="adm-label" for="cfFeatures">Feature bullets</label>' +
            '<textarea class="adm-textarea" id="cfFeatures" placeholder="One per line">' +
              esc((c && c.features ? c.features : []).join("\n")) + "</textarea>" +
            '<div class="adm-hint">Shown on the product detail page — one per line.</div></div>' +
        "</div></form>",
      foot: '<button class="adm-btn" type="button" id="cfCancel">Cancel</button>' +
        '<button class="adm-btn adm-btn-primary" type="button" id="cfSave"><i class="fas fa-floppy-disk"></i>' +
        (isEdit ? "Save changes" : "Create category") + "</button>"
    });

    $("cfCancel").addEventListener("click", closeModal);
    $("cfSave").addEventListener("click", function () {
      var slugValue = slugify($("cfSlug").value);
      var name = $("cfName").value.trim();
      if (name.length < 2) { toast("Please enter a category name.", true); return; }
      if (!/^[a-z0-9-]{2,40}$/.test(slugValue)) { toast("The slug needs 2–40 lowercase letters, numbers or dashes.", true); return; }

      busy(this, true);
      API.admin.saveCategory({
        slug: slugValue,
        name: name,
        icon: $("cfIcon").value.trim() || "fa-tag",
        tag: $("cfTag").value.trim(),
        blurb: $("cfBlurb").value.trim(),
        features: $("cfFeatures").value.split("\n").map(function (s) { return s.trim(); }).filter(Boolean),
        sortOrder: num($("cfSort").value) || 0
      }).then(function (r) {
        busy($("cfSave"), false);
        if (!finish(r, isEdit ? "Category updated." : "Category created.")) return;
        closeModal();
        loadData().then(render);
      });
    });
  }

  function field(id, label, type, value, placeholder, required, hint) {
    return '<div class="adm-field"><label class="adm-label" for="' + id + '">' + esc(label) +
      (required ? ' <span class="adm-req">*</span>' : "") + "</label>" +
      '<input class="adm-input" id="' + id + '" type="' + type + '" value="' + esc(value === null || value === undefined ? "" : value) + '" ' +
        'placeholder="' + esc(placeholder || "") + '" />' +
      (hint ? '<div class="adm-hint">' + esc(hint) + "</div>" : "") + "</div>";
  }

  /* ================================================================= PROMOS */

  function renderPromos() {
    var active = S.promos.filter(function (p) { return p.isActive && !p.expired; }).length;
    var redeemed = S.promos.reduce(function (sum, p) { return sum + (p.uses || 0); }, 0);

    els.view.innerHTML =
      '<section class="adm-cards">' +
        statCard({ label: "Promo codes", icon: "fa-ticket", value: S.promos.length }) +
        statCard({ label: "Active", icon: "fa-circle-check", value: active }) +
        statCard({ label: "Total redemptions", icon: "fa-repeat", tone: "is-deep", value: redeemed }) +
      "</section>" +

      '<div class="adm-panel">' +
        '<div class="adm-panel-head">' +
          "<h3><i class=\"fas fa-ticket\"></i>Discount codes</h3>" +
          '<button class="adm-btn adm-btn-sm adm-btn-primary" type="button" data-action="promo-new"><i class="fas fa-plus"></i>New promo</button>' +
        "</div>" +
        (S.promos.length ? '<div class="adm-table-wrap"><table class="adm-table"><thead><tr>' +
          "<th>Code</th><th>Discount</th><th>Min. subtotal</th><th>Uses</th><th>Expires</th><th>Status</th><th class=\"adm-right\">Actions</th>" +
          "</tr></thead><tbody>" +
          S.promos.map(function (p) {
            var state = !p.isActive ? '<span class="adm-badge is-muted">Paused</span>'
              : p.expired ? '<span class="adm-badge is-danger">Expired</span>'
              : '<span class="adm-badge is-ok">Active</span>';
            var exhausted = p.maxUses !== null && p.uses >= p.maxUses;
            return "<tr>" +
              "<td><strong>" + esc(p.code) + "</strong>" + (exhausted && p.isActive ? ' <span class="adm-badge is-warn">Used up</span>' : "") + "</td>" +
              '<td class="adm-money">' + p.percentOff + "% off</td>" +
              '<td class="adm-money">' + (p.minSubtotal ? money(p.minSubtotal) : "—") + "</td>" +
              "<td>" + p.uses + (p.maxUses !== null ? " / " + p.maxUses : "") + "</td>" +
              '<td class="adm-nowrap">' + (p.expiresAt ? esc(shortDate(p.expiresAt)) : "Never") + "</td>" +
              "<td>" + state + "</td>" +
              '<td><div class="adm-row-actions">' +
                '<button class="adm-btn adm-btn-sm" type="button" data-action="promo-edit" data-id="' + esc(p.code) + '"><i class="fas fa-pen"></i>Edit</button>' +
                '<button class="adm-btn adm-btn-sm" type="button" data-action="promo-toggle" data-id="' + esc(p.code) + '" data-active="' + (p.isActive ? "false" : "true") + '">' +
                  '<i class="fas ' + (p.isActive ? "fa-pause" : "fa-play") + '"></i>' + (p.isActive ? "Pause" : "Activate") + "</button>" +
                '<button class="adm-btn adm-btn-sm adm-btn-danger" type="button" data-action="promo-delete" data-id="' + esc(p.code) + '"><i class="fas fa-trash"></i></button>' +
              "</div></td></tr>";
          }).join("") + "</tbody></table></div>"
          : emptyBlock("fa-ticket", "No promo codes", "Create one to offer a percentage discount at checkout.")) +
        '<div class="adm-panel-body" style="border-top:1px solid var(--line)">' +
          '<p class="adm-hint">Promo codes are never readable by visitors — the shop only learns whether the code ' +
            "you typed is valid, and the discount is applied inside the database when an order is placed.</p>" +
        "</div>" +
      "</div>";
  }

  function openPromoModal(code) {
    var p = code ? S.promos.filter(function (x) { return x.code === code; })[0] : null;
    var isEdit = Boolean(p);
    var expires = "";
    if (p && p.expiresAt) {
      var d = new Date(p.expiresAt);
      if (!isNaN(d.getTime())) {
        var pad = function (n) { return String(n).padStart(2, "0"); };
        expires = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
      }
    }

    openModal({
      title: isEdit ? "Edit promo code" : "New promo code",
      subtitle: isEdit ? p.code : "Customers enter this code in the cart.",
      body:
        '<form id="admPromoForm" novalidate><div class="adm-form-grid">' +
          field("prCode", "Code", "text", p ? p.code : "", "SPARKLE10", true, "Uppercase letters, numbers and dashes (3–24 characters).") +
          field("prPercent", "Percent off", "number", p ? p.percentOff : 10, "10", true, "Between 1 and 90.") +
          field("prMin", "Minimum subtotal (₦)", "number", p ? p.minSubtotal : 0, "0") +
          field("prMaxUses", "Maximum uses", "number", p && p.maxUses !== null ? p.maxUses : "", "Leave empty for unlimited") +
          field("prExpires", "Expires", "datetime-local", expires, "") +
          '<div class="adm-field"><label class="adm-label">Status</label>' +
            '<label class="adm-switch"><input type="checkbox" id="prActive"' + (!p || p.isActive ? " checked" : "") + ' />' +
            '<span class="adm-track"></span>Available at checkout</label></div>' +
        "</div></form>",
      foot: '<button class="adm-btn" type="button" id="prCancel">Cancel</button>' +
        '<button class="adm-btn adm-btn-primary" type="button" id="prSave"><i class="fas fa-floppy-disk"></i>' +
        (isEdit ? "Save changes" : "Create promo") + "</button>"
    });

    $("prCancel").addEventListener("click", closeModal);
    $("prSave").addEventListener("click", function () {
      var codeValue = $("prCode").value.trim().toUpperCase();
      var percent = num($("prPercent").value);
      var expiresValue = $("prExpires").value;

      if (!/^[A-Z0-9-]{3,24}$/.test(codeValue)) { toast("Codes use 3–24 uppercase letters, numbers or dashes.", true); return; }
      if (percent === null || percent <= 0 || percent > 90) { toast("Percent off must be between 1 and 90.", true); return; }

      busy(this, true);
      API.admin.savePromo({
        code: codeValue,
        percentOff: percent,
        minSubtotal: num($("prMin").value) || 0,
        maxUses: num($("prMaxUses").value),
        isActive: $("prActive").checked,
        /* Convert the browser's local time to an unambiguous UTC timestamp. */
        expiresAt: expiresValue ? new Date(expiresValue).toISOString() : null
      }).then(function (r) {
        busy($("prSave"), false);
        if (!finish(r, isEdit ? "Promo updated." : "Promo created.")) return;
        closeModal();
        loadData().then(render);
      });
    });
  }

  /* ============================================================= CONNECTION */

  function renderConnection() {
    var cfg = window.UAGE_SUPABASE_CONFIG || {};
    var host = "—";
    try { host = new URL(cfg.url).host; } catch (e) { host = cfg.url || "—"; }
    var session = S.user ? (S.user.email || "") : "";

    var bootstrapSql = "update public.user_roles\n   set role = 'admin', granted_at = now()\n where user_id = (select id from auth.users\n                  where email = '" + (session || "you@example.com") + "');";

    els.view.innerHTML =
      '<div class="adm-split">' +
        '<div class="adm-panel">' +
          '<div class="adm-panel-head"><h3><i class="fas fa-plug"></i>Backend connection</h3></div>' +
          '<div class="adm-panel-body"><div class="adm-detail-list">' +
            row("Project host", "<code>" + esc(host) + "</code>") +
            row("Client key", '<span class="adm-badge is-ok">anon / publishable</span>') +
            row("Signed in as", esc(session || "—")) +
            row("Admin access", '<span class="adm-badge is-ok"><i class="fas fa-user-shield"></i>Verified by database</span>') +
            row("Secret key in browser", '<span class="adm-badge is-ok">Not present</span>') +
          "</div></div>" +
        "</div>" +

        '<div class="adm-panel">' +
          '<div class="adm-panel-head"><h3><i class="fas fa-shield-halved"></i>What is enforced where</h3></div>' +
          '<div class="adm-panel-body" style="display:flex;flex-direction:column;gap:.6rem;font-size:.86rem">' +
            check("Roles are read from <code>public.user_roles</code> by <code>is_admin()</code> — never from the browser.") +
            check("Order totals, discounts and delivery fees are computed inside <code>place_order()</code>.") +
            check("Products, variants, categories and promos are writable only by an admin, checked by RLS.") +
            check("Every size and product price is validated by database constraints on write.") +
            check("Product images live in Supabase Storage; only admins can write to the bucket.") +
          "</div>" +
        "</div>" +
      "</div>" +

      '<div class="adm-panel">' +
        '<div class="adm-panel-head">' +
          "<h3><i class=\"fas fa-key\"></i>Promote an administrator</h3>" +
          '<button class="adm-btn adm-btn-sm" type="button" id="admCopySql"><i class="fas fa-copy"></i>Copy SQL</button>' +
        "</div>" +
        '<div class="adm-panel-body">' +
          '<p style="font-size:.88rem;line-height:1.65">Admin rights are deliberately impossible to grant from a ' +
            "browser. Run this once in the Supabase SQL editor for the account that should own the store, then reload:</p>" +
          '<pre id="admSql" style="overflow:auto;background:rgba(6,42,63,.06);padding:1rem;border-radius:14px;font-size:.78rem;line-height:1.6;margin-top:.8rem">' +
            esc(bootstrapSql) + "</pre>" +
          '<div class="adm-alert is-warn" style="margin-top:.9rem"><i class="fas fa-triangle-exclamation"></i>' +
            "<div>Once at least one administrator exists, use the <strong>Customers</strong> tab to promote or demote others — " +
            "the database refuses to remove the last administrator.</div></div>" +
        "</div>" +
      "</div>" +

      '<div class="adm-panel">' +
        '<div class="adm-panel-head"><h3><i class="fas fa-book"></i>Reference</h3></div>' +
        '<div class="adm-panel-body" style="font-size:.88rem;line-height:1.7">' +
          "<p>Database schema, RLS policies, storage buckets and migration order are documented in " +
            "<code>BACKEND.md</code>. The five migrations in <code>supabase/migrations/</code> recreate the whole " +
            "backend from scratch, and <code>supabase/tests</code> proves the policies behave correctly.</p>" +
        "</div>" +
      "</div>";

    $("admCopySql").addEventListener("click", function () {
      var text = bootstrapSql;
      function done() { toast("SQL copied to the clipboard."); }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { toast("Copy failed — select the text manually.", true); });
      } else {
        toast("Copy failed — select the text manually.", true);
      }
    });
  }

  function check(text) {
    return '<div style="display:flex;gap:.55rem;align-items:flex-start">' +
      '<i class="fas fa-circle-check" style="color:var(--teal);margin-top:.2rem"></i><span>' + text + "</span></div>";
  }

  /* ======================================================= EVENT DELEGATION */

  function bindShell() {
    els.view = $("admView");
    els.title = $("admTitle");
    els.subtitle = $("admSubtitle");
    els.user = $("admUser");
    els.avatar = $("admAvatar");
    els.userName = $("admUserName");
    els.userEmail = $("admUserEmail");
    els.signOut = $("admSignOut");
    els.modal = $("admModal");
    els.modalCard = $("admModalCard");
    els.modalTitle = $("admModalTitle");
    els.modalSubtitle = $("admModalSubtitle");
    els.modalBody = $("admModalBody");
    els.modalFoot = $("admModalFoot");
    els.toast = $("admToast");
    els.side = $("admSide");
    els.backdrop = $("admBackdrop");

    $("admBurger").addEventListener("click", function () {
      var open = els.side.classList.toggle("open");
      els.backdrop.classList.toggle("show", open);
      this.setAttribute("aria-expanded", open ? "true" : "false");
    });
    els.backdrop.addEventListener("click", closeDrawer);

    $("admModalClose").addEventListener("click", closeModal);
    els.modal.addEventListener("click", function (e) { if (e.target === els.modal) closeModal(); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { closeModal(); closeDrawer(); }
    });

    els.signOut.addEventListener("click", signOut);

    $("admRefresh").addEventListener("click", function () {
      var btn = this;
      busy(btn, true);
      loadData().then(function () {
        busy(btn, false);
        render();
        toast("Data refreshed.");
      });
    });

    window.addEventListener("hashchange", route);

    els.view.addEventListener("click", onViewClick);
    els.view.addEventListener("input", onViewInput);
    els.view.addEventListener("change", onViewChange);
  }

  function closeDrawer() {
    if (els.side) els.side.classList.remove("open");
    if (els.backdrop) els.backdrop.classList.remove("show");
  }

  function onViewInput(e) {
    var search = e.target.closest("[data-filter]");
    if (!search) return;
    var key = search.dataset.filter;
    if (key === "productSearch" || key === "orderSearch" || key === "customerSearch") {
      S.f[key] = e.target.value;
      if (key === "productSearch") S.f.productPage = 1;
      if (key === "orderSearch") S.f.orderPage = 1;
      /* Re-render on the next tick so typing stays responsive. */
      clearTimeout(S._searchTimer);
      S._searchTimer = setTimeout(function () {
        var pos = e.target.selectionStart;
        render();
        var again = document.querySelector('[data-filter="' + key + '"]');
        if (again) { again.focus(); if (pos !== null) again.setSelectionRange(pos, pos); }
      }, 220);
    }
  }

  function onViewChange(e) {
    var control = e.target.closest("[data-filter]");
    if (!control || control.tagName === "INPUT") return;
    var key = control.dataset.filter;
    S.f[key] = e.target.value;
    if (key === "productCategory" || key === "productStatus") S.f.productPage = 1;
    if (key === "orderStatus") S.f.orderPage = 1;
    render();
  }

  function onViewClick(e) {
    var pagerBtn = e.target.closest("[data-page]");
    if (pagerBtn) {
      var pageKey = pagerBtn.dataset.pagekey;
      S.f[pageKey] = Number(pagerBtn.dataset.page);
      render();
      return;
    }

    var trigger = e.target.closest("[data-action]");
    if (!trigger) return;
    var action = trigger.dataset.action;
    var id = trigger.dataset.id;

    switch (action) {
      case "goto":
        window.location.hash = "#" + id;
        break;

      case "product-new":
        openProductModal(null);
        break;
      case "product-edit":
        openProductModal(id);
        break;
      case "product-toggle": {
        var makeActive = trigger.dataset.active !== "true";
        busy(trigger, true);
        API.admin.setProductActive(id, makeActive).then(function (r) {
          busy(trigger, false);
          if (!finish(r, makeActive ? "Product is live again." : "Product hidden from the shop.")) return;
          loadData().then(render);
        });
        break;
      }
      case "product-delete": {
        var product = S.products.filter(function (p) { return p.uuid === id; })[0] || {};
        confirmAction({
          title: "Delete product",
          subtitle: product.name || "",
          message: "Delete <strong>" + esc(product.name || "this product") + "</strong> permanently? " +
            "Products that customers have already ordered cannot be deleted — hide those instead, so past orders stay intact.",
          detail: "This cannot be undone.",
          danger: true,
          confirmLabel: "Delete permanently",
          run: function () { return API.admin.deleteProduct(id); },
          successMsg: "Product deleted."
        });
        break;
      }

      case "stock-save": {
        var input = document.querySelector('[data-stock-input="' + id + '"]');
        var newStock = num(input ? input.value : null);
        if (newStock === null || newStock < 0) { toast("Enter a valid stock number.", true); return; }
        busy(trigger, true);
        var save;
        if (trigger.dataset.kind === "variant") {
          save = API.admin.upsertVariant(trigger.dataset.product, {
            label: trigger.dataset.label,
            price: Number(trigger.dataset.price),
            stockQuantity: newStock,
            sortOrder: Number(trigger.dataset.sort || 0)
          });
        } else {
          save = API.admin.updateProduct(id, { stock_quantity: newStock });
        }
        save.then(function (r) {
          busy(trigger, false);
          if (!finish(r, "Stock updated.")) return;
          loadData().then(render);
        });
        break;
      }

      case "order-manage":
        openOrderModal(id);
        break;
      case "order-status": {
        var nextStatus = trigger.dataset.status;
        busy(trigger, true);
        API.admin.setOrderStatus(id, nextStatus).then(function (r) {
          busy(trigger, false);
          if (!finish(r, "Order moved to " + nextStatus + ".")) return;
          closeModal();
          loadData().then(function () { render(); openOrderModal(id); });
        });
        break;
      }
      case "order-payment": {
        busy(trigger, true);
        API.admin.setPaymentStatus(id, trigger.dataset.status).then(function (r) {
          busy(trigger, false);
          if (!finish(r, "Payment marked " + trigger.dataset.status + ".")) return;
          loadData().then(function () { render(); openOrderModal(id); });
        });
        break;
      }

      case "customer-role": {
        var targetRole = trigger.dataset.role;
        confirmAction({
          title: targetRole === "admin" ? "Grant administrator access" : "Revoke administrator access",
          subtitle: trigger.dataset.name || "",
          message: "Change <strong>" + esc(trigger.dataset.name || "this account") + "</strong> to <strong>" + esc(targetRole) + "</strong>?",
          detail: targetRole === "admin"
            ? "Administrators can manage products, prices, stock, orders and promotions."
            : "The account keeps its orders and profile but loses access to this dashboard.",
          danger: targetRole !== "admin",
          confirmLabel: targetRole === "admin" ? "Make administrator" : "Make customer",
          run: function () { return API.admin.setUserRole(id, targetRole); },
          successMsg: "Role updated."
        });
        break;
      }

      case "category-new":
        openCategoryModal(null);
        break;
      case "category-edit":
        openCategoryModal(id);
        break;
      case "category-delete":
        confirmAction({
          title: "Delete category",
          subtitle: id,
          message: "Delete the <strong>" + esc(id) + "</strong> category?",
          detail: "A category used by any product cannot be deleted — move those products first.",
          danger: true,
          confirmLabel: "Delete category",
          run: function () { return API.admin.deleteCategory(id); },
          successMsg: "Category deleted."
        });
        break;

      case "promo-new":
        openPromoModal(null);
        break;
      case "promo-edit":
        openPromoModal(id);
        break;
      case "promo-toggle": {
        var makeActive = trigger.dataset.active === "true";
        busy(trigger, true);
        API.admin.setPromoActive(id, makeActive).then(function (r) {
          busy(trigger, false);
          if (!finish(r, makeActive ? "Promo activated." : "Promo paused.")) return;
          loadData().then(render);
        });
        break;
      }
      case "promo-delete":
        confirmAction({
          title: "Delete promo code",
          subtitle: id,
          message: "Delete the promo code <strong>" + esc(id) + "</strong>?",
          detail: "Orders that already used this code keep their discount.",
          danger: true,
          confirmLabel: "Delete promo",
          run: function () { return API.admin.deletePromo(id); },
          successMsg: "Promo deleted."
        });
        break;

      case "export-products":
        downloadCsv("uage-products.csv",
          ["slug", "name", "category", "price", "old_price", "stock", "sizes", "active", "featured"],
          S.products.map(function (p) {
            return [p.id, p.name, p.category, p.price === null ? "" : p.price, p.oldPrice === null ? "" : p.oldPrice,
              productStock(p), (p.sizes || []).map(function (s) { return s.label + ":" + s.price; }).join(" | "),
              p.active === false ? "hidden" : "live", p.featured ? "yes" : "no"];
          }));
        break;
      case "export-inventory":
        downloadCsv("uage-inventory.csv",
          ["product", "slug", "size", "price", "stock", "value"],
          S.products.reduce(function (acc, p) {
            if (p.sizes && p.sizes.length) {
              p.sizes.forEach(function (v) {
                acc.push([p.name, p.id, v.label, v.price, v.stock, Number(v.price) * Number(v.stock || 0)]);
              });
            } else {
              acc.push([p.name, p.id, "", p.price, p.stock, Number(p.price || 0) * Number(p.stock || 0)]);
            }
            return acc;
          }, []));
        break;
      case "export-orders":
        downloadCsv("uage-orders.csv",
          ["order", "date", "customer", "phone", "email", "city", "items", "subtotal", "discount", "delivery", "total", "payment_method", "payment_status", "status"],
          S.orders.map(function (o) {
            var items = o.items.map(function (i) { return i.qty + "x " + i.name + (i.size ? " (" + i.size + ")" : ""); }).join(" | ");
            return [o.id, o.createdAt, o.customer, o.phone, o.email, o.city, items,
              o.subtotal, o.discount, o.delivery, o.total, o.paymentMethod, o.paymentStatus, o.status];
          }));
        break;
      case "export-customers":
        downloadCsv("uage-customers.csv",
          ["name", "email", "phone", "joined", "role", "orders", "spent"],
          S.customers.map(function (c) {
            return [c.name, c.email, c.phone, c.joined, c.role || "customer", ordersForUser(c.uuid).length, spentForUser(c.uuid)];
          }));
        break;
    }
  }

  /* =================================================================== BOOT */

  function boot() {
    if (!API || typeof API.isConfigured !== "function") {
      els.title.textContent = "Unavailable";
      els.subtitle.textContent = "The data layer could not be loaded.";
      viewShell('<i class="fas fa-triangle-exclamation"></i><h3>Data layer missing</h3>' +
        "<p><code>js/api.js</code> did not load. Check the browser console, then reload.</p>");
      return;
    }

    if (!API.isConfigured()) { renderNotConfigured(); return; }

    setLoadingState();
    API.getSession().then(function (r) {
      if (!r.data) { renderSignIn(); return; }
      return Promise.all([API.getUser(), API.getProfile()]).then(function (res) {
        S.user = res[0].data || null;
        S.profile = res[1].data || null;
        return API.admin.checkAccess();
      }).then(function (access) {
        S.access = Boolean(access && access.data);
        if (!S.access) { renderNoAccess(); return; }
        showUserChrome();
        return loadData().then(route);
      });
    });
  }

  function setLoadingState() {
    els.title.textContent = "Dashboard";
    els.subtitle.textContent = "Checking your access…";
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { bindShell(); boot(); });
  } else {
    bindShell();
    boot();
  }
})();
