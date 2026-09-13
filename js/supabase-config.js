/* ===========================================================================
 * UAGE — public Supabase client configuration
 * ---------------------------------------------------------------------------
 * These two values are PUBLISHABLE. They are meant to be visible in the
 * browser: the anon key grants nothing on its own, because every table is
 * protected by Row Level Security. This is the only file that may hold
 * Supabase values that reach the browser.
 *
 * NEVER put the service-role key here (or anywhere under js/). It bypasses
 * every RLS policy and must stay server-side in .env only.
 *
 * Fill these in from:  Supabase Dashboard -> Project Settings -> API
 * =========================================================================== */
window.UAGE_SUPABASE_CONFIG = {
  /* Project URL — Supabase Dashboard -> Project Settings -> API -> Project URL */
  url: "https://dfijuptbuhshmdsalbnm.supabase.co",

  /* The "anon / public" key, NOT the service_role / secret key.
   * Decoded before committing: { role: "anon", ref: "dfijuptbuhshmdsalbnm" }. */
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRmaWp1cHRidWhzaG1kc2FsYm5tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkxNTc4NjAsImV4cCI6MjEwNDczMzg2MH0.d_cEwrVHUcfh00Gd_IBqUyicKGIFU2enGIdJS8ENYkk",

  /* supabase-js major version loaded on demand by js/api.js */
  clientVersion: "@2",

  /* ---- internal: has somebody actually filled the values in? ---- */
  isConfigured: function () {
    return Boolean(
      this.url &&
        this.anonKey &&
        this.url.indexOf("YOUR-PROJECT-REF") === -1 &&
        this.anonKey.indexOf("YOUR-ANON-PUBLIC-KEY") === -1 &&
        /^https:\/\/.+\.supabase\.(co|in)$/.test(this.url)
    );
  },

  /* ---- internal: guard against the service-role key being pasted in ---- */
  looksLikeSecretKey: function () {
    return /^(sb_secret_|service_role)/.test(String(this.anonKey || "")) ||
      String(this.anonKey || "").indexOf("service_role") !== -1;
  }
};
