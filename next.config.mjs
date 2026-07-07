/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Sub-path hosting (e.g. NEXT_PUBLIC_BASE_PATH=/jargonslayer for the
  // public demo). Unset for the default root deployment. Client code
  // reads the same var via src/lib/basePath.ts.
  ...(process.env.NEXT_PUBLIC_BASE_PATH
    ? { basePath: process.env.NEXT_PUBLIC_BASE_PATH }
    : {}),
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
  },
};

export default nextConfig;
