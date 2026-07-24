// v0.6 T3(a) — dictionary pack URL installs: users paste a GitHub
// *blob* URL (the page you land on browsing a repo, e.g.
// https://github.com/<owner>/<repo>/blob/<ref>/<path>) constantly,
// instead of the raw.githubusercontent.com content URL addPackSource
// actually needs to fetch. This is a pure, total rewrite — anything
// that isn't exactly that shape (a non-GitHub host, a GitHub URL that
// isn't a /blob/ path, or a string that doesn't even parse as a URL)
// passes through completely unchanged; the caller (SettingsDialog)
// still owns deciding whether the result is actually installable
// (https-only, etc.).

/** `https://github.com/<owner>/<repo>/blob/<ref>/<path...>` ->
 *  `https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path...>`.
 *  Query string/fragment (github's own UI params, e.g. `?plain=1`/
 *  `#L10-L20`) are dropped — meaningless on a raw content URL, and
 *  never carried over since the rewrite is rebuilt from the matched
 *  path groups alone rather than editing the original URL in place. */
export function toRawGithubUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") return url;
  const m = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
  if (!m) return url;
  const [, owner, repo, ref, path] = m;
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`;
}
