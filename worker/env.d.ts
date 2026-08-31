/**
 * Secrets are set with `wrangler secret put` rather than declared in wrangler.jsonc, so
 * they do not appear in the generated bindings. Declared here so the Worker still type
 * checks, and optional because the app runs without a relay configured.
 *
 *   npx wrangler secret put TURN_KEY_ID
 *   npx wrangler secret put TURN_KEY_API_TOKEN
 */
interface Env {
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}
