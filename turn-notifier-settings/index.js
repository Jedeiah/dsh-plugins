/**
 * Host half of the turn-notifier-settings bundle.
 *
 * Why this bundle exists: the settings page of `@jedeiah/turn-notifier` used to
 * live in that bundle's Client half, which lives and dies with its profile row.
 * Switching a row that ships a Client half off tears the half down, and
 * switching it back on does not mount it again (deepseek-harness#8452: the
 * browser module table reports the bundle as already loaded, so `apply` never
 * re-runs) — which is how the row's `›` went missing. A page can only outlive
 * that switch if it belongs to a bundle whose own row is never meant to be
 * switched off, so the page lives here and registers itself on the notifier's
 * row.
 *
 * The Host half itself is deliberately empty: this bundle has no tunables of its
 * own. The values its page edits are the notifier's `Config`
 * (../turn-notifier/index.js, `.volatile()` fields), read through the global
 * `configForms` service. Exporting no `Config` here also leaves the settings
 * service nothing to describe for this row, so there is no auto-generated form
 * to suppress either.
 */

/** No Host-side behavior: the row exists only to carry this bundle's Client half. */
export function apply() {}
