import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			// AI バインディングはローカルシミュレータが存在しないため、
			// プラグイン既定の remoteBindings: true だと CLOUDFLARE_API_TOKEN が
			// 必須になる。テストでは AI をモック注入するため remote を無効化する
			remoteBindings: false,
		}),
	],
});
