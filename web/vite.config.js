import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const alchemyKey = env.VITE_ALCHEMY_KEY || "";
  const rpcTarget = alchemyKey
    ? `https://monad-testnet.g.alchemy.com`
    : `https://monad-testnet.drpc.org`;
  const rpcRewrite = alchemyKey
    ? (path) => path.replace(/^\/rpc/, `/v2/${alchemyKey}`)
    : (path) => path.replace(/^\/rpc/, "");

  return {
    server: {
      strictPort: true,
      proxy: {
        "/rpc": { target: rpcTarget, changeOrigin: true, rewrite: rpcRewrite },
      },
    },
    build: { target: "es2022", outDir: "dist" },
  };
});
