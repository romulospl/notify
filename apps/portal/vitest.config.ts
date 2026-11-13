import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.join(import.meta.dirname, "src") } },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup-env.ts"],
    // Os testes de integração compartilham o mesmo banco.
    fileParallelism: false,
  },
});
