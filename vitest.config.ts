import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30_000,
    include: ["test/**/*.test.ts"],
    // Pre-download the ONNX model once so parallel test files don't race
    // on the same destination path. See test/global-setup.ts.
    globalSetup: ["./test/global-setup.ts"],
  },
});
