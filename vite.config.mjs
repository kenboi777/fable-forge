import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({ base: "/fable-forge/", plugins: [react()], build: { target: "es2022", minify: false, outDir: "site-dist", emptyOutDir: false } });
