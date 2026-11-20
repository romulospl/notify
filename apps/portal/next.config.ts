import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lean Docker image: only the server and the traced dependencies.
  output: "standalone",
  // Monorepo: traces dependencies from the repository root.
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  poweredByHeader: false,
  // The portal does not use the image optimizer; avoids depending on libvips at runtime.
  images: { unoptimized: true },
};

export default nextConfig;
