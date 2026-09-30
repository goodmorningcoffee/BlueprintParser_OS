import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  turbopack: {},
  // No component uses next/image, but the optimizer endpoint is on by default and replays any
  // local GET route WITHOUT passing through middleware (no rate limit, no IP ban, no visit log).
  images: { unoptimized: true },
};

export default nextConfig;
