import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Cache Components makes dev renders of the date-heavy Overview take 25s+ (Date access tracking); nothing here uses "use cache".
  cacheComponents: false,
  serverExternalPackages: ["@clausage/core"],
  turbopack: {
    root: path.join(__dirname, "..", ".."),
    // core resolves the user's log directories at runtime; output tracing doesn't matter for a local app.
    ignoreIssue: [{ path: "**/packages/core/dist/**", title: /Dynamic filesystem access/ }],
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
