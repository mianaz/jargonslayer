/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // #53 workspace extraction: @jargonslayer/core ships raw TS source
  // (no build step, see packages/core/package.json), so Next's default
  // "don't transform node_modules" fast path must be told to run its
  // own SWC transform over it too, same as first-party app code.
  transpilePackages: ["@jargonslayer/core"],
  // Sub-path hosting (e.g. NEXT_PUBLIC_BASE_PATH=/jargonslayer for the
  // public demo). Unset for the default root deployment. Client code
  // reads the same var via src/lib/basePath.ts.
  ...(process.env.NEXT_PUBLIC_BASE_PATH
    ? { basePath: process.env.NEXT_PUBLIC_BASE_PATH }
    : {}),
  // v0.4 S1 dual-target hook (PLAN-v0.4 §1A): Tauri's desktop shell
  // wraps a static-export webview, so BUILD_TARGET=desktop must emit
  // `output: "export"` — API routes don't run in that target (S2
  // moves detect/define/translate/summarize to a client-side
  // callProvider). Only wiring the hook is in scope for S1: a
  // `BUILD_TARGET=desktop npm run build -w apps/web` run today is
  // EXPECTED to fail on the API routes (next export can't emit a
  // route with no static params / server-only code) — that's S2+S3's
  // job to resolve, not this session's. Web builds (BUILD_TARGET unset
  // or anything else) are completely unaffected.
  ...(process.env.BUILD_TARGET === "desktop" ? { output: "export" } : {}),
  // Subscription-direct kill-switch (v0.2.2, experimental — see
  // src/lib/agent/localHost.ts's isFeatureBuilt). Next.js's webpack
  // DefinePlugin only inlines a NEXT_PUBLIC_* var (and thus lets the
  // bundler dead-code-eliminate an `if (that var === "1")` branch) when
  // the var is ACTUALLY PRESENT in process.env at build time — a
  // genuinely UNSET var is left as a live `process.env.X` runtime
  // lookup instead (verified empirically 2026-07-06: an unset
  // NEXT_PUBLIC_ENABLE_SUBSCRIPTION_DIRECT left the whole SettingsDialog
  // section's JSX reachable in the client bundle, even though it
  // correctly rendered nothing at runtime — the section's MARKUP
  // survived tree-shaking, only its RUNTIME visibility was correct).
  // Explicitly defaulting it here to "" via next/dist/lib/static-env.
  // js's getNextConfigEnv (which defines process.env.KEY for any `env`
  // config key whose value is non-null, independent of the actual
  // shell environment) guarantees every build — including one where
  // the deployer never touched this var at all — gets a build-time-
  // inlinable falsy value, so the experience-tier/default build's
  // bundle genuinely omits the feature's markup+call code, not just
  // hides it at runtime.
  env: {
    NEXT_PUBLIC_ENABLE_SUBSCRIPTION_DIRECT:
      process.env.NEXT_PUBLIC_ENABLE_SUBSCRIPTION_DIRECT ?? "",
    // Preview tier (#61) — hosted showroom build (apps.bioinfospace.
    // com/jargonslayer): full UI visible, AI runs on OUR server key,
    // BYOK/sidecar-only affordances greyed with a 「本地版功能」 badge
    // instead of hidden. Same explicit-default-via-`env` requirement as
    // NEXT_PUBLIC_ENABLE_SUBSCRIPTION_DIRECT above (an unset var isn't
    // reliably inlined by DefinePlugin) — see src/lib/deployTier.ts.
    NEXT_PUBLIC_DEPLOY_TIER: process.env.NEXT_PUBLIC_DEPLOY_TIER ?? "",
    // v0.4 S2 (PLAN-v0.4 §1A/§4) — client-side callProvider path:
    // "client" routes detect/define/translate/summarize straight to
    // the LLM provider (BYOK only) instead of /api/*; unset/anything
    // else keeps today's behavior byte-identical. Same explicit-
    // default-via-`env` requirement as the two vars above — see
    // src/lib/llm/llmTransport.ts's useClientTransport. S3 (Tauri) is
    // expected to set this alongside BUILD_TARGET=desktop, since that
    // target has no /api/* to fall back to at all; S2 itself never sets
    // it by default.
    //
    // Flag containment (F2, codex v04-integration review): only ever
    // forward the AMBIENT env var when this is genuinely a
    // BUILD_TARGET=desktop build. A shared CI environment that happens
    // to export NEXT_PUBLIC_LLM_TRANSPORT=client (e.g. alongside a
    // desktop build run in the same job/environment) would otherwise
    // silently flip an ordinary hosted-web build onto the client-side
    // path too — and the hosted web app must NEVER lose its route-side
    // validation/allowlist/rate-limit (app/api/*/route.ts), even if
    // that env var leaks into its build environment. Every non-desktop
    // build gets a hardcoded "server" here, ignoring the ambient var
    // entirely (not "" — an explicit non-empty sentinel so a bundle
    // inspection unambiguously shows containment took effect, same
    // spirit as the two vars above always being build-time-inlinable).
    NEXT_PUBLIC_LLM_TRANSPORT:
      process.env.BUILD_TARGET === "desktop"
        ? (process.env.NEXT_PUBLIC_LLM_TRANSPORT ?? "")
        : "server",
  },
};

export default nextConfig;
