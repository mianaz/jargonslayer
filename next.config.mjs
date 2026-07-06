/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Sub-path hosting (e.g. NEXT_PUBLIC_BASE_PATH=/jargonslayer for the
  // public demo). Unset for the default root deployment. Client code
  // reads the same var via src/lib/basePath.ts.
  ...(process.env.NEXT_PUBLIC_BASE_PATH
    ? { basePath: process.env.NEXT_PUBLIC_BASE_PATH }
    : {}),
};

export default nextConfig;
