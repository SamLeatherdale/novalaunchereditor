import react from "@vitejs/plugin-react";
import { defineConfig, lazyPlugins } from "vite-plus";
import { devBackupsPlugin } from "./src/server/viteDevBackupsPlugin";
import { playAppDevPlugin } from "./src/server/vitePlayAppPlugin";

export default defineConfig({
  fmt: {
    ignorePatterns: ["dist/**", "backups/**", ".sandbox/**"],
  },
  lint: {
    ignorePatterns: ["dist/**", "backups/**", ".sandbox/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  plugins: lazyPlugins(() => [react(), playAppDevPlugin(), devBackupsPlugin()]),
});
