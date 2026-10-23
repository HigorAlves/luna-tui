import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // orc's browser QA opens the dev server as 127.0.0.1; Next blocks that origin for /_next/hmr by default.
  allowedDevOrigins: ["127.0.0.1"],
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
