-- ===========================================================================
-- UAGE — 05. Seed the live catalog
-- ---------------------------------------------------------------------------
-- Brings the 22 products that currently live in data.js into the database,
-- keeping the exact same slugs so every existing product.html?id=… URL and
-- every shared link keeps working.
--
-- Idempotent: re-running updates the existing rows instead of duplicating.
--
-- Stock note: seeded stock is placeholder stock so the store is orderable
-- immediately. Real stock is managed by an administrator.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Categories
-- ---------------------------------------------------------------------------
insert into public.categories (slug, name, icon, tag, blurb, features, sort_order) values
  ('dishwash', 'Dishwash Liquid', 'fa-soap', 'Kitchen care', '500ml to 2L jugs',
   array[
     'Cuts 100% of grease on contact',
     'Plant-based, biodegradable formula',
     'Gentle on hands — no harsh residue',
     'Fresh scent that lingers after rinsing'
   ], 1),
  ('cosmetics', 'Body Cosmetics', 'fa-spa', 'Skin & body', 'Butters, scrubs, creams',
   array[
     'Formulated for all skin types',
     'Deep, long-lasting moisture',
     'Paraben-free & cruelty-free',
     'Lightweight, fast-absorbing texture'
   ], 2),
  ('perfume', 'Perfumes', 'fa-spray-can-sparkles', 'Signature scents', 'Eau de parfum',
   array[
     'Long-lasting eau de parfum concentration',
     'Rich sillage that lingers all day',
     'Alcohol-based, skin-safe blend',
     'Available in 30ml, 50ml and 100ml'
   ], 3),
  ('air', 'Air Fresheners', 'fa-wind', 'Home & car', 'Mists, candles & more',
   array[
     'Neutralises odours — doesn''t just mask them',
     'Long-lasting fresh scent',
     'Safe for home, office and car',
     'Quality you can smell from the first spray'
   ], 4)
on conflict (slug) do update
  set name       = excluded.name,
      icon       = excluded.icon,
      tag        = excluded.tag,
      blurb      = excluded.blurb,
      features   = excluded.features,
      sort_order = excluded.sort_order;

