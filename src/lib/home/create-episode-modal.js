// The create form lives behind an overlay. After a failed `?/create` POST,
// SvelteKit puts the fail payload on `form` and re-renders the page with
// the overlay closed unless we reopen it from that payload. Only `error`
// is a create-form failure — `siteError` belongs to the site password gate.

export function shouldOpenCreateEpisodeModal(form) {
  return Boolean(form?.error)
}
