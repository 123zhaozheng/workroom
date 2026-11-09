import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

const target = process.env.WORKROOM_API ?? "http://127.0.0.1:8787";

export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./src", import.meta.url)),
			"@shared": fileURLToPath(new URL("../shared", import.meta.url)),
		},
	},
	server: {
		port: 5173,
		proxy: { "/api": { target, changeOrigin: false } },
	},
	build: {
		outDir: "dist",
		// Heavy previewers / charts are split by dynamic import(); keep warnings meaningful.
		chunkSizeWarningLimit: 900,
	},
});
