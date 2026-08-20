/**
 * Svelte action that keeps an input `readonly` until it's first focused.
 *
 * Chrome's password manager (save-password prompt + the "adjacent field
 * autofill" behavior that clobbers a neighbouring text input) decides
 * whether a field is a fillable login field by scanning the DOM at parse
 * time — `autocomplete="off"` doesn't stop this for anything it judges to
 * be a login form, and `--disable-features=...` launch flags don't
 * reliably suppress it either (see playwright.config.js history). A field
 * that's `readonly` at parse time is invisible to that scan; removing
 * `readonly` on focus makes it behave like a normal input for the user.
 *
 * Pair this with a `readonly` attribute in the markup (so SSR HTML is
 * already skipped by Chrome's scan) and run this action *before*
 * `use:focus`. Playwright's `.fill()` checks "editable" *before* it
 * focuses, so a stuck-readonly field is a deadlock, not a fill.
 *
 * Rooms here are one-off/transitory — there's never a credential worth
 * Chrome offering to save — so this is a permanent UX fix, not just a
 * test workaround.
 */
export function noAutofill(node) {
  function unlock() {
    node.readOnly = false;
  }
  node.readOnly = true;
  node.addEventListener("focus", unlock, { once: true });
  // `use:focus` (or the browser restoring focus) may have already focused
  // this node before the action ran, so the listener would never fire and
  // the field would stay stuck readonly — including for Playwright.
  if (document.activeElement === node) unlock();
  return {
    destroy() {
      node.removeEventListener("focus", unlock);
    },
  };
}