-- ---------------------------------------------------------------------------
-- Products
-- `price` is NULL for size-priced ranges (their prices live in
-- product_variants); single-size items carry their price directly.
-- ---------------------------------------------------------------------------
insert into public.products (
  slug, name, description, category, price, old_price, badge,
  rating, review_count, image_url, featured, stock_quantity
) values
  -- Dishwash liquid — priced per size
  ('crystal-clean', 'Crystal Clean',
   'Grease destroyer with a fresh citrus scent. Concentrated, streak-free shine.',
   'dishwash', null, null, 'Bestseller', 4.9, 312,
   'https://images.unsplash.com/photo-1563453392212-326f5e854473?auto=format&fit=crop&w=800&q=80',
   true, 0),

  ('fresh-zest', 'Fresh Zest',
   'Lemon & lavender power that cuts 100% of grease. Gentle on hands, bold on dishes.',
   'dishwash', null, null, 'Lemon & Lavender', 4.8, 196,
   'https://images.unsplash.com/photo-1584622650111-993a426fbf0a?auto=format&fit=crop&w=800&q=80',
   true, 0),

  ('silky-foam', 'Silky Foam',
   'Cloud-like foam, tough on oil yet extra mild on skin. No harsh residue.',
   'dishwash', null, null, 'Gentle care', 4.9, 258,
   'https://images.unsplash.com/photo-1585421514738-01798e348b17?auto=format&fit=crop&w=800&q=80',
   false, 0),

  ('lemon-burst', 'Lemon Burst',
   'Zingy lemon gel that lifts burnt-on food fast. Refreshing scent after every rinse.',
   'dishwash', null, null, 'Fresh citrus', 4.7, 141,
   'https://images.unsplash.com/photo-1610557892470-55d9e80c0bce?auto=format&fit=crop&w=800&q=80',
   false, 0),

  ('berry-blast', 'Berry Blast',
   'Berry-fresh gel with antibacterial power. Sparkling glasses, happy kitchen.',
   'dishwash', null, null, 'Antibacterial', 4.6, 98,
   'https://images.unsplash.com/photo-1556911220-e15b29be8c8f?auto=format&fit=crop&w=800&q=80',
   false, 0),

  ('aloe-soft', 'Aloe Soft',
   'Aloe-enriched formula that pampers hands while it powers through oil and grime.',
   'dishwash', null, null, 'Skin friendly', 4.8, 173,
   'https://images.unsplash.com/photo-1522673607200-164d1b6ce486?auto=format&fit=crop&w=800&q=80',
   false, 0),

  -- Body cosmetics — single price
  ('shea-body-butter', 'Shea Body Butter',
   'Rich whipped shea & cocoa butter for deep, all-day moisture. 200ml jar.',
   'cosmetics', 6500, 7500, 'Best for dry skin', 4.9, 231,
   'https://images.unsplash.com/photo-1611930022073-b7a4ba5fcccd?auto=format&fit=crop&w=800&q=80',
   true, 45),

  ('coconut-body-wash', 'Coconut Body Wash',
   'Creamy coconut milk wash that cleanses softly and keeps skin smooth. 400ml.',
   'cosmetics', 5800, null, 'Hydrating', 4.7, 164,
   'https://images.unsplash.com/photo-1595425970377-c9703cf48b6d?auto=format&fit=crop&w=800&q=80',
   false, 60),

  ('sugar-body-scrub', 'Sugar Body Scrub',
   'Brown sugar & lime crystals that buff away dullness for baby-soft skin. 250ml.',
   'cosmetics', 7200, null, 'Exfoliating', 4.8, 142,
   'https://images.unsplash.com/photo-1556228578-8c89e6adf883?auto=format&fit=crop&w=800&q=80',
   false, 38),

  ('aloe-hand-cream', 'Aloe Hand Cream',
   'Fast-absorbing aloe cream that repairs dry, cracked hands. 100ml tube.',
   'cosmetics', 3900, null, 'Non-greasy', 4.6, 87,
   'https://images.unsplash.com/photo-1598440947619-2c35fc9aa908?auto=format&fit=crop&w=800&q=80',
   false, 72),

  ('vanilla-body-lotion', 'Vanilla Body Lotion',
   'Silky vanilla-scented lotion for everyday glow and 24-hour softness. 350ml.',
   'cosmetics', 5200, null, 'Daily glow', 4.7, 118,
   'https://images.unsplash.com/photo-1556228720-195a672e8a03?auto=format&fit=crop&w=800&q=80',
   false, 55),

  ('glow-body-oil', 'Glow Body Oil',
   'Nourishing botanical oil that leaves skin luminous and lightly scented. 150ml.',
   'cosmetics', 8900, null, 'Radiance', 4.8, 76,
   'https://images.unsplash.com/photo-1567721913486-6585f069b332?auto=format&fit=crop&w=800&q=80',
   false, 24),

  -- Perfumes — priced per size
  ('oud-royale', 'Oud Royale',
   'Smoky oud blended with amber and saffron. A long-lasting evening statement.',
   'perfume', null, null, 'Signature', 4.9, 204,
   'https://images.unsplash.com/photo-1541643600914-78b084683601?auto=format&fit=crop&w=800&q=80',
   true, 0),

  ('citrus-bloom', 'Citrus Bloom',
   'Bright bergamot, neroli and white florals. Fresh, airy and effortlessly chic.',
   'perfume', null, null, 'Daytime fresh', 4.8, 167,
   'https://images.unsplash.com/photo-1596462502278-27bfdc403348?auto=format&fit=crop&w=800&q=80',
   false, 0),

  ('amber-nights', 'Amber Nights',
   'Warm amber, vanilla and musk for cozy evenings. Rich, addictive trail.',
   'perfume', null, null, 'Evening', 4.8, 189,
   'https://images.unsplash.com/photo-1615634260167-c8cdede054de?auto=format&fit=crop&w=800&q=80',
   false, 0),

  ('rose-elegance', 'Rose Élégance',
   'Damask rose with soft peony and clean musk. Romantic and timeless.',
   'perfume', null, null, 'Floral', 4.7, 133,
   'https://images.unsplash.com/photo-1547887537-6158d64c35b3?auto=format&fit=crop&w=800&q=80',
   false, 0),

  ('velvet-musk', 'Velvet Musk',
   'Powdery musk with iris and sandalwood. Soft, sensual and unisex.',
   'perfume', null, null, 'Unisex', 4.9, 221,
   'https://images.unsplash.com/photo-1608571423902-eed4a5ad8108?auto=format&fit=crop&w=800&q=80',
   false, 0),

  -- Air fresheners — single price
  ('citrus-room-mist', 'Citrus Room Mist',
   'Instant fresh citrus burst for kitchens, living rooms and offices. 300ml spray.',
   'air', 3500, null, 'Kitchen fresh', 4.7, 154,
   'https://images.unsplash.com/photo-1585771724684-38269d6639fd?auto=format&fit=crop&w=800&q=80',
   true, 80),

  ('lavender-spray', 'Lavender Room Spray',
   'Calming lavender mist that neutralises odours and relaxes the room. 250ml.',
   'air', 3200, null, 'Calming', 4.8, 126,
   'https://images.unsplash.com/photo-1615397349754-cfa2066a298e?auto=format&fit=crop&w=800&q=80',
   false, 64),

  ('ocean-car-fresh', 'Ocean Car Freshener',
   'Fresh ocean breeze scent that lasts weeks in any car. Clip-on spray, 100ml.',
   'air', 2800, null, 'Car essential', 4.6, 203,
   'https://images.unsplash.com/photo-1625772299848-391b6a87d7b3?auto=format&fit=crop&w=800&q=80',
   false, 90),

  ('vanilla-candle', 'Vanilla Scent Candle',
   'Hand-poured vanilla soy candle with a cosy 40-hour burn. 200g.',
   'air', 4500, null, 'Hand-poured', 4.9, 96,
   'https://images.unsplash.com/photo-1603006905003-be475563bc59?auto=format&fit=crop&w=800&q=80',
   false, 30),

  ('floral-aroma-candle', 'Floral Aroma Candle',
   'Jasmine & peony candle that fills the room with soft garden florals. 200g.',
   'air', 4900, null, 'Floral', 4.8, 84,
   'https://images.unsplash.com/photo-1562157873-818bc0726f68?auto=format&fit=crop&w=800&q=80',
   false, 26)
