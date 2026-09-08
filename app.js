/* UAGE shared app logic — cart, layout injection, shop rendering, auth */
(function () {
  "use strict";

  var D = window.UAGE_DATA;
  var PAGE = (document.body && document.body.dataset.page) || "home";
  var prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- storage helpers ---------- */
  var CART_KEY = "uage_cart";
  var USER_KEY = "uage_user";
  var ORDERS_KEY = "uage_orders";
  var PROMO_KEY = "uage_promo";

  function read(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; }
    catch (e) { return fallback; }
  }
  function write(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }

  function getCart() { return read(CART_KEY, []); }
  function saveCart(cart) { write(CART_KEY, cart); updateBadges(); }
  function getUser() { return read(USER_KEY, null); }
  function getOrders() { return read(ORDERS_KEY, []); }
  function cartKey(id, size) { return id + "|" + (size || ""); }

  function cartCount() {
    return getCart().reduce(function (sum, item) { return sum + (item.qty || 1); }, 0);
  }

  /* ---------- toast ---------- */
  var toastEl = null;
  function showToast(msg, icon) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "toast";
      toastEl.setAttribute("role", "status");
      toastEl.setAttribute("aria-live", "polite");
      document.body.appendChild(toastEl);
    }
    toastEl.innerHTML = '<i class="fas ' + (icon || "fa-circle-check") + '"></i>' + msg;
    toastEl.classList.add("show");
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(function () { toastEl.classList.remove("show"); }, 2300);
  }

  /* ---------- layout injection (single source of truth) ---------- */
  function initials(name) {
    if (!name) return "U";
    var parts = String(name).trim().split(/\s+/);
    return ((parts[0] || "U")[0] + (parts[1] ? parts[1][0] : "")).toUpperCase();
  }

  function buildShell() {
    var user = getUser();
    var count = cartCount();

    var navItems = [
      { href: "index.html", label: "Home", icon: "fa-house", page: "home" },
      { href: "shop.html", label: "Shop", icon: "fa-store", page: "shop" },
      { href: "cart.html", label: "Cart", icon: "fa-cart-shopping", page: "cart" },
      { href: user ? "account.html" : "signup.html", label: user ? "Account" : "Sign in", icon: user ? "fa-user" : "fa-user-plus", page: "account" }
    ];
    var navHtml = navItems.map(function (n) {
      return '<a href="' + n.href + '" class="' + (PAGE === n.page ? "active" : "") + '">' +
        '<i class="fas ' + n.icon + '"></i>' + n.label + "</a>";
    }).join("");

    var headerLinks = [
      { href: "index.html", label: "Home", icon: "fa-house", page: "home" },
      { href: "shop.html", label: "Shop", icon: "fa-store", page: "shop" },
      { href: "cart.html", label: "Cart", icon: "fa-cart-shopping", page: "cart" },
      { href: user ? "account.html" : "signup.html", label: user ? "Hi, " + String(user.name || "there").split(" ")[0] : "Sign in", icon: user ? "fa-user" : "fa-right-to-bracket", page: "account" }
    ];
    var headerHtml = headerLinks.map(function (n) {
      return '<a class="nav-link' + (PAGE === n.page ? " active" : "") + '" href="' + n.href + '">' +
        '<i class="fas ' + n.icon + '"></i><span>' + n.label + "</span></a>";
    }).join("");

    var footerCats = D.categories.map(function (c) {
      return '<a href="shop.html?cat=' + c.slug + '">' + c.name + "</a>";
    }).join("");

    var shell = document.createElement("div");
    shell.innerHTML =
      '<div class="announce"><i class="fas fa-truck-fast"></i>Free delivery on orders over ₦10,000 — code SPARKLE10</div>' +
      '<header class="site-header" id="siteHeader">' +
        '<div class="wrap header-inner">' +
          '<a class="brand" href="index.html" aria-label="UAGE home">' +
            '<span class="brand-mark">U</span>' +
            '<span class="brand-word"><span>AGE</span><span class="dot">.</span>' +
            '<span class="brand-tag">Unique Age</span></span>' +
          "</a>" +
          '<nav class="nav-links" id="navLinks" aria-label="Primary">' + headerHtml + "</nav>" +
          '<button class="hamburger" id="hamburger" type="button" aria-label="Open menu" aria-expanded="false">' +
            '<i class="fas fa-bars"></i></button>' +
          '<a class="cart-btn" href="cart.html" aria-label="Shopping cart">' +
            '<i class="fas fa-cart-shopping"></i><span>Cart</span>' +
            '<span class="cart-badge" id="cartCount">' + count + "</span></a>" +
        "</div>" +
      "</header>" +
      '<nav class="bottom-nav" aria-label="Quick tools">' + navHtml + "</nav>" +
      "<footer>" +
        '<div class="wrap">' +
          '<div class="footer-top">' +
            '<div class="footer-brand">' +
              '<a class="brand" href="index.html">' +
                '<span class="brand-mark">U</span>' +
                '<span class="brand-word"><span>AGE</span><span class="dot">.</span></span></a>' +
              "<p>Clean dishes, happy moments — dish care, body care and home fragrance for every home.</p>" +
            "</div>" +
            '<div class="footer-cols">' +
              '<div class="footer-col"><h4>Shop</h4>' + footerCats + "</div>" +
              '<div class="footer-col"><h4>Account</h4>' +
                '<a href="cart.html">Your cart</a>' +
                '<a href="signup.html">Sign up</a>' +
                '<a href="account.html">My account</a>' +
              "</div>" +
              '<div class="footer-col"><h4>Company</h4>' +
                '<a href="index.html#benefits">Why UAGE</a>' +
                '<a href="index.html#reviews">Reviews</a>' +
                '<a href="index.html#featured">Bestsellers</a>' +
              "</div>" +
            "</div>" +
            '<div class="socials">' +
              '<a href="#" aria-label="Instagram"><i class="fa-brands fa-instagram"></i></a>' +
              '<a href="#" aria-label="X (Twitter)"><i class="fa-brands fa-x-twitter"></i></a>' +
              '<a href="#" aria-label="Facebook"><i class="fa-brands fa-facebook-f"></i></a>' +
            "</div>" +
          "</div>" +
          '<div class="footer-bottom">' +
            "<span>© 2026 Unique Age. All rights reserved.</span>" +
            '<span>Photography via <a href="https://unsplash.com" target="_blank" rel="noopener">Unsplash</a></span>' +
          "</div>" +
        "</div>" +
      "</footer>";

    document.body.insertAdjacentHTML("afterbegin", shell.innerHTML);
  }

  function updateBadges() {
    var count = cartCount();
    document.querySelectorAll("#cartCount").forEach(function (el) { el.textContent = count; });
    var bnBadge = document.querySelector(".bottom-nav .cart-badge");
    if (bnBadge) bnBadge.textContent = count;
  }

  /* ---------- header interactions ---------- */
  function initHeader() {
    var header = document.getElementById("siteHeader");
    function onScroll() { if (header) header.classList.toggle("scrolled", window.scrollY > 10); }
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });

    var burger = document.getElementById("hamburger");
    var links = document.getElementById("navLinks");
    if (burger && links) {
      burger.addEventListener("click", function () {
        var open = links.classList.toggle("open");
        burger.setAttribute("aria-expanded", open ? "true" : "false");
      });
      links.addEventListener("click", function (e) {
        if (e.target.closest("a")) links.classList.remove("open");
      });
    }
  }

  /* ---------- cart ---------- */
  function addToCart(id, size, qty) {
    var p = D.getProduct(id);
    if (!p) return;
    var unitPrice = p.price || 0;
    if (p.sizes && p.sizes.length) {
      var s = p.sizes.find(function (x) { return x.label === size; }) || p.sizes[0];
      size = s.label;
      unitPrice = s.price;
    }
    var cart = getCart();
    var key = cartKey(id, size);
    var found = cart.find(function (item) { return cartKey(item.id, item.size) === key; });
    if (found) found.qty += qty || 1;
    else cart.push({ id: id, size: size || "", qty: qty || 1, price: unitPrice });
    saveCart(cart);
    var label = p.name + (size ? " · " + size : "");
    showToast(label + " added to cart", "fa-cart-plus");
    pulseBadge();
  }

  function pulseBadge() {
    var badge = document.getElementById("cartCount");
    if (!badge) return;
    badge.classList.remove("pulse");
    void badge.offsetWidth;
    badge.classList.add("pulse");
  }

  function changeQty(key, delta) {
    var cart = getCart();
    var item = cart.find(function (i) { return cartKey(i.id, i.size) === key; });
    if (!item) return;
    item.qty += delta;
    if (item.qty <= 0) cart = cart.filter(function (i) { return cartKey(i.id, i.size) !== key; });
    saveCart(cart);
    renderCart();
  }

  function removeItem(key) {
    var cart = getCart().filter(function (i) { return cartKey(i.id, i.size) !== key; });
    saveCart(cart);
    renderCart();
  }

  /* ---------- product cards ---------- */
  function starsHtml(r) {
    var full = Math.round(r || 0);
    var s = "";
    for (var i = 1; i <= 5; i++) s += i <= full ? '<i class="fas fa-star"></i>' : '<i class="fa-solid fa-star" style="opacity:.25"></i>';
    return s;
  }

  function catOf(slug) {
    return D.getCategory(slug) || { name: slug, icon: "fa-tag" };
  }

  function cardHtml(p) {
    var cat = catOf(p.category);
    var sizesHtml = "";
    if (p.sizes && p.sizes.length) {
      sizesHtml = '<div class="size-pills">' + p.sizes.map(function (s, i) {
        return '<button type="button" class="size-pill' + (i === 0 ? " active" : "") + '" data-size="' + s.label + '" data-size-price="' + s.price + '">' + s.label + "</button>";
      }).join("") + "</div>";
    }
    var priceHtml;
    if (p.sizes && p.sizes.length) {
      priceHtml = '<span class="price">' + D.format(p.sizes[0].price) + "<small> · " + p.sizes[0].label + " +</small></span>";
    } else {
      priceHtml = '<span class="price">' + D.format(p.price) +
        (p.oldPrice ? '<span class="old">' + D.format(p.oldPrice) + "</span>" : "") + "</span>";
    }
    return '<article class="product-card reveal" data-id="' + p.id + '">' +
      '<div class="card-media">' +
        '<img src="' + p.image + '" alt="' + p.name + '" loading="lazy" />' +
        (p.badge ? '<span class="card-flag">' + p.badge + "</span>" : "") +
      "</div>" +
      '<span class="card-cat"><i class="fas ' + cat.icon + '"></i> ' + cat.name + "</span>" +
      "<h3>" + p.name + "</h3>" +
      '<div class="card-rating">' + starsHtml(p.rating) + " " + p.rating + " · " + p.reviews + " reviews</div>" +
      '<p class="sub">' + p.desc + "</p>" +
      sizesHtml +
      '<div class="price-row">' + priceHtml + '<span class="stock">In stock</span></div>' +
      '<button class="btn btn-primary btn-block add-to-cart" type="button" data-id="' + p.id + '"' +
        (p.sizes && p.sizes.length ? ' data-size="' + p.sizes[0].label + '"' : "") + ">" +
        '<i class="fas fa-cart-plus"></i>Add to cart</button>' +
      "</article>";
  }

  function bindCards(scope) {
    var root = scope || document;
    root.querySelectorAll(".add-to-cart").forEach(function (btn) {
      btn.addEventListener("click", function () {
        addToCart(btn.dataset.id, btn.dataset.size || "", 1);
      });
    });
    root.querySelectorAll(".size-pill").forEach(function (pill) {
      pill.addEventListener("click", function () {
        var card = pill.closest(".product-card");
        if (!card) return;
        card.querySelectorAll(".size-pill").forEach(function (x) { x.classList.remove("active"); });
        pill.classList.add("active");
        var priceEl = card.querySelector(".price");
        var btn = card.querySelector(".add-to-cart");
        if (priceEl) priceEl.innerHTML = D.format(pill.dataset.sizePrice) + '<small> · ' + pill.dataset.size + " +</small>";
        if (btn) btn.dataset.size = pill.dataset.size;
      });
    });
  }

  /* ---------- home page ---------- */
  function initHome() {
    var featuredEl = document.getElementById("featuredGrid");
    if (featuredEl) {
      var featured = D.products.filter(function (p) { return p.featured; }).slice(0, 4);
      featuredEl.innerHTML = featured.map(cardHtml).join("");
      bindCards(featuredEl);
    }

    var track = document.getElementById("carouselTrack");
    if (!track) return;
    var slides = Array.prototype.slice.call(track.children);
    var dots = Array.prototype.slice.call(document.querySelectorAll(".dot"));
    var prevBtn = document.getElementById("prevBtn");
    var nextBtn = document.getElementById("nextBtn");
    var carousel = document.getElementById("carousel");
    var index = 0;
    var total = slides.length;
    if (!total) return;

    function update(i) {
      index = (i + total) % total;
      track.style.transform = "translateX(-" + index * 100 + "%)";
      dots.forEach(function (dot, di) {
        dot.classList.toggle("active", di === index);
        dot.setAttribute("aria-current", di === index ? "true" : "false");
      });
    }
    function next() { update(index + 1); }
    function prev() { update(index - 1); }

    nextBtn.addEventListener("click", next);
    prevBtn.addEventListener("click", prev);
    dots.forEach(function (dot) {
      dot.addEventListener("click", function () { update(Number(dot.dataset.index)); });
    });
    carousel.addEventListener("keydown", function (e) {
      if (e.key === "ArrowLeft") { e.preventDefault(); prev(); }
      if (e.key === "ArrowRight") { e.preventDefault(); next(); }
    });

    var startX = null;
    carousel.addEventListener("pointerdown", function (e) { startX = e.clientX; stopAuto(); });
    carousel.addEventListener("pointerup", function (e) {
      if (startX === null) return;
      var dx = e.clientX - startX;
      if (Math.abs(dx) > 45) { dx > 0 ? prev() : next(); }
      startX = null;
      startAuto();
    });
    carousel.addEventListener("pointercancel", function () { startX = null; startAuto(); });

    var timer = null;
    function startAuto() {
      if (prefersReduced || timer) return;
      timer = setInterval(next, 5500);
    }
    function stopAuto() { clearInterval(timer); timer = null; }
    carousel.addEventListener("mouseenter", stopAuto);
    carousel.addEventListener("mouseleave", startAuto);
    carousel.addEventListener("focusin", stopAuto);
    carousel.addEventListener("focusout", startAuto);
    startAuto();
  }

  /* ---------- shop page ---------- */
  function initShop() {
    var grid = document.getElementById("shopGrid");
    var tabsWrap = document.getElementById("filterTabs");
    var searchInput = document.getElementById("shopSearch");
    var sortSelect = document.getElementById("shopSort");
    var countEl = document.getElementById("resultCount");
    if (!grid || !tabsWrap) return;

    var params = new URLSearchParams(window.location.search);
    var activeCat = params.get("cat") || "all";

    var tabsHtml = [{ slug: "all", name: "All", icon: "fa-border-all" }]
      .concat(D.categories.map(function (c) { return { slug: c.slug, name: c.name, icon: c.icon }; }))
      .map(function (t) {
        return '<button type="button" class="filter-tab' + (activeCat === t.slug ? " active" : "") + '" data-cat="' + t.slug + '">' +
          '<i class="fas ' + t.icon + '"></i>' + t.name + "</button>";
      }).join("");
    tabsWrap.innerHTML = tabsHtml;

    var query = "";
    var sort = "featured";

    function visibleProducts() {
      var list = activeCat === "all" ? D.products.slice() : D.byCategory(activeCat);
      if (query) {
        var q = query.toLowerCase();
        list = list.filter(function (p) {
          return p.name.toLowerCase().indexOf(q) !== -1 ||
            p.desc.toLowerCase().indexOf(q) !== -1 ||
            catOf(p.category).name.toLowerCase().indexOf(q) !== -1;
        });
      }
      var minPrice = function (p) {
        return p.sizes && p.sizes.length ? p.sizes[0].price : p.price;
      };
      if (sort === "price-asc") list.sort(function (a, b) { return minPrice(a) - minPrice(b); });
      if (sort === "price-desc") list.sort(function (a, b) { return minPrice(b) - minPrice(a); });
      if (sort === "rating") list.sort(function (a, b) { return (b.rating || 0) - (a.rating || 0); });
      if (sort === "featured") list.sort(function (a, b) { return (b.featured ? 1 : 0) - (a.featured ? 1 : 0); });
      return list;
    }

    function render() {
      var list = visibleProducts();
      countEl.textContent = list.length + (list.length === 1 ? " product" : " products") +
        (activeCat !== "all" ? " in " + catOf(activeCat).name : "");
      if (!list.length) {
        grid.innerHTML = '<div class="empty-state"><i class="fas fa-magnifying-glass"></i>' +
          "<h3>No matches found</h3><p>Try a different category, or clear your search.</p>" +
          '<button class="btn btn-primary" id="clearFilters" type="button"><i class="fas fa-rotate-left"></i>Clear filters</button></div>';
        var clearBtn = document.getElementById("clearFilters");
        if (clearBtn) clearBtn.addEventListener("click", function () {
          activeCat = "all";
          query = "";
          searchInput.value = "";
          tabsWrap.querySelectorAll(".filter-tab").forEach(function (t) {
            t.classList.toggle("active", t.dataset.cat === "all");
          });
          render();
        });
        return;
      }
      grid.innerHTML = list.map(cardHtml).join("");
      bindCards(grid);
      observeReveals();
    }

    tabsWrap.addEventListener("click", function (e) {
      var tab = e.target.closest(".filter-tab");
      if (!tab) return;
      activeCat = tab.dataset.cat;
      tabsWrap.querySelectorAll(".filter-tab").forEach(function (t) { t.classList.toggle("active", t === tab); });
      render();
    });
    searchInput.addEventListener("input", function () { query = searchInput.value.trim(); render(); });
    sortSelect.addEventListener("change", function () { sort = sortSelect.value; render(); });

    render();
  }

  /* ---------- cart page ---------- */
  function renderCart() {
    var listEl = document.getElementById("cartItems");
    var summaryEl = document.getElementById("cartSummary");
    var emptyEl = document.getElementById("cartEmpty");
    if (!listEl) return;

    var cart = getCart();
    if (!cart.length) {
      if (emptyEl) emptyEl.style.display = "";
      listEl.innerHTML = "";
      if (summaryEl) summaryEl.style.display = "none";
      return;
    }
    if (emptyEl) emptyEl.style.display = "none";
    if (summaryEl) summaryEl.style.display = "";

    var rows = cart.map(function (item) {
      var p = D.getProduct(item.id);
      if (!p) return "";
      var key = cartKey(item.id, item.size);
      var unit = item.price || p.price || 0;
      return '<div class="cart-item" data-key="' + key + '">' +
        '<img src="' + p.image + '" alt="' + p.name + '" loading="lazy" />' +
        '<div class="cart-item-info">' +
          "<h3>" + p.name + "</h3>" +
          '<div class="meta">' + (item.size ? item.size + " · " : "") + "Unit " + D.format(unit) + "</div>" +
          '<div style="margin-top:.55rem"><div class="qty-stepper">' +
            '<button type="button" class="qty-minus" aria-label="Decrease quantity"><i class="fas fa-minus"></i></button>' +
            "<span>" + item.qty + "</span>" +
            '<button type="button" class="qty-plus" aria-label="Increase quantity"><i class="fas fa-plus"></i></button>' +
          "</div></div>" +
        "</div>" +
        '<div class="cart-item-price">' + D.format(unit * item.qty) + "</div>" +
        '<button type="button" class="cart-item-remove" aria-label="Remove item"><i class="fas fa-trash-can"></i></button>' +
      "</div>";
    }).join("");
    listEl.innerHTML = rows;

    listEl.querySelectorAll(".qty-minus").forEach(function (b) {
      b.addEventListener("click", function () {
        changeQty(b.closest(".cart-item").dataset.key, -1);
      });
    });
    listEl.querySelectorAll(".qty-plus").forEach(function (b) {
      b.addEventListener("click", function () {
        changeQty(b.closest(".cart-item").dataset.key, 1);
      });
    });
    listEl.querySelectorAll(".cart-item-remove").forEach(function (b) {
      b.addEventListener("click", function () {
        removeItem(b.closest(".cart-item").dataset.key);
        showToast("Item removed", "fa-trash-can");
      });
    });

    updateSummary(cart);
  }

  function updateSummary(cart) {
    var sub = cart.reduce(function (sum, i) { return sum + (i.price || 0) * i.qty; }, 0);
    var promo = read(PROMO_KEY, null);
    var discount = 0;
    var promoMsgEl = document.getElementById("promoMsg");
    if (promo) {
      discount = Math.round(sub * 0.1);
      if (promoMsgEl) { promoMsgEl.className = "promo-msg ok"; promoMsgEl.textContent = "SPARKLE10 applied — 10% off 🎉"; }
    }
    var delivery = sub - discount > 0 && sub - discount < 10000 ? 1500 : 0;
    var total = sub - discount + delivery;

    var el = document.getElementById("cartSummary");
    if (!el) return;
    var subEl = document.getElementById("sumSubtotal");
    var discEl = document.getElementById("sumDiscount");
    var delEl = document.getElementById("sumDelivery");
    var totEl = document.getElementById("sumTotal");
    if (subEl) subEl.textContent = D.format(sub);
    if (discEl) discEl.innerHTML = promo ? '<span class="disc">−' + D.format(discount) + "</span>" : "—";
    if (delEl) delEl.innerHTML = delivery === 0 ? '<span class="free">Free</span>' : D.format(delivery);
    if (totEl) totEl.textContent = D.format(total);
    var checkoutTotal = document.getElementById("checkoutTotal");
    if (checkoutTotal) checkoutTotal.textContent = D.format(total);
    if (promoMsgEl && !promo) { promoMsgEl.className = "promo-msg"; promoMsgEl.textContent = ""; }
  }

  function initCartPage() {
    var promoBtn = document.getElementById("promoApply");
    var promoInput = document.getElementById("promoInput");
    if (promoBtn && promoInput) {
      promoBtn.addEventListener("click", function () {
        var code = promoInput.value.trim().toUpperCase();
        var msgEl = document.getElementById("promoMsg");
        if (code === "SPARKLE10") {
          write(PROMO_KEY, code);
          if (msgEl) { msgEl.className = "promo-msg ok"; msgEl.textContent = "SPARKLE10 applied — 10% off 🎉"; }
          renderCart();
        } else {
          if (msgEl) { msgEl.className = "promo-msg err"; msgEl.textContent = "That code isn't valid — try SPARKLE10."; }
        }
      });
    }

    var checkoutBtn = document.getElementById("checkoutBtn");
    if (checkoutBtn) {
      checkoutBtn.addEventListener("click", function () {
        var cart = getCart();
        if (!cart.length) return;
        var sub = cart.reduce(function (s, i) { return s + (i.price || 0) * i.qty; }, 0);
        var discount = read(PROMO_KEY, null) ? Math.round(sub * 0.1) : 0;
        var delivery = sub - discount > 0 && sub - discount < 10000 ? 1500 : 0;
        var total = sub - discount + delivery;
        var order = {
          id: "UAGE-" + Date.now().toString().slice(-6),
          date: new Date().toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" }),
          items: cart.map(function (i) {
            var p = D.getProduct(i.id);
            return { name: p ? p.name : i.id, size: i.size, qty: i.qty, price: i.price };
          }),
          total: total
        };
        var orders = getOrders();
        orders.unshift(order);
        write(ORDERS_KEY, orders);
        saveCart([]);
        localStorage.removeItem(PROMO_KEY);
        renderCart();
        var done = document.getElementById("checkoutDone");
        if (done) {
          done.style.display = "";
          done.innerHTML = '<i class="fas fa-circle-check"></i>' +
            '<h3>Order ' + order.id + " placed!</h3>" +
            "<p>Thanks for shopping with UAGE. We'll reach out to confirm delivery soon.</p>" +
            '<a class="btn btn-primary" href="account.html"><i class="fas fa-user"></i>View my orders</a>';
          done.scrollIntoView({ behavior: prefersReduced ? "auto" : "smooth", block: "center" });
        }
        showToast("Order placed — " + D.format(total), "fa-circle-check");
      });
    }
  }

  /* ---------- auth ---------- */
  function initAuth() {
    var signupForm = document.getElementById("signupForm");
    var loginForm = document.getElementById("loginForm");
    var tabs = Array.prototype.slice.call(document.querySelectorAll(".auth-tab"));
    var cards = {
      signup: document.getElementById("authSignup"),
      login: document.getElementById("authLogin")
    };

    function showPane(pane) {
      tabs.forEach(function (t) { t.classList.toggle("active", t.dataset.pane === pane); });
      if (cards.signup) cards.signup.style.display = pane === "signup" ? "" : "none";
      if (cards.login) cards.login.style.display = pane === "login" ? "" : "none";
    }
    if (tabs.length) {
      tabs.forEach(function (tab) {
        tab.addEventListener("click", function () { showPane(tab.dataset.pane); });
      });
      document.querySelectorAll("[data-switch]").forEach(function (link) {
        link.addEventListener("click", function (e) {
          e.preventDefault();
          showPane(link.dataset.switch);
        });
      });
    }

    function setErr(input, msg) {
      var hint = input.parentElement.querySelector(".form-hint");
      if (!hint) return;
      if (msg) { input.classList.add("err"); hint.textContent = msg; hint.classList.add("show"); }
      else { input.classList.remove("err"); hint.classList.remove("show"); }
    }

    if (signupForm) {
      signupForm.addEventListener("submit", function (e) {
        e.preventDefault();
        var name = signupForm.name.value.trim();
        var email = signupForm.email.value.trim().toLowerCase();
        var pass = signupForm.password.value;
        var confirm = signupForm.confirm.value;
        var ok = true;
        setErr(signupForm.name, name.length < 2 ? "Please enter your full name." : null);
        if (name.length < 2) ok = false;
        setErr(signupForm.email, !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? "Please enter a valid email address." : null);
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) ok = false;
        setErr(signupForm.password, pass.length < 6 ? "Password must be at least 6 characters." : null);
        if (pass.length < 6) ok = false;
        setErr(signupForm.confirm, pass !== confirm ? "Passwords do not match." : null);
        if (pass !== confirm) ok = false;
        if (!ok) return;
        write(USER_KEY, { name: name, email: email, password: pass, joined: new Date().toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" }) });
        showToast("Welcome to UAGE, " + name.split(" ")[0] + "!", "fa-circle-check");
        setTimeout(function () { window.location.href = "account.html"; }, 700);
      });
    }

    if (loginForm) {
      loginForm.addEventListener("submit", function (e) {
        e.preventDefault();
        var email = loginForm.email.value.trim().toLowerCase();
        var pass = loginForm.password.value;
        var user = getUser();
        if (user && user.email === email && user.password === pass) {
          showToast("Welcome back, " + user.name.split(" ")[0] + "!", "fa-circle-check");
          setTimeout(function () { window.location.href = "account.html"; }, 700);
        } else {
          var hint = loginForm.password.parentElement.querySelector(".form-hint");
          if (hint) { hint.textContent = "No account matches that email & password. Try signing up."; hint.classList.add("show"); }
        }
      });
    }
  }

  /* ---------- account page ---------- */
  function initAccount() {
    var user = getUser();
    var signedInEl = document.getElementById("accountSignedIn");
    var signedOutEl = document.getElementById("accountSignedOut");
    if (!signedInEl && !signedOutEl) return;

    if (!user) {
      if (signedInEl) signedInEl.style.display = "none";
      if (signedOutEl) signedOutEl.style.display = "";
      return;
    }
    if (signedOutEl) signedOutEl.style.display = "none";
    if (signedInEl) signedInEl.style.display = "";

    var avatar = document.getElementById("accountAvatar");
    if (avatar) avatar.textContent = initials(user.name);
    var nameEl = document.getElementById("accountName");
    if (nameEl) nameEl.textContent = user.name;
    var emailEl = document.getElementById("accountEmail");
    if (emailEl) emailEl.textContent = user.email;
    var joinedEl = document.getElementById("accountJoined");
    if (joinedEl) joinedEl.textContent = user.joined || "—";

    var orders = getOrders();
    var countEl = document.getElementById("accountOrderCount");
    if (countEl) countEl.textContent = orders.length;
    var spentEl = document.getElementById("accountTotalSpent");
    if (spentEl) spentEl.textContent = D.format(orders.reduce(function (s, o) { return s + o.total; }, 0));

    var listEl = document.getElementById("ordersList");
    if (listEl) {
      if (!orders.length) {
        listEl.innerHTML = '<div class="empty-state" style="padding:2rem 1rem"><i class="fas fa-box-open"></i>' +
          "<h3>No orders yet</h3><p>Your placed orders will show up here.</p>" +
          '<a class="btn btn-primary" href="shop.html"><i class="fas fa-store"></i>Start shopping</a></div>';
      } else {
        listEl.innerHTML = orders.map(function (o) {
          var items = o.items.map(function (i) { return i.qty + "× " + i.name + (i.size ? " (" + i.size + ")" : ""); }).join(", ");
          return '<div class="order-row">' +
            '<div><div class="ord-id"><i class="fas fa-receipt"></i> ' + o.id + "</div>" +
            '<div class="ord-date">' + o.date + "</div></div>" +
            '<div class="ord-total">' + D.format(o.total) + "</div>" +
            '<div class="ord-items">' + items + "</div>" +
          "</div>";
        }).join("");
      }
    }

    var signoutBtn = document.getElementById("signoutBtn");
    if (signoutBtn) {
      signoutBtn.addEventListener("click", function () {
        localStorage.removeItem(USER_KEY);
        showToast("Signed out. See you soon!", "fa-right-from-bracket");
        setTimeout(function () { window.location.reload(); }, 700);
      });
    }
  }

  /* ---------- reveal on scroll ---------- */
  function observeReveals() {
    var reveals = Array.prototype.slice.call(document.querySelectorAll(".reveal:not(.in)"));
    if (!reveals.length) return;
    if (prefersReduced || !("IntersectionObserver" in window)) {
      reveals.forEach(function (el) { el.classList.add("in"); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" });
    reveals.forEach(function (el) { io.observe(el); });
  }

  /* ---------- boot ---------- */
  buildShell();
  initHeader();
  updateBadges();
  initHome();
  initShop();
  renderCart();
  initCartPage();
  initAuth();
  initAccount();
  observeReveals();
})();