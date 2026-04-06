import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  define: {
    // Required for @solana/web3.js in the browser
    "process.env": {},
    global: "globalThis",
  },
  resolve: {
    alias: {
      stream: "stream-browserify",
    },
  },
  optimizeDeps: {
    include: ["@solana/web3.js", "@coral-xyz/anchor"],
    esbuildOptions: {
      target: "esnext",
    },
  },
});