on conflict (slug) do update
  set name          = excluded.name,
      description   = excluded.description,
      category      = excluded.category,
      price         = excluded.price,
      old_price     = excluded.old_price,
      badge         = excluded.badge,
      rating        = excluded.rating,
      review_count  = excluded.review_count,
      image_url     = excluded.image_url,
      featured      = excluded.featured;

-- ---------------------------------------------------------------------------
-- Size variants
-- ---------------------------------------------------------------------------
insert into public.product_variants (product_id, label, price, stock_quantity, sort_order)
select p.id, v.label, v.price, v.stock, v.ord
from (values
  -- Crystal Clean
  ('crystal-clean', '500ml',  4500, 60, 1),
  ('crystal-clean', '750ml',  6200, 45, 2),
  ('crystal-clean', '1L',     8500, 35, 3),
  ('crystal-clean', '2L',    15500, 20, 4),
  -- Fresh Zest
  ('fresh-zest', '500ml',     5200, 55, 1),
  ('fresh-zest', '750ml',     7000, 40, 2),
  ('fresh-zest', '1L',        9500, 30, 3),
  ('fresh-zest', '2L',       17500, 18, 4),
  -- Silky Foam
  ('silky-foam', '500ml',     4900, 58, 1),
  ('silky-foam', '750ml',     6700, 42, 2),
  ('silky-foam', '1L',        9200, 32, 3),
  ('silky-foam', '2L',       16800, 19, 4),
  -- Lemon Burst
  ('lemon-burst', '500ml',    4200, 70, 1),
  ('lemon-burst', '750ml',    5800, 50, 2),
  ('lemon-burst', '1L',       8000, 36, 3),
  ('lemon-burst', '2L',      14800, 22, 4),
  -- Berry Blast
  ('berry-blast', '500ml',    4600, 48, 1),
  ('berry-blast', '750ml',    6400, 34, 2),
  ('berry-blast', '1L',       8800, 26, 3),
  ('berry-blast', '2L',      16000, 14, 4),
  -- Aloe Soft
  ('aloe-soft', '500ml',      4800, 52, 1),
  ('aloe-soft', '750ml',      6600, 38, 2),
  ('aloe-soft', '1L',         9000, 28, 3),
  ('aloe-soft', '2L',        16400, 16, 4),
  -- Oud Royale
  ('oud-royale', '30ml',     14900, 40, 1),
  ('oud-royale', '50ml',     24500, 26, 2),
  ('oud-royale', '100ml',    42500, 12, 3),
  -- Citrus Bloom
  ('citrus-bloom', '30ml',    9800, 44, 1),
  ('citrus-bloom', '50ml',   15800, 30, 2),
  ('citrus-bloom', '100ml',  26800, 15, 3),
  -- Amber Nights
  ('amber-nights', '30ml',   12400, 38, 1),
  ('amber-nights', '50ml',   19900, 24, 2),
  ('amber-nights', '100ml',  34500, 11, 3),
  -- Rose Élégance
  ('rose-elegance', '30ml',  11000, 36, 1),
  ('rose-elegance', '50ml',  17500, 23, 2),
  ('rose-elegance', '100ml', 29800, 10, 3),
  -- Velvet Musk
  ('velvet-musk', '30ml',    16800, 30, 1),
  ('velvet-musk', '50ml',    28000, 18, 2),
  ('velvet-musk', '100ml',   48000,  8, 3)
) as v(slug, label, price, stock, ord)
join public.products p on p.slug = v.slug
on conflict (product_id, label) do update
  set price     = excluded.price,
      sort_order = excluded.sort_order;

-- ---------------------------------------------------------------------------
-- Promo codes
-- ---------------------------------------------------------------------------
insert into public.promo_codes (code, percent_off, min_subtotal, max_uses, is_active)
values
  ('SPARKLE10', 10.00, 0, null, true)
on conflict (code) do update
  set percent_off  = excluded.percent_off,
      min_subtotal = excluded.min_subtotal,
      is_active    = excluded.is_active;

-- ===========================================================================
-- BOOTSTRAPPING THE FIRST ADMINISTRATOR
-- ---------------------------------------------------------------------------
-- There is intentionally no API path to admin, so the first one is created
-- directly in the Supabase SQL editor AFTER that person has signed up:
--
--   update public.user_roles
--      set role = 'admin', granted_at = now()
--    where user_id = (select id from auth.users where email = 'owner@example.com');
--
-- Verify with:
--
--   select u.email, r.role
--     from public.user_roles r
--     join auth.users u on u.id = r.user_id
--    order by r.role, u.email;
--
-- After that, additional administrators can be promoted from the admin page,
-- which calls the guarded public.admin_set_user_role() function.
-- ===========================================================================
