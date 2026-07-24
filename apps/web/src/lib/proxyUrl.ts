// W2 desktop proxy support — shared validation for the one proxyUrl
// field (F5 fix, field-test batch C: hoisted out of SettingsDialog.tsx
// so the restore/sanitize boundary in history/autoExport.ts can apply
// the SAME rules a hand-typed value already goes through, instead of
// a hand-edited backup file smuggling a malformed proxy past the
// dialog's own validator entirely).

// Same trim + full-width→ASCII hygiene as SettingsDialog's own
// normalizeBaseUrl (a sibling, not a shared/parameterized helper: the
// two fields' validation rules genuinely diverge below — a proxy
// URL's scheme set is wider and its userinfo is EXPECTED, not
// rejected — so folding them into one parameterized function would
// obscure that divergence for no real line-count win).
export function normalizeProxyUrl(raw: string): string {
  const trimmed = raw.trim();
  return trimmed
    .replace(/：/g, ":")
    .replace(/／/g, "/")
    .replace(/．/g, ".")
    .replace(/～/g, "~");
}

/** Empty stays allowed (= follow the system proxy, this field's own
 *  default). Scheme set is http/https/socks5/socks5h (a manual proxy —
 *  e.g. Clash's mixed port — commonly speaks either); userinfo
 *  (`user:pass@`) is DELIBERATELY allowed here, unlike isValidBaseUrl's
 *  own rejection of it, since a proxy URL is the one legitimate place
 *  Basic-auth credentials belong (tauri-plugin-http's own ProxyConfig
 *  forwards them as a `Proxy-Authorization` header, never sent to the
 *  proxy TARGET). "must have host" rejects a scheme-only value like
 *  `socks5://` (parses successfully but with an empty hostname) rather
 *  than silently handing tauri-plugin-http a hostless proxy config. */
export function isValidProxyUrl(value: string): boolean {
  if (!value) return true;
  if (/\s/.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (!["http:", "https:", "socks5:", "socks5h:"].includes(url.protocol)) return false;
  if (!url.hostname) return false;
  if (url.search || url.hash) return false;
  return true;
}
