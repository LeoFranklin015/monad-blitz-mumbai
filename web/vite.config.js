import { defineConfig } from "vite";

export default defineConfig({
  server: {
    strictPort: true,
    proxy: {
      "/rpc": {
        target: "https://monad-testnet.g.alchemy.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/rpc/, "/v2/alch_I7RtHwdMsa590uGHCV6jt"),
      },
    },
  },
  build: { target: "es2022", outDir: "dist" },
});
