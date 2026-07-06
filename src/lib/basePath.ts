// Build-time base path support for sub-path hosting (e.g. the public
// demo at apps.bioinfospace.com/jargonslayer). Next.js only auto-
// prefixes <Link>/router/assets with `basePath`; raw fetch() calls,
// plain <a>/<img> attributes, and audioWorklet module URLs must go
// through withBase(). NEXT_PUBLIC_ so the value inlines into client
// bundles at build time; empty string for the default root deployment.
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export function withBase(path: string): string {
  return `${BASE_PATH}${path}`;
}
