import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Imagem Docker enxuta: só o servidor e as dependências rastreadas.
  output: "standalone",
  // Monorepo: rastreia dependências a partir da raiz do repositório.
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  poweredByHeader: false,
};

export default nextConfig;
