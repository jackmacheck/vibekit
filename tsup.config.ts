import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  external: ["e2b", "@daytonaio/sdk"],
  splitting: false,
  sourcemap: false,
  clean: true,
});
