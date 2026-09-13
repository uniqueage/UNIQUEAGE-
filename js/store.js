/* ===========================================================================
 * UAGE — storefront adapter
 * ---------------------------------------------------------------------------
 * The single bridge between the existing storefront (app.js) and the backend.
 * app.js keeps rendering exactly as it always did; this file decides WHERE its
 * data comes from and does every backend call for it.
 *
 * Two modes, chosen at runtime:
 *
 *   live      the project is configured AND the migrations have been applied.
 *             Catalog, accounts, orders and quotes all come from Postgres.
 *
 *   bundled   Supabase is unset, unreachable, or the schema is not installed
 *             yet. The shop falls back to the bundled data.js catalog and the
 *             offline preview account, so the site is never broken — it just
 *             is not backed by the database yet.
 *
 * Security rules this file exists to keep:
 *   * localStorage is a DISPLAY CACHE only — a photo of who was last signed in
 *     so the header can render instantly. It is never consulted to decide what
 *     a visitor is allowed to do. Every read and write is authorised by RLS in
 *     the database.
 *   * No password is ever stored on the device.
 *   * No price, discount, delivery fee or total is calculated here or trusted
 *     from here. The cart asks the server (checkout_preview) and the order is
 *     priced again inside place_order().
 * =========================================================================== */
