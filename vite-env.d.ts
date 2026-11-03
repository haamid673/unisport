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
  /**
   * Razorpay TEST public key id (rzp_test_...). Switches on test-mode
   * checkout; must equal the key id the payments-create-order function
   * returns. Live keys are refused. NEVER put the Razorpay key SECRET in
   * any VITE_* variable.
   */
  readonly VITE_RAZORPAY_TEST_KEY_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
