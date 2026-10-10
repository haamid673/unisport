/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Supabase API URL, e.g. http://127.0.0.1:54321 for the local stack. */
  readonly VITE_SUPABASE_URL?: string;
  /**
   * Supabase publishable (anon) key. Safe for the browser by design:
   * data access is enforced by Row Level Security. NEVER put a
   * service-role or secret key in a VITE_* variable.
   */
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