(function () {
  "use strict";

  var API = window.UAGE_API;
  var DATA = window.UAGE_DATA;

  var USER_KEY = "uage_user";
  var DEFAULT_CATALOG_TIMEOUT_MS = 2500;

  /**
   * How long to wait for the catalog before painting from bundled data. Kept
   * short so a dead network can never leave a visitor looking at empty grids;
   * overridable via window.UAGE_STORE_TIMEOUT_MS (used by the test suite).
   */
  function catalogTimeoutMs() {
    var override = Number(window.UAGE_STORE_TIMEOUT_MS);
    return isFinite(override) && override > 0 ? override : DEFAULT_CATALOG_TIMEOUT_MS;
  }

  var state = {
    probed: false,
    live: false,
    catalogSource: "bundled"
  };

  /* ------------------------------------------------------------- utilities */

  function readCache() {
    try { return JSON.parse(localStorage.getItem(USER_KEY)) || null; }
    catch (e) { return null; }
  }

  function writeCache(user) {
    try {
      if (!user) localStorage.removeItem(USER_KEY);
      else localStorage.setItem(USER_KEY, JSON.stringify(user));
    } catch (e) { /* private mode — the app still works, just without the cache */ }
  }

  function timeout(ms) {
    return new Promise(function (resolve) { setTimeout(function () { resolve(null); }, ms); });
  }

  /** Replaces an array's CONTENTS so every existing reference sees the new data. */
  function replaceInPlace(target, items) {
    if (!target) return;
    target.length = 0;
    (items || []).forEach(function (item) { target.push(item); });
  }

  function displayName(user) {
    if (!user) return "";
    return user.name || (user.email ? String(user.email).split("@")[0] : "");
  }

  /* ------------------------------------------------------------ live check */

  /**
   * Is the backend usable? Configured *and* migrated. Probed once per page.
   * Never throws: any failure means "use the bundled catalog".
   */
  function live() {
    if (state.probed) return Promise.resolve(state.live);
    if (!API || typeof API.isConfigured !== "function" || !API.isConfigured()) {
      state.probed = true;
      state.live = false;
      return Promise.resolve(false);
    }
    return API.admin.checkSchema().then(function (r) {
      state.probed = true;
      state.live = Boolean(r && r.data && r.data.ready);
      return state.live;
    }, function () {
      state.probed = true;
      state.live = false;
      return false;
    });
  }

  /** Synchronous view of the last probe — for code that cannot await. */
  function isLive() {
    return state.live;
  }

  /* --------------------------------------------------------------- catalog */

  /**
   * Resolves once UAGE_DATA holds the catalog to render — from the database
   * when possible, otherwise the bundled file (already in place).
   *
   * The swap is done IN PLACE so app.js's reference to UAGE_DATA sees it, and
   * the fetch is raced against a timeout so a dead network cannot leave a
   * visitor staring at empty grids.
   */
  function catalog() {
    if (!DATA) return Promise.resolve({ source: "none", live: false });

    return live().then(function (isLive) {
      if (!isLive) return { source: "bundled", live: false };

      /* Tolerate a partial API surface rather than throwing: anything missing
       * means "render from the bundled catalog". */
      if (typeof API.listProducts !== "function") {
        return { source: "bundled", live: true, degraded: true };
      }

      var fetched = Promise.all([
        API.listProducts(),
        typeof API.listCategories === "function"
          ? API.listCategories()
          : Promise.resolve({ data: [] })
      ]);
      return Promise.race([fetched, timeout(catalogTimeoutMs())]).then(function (res) {
        if (!res || !res[0] || res[0].error || !res[0].data || !res[0].data.length) {
          return { source: "bundled", live: true, degraded: true };
        }
        replaceInPlace(DATA.products, res[0].data);
        if (res[1] && !res[1].error && res[1].data && res[1].data.length) {
          replaceInPlace(DATA.categories, res[1].data);
        }
        state.catalogSource = "database";
        return { source: "database", live: true, count: res[0].data.length };
      }, function () {
        return { source: "bundled", live: true, degraded: true };
      });
    });
  }

  function catalogSource() {
    return state.catalogSource;
  }

  /* ------------------------------------------------------------------ auth */

  /** The cached display record. Never an authorisation decision. */
  function user() {
    return readCache();
  }

  /** Resolves the real session and refreshes the display cache. */
  function me() {
    return live().then(function (isLive) {
      if (!isLive) return readCache();
      return API.getUser().then(function (r) {
        var u = r.data;
        if (!u) { writeCache(null); return null; }
        return API.getProfile().then(function (p) {
          var record = {
            uuid: u.id,
            name: (p.data && p.data.name) ||
              (u.user_metadata && u.user_metadata.full_name) ||
              String(u.email || "").split("@")[0],
            email: u.email || "",
            phone: (p.data && p.data.phone) || "",
            joined: (p.data && p.data.joined) || ""
          };
          writeCache(record);
          return record;
        });
      });
    });
  }

  function signUp(fields) {
    var f = fields || {};
    return live().then(function (isLive) {
      if (!isLive) {
        /* Offline preview: record who is browsing so the account page has
         * something to show. No password is stored, and no real account
         * exists. */
        var record = {
          name: f.name,
          email: f.email,
          joined: new Date().toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" })
        };
        writeCache(record);
        return { data: { offline: true, user: record }, error: null };
      }
      return API.signUp(f).then(function (r) {
        if (r.error) return r;
        if (r.data && r.data.needsEmailConfirmation) {
          return { data: { needsEmailConfirmation: true }, error: null };
        }
        return me().then(function () { return { data: { user: user() }, error: null }; });
      });
    });
  }

  function signIn(email, password) {
    return live().then(function (isLive) {
      if (!isLive) {
        var cached = readCache();
        if (cached && String(cached.email).toLowerCase() === String(email).toLowerCase()) {
          return { data: { user: cached, offline: true }, error: null };
        }
        return {
          data: null,
          error: { code: "AUTH", message: "No account matches that email in this preview — sign up to continue." }
        };
      }
      return API.signIn(email, password).then(function (r) {
        if (r.error) return r;
        return me().then(function (record) { return { data: { user: record }, error: null }; });
      });
    });
  }

  /**
   * Signs out. The display cache is cleared immediately either way, because the
   * visitor asked to be signed out. But if the server call fails we say so
   * instead of pretending: a still-live session token would sign them straight
   * back in on the next page load.
   */
  function signOut() {
    var couldNotReachServer = {
      data: { signedOut: true },
      error: {
        code: "NETWORK",
        message: "Signed out on this device, but we couldn't reach the server. Please try again."
      }
    };

    return live().then(function (isLive) {
      writeCache(null);
      if (!isLive || typeof API.signOut !== "function") return { data: { signedOut: true }, error: null };

      return API.signOut().then(function (r) {
        if (r && r.error) return couldNotReachServer;
        return { data: { signedOut: true }, error: null };
      }, function () { return couldNotReachServer; });
    });
  }

  function updateProfile(fields) {
    return live().then(function (isLive) {
      if (!isLive) return { data: null, error: { code: "OFFLINE", message: "Connect the backend to edit your profile." } };
      return API.updateProfile(fields).then(function (r) {
        if (r.error) return r;
        return me().then(function (record) { return { data: record, error: null }; });
      });
    });
  }

  function uploadAvatar(file) {
    return live().then(function (isLive) {
      if (!isLive) return { data: null, error: { code: "OFFLINE", message: "Connect the backend to upload a photo." } };
      return API.uploadAvatar(file);
    });
  }

  /* ---------------------------------------------------------------- orders */

  function myOrders() {
    return live().then(function (isLive) {
      if (!isLive) return { data: null, error: null, live: false };
      return API.listMyOrders().then(function (r) {
        return { data: r.data, error: r.error, live: true };
      });
    });
  }

  /**
   * Prices the basket on the server. Returns the same fields the cart and
   * checkout pages render, so neither ever has to compute money itself.
   */
  function quote(fields) {
    var f = fields || {};
    return live().then(function (isLive) {
      if (!isLive || !API.previewCheckout) {
        return { data: null, error: null, live: false };
      }
      return API.previewCheckout(f).then(function (r) {
        return { data: r.data, error: r.error, live: true };
      });
    });
  }

  function placeOrder(fields) {
    return live().then(function (isLive) {
      if (!isLive) {
        return {
          data: null,
          error: { code: "OFFLINE", message: "The store is not connected to its database yet, so orders cannot be placed." }
        };
      }
      return API.placeOrder(fields);
    });
  }

  /** True when a signed-in customer exists and orders can be created. */
  function canOrder() {
    return live().then(function (isLive) {
      if (!isLive) return false;
      return API.getUser().then(function (r) { return Boolean(r.data); });
    });
  }

  /* ---------------------------------------------------------------- export */

  window.UAGE_STORE = {
    /* mode */
    live: live,
    isLive: isLive,
    catalog: catalog,
    catalogSource: catalogSource,

    /* catalog helpers used by the UI */
    name: function () { return displayName(readCache()); },

    /* auth */
    user: user,
    me: me,
    signUp: signUp,
    signIn: signIn,
    signOut: signOut,
    updateProfile: updateProfile,
    uploadAvatar: uploadAvatar,

    /* orders */
    myOrders: myOrders,
    quote: quote,
    placeOrder: placeOrder,
    canOrder: canOrder
  };
})();
