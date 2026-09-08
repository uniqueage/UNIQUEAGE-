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

  function computeTotals(cart) {
    var sub = cart.reduce(function (s, i) { return s + (i.price || 0) * i.qty; }, 0);
    var promo = read(PROMO_KEY, null);
    var discount = promo ? Math.round(sub * 0.1) : 0;
    var delivery = sub - discount > 0 && sub - discount < 10000 ? 1500 : 0;
    return { sub: sub, discount: discount, delivery: delivery, total: sub - discount + delivery };
  }

  function setFieldError(input, msg) {
    if (!input) return;
    var hint = input.parentElement ? input.parentElement.querySelector(".form-hint") : null;
    if (!hint) return;
    if (msg) { input.classList.add("err"); hint.textContent = msg; hint.classList.add("show"); }
    else { input.classList.remove("err"); hint.classList.remove("show"); }
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
      return '<a href="category.html?cat=' + c.slug + '">' + c.name + "</a>";
    }).join("");

    var shell = document.createElement("div");
    shell.innerHTML =
      '<div class="announce"><i class="fas fa-truck-fast"></i>Free delivery on orders over ₦10,000 — code SPARKLE10</div>' +
      '<header class="site-header" id="siteHeader">' +
        '<div class="wrap header-inner">' +
          '<a class="brand" href="index.html" aria-label="UAGE — Unique Age home">' +
            '<span class="brand-word"><span class="brand-u">U</span>AGE<span class="dot">.</span></span>' +
            '<span class="brand-sub">Unique Age</span>' +
          "</a>" +
          '<nav class="nav-links" id="navLinks" aria-label="Primary">' + headerHtml + "</nav>" +
          '<button class="hamburger" id="hamburger" type="button" aria-label="Open menu" aria-expanded="false">' +
            '<i class="fas fa-bars"></i></button>' +
          '<a class="cart-btn" href="cart.html" aria-label="Shopping cart">' +
            '<i class="fas fa-cart-shopping"></i><span>Cart</span>' +
            '<span class="cart-badge" id="cartCount">' + count + "</span></a>" +
        "</div>" +
      "</header>" +
      '<nav class="bottom-nav" aria-label="Quick tools">' + navHtml + "</nav>";

    document.body.insertAdjacentHTML("afterbegin", shell.innerHTML);

    var footer = document.createElement("footer");
    footer.innerHTML =
        '<div class="wrap">' +
          '<div class="footer-top">' +
            '<div class="footer-brand">' +
              '<a class="brand" href="index.html" aria-label="UAGE home">' +
                '<span class="brand-word"><span class="brand-u">U</span>AGE<span class="dot">.</span></span>' +
                '<span class="brand-sub">Unique Age</span></a>' +
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
                '<a href="about.html">About us</a>' +
                '<a href="faq.html">FAQ</a>' +
                '<a href="contact.html">Contact</a>' +
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
        "</div>";
    document.body.appendChild(footer);
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
    var href = "product.html?id=" + p.id;
    return '<article class="product-card reveal" data-id="' + p.id + '">' +
      '<a class="card-media" href="' + href + '" aria-label="View ' + p.name + '">' +
        '<img src="' + p.image + '" alt="' + p.name + '" loading="lazy" />' +
        (p.badge ? '<span class="card-flag">' + p.badge + "</span>" : "") +
      "</a>" +
      '<span class="card-cat"><i class="fas ' + cat.icon + '"></i> ' + cat.name + "</span>" +
      '<h3><a href="' + href + '">' + p.name + "</a></h3>" +
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

  /* ---------- product detail page ---------- */
  function initProduct() {
    var root = document.getElementById("productDetail");
    if (!root) return;
    var params = new URLSearchParams(window.location.search);
    var p = D.getProduct(params.get("id"));
    if (!p) {
      root.innerHTML = '<div class="wrap"><div class="empty-state" style="margin-top:var(--section-y)">' +
        '<i class="fas fa-triangle-exclamation"></i><h3>Product not found</h3>' +
        "<p>The item you're looking for doesn't exist or was moved.</p>" +
        '<a class="btn btn-primary" href="shop.html"><i class="fas fa-store"></i>Back to shop</a></div></div>';
      return;
    }
    var cat = catOf(p.category);
    document.title = p.name + " · UAGE — UNIQUE AGE";

    var b = document.getElementById("pdBreadcrumb");
    if (b) b.innerHTML = '<a href="index.html">Home</a><i class="fas fa-chevron-right"></i>' +
      '<a href="shop.html">Shop</a><i class="fas fa-chevron-right"></i>' +
      '<a href="shop.html?cat=' + p.category + '">' + cat.name + "</a>" +
      '<i class="fas fa-chevron-right"></i><span>' + p.name + "</span>";

    var img = document.getElementById("pdImage");
    if (img) { img.src = p.image; img.alt = p.name; }
    var badge = document.getElementById("pdBadge");
    if (badge) { if (p.badge) badge.textContent = p.badge; else badge.style.display = "none"; }
    var catEl = document.getElementById("pdCat");
    if (catEl) catEl.innerHTML = '<i class="fas ' + cat.icon + '"></i> ' + cat.name;
    var nameEl = document.getElementById("pdName");
    if (nameEl) nameEl.textContent = p.name;
    var ratingEl = document.getElementById("pdRating");
    if (ratingEl) ratingEl.innerHTML = starsHtml(p.rating) + " " + p.rating + " · " + p.reviews + " reviews";
    var descEl = document.getElementById("pdDesc");
    if (descEl) descEl.textContent = p.desc;

    /* size selection */
    var selectedSize = p.sizes && p.sizes.length ? p.sizes[0].label : "";
    function currentPrice() {
      if (p.sizes && p.sizes.length) {
        var s = p.sizes.find(function (x) { return x.label === selectedSize; });
        return s ? s.price : p.sizes[0].price;
      }
      return p.price || 0;
    }
    function renderPrice() {
      var el = document.getElementById("pdPrice");
      var old = document.getElementById("pdOldPrice");
      if (!el) return;
      if (p.sizes && p.sizes.length) {
        el.innerHTML = D.format(currentPrice()) + "<small> · " + selectedSize + "</small>";
        if (old) old.style.display = "none";
      } else {
        el.textContent = D.format(p.price);
        if (old) {
          if (p.oldPrice) { old.textContent = D.format(p.oldPrice); old.style.display = ""; }
          else old.style.display = "none";
        }
      }
    }

    var sizesEl = document.getElementById("pdSizes");
    if (sizesEl) {
      if (p.sizes && p.sizes.length) {
        sizesEl.innerHTML = p.sizes.map(function (s, i) {
          return '<button type="button" class="size-pill' + (i === 0 ? " active" : "") + '" data-size="' + s.label + '">' +
            s.label + ' <small>· ' + D.format(s.price) + "</small></button>";
        }).join("");
        sizesEl.querySelectorAll(".size-pill").forEach(function (pill) {
          pill.addEventListener("click", function () {
            sizesEl.querySelectorAll(".size-pill").forEach(function (x) { x.classList.remove("active"); });
            pill.classList.add("active");
            selectedSize = pill.dataset.size;
            renderPrice();
          });
        });
      } else {
        var block = sizesEl.closest(".pd-sizes-block");
        if (block) block.style.display = "none";
      }
    }

    /* quantity stepper */
    var qty = 1;
    var qtyVal = document.getElementById("pdQtyValue");
    var minus = document.getElementById("pdQtyMinus");
    var plus = document.getElementById("pdQtyPlus");
    function renderQty() { if (qtyVal) qtyVal.textContent = qty; }
    if (minus) minus.addEventListener("click", function () { if (qty > 1) { qty--; renderQty(); } });
    if (plus) plus.addEventListener("click", function () { qty++; renderQty(); });

    var addBtn = document.getElementById("pdAddBtn");
    if (addBtn) addBtn.addEventListener("click", function () { addToCart(p.id, selectedSize, qty); });

    /* category features */
    var feats = cat.features || [];
    var featsEl = document.getElementById("pdFeatures");
    if (featsEl) {
      if (feats.length) {
        featsEl.innerHTML = '<div class="pd-label">Why you\'ll love it</div><ul>' +
          feats.map(function (f) { return '<li><i class="fas fa-circle-check"></i>' + f + "</li>"; }).join("") + "</ul>";
      } else featsEl.style.display = "none";
    }

    /* related products */
    var relatedEl = document.getElementById("relatedGrid");
    if (relatedEl) {
      var same = D.byCategory(p.category).filter(function (x) { return x.id !== p.id; });
      var others = D.products.filter(function (x) { return x.category !== p.category; })
        .sort(function (a, b) { return (b.featured ? 1 : 0) - (a.featured ? 1 : 0); });
      var related = same.concat(others).slice(0, 4);
      relatedEl.innerHTML = related.map(cardHtml).join("");
      bindCards(relatedEl);
    }

    renderPrice();
  }

  /* ---------- category page ---------- */
  function initCategory() {
    var grid = document.getElementById("catGrid");
    if (!grid) return;
    var params = new URLSearchParams(window.location.search);
    var slug = params.get("cat") || "dishwash";
    var cat = D.getCategory(slug);
    if (!cat) {
      grid.innerHTML = '<div class="empty-state"><i class="fas fa-triangle-exclamation"></i>' +
        "<h3>Category not found</h3><p>The category you're looking for doesn't exist.</p>" +
        '<a class="btn btn-primary" href="shop.html"><i class="fas fa-store"></i>Back to shop</a></div>';
      return;
    }
    document.title = cat.name + " — UNIQUE AGE · UAGE";

    var heroLines = {
      dishwash: "Grease-busting, plant-based dishwash in 500ml, 750ml, 1L and 2L sizes — pick the size that fits your kitchen.",
      cosmetics: "Body butters, scrubs, washes and creams for deep, long-lasting moisture on every skin type.",
      perfume: "Long-lasting eau de parfum in 30ml, 50ml and 100ml — from fresh daytime scents to bold evening statements.",
      air: "Room mists, candles and car fresheners that neutralise odours and keep every space inviting."
    };

    var hero = document.getElementById("catHero");
    if (hero) {
      hero.className = "cat-hero cat-bg-" + cat.slug;
      hero.innerHTML = '<div>' +
        '<span class="crumb"><i class="fas ' + cat.icon + '"></i>' + cat.tag + "</span>" +
        "<h1>Shop <em>" + cat.name + "</em></h1>" +
        "<p>" + (heroLines[cat.slug] || cat.blurb) + "</p>" +
        '<span class="cat-chip"><i class="fas fa-bag-shopping"></i>' + cat.blurb + "</span>" +
      "</div>" +
      '<div class="cat-hero-icon"><i class="fas ' + cat.icon + '"></i></div>';
    }
    var eyebrow = document.getElementById("catEyebrow");
    if (eyebrow) eyebrow.textContent = "Browse " + cat.name;
    var title = document.getElementById("catTitle");
    if (title) title.innerHTML = "The <em>" + cat.name + "</em> collection";

    var list = D.byCategory(cat.slug);
    grid.innerHTML = list.map(cardHtml).join("");
    bindCards(grid);
    observeReveals();
  }

  /* ---------- checkout page ---------- */
  function initCheckout() {
    var form = document.getElementById("checkoutForm");
    if (!form) return;
    var empty = document.getElementById("coEmpty");
    var layout = document.getElementById("coLayout");
    var cart = getCart();
    if (!cart.length) {
      if (empty) empty.style.display = "";
      if (layout) layout.style.display = "none";
      return;
    }

    function setText(id, html) {
      var el = document.getElementById(id);
      if (el) el.innerHTML = html;
    }
    function renderSummary() {
      var totals = computeTotals(cart);
      var linesEl = document.getElementById("coLines");
      if (linesEl) {
        linesEl.innerHTML = cart.map(function (i) {
          var p = D.getProduct(i.id);
          return '<div class="cart-line"><span>' + (p ? p.name : i.id) +
            (i.size ? " <small>(" + i.size + ")</small>" : "") + " × " + i.qty + "</span><span>" +
            D.format((i.price || 0) * i.qty) + "</span></div>";
        }).join("");
      }
      setText("coSubtotal", D.format(totals.sub));
      setText("coDiscount", totals.discount ? '<span class="disc">−' + D.format(totals.discount) + "</span>" : "—");
      setText("coDelivery", totals.delivery ? D.format(totals.delivery) : '<span class="free">Free</span>');
      setText("coTotalSum", D.format(totals.total));
      setText("coTotal", D.format(totals.total));
    }
    renderSummary();

    document.querySelectorAll(".payment-option input").forEach(function (radio) {
      radio.addEventListener("change", function () {
        document.querySelectorAll(".payment-option").forEach(function (opt) {
          opt.classList.toggle("selected", opt.querySelector("input").checked);
        });
      });
    });

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var name = form.name.value.trim();
      var phone = form.phone.value.trim();
      var email = form.email.value.trim();
      var address = form.address.value.trim();
      var city = form.city.value.trim();
      var digits = phone.replace(/\D/g, "");
      var ok = true;
      setFieldError(form.name, name.length < 2 ? "Please enter your full name." : null); if (name.length < 2) ok = false;
      setFieldError(form.phone, digits.length < 10 ? "Enter a valid phone number." : null); if (digits.length < 10) ok = false;
      setFieldError(form.email, !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? "Enter a valid email address." : null); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) ok = false;
      setFieldError(form.address, address.length < 5 ? "Enter your delivery address." : null); if (address.length < 5) ok = false;
      setFieldError(form.city, city.length < 2 ? "Enter your city." : null); if (city.length < 2) ok = false;
      if (!ok) return;

      var totals = computeTotals(cart);
      var order = {
        id: "UAGE-" + Date.now().toString().slice(-6),
        date: new Date().toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" }),
        items: cart.map(function (i) {
          var p = D.getProduct(i.id);
          return { name: p ? p.name : i.id, size: i.size, qty: i.qty, price: i.price };
        }),
        total: totals.total
      };
      var orders = getOrders();
      orders.unshift(order);
      write(ORDERS_KEY, orders);
      saveCart([]);
      localStorage.removeItem(PROMO_KEY);

      if (layout) layout.style.display = "none";
      var success = document.getElementById("coSuccess");
      if (success) {
        success.classList.add("show");
        var t = document.getElementById("coSuccessTitle");
        if (t) t.textContent = "Order " + order.id + " placed!";
        var m = document.getElementById("coSuccessMsg");
        if (m) m.textContent = "Thanks " + name.split(" ")[0] + " — we'll call " + phone + " to confirm delivery to " + city + " soon.";
      }
      showToast("Order placed — " + D.format(totals.total), "fa-circle-check");
      window.scrollTo({ top: 0, behavior: prefersReduced ? "auto" : "smooth" });
    });
  }

  /* ---------- contact page ---------- */
  function initContact() {
    var form = document.getElementById("contactForm");
    if (!form) return;
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var name = form.name.value.trim();
      var email = form.email.value.trim();
      var msg = form.message.value.trim();
      var ok = true;
      setFieldError(form.name, name.length < 2 ? "Please enter your name." : null); if (name.length < 2) ok = false;
      setFieldError(form.email, !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? "Enter a valid email." : null); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) ok = false;
      setFieldError(form.message, msg.length < 5 ? "Tell us a little more." : null); if (msg.length < 5) ok = false;
      if (!ok) return;
      form.reset();
      showToast("Message sent — we'll reply within a day!", "fa-paper-plane");
    });
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
    var totals = computeTotals(cart);
    var sub = totals.sub, discount = totals.discount, delivery = totals.delivery, total = totals.total;
    var promoMsgEl = document.getElementById("promoMsg");
    if (discount && promoMsgEl) { promoMsgEl.className = "promo-msg ok"; promoMsgEl.textContent = "SPARKLE10 applied — 10% off 🎉"; }

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
  initProduct();
  initCategory();
  initShop();
  renderCart();
  initCartPage();
  initCheckout();
  initContact();
  initAuth();
  initAccount();
  observeReveals();
})();