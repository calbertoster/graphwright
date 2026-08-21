/**
 * Shared across app.mjs and the view modules — anything built from
 * API-sourced text (error messages, node/file/language names) that goes
 * into innerHTML must go through this first. API error messages can echo
 * user-supplied input back (e.g. a bad /api/node/:id id), so this isn't
 * just defensive: it's the one thing standing between a crafted request
 * and script execution in the viewer.
 */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
