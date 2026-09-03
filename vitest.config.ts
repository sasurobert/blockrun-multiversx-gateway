import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    pool: "forks",
    env: {
      NO_PROXY: "127.0.0.1,localhost,::1",
      no_proxy: "127.0.0.1,localhost,::1",
      HTTP_PROXY: "",
      http_proxy: "",
      HTTPS_PROXY: "",
      https_proxy: "",
      ALL_PROXY: "",
      all_proxy: "",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
    },
  },
});
