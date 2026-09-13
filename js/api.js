/* ===========================================================================
 * UAGE — data-access layer (the ONLY module that talks to Supabase)
 * ---------------------------------------------------------------------------
 * UI code never builds a query. It calls window.UAGE_API and gets back a
 * normalised { data, error } result:
 *
 *     error === null   -> success, use `data`
 *     error !== null   -> { code, message } with a message safe to display
 *
 * Technical detail is logged to the console, never shown to the user, so no
 * stack traces, table names or credentials leak into the UI.
 *
 * The client library is fetched on demand, so pages that do not use Supabase
 * pay nothing. If the config is still placeholder values, every call resolves
 * to a NOT_CONFIGURED error instead of throwing — the existing data.js /
 * localStorage paths keep working untouched.
 * =========================================================================== */
(function () {
  "use strict";

  var CONFIG = window.UAGE_SUPABASE_CONFIG || {};
  var CDN = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js" +
    (CONFIG.clientVersion || "@2") + "/dist/umd/supabase.js";

  var clientPromise = null;
  var client = null;

  /* ------------------------------------------------------------------ errors */

  /* Codes raised by OUR functions/constraints carry messages written for
   * humans, so they are safe to show. Everything else is generic. */
  var FRIENDLY_CODES = {
    "23505": "That already exists.",
    "23503": "That item can no longer be used.",
    "22P02": "That value isn't valid.",
    "PGRST116": "We couldn't find what you asked for.",
    "42P01": "Something went wrong on our side.",
    "42501": "You don't have permission to do that."
  };

  var GENERIC = "Something went wrong. Please try again.";

  function fail(code, message) {
    return Promise.resolve({ data: null, error: { code: code, message: message } });
  }

  /** Turns anything thrown/returned by supabase-js into a safe {code,message}. */
  function toError(err) {
    if (!err) return null;

    var code = String(err.code || err.status || "UNKNOWN");
    var raw = String(err.message || "").trim();

    console.warn("[UAGE_API] Supabase error", {
      code: code,
      message: raw,
      details: err.details,
      hint: err.hint
    });

    /* Let our own auth/validation messages through — they are written for
     * customers and contain no internal detail. */
    if (raw && /^(Please |Your |That |Only |Each |An item|One of|\u201c)/i.test(raw)) {
      return { code: code, message: raw };
    }

    if (raw && (code === "22023" || code === "23514")) {
      return { code: code, message: raw };
    }

    return { code: code, message: FRIENDLY_CODES[code] || GENERIC };
  }

  function ok(data) {
    return Promise.resolve({ data: data, error: null });
  }

  function notConfigured() {
    return fail(
      "NOT_CONFIGURED",
      "Sign-in isn't available yet. Please check back shortly."
    );
  }

  /* ------------------------------------------------------------------ client */

  function loadLibrary() {
    if (window.supabase && window.supabase.createClient) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = CDN;
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error("Could not load the Supabase client library.")); };
      document.head.appendChild(s);
    });
  }

  /** Resolves to the supabase client, or null when the site isn't configured. */
  function getClient() {
    if (client) return Promise.resolve(client);
    if (clientPromise) return clientPromise;

    if (!CONFIG.isConfigured || !CONFIG.isConfigured()) return Promise.resolve(null);

    /* Hard stop if a service-role / secret key was pasted into public config.
     * Shipping one would hand full database access to every visitor. */
    if (CONFIG.looksLikeSecretKey && CONFIG.looksLikeSecretKey()) {
      console.error(
        "[UAGE_API] BLOCKED: a secret/service-role key was placed in " +
          "js/supabase-config.js. That key must never reach the browser. " +
          "Rotate it, then use the anon public key here instead."
      );
      return Promise.resolve(null);
    }

    clientPromise = loadLibrary()
      .then(function () {
        client = window.supabase.createClient(CONFIG.url, CONFIG.anonKey, {
          auth: {
            persistSession: true,        // session survives reloads
            autoRefreshToken: true,
            detectSessionInUrl: true,    // needed for password-reset links
            storageKey: "uage_auth"
          }
        });
        return client;
      })
      .catch(function (err) {
        console.warn("[UAGE_API] client init failed", err);
        return null;
      });

    return clientPromise;
  }

  /** Wraps a call that needs a client. */
  function withClient(fn) {
    return getClient().then(function (c) {
      if (!c) return notConfigured();
      try {
        return Promise.resolve(fn(c)).then(
          function (res) {
            if (res && res.error) return { data: null, error: toError(res.error) };
            return { data: res ? res.data : null, error: null };
          },
          function (err) { return { data: null, error: toError(err) }; }
        );
      } catch (err) {
        return { data: null, error: toError(err) };
      }
    });
  }

  /* ------------------------------------------------------------------- shape
   * The database stores normalised rows; the existing storefront renders the
   * data.js shape. These mappers keep cardHtml(), initProduct() and friends
   * working unchanged — `id` is the slug (so product.html?id=… still works)
   * and `uuid` carries the database identifier for backend calls.
   * ------------------------------------------------------------------------- */

  function toUiCategory(row) {
    return {
      slug: row.slug,
      name: row.name,
      icon: row.icon,
      tag: row.tag || "",
      blurb: row.blurb || "",
      features: row.features || []
    };
  }

  function toUiProduct(row, variants) {
    var sizes = (variants || [])
      .slice()
      .sort(function (a, b) { return (a.sort_order || 0) - (b.sort_order || 0); })
      .map(function (v) {
        return { label: v.label, price: Number(v.price), stock: v.stock_quantity, uuid: v.id };
      });

    var out = {
      id: row.slug,
      uuid: row.id,
      name: row.name,
      category: row.category,
      desc: row.description || "",
      badge: row.badge || "",
      rating: Number(row.rating || 0),
      reviews: row.review_count || 0,
      featured: !!row.featured,
      image: row.image_url,
      stock: row.stock_quantity,
      active: !!row.is_active,
      price: row.price === null || row.price === undefined ? null : Number(row.price),
      oldPrice: row.old_price === null || row.old_price === undefined ? null : Number(row.old_price)
    };
    if (sizes.length) out.sizes = sizes;
    return out;
  }

  function toUiOrder(row) {
    /* order_items is embedded by ORDER_WITH_ITEMS; tolerate its absence. */
    var items = (row.order_items || []).map(function (i) {
      return {
        name: i.product_name,
        size: i.variant_label || "",
        qty: i.quantity,
        price: Number(i.unit_price),
        lineTotal: Number(i.unit_price) * i.quantity
      };
    });

    var itemCount = 0;
    items.forEach(function (i) { itemCount += i.qty; });

    return {
      id: row.order_number,
      uuid: row.id,
      /* The storefront only needs the fields above; the admin dashboard uses
       * these extra ones to identify the customer and fulfil the order. All of
       * it comes from the customer's own row (or an admin's RLS grant). */
      userId: row.user_id,
      createdAt: row.created_at,
      date: new Date(row.created_at).toLocaleDateString("en-NG", {
        day: "numeric", month: "short", year: "numeric"
      }),
      status: row.status,
      paymentMethod: row.payment_method,
      paymentStatus: row.payment_status,
      customer: row.delivery_name,
      phone: row.delivery_phone,
      email: row.delivery_email || "",
      address: row.delivery_address,
      city: row.delivery_city,
      notes: row.notes || "",
      subtotal: Number(row.subtotal),
      discount: Number(row.discount),
      delivery: Number(row.delivery_fee),
      total: Number(row.total_amount),
      promoCode: row.promo_code || null,
      itemCount: itemCount,
      items: items
    };
  }

  function toUiPromo(row) {
    return {
      code: row.code,
      percentOff: Number(row.percent_off),
      minSubtotal: Number(row.min_subtotal),
      maxUses: row.max_uses === null || row.max_uses === undefined ? null : row.max_uses,
      uses: row.uses,
      isActive: !!row.is_active,
      expiresAt: row.expires_at || null,
      expired: row.expires_at ? new Date(row.expires_at).getTime() < Date.now() : false
    };
  }

  function toUiProfile(row) {
    if (!row) return null;
    return {
      uuid: row.id,
      name: row.full_name,
      email: row.email || "",
      phone: row.phone || "",
      avatarUrl: row.avatar_url || "",
      joinedAt: row.created_at,
      joined: new Date(row.created_at).toLocaleDateString("en-NG", {
        day: "numeric", month: "short", year: "numeric"
      })
    };
  }

  var ORDER_WITH_ITEMS = "*, order_items(*)";

  /* ====================================================== catalog (public) === */

  function listCategories() {
    return withClient(function (c) {
      return c.from("categories").select("slug,name,icon,tag,blurb,features").order("sort_order");
    }).then(function (r) {
      if (r.error) return r;
      return ok((r.data || []).map(toUiCategory));
    });
  }

  /** All active products (admins also get inactive ones). */
  function listProducts(opts) {
    var options = opts || {};
    return withClient(function (c) {
      var q = c.from("products").select("*, product_variants(*)");
      if (!options.includeInactive) q = q.eq("is_active", true);
      if (options.category) q = q.eq("category", options.category);
      if (options.featured) q = q.eq("featured", true);
      return q.order("created_at", { ascending: true });
    }).then(function (r) {
      if (r.error) return r;
      return ok((r.data || []).map(function (row) {
        return toUiProduct(row, row.product_variants);
      }));
    });
  }

  function getProduct(slug) {
    if (!slug) return fail("BAD_REQUEST", "No product was specified.");
    return withClient(function (c) {
      return c
        .from("products")
        .select("*, product_variants(*)")
        .eq("slug", slug)
        .maybeSingle();
    }).then(function (r) {
      if (r.error) return r;
      if (!r.data) return fail("PGRST116", "We couldn't find that product.");
      return ok(toUiProduct(r.data, r.data.product_variants));
    });
  }

  /**
   * Every product, inactive ones included. RLS only returns inactive rows to
   * administrators, so this is safe to expose — a visitor simply gets the
   * active catalog back.
   */
  function listAllProducts() {
    return listProducts({ includeInactive: true });
  }

  /* ============================================================== auth === */

  function signUp(fields) {
    var f = fields || {};
    return withClient(function (c) {
      return c.auth.signUp({
        email: f.email,
        password: f.password,
        options: { data: { full_name: f.name || "", phone: f.phone || "" } }
      });
    }).then(function (r) {
      if (r.error) return r;
      /* With email confirmation switched on, there is no session yet. */
      if (r.data && r.data.user && !r.data.session) {
        return ok({ needsEmailConfirmation: true, user: r.data.user });
      }
      return ok({ needsEmailConfirmation: false, user: r.data ? r.data.user : null });
    });
  }

  function signIn(email, password) {
    return withClient(function (c) {
      return c.auth.signInWithPassword({ email: email, password: password });
    }).then(function (r) {
      if (r.error) {
        /* Don't reveal whether the address exists. */
        return fail("AUTH", "That email and password don't match an account.");
      }
      return ok({ user: r.data.user, session: r.data.session });
    });
  }

  function signOut() {
    return withClient(function (c) { return c.auth.signOut(); });
  }

  function getSession() {
    return withClient(function (c) { return c.auth.getSession(); }).then(function (r) {
      if (r.error) return r;
      return ok(r.data ? r.data.session : null);
    });
  }

  function getUser() {
    return getClient().then(function (c) {
      if (!c) return ok(null);
      return c.auth.getUser().then(
        function (res) { return ok(res.data ? res.data.user : null); },
        function () { return ok(null); }
      );
    });
  }

  /** Subscribe to sign-in / sign-out. Returns an unsubscribe function. */
  function onAuthChange(handler) {
    var unsub = function () {};
    getClient().then(function (c) {
      if (!c || typeof handler !== "function") return;
      var res = c.auth.onAuthStateChange(function (event, session) {
        handler(event, session);
      });
      if (res && res.data && res.data.subscription) {
        unsub = function () { res.data.subscription.unsubscribe(); };
      }
    });
    return function () { unsub(); };
  }

  function sendPasswordReset(email) {
    return withClient(function (c) {
      return c.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin + window.location.pathname.replace(/[^/]*$/, "signup.html")
      });
    }).then(function (r) {
      if (r.error) return r;
      return ok({ sent: true });
    });
  }

  function updatePassword(newPassword) {
    return withClient(function (c) { return c.auth.updateUser({ password: newPassword }); });
  }

  /* =========================================================== profile === */

  /**
   * Resolves the signed-in user, then runs `fn(client, user)`.
   * Always identify the row by user id rather than leaning on RLS alone: an
   * administrator's policies match EVERY row, so an unfiltered read or update
   * here would hit other people's profiles.
   */
  function withUser(fn) {
    return getClient().then(function (c) {
      if (!c) return notConfigured();
      return c.auth.getUser().then(
        function (res) {
          var user = res && res.data ? res.data.user : null;
          if (!user) return { data: null, error: { code: "AUTH", message: "Please sign in to continue." } };
          return fn(c, user);
        },
        function () {
          return { data: null, error: { code: "AUTH", message: "Please sign in to continue." } };
        }
      );
    });
  }

  function getProfile() {
    return withUser(function (c, user) {
      return c
        .from("profiles")
        .select("*")
        .eq("id", user.id)
        .maybeSingle()
        .then(function (r) {
          if (r.error) return { data: null, error: toError(r.error) };
          return ok(toUiProfile(r.data));
        });
    });
  }

  function updateProfile(fields) {
    var f = fields || {};
    return withUser(function (c, user) {
      return c
        .from("profiles")
        .update({ full_name: f.name, phone: f.phone })
        .eq("id", user.id)          // never unfiltered: admins match every row
        .select()
        .maybeSingle()
        .then(function (r) {
          if (r.error) return { data: null, error: toError(r.error) };
          return ok(toUiProfile(r.data));
        });
    });
  }

  /** Uploads to avatars/{uid}/… (the only path the storage policy permits). */
  function uploadAvatar(file) {
    return withUser(function (c, user) {
      var ext = (file.name.split(".").pop() || "png").toLowerCase();
      var path = user.id + "/avatar." + ext;

      return c.storage
        .from("avatars")
        .upload(path, file, { upsert: true, cacheControl: "3600" })
        .then(function (up) {
          if (up.error) return { data: null, error: toError(up.error) };
          var url = c.storage.from("avatars").getPublicUrl(up.data.path).data.publicUrl;
          return c
            .from("profiles")
            .update({ avatar_url: url })
            .eq("id", user.id)
            .then(function (u) {
              if (u.error) return { data: null, error: toError(u.error) };
              return ok({ url: url });
            });
        });
    });
  }

  /* ============================================================ orders === */

  /** Resolves the UI cart (slugs + size labels) to database uuids. */
  function resolveCart(items) {
    var products = listProducts().then(function (r) {
      if (r.error) throw r.error;
      return r.data;
    });

    return products.then(function (list) {
      var bySlug = {};
      list.forEach(function (p) { bySlug[p.id] = p; });

      var payload = [];
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var p = bySlug[item.id];
        if (!p) throw { code: "22023", message: "An item in your cart is no longer available." };

        if (p.sizes && p.sizes.length) {
          var size = null;
          for (var j = 0; j < p.sizes.length; j++) {
            if (p.sizes[j].label === item.size) { size = p.sizes[j]; break; }
          }
          if (!size) throw { code: "22023", message: "Please choose a size for " + p.name + "." };
          payload.push({ variant_id: size.uuid, quantity: item.qty });
        } else {
          if (p.price === null) throw { code: "22023", message: p.name + " isn't available right now." };
          payload.push({ product_id: p.uuid, quantity: item.qty });
        }
      }
      return payload;
    });
  }

  /**
   * Places an order. Prices, discounts, delivery and stock are all decided by
   * the database — nothing about money is sent from here.
   *
   * items: [{ id: slug, size: label, qty: n }]
   */
  function placeOrder(fields) {
    var f = fields || {};
    if (!f.items || !f.items.length) return fail("22023", "Your cart is empty.");

    return resolveCart(f.items)
      .then(function (payload) {
        return withClient(function (c) {
          return c.rpc("place_order", {
            p_items: payload,
            p_delivery: f.delivery || {},
            p_payment_method: f.paymentMethod,
            p_promo_code: f.promoCode || null
          });
        });
      })
      .then(function (r) {
        if (r && r.error) return r;
        var raw = r.data;
        return ok({
          orderId: raw.order_id,
          orderNumber: raw.order_number,
          status: raw.status,
          subtotal: Number(raw.subtotal),
          discount: Number(raw.discount),
          delivery: Number(raw.delivery_fee),
          total: Number(raw.total_amount),
          itemCount: raw.item_count
        });
      })
      .catch(function (err) { return { data: null, error: toError(err) }; });
  }

  function listMyOrders() {
    return withClient(function (c) {
      return c
        .from("orders")
        .select(ORDER_WITH_ITEMS)
        .order("created_at", { ascending: false });
    }).then(function (r) {
      if (r.error) return r;
      return ok((r.data || []).map(toUiOrder));
    });
  }

  /* ============================================================= admin === */

  var admin = {
    /**
     * Server-side "am I an administrator?" check. This calls the database
     * function public.is_admin(), which reads public.user_roles. Nothing is
     * cached in the browser, so a customer cannot fake their way in by editing
     * a variable — every admin read/write is still gated by RLS regardless.
     */
    checkAccess: function () {
      return withClient(function (c) { return c.rpc("is_admin"); }).then(function (r) {
        if (r.error) return ok(false);
        return ok(Boolean(r.data));
      });
    },

    stats: function () {
      return withClient(function (c) { return c.rpc("admin_dashboard_stats"); });
    },

    /* --- products (RLS enforces admin; the server rejects anyone else) --- */
    /**
     * Creates a product, optionally with its size variants.
     *
     * The variants are sent as a NESTED insert so PostgREST writes the product
     * and its sizes in a single transaction. That matters: a size-priced
     * product has price = NULL, and the deferred database constraint
     * "a product must be priced somewhere" is only satisfied once the variant
     * rows exist. Two separate requests would fail at the first commit.
     */
    createProduct: function (p, variants) {
      return withClient(function (c) {
        var row = {
          slug: p.slug, name: p.name, description: p.description || "",
          category: p.category, price: p.price === undefined ? null : p.price,
          old_price: p.oldPrice === undefined ? null : p.oldPrice,
          badge: p.badge || null, image_url: p.imageUrl,
          is_active: p.isActive !== false, featured: !!p.featured,
          stock_quantity: p.stockQuantity || 0,
          rating: p.rating === undefined || p.rating === null ? 0 : p.rating
        };

        if (variants && variants.length) {
          row.product_variants = variants.map(function (v, i) {
            return {
              label: v.label,
              price: v.price,
              stock_quantity: v.stockQuantity || 0,
              sort_order: v.sortOrder === undefined ? i : v.sortOrder
            };
          });
        }

        return c.from("products").insert(row).select("*, product_variants(*)").maybeSingle();
      }).then(function (r) {
        if (r.error) return r;
        /* The write can succeed without the row coming back (for example when
         * the caller may insert but not re-read). Report success rather than
         * dereferencing null. */
        if (!r.data) return ok(null);
        return ok(toUiProduct(r.data, r.data.product_variants));
      });
    },

    updateProduct: function (uuid, changes) {
      return withClient(function (c) {
        return c.from("products").update(changes).eq("id", uuid).select().maybeSingle();
      }).then(function (r) {
        if (r.error) return r;
        return ok(r.data);
      });
    },

    /** Soft delete — keeps purchase history intact. */
    setProductActive: function (uuid, isActive) {
      return admin.updateProduct(uuid, { is_active: !!isActive });
    },

    upsertVariant: function (productUuid, v) {
      return withClient(function (c) {
        return c.from("product_variants").upsert({
          product_id: productUuid, label: v.label, price: v.price,
          stock_quantity: v.stockQuantity || 0, sort_order: v.sortOrder || 0
        }, { onConflict: "product_id,label" }).select().maybeSingle();
      }).then(function (r) {
        if (r.error) return r;
        return ok(r.data);
      });
    },

    deleteVariant: function (variantUuid) {
      return withClient(function (c) {
        return c.from("product_variants").delete().eq("id", variantUuid);
      });
    },

    /** Product images live in Storage; only the URL goes in the database. */
    uploadProductImage: function (file) {
      return withClient(function (c) {
        var ext = (file.name.split(".").pop() || "jpg").toLowerCase();
        var path = Date.now() + "-" + Math.random().toString(36).slice(2, 8) + "." + ext;
        return c.storage.from("product-images").upload(path, file, { cacheControl: "3600" });
      }).then(function (r) {
        if (r.error) return r;
        return ok({
          url: client.storage.from("product-images").getPublicUrl(r.data.path).data.publicUrl
        });
      });
    },

    /* --- orders --- */
    listOrders: function () {
      return withClient(function (c) {
        return c.from("orders").select(ORDER_WITH_ITEMS).order("created_at", { ascending: false });
      }).then(function (r) {
        if (r.error) return r;
        return ok((r.data || []).map(toUiOrder));
      });
    },

    setOrderStatus: function (uuid, status) {
      return withClient(function (c) {
        return c.from("orders").update({ status: status }).eq("id", uuid).select().maybeSingle();
      }).then(function (r) {
        if (r.error) return r;
        return ok(r.data);
      });
    },

    setPaymentStatus: function (uuid, status) {
      return withClient(function (c) {
        return c.rpc("admin_set_payment_status", { p_order_id: uuid, p_status: status });
      }).then(function (r) {
        if (r.error) return r;
        return ok({ updated: true });
      });
    },

    /* --- customers (email is visible to admins through RLS) --- */
    listCustomers: function () {
      return withClient(function (c) {
        return c.from("profiles").select("id,full_name,email,phone,created_at").order("created_at", { ascending: false });
      }).then(function (r) {
        if (r.error) return r;
        return ok((r.data || []).map(toUiProfile));
      });
    },

    /**
     * user_id -> role for every account. RLS only returns other people's rows
     * to an administrator, so this is empty for a normal customer.
     */
    listRoles: function () {
      return withClient(function (c) {
        return c.from("user_roles").select("user_id,role");
      }).then(function (r) {
        if (r.error) return r;
        var map = {};
        (r.data || []).forEach(function (row) { map[row.user_id] = row.role; });
        return ok(map);
      });
    },

    setUserRole: function (uuid, role) {
      return withClient(function (c) {
        return c.rpc("admin_set_user_role", { p_user_id: uuid, p_role: role });
      }).then(function (r) {
        if (r.error) return r;
        return ok({ updated: true });
      });
    },

    /** Hard delete. Order history is protected by ON DELETE RESTRICT, so a
     *  product that has ever been ordered can only be deactivated. */
    deleteProduct: function (uuid) {
      return withClient(function (c) {
        return c.from("products").delete().eq("id", uuid);
      }).then(function (r) {
        if (r.error) return r;
        return ok({ deleted: true });
      });
    },

    /* --- categories (admins may write; the seed owns the defaults) --- */
    saveCategory: function (cat) {
      return withClient(function (c) {
        return c.from("categories").upsert({
          slug: String(cat.slug || "").trim(),
          name: cat.name,
          icon: cat.icon || "fa-tag",
          tag: cat.tag || null,
          blurb: cat.blurb || null,
          features: cat.features || [],
          sort_order: cat.sortOrder || 0
        }, { onConflict: "slug" }).select().maybeSingle();
      }).then(function (r) {
        if (r.error) return r;
        if (!r.data) return ok(null);
        return ok(toUiCategory(r.data));
      });
    },

    deleteCategory: function (slug) {
      return withClient(function (c) {
        return c.from("categories").delete().eq("slug", slug);
      }).then(function (r) {
        if (r.error) return r;
        return ok({ deleted: true });
      });
    },

    /* --- promo codes (never readable by the public) --- */
    listPromos: function () {
      return withClient(function (c) {
        return c.from("promo_codes").select("*").order("created_at", { ascending: false });
      }).then(function (r) {
        if (r.error) return r;
        return ok((r.data || []).map(toUiPromo));
      });
    },

    savePromo: function (p) {
      return withClient(function (c) {
        return c.from("promo_codes").upsert({
          /* Normalise here too: the database CHECK requires upper-case with no
           * surrounding whitespace, so a stray space would be rejected. */
          code: String(p.code || "").trim().toUpperCase(),
          percent_off: p.percentOff,
          min_subtotal: p.minSubtotal || 0,
          max_uses: p.maxUses === undefined || p.maxUses === "" ? null : p.maxUses,
          is_active: p.isActive !== false,
          expires_at: p.expiresAt || null
        }, { onConflict: "code" }).select().maybeSingle();
      }).then(function (r) {
        if (r.error) return r;
        if (!r.data) return ok(null);
        return ok(toUiPromo(r.data));
      });
    },

    setPromoActive: function (code, isActive) {
      return withClient(function (c) {
        return c.from("promo_codes").update({ is_active: !!isActive }).eq("code", code);
      }).then(function (r) {
        if (r.error) return r;
        return ok({ updated: true });
      });
    },

    deletePromo: function (code) {
      return withClient(function (c) {
        return c.from("promo_codes").delete().eq("code", code);
      }).then(function (r) {
        if (r.error) return r;
        return ok({ deleted: true });
      });
    }
  };

  /* ================================================================ export */

  window.UAGE_API = {
    /* diagnostics */
    isConfigured: function () {
      return Boolean(CONFIG.isConfigured && CONFIG.isConfigured());
    },
    ready: getClient,

    /* catalog */
    listCategories: listCategories,
    listProducts: listProducts,
    listAllProducts: listAllProducts,
    getProduct: getProduct,

    /* auth */
    signUp: signUp,
    signIn: signIn,
    signOut: signOut,
    getSession: getSession,
    getUser: getUser,
    onAuthChange: onAuthChange,
    sendPasswordReset: sendPasswordReset,
    updatePassword: updatePassword,

    /* profile */
    getProfile: getProfile,
    updateProfile: updateProfile,
    uploadAvatar: uploadAvatar,

    /* orders */
    placeOrder: placeOrder,
    listMyOrders: listMyOrders,

    /* admin */
    admin: admin,

    /* helpers for UI code that already has raw rows */
    _map: {
      product: toUiProduct,
      category: toUiCategory,
      order: toUiOrder,
      profile: toUiProfile,
      error: toError
    }
  };
})();
