/* UAGE product catalog — shared across all pages */
window.UAGE_DATA = {
  categories: [
    {
      slug: "dishwash", name: "Dishwash Liquid", icon: "fa-soap", tag: "Kitchen care", blurb: "500ml to 2L jugs",
      features: [
        "Cuts 100% of grease on contact",
        "Plant-based, biodegradable formula",
        "Gentle on hands — no harsh residue",
        "Fresh scent that lingers after rinsing"
      ]
    },
    {
      slug: "cosmetics", name: "Body Cosmetics", icon: "fa-spa", tag: "Skin & body", blurb: "Butters, scrubs, creams",
      features: [
        "Formulated for all skin types",
        "Deep, long-lasting moisture",
        "Paraben-free & cruelty-free",
        "Lightweight, fast-absorbing texture"
      ]
    },
    {
      slug: "perfume", name: "Perfumes", icon: "fa-spray-can-sparkles", tag: "Signature scents", blurb: "Eau de parfum",
      features: [
        "Long-lasting eau de parfum concentration",
        "Rich sillage that lingers all day",
        "Alcohol-based, skin-safe blend",
        "Available in 30ml, 50ml and 100ml"
      ]
    },
    {
      slug: "air", name: "Air Fresheners", icon: "fa-wind", tag: "Home & car", blurb: "Mists, candles & more",
      features: [
        "Neutralises odours — doesn't just mask them",
        "Long-lasting fresh scent",
        "Safe for home, office and car",
        "Quality you can smell from the first spray"
      ]
    }
  ],
  products: [
    /* ============ DISHWASH LIQUID ============ */
    {
      id: "crystal-clean",
      name: "Crystal Clean",
      category: "dishwash",
      desc: "Grease destroyer with a fresh citrus scent. Concentrated, streak-free shine.",
      badge: "Bestseller",
      rating: 4.9,
      reviews: 312,
      featured: true,
      image: "https://images.unsplash.com/photo-1563453392212-326f5e854473?auto=format&fit=crop&w=800&q=80",
      sizes: [
        { label: "500ml", price: 4500 },
        { label: "750ml", price: 6200 },
        { label: "1L", price: 8500 },
        { label: "2L", price: 15500 }
      ]
    },
    {
      id: "fresh-zest",
      name: "Fresh Zest",
      category: "dishwash",
      desc: "Lemon & lavender power that cuts 100% of grease. Gentle on hands, bold on dishes.",
      badge: "Lemon & Lavender",
      rating: 4.8,
      reviews: 196,
      featured: true,
      image: "https://images.unsplash.com/photo-1584622650111-993a426fbf0a?auto=format&fit=crop&w=800&q=80",
      sizes: [
        { label: "500ml", price: 5200 },
        { label: "750ml", price: 7000 },
        { label: "1L", price: 9500 },
        { label: "2L", price: 17500 }
      ]
    },
    {
      id: "silky-foam",
      name: "Silky Foam",
      category: "dishwash",
      desc: "Cloud-like foam, tough on oil yet extra mild on skin. No harsh residue.",
      badge: "Gentle care",
      rating: 4.9,
      reviews: 258,
      image: "https://images.unsplash.com/photo-1585421514738-01798e348b17?auto=format&fit=crop&w=800&q=80",
      sizes: [
        { label: "500ml", price: 4900 },
        { label: "750ml", price: 6700 },
        { label: "1L", price: 9200 },
        { label: "2L", price: 16800 }
      ]
    },
    {
      id: "lemon-burst",
      name: "Lemon Burst",
      category: "dishwash",
      desc: "Zingy lemon gel that lifts burnt-on food fast. Refreshing scent after every rinse.",
      badge: "Fresh citrus",
      rating: 4.7,
      reviews: 141,
      image: "https://images.unsplash.com/photo-1610557892470-55d9e80c0bce?auto=format&fit=crop&w=800&q=80",
      sizes: [
        { label: "500ml", price: 4200 },
        { label: "750ml", price: 5800 },
        { label: "1L", price: 8000 },
        { label: "2L", price: 14800 }
      ]
    },
    {
      id: "berry-blast",
      name: "Berry Blast",
      category: "dishwash",
      desc: "Berry-fresh gel with antibacterial power. Sparkling glasses, happy kitchen.",
      badge: "Antibacterial",
      rating: 4.6,
      reviews: 98,
      image: "https://images.unsplash.com/photo-1556911220-e15b29be8c8f?auto=format&fit=crop&w=800&q=80",
      sizes: [
        { label: "500ml", price: 4600 },
        { label: "750ml", price: 6400 },
        { label: "1L", price: 8800 },
        { label: "2L", price: 16000 }
      ]
    },
    {
      id: "aloe-soft",
      name: "Aloe Soft",
      category: "dishwash",
      desc: "Aloe-enriched formula that pampers hands while it powers through oil and grime.",
      badge: "Skin friendly",
      rating: 4.8,
      reviews: 173,
      image: "https://images.unsplash.com/photo-1522673607200-164d1b6ce486?auto=format&fit=crop&w=800&q=80",
      sizes: [
        { label: "500ml", price: 4800 },
        { label: "750ml", price: 6600 },
        { label: "1L", price: 9000 },
        { label: "2L", price: 16400 }
      ]
    },

    /* ============ BODY COSMETICS ============ */
    {
      id: "shea-body-butter",
      name: "Shea Body Butter",
      category: "cosmetics",
      desc: "Rich whipped shea & cocoa butter for deep, all-day moisture. 200ml jar.",
      badge: "Best for dry skin",
      rating: 4.9,
      reviews: 231,
      featured: true,
      image: "https://images.unsplash.com/photo-1611930022073-b7a4ba5fcccd?auto=format&fit=crop&w=800&q=80",
      price: 6500,
      oldPrice: 7500
    },
    {
      id: "coconut-body-wash",
      name: "Coconut Body Wash",
      category: "cosmetics",
      desc: "Creamy coconut milk wash that cleanses softly and keeps skin smooth. 400ml.",
      badge: "Hydrating",
      rating: 4.7,
      reviews: 164,
      image: "https://images.unsplash.com/photo-1595425970377-c9703cf48b6d?auto=format&fit=crop&w=800&q=80",
      price: 5800
    },
    {
      id: "sugar-body-scrub",
      name: "Sugar Body Scrub",
      category: "cosmetics",
      desc: "Brown sugar & lime crystals that buff away dullness for baby-soft skin. 250ml.",
      badge: "Exfoliating",
      rating: 4.8,
      reviews: 142,
      image: "https://images.unsplash.com/photo-1556228578-8c89e6adf883?auto=format&fit=crop&w=800&q=80",
      price: 7200
    },
    {
      id: "aloe-hand-cream",
      name: "Aloe Hand Cream",
      category: "cosmetics",
      desc: "Fast-absorbing aloe cream that repairs dry, cracked hands. 100ml tube.",
      badge: "Non-greasy",
      rating: 4.6,
      reviews: 87,
      image: "https://images.unsplash.com/photo-1598440947619-2c35fc9aa908?auto=format&fit=crop&w=800&q=80",
      price: 3900
    },
    {
      id: "vanilla-body-lotion",
      name: "Vanilla Body Lotion",
      category: "cosmetics",
      desc: "Silky vanilla-scented lotion for everyday glow and 24-hour softness. 350ml.",
      badge: "Daily glow",
      rating: 4.7,
      reviews: 118,
      image: "https://images.unsplash.com/photo-1556228720-195a672e8a03?auto=format&fit=crop&w=800&q=80",
      price: 5200
    },
    {
      id: "glow-body-oil",
      name: "Glow Body Oil",
      category: "cosmetics",
      desc: "Nourishing botanical oil that leaves skin luminous and lightly scented. 150ml.",
      badge: "Radiance",
      rating: 4.8,
      reviews: 76,
      image: "https://images.unsplash.com/photo-1567721913486-6585f069b332?auto=format&fit=crop&w=800&q=80",
      price: 8900
    },

    /* ============ PERFUMES ============ */
    {
      id: "oud-royale",
      name: "Oud Royale",
      category: "perfume",
      desc: "Smoky oud blended with amber and saffron. A long-lasting evening statement.",
      badge: "Signature",
      rating: 4.9,
      reviews: 204,
      featured: true,
      image: "https://images.unsplash.com/photo-1541643600914-78b084683601?auto=format&fit=crop&w=800&q=80",
      sizes: [
        { label: "30ml", price: 14900 },
        { label: "50ml", price: 24500 },
        { label: "100ml", price: 42500 }
      ]
    },
    {
      id: "citrus-bloom",
      name: "Citrus Bloom",
      category: "perfume",
      desc: "Bright bergamot, neroli and white florals. Fresh, airy and effortlessly chic.",
      badge: "Daytime fresh",
      rating: 4.8,
      reviews: 167,
      image: "https://images.unsplash.com/photo-1596462502278-27bfdc403348?auto=format&fit=crop&w=800&q=80",
      sizes: [
        { label: "30ml", price: 9800 },
        { label: "50ml", price: 15800 },
        { label: "100ml", price: 26800 }
      ]
    },
    {
      id: "amber-nights",
      name: "Amber Nights",
      category: "perfume",
      desc: "Warm amber, vanilla and musk for cozy evenings. Rich, addictive trail.",
      badge: "Evening",
      rating: 4.8,
      reviews: 189,
      image: "https://images.unsplash.com/photo-1615634260167-c8cdede054de?auto=format&fit=crop&w=800&q=80",
      sizes: [
        { label: "30ml", price: 12400 },
        { label: "50ml", price: 19900 },
        { label: "100ml", price: 34500 }
      ]
    },
    {
      id: "rose-elegance",
      name: "Rose Élégance",
      category: "perfume",
      desc: "Damask rose with soft peony and clean musk. Romantic and timeless.",
      badge: "Floral",
      rating: 4.7,
      reviews: 133,
      image: "https://images.unsplash.com/photo-1547887537-6158d64c35b3?auto=format&fit=crop&w=800&q=80",
      sizes: [
        { label: "30ml", price: 11000 },
        { label: "50ml", price: 17500 },
        { label: "100ml", price: 29800 }
      ]
    },
    {
      id: "velvet-musk",
      name: "Velvet Musk",
      category: "perfume",
      desc: "Powdery musk with iris and sandalwood. Soft, sensual and unisex.",
      badge: "Unisex",
      rating: 4.9,
      reviews: 221,
      image: "https://images.unsplash.com/photo-1608571423902-eed4a5ad8108?auto=format&fit=crop&w=800&q=80",
      sizes: [
        { label: "30ml", price: 16800 },
        { label: "50ml", price: 28000 },
        { label: "100ml", price: 48000 }
      ]
    },

    /* ============ AIR FRESHENERS ============ */
    {
      id: "citrus-room-mist",
      name: "Citrus Room Mist",
      category: "air",
      desc: "Instant fresh citrus burst for kitchens, living rooms and offices. 300ml spray.",
      badge: "Kitchen fresh",
      rating: 4.7,
      reviews: 154,
      featured: true,
      image: "https://images.unsplash.com/photo-1585771724684-38269d6639fd?auto=format&fit=crop&w=800&q=80",
      price: 3500
    },
    {
      id: "lavender-spray",
      name: "Lavender Room Spray",
      category: "air",
      desc: "Calming lavender mist that neutralises odours and relaxes the room. 250ml.",
      badge: "Calming",
      rating: 4.8,
      reviews: 126,
      image: "https://images.unsplash.com/photo-1615397349754-cfa2066a298e?auto=format&fit=crop&w=800&q=80",
      price: 3200
    },
    {
      id: "ocean-car-fresh",
      name: "Ocean Car Freshener",
      category: "air",
      desc: "Fresh ocean breeze scent that lasts weeks in any car. Clip-on spray, 100ml.",
      badge: "Car essential",
      rating: 4.6,
      reviews: 203,
      image: "https://images.unsplash.com/photo-1625772299848-391b6a87d7b3?auto=format&fit=crop&w=800&q=80",
      price: 2800
    },
    {
      id: "vanilla-candle",
      name: "Vanilla Scent Candle",
      category: "air",
      desc: "Hand-poured vanilla soy candle with a cosy 40-hour burn. 200g.",
      badge: "Hand-poured",
      rating: 4.9,
      reviews: 96,
      image: "https://images.unsplash.com/photo-1603006905003-be475563bc59?auto=format&fit=crop&w=800&q=80",
      price: 4500
    },
    {
      id: "floral-aroma-candle",
      name: "Floral Aroma Candle",
      category: "air",
      desc: "Jasmine & peony candle that fills the room with soft garden florals. 200g.",
      badge: "Floral",
      rating: 4.8,
      reviews: 84,
      image: "https://images.unsplash.com/photo-1562157873-818bc0726f68?auto=format&fit=crop&w=800&q=80",
      price: 4900
    }
  ]
};

/* helpers */
(function () {
  UAGE_DATA.getProduct = function (id) {
    return UAGE_DATA.products.find(function (p) { return p.id === id; });
  };
  UAGE_DATA.getCategory = function (slug) {
    return UAGE_DATA.categories.find(function (c) { return c.slug === slug; });
  };
  UAGE_DATA.byCategory = function (slug) {
    return UAGE_DATA.products.filter(function (p) { return p.category === slug; });
  };
  UAGE_DATA.format = function (n) {
    return "\u20A6" + Number(n || 0).toLocaleString("en-NG");
  };
})();