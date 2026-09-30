import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	cacheTranslation,
	getCachedTranslation,
	TRANSLATION_CACHE_TTL_SECONDS,
	translationCacheKey,
} from "../src/store";
import { createEnv, MockKV } from "./test-utils";

describe("translationCacheKey", () => {
	it("cache: プレフィックス + 64 文字の 16 進 (SHA-256) キーを返す", async () => {
		const key = await translationCacheKey("Hello", "ja");
		expect(key).toMatch(/^cache:[0-9a-f]{64}$/);
	});

	it("同一の text + lang は同一キーを返す (決定的)", async () => {
		const a = await translationCacheKey("Hello", "ja");
		const b = await translationCacheKey("Hello", "ja");
		expect(a).toBe(b);
	});

	it("text が異なれば別キーを返す", async () => {
		const a = await translationCacheKey("Hello", "ja");
		const b = await translationCacheKey("Hello!", "ja");
		expect(a).not.toBe(b);
	});

	it("lang が異なれば別キーを返す", async () => {
		const a = await translationCacheKey("Hello", "ja");
		const b = await translationCacheKey("Hello", "fr");
		expect(a).not.toBe(b);
	});
});

describe("getCachedTranslation / cacheTranslation", () => {
	let kv: MockKV;

	beforeEach(() => {
		kv = new MockKV();
	});

	it("cacheTranslation で保存した値を getCachedTranslation で読み戻せる", async () => {
		const env = createEnv({ kv });
		await cacheTranslation(env, "Hello", "ja", "こんにちは");
		await expect(getCachedTranslation(env, "Hello", "ja")).resolves.toBe(
			"こんにちは",
		);
	});

	it("KV.put に expirationTtl: 1209600 (2 週間) が渡る", async () => {
		const env = createEnv({ kv });
		await cacheTranslation(env, "Hello", "ja", "こんにちは");
		const key = await translationCacheKey("Hello", "ja");
		expect(kv.putOptions.get(key)?.expirationTtl).toBe(
			TRANSLATION_CACHE_TTL_SECONDS,
		);
		expect(kv.putOptions.get(key)?.expirationTtl).toBe(1209600);
	});

	it("値が長い原文・特殊文字でもラウンドトリップできる", async () => {
		const env = createEnv({ kv });
		const text = `改行\n含む "引用" 🌐 ${"あ".repeat(2000)}`;
		await cacheTranslation(env, text, "fr", "Bonjour");
		await expect(getCachedTranslation(env, text, "fr")).resolves.toBe(
			"Bonjour",
		);
	});

	it("KV に値が無い場合は null を返す", async () => {
		const env = createEnv({ kv });
		await expect(getCachedTranslation(env, "Hello", "ja")).resolves.toBeNull();
	});

	it("空文字が保存されていた場合も null (ミス) 扱いにする", async () => {
		const env = createEnv({ kv });
		const key = await translationCacheKey("Hello", "ja");
		kv.store.set(key, "");
		await expect(getCachedTranslation(env, "Hello", "ja")).resolves.toBeNull();
	});

	it("KV.get が例外を投げても null を返し例外は漏れない", async () => {
		const failingKv = {
			get: async () => {
				throw new Error("KV get failed");
			},
			put: async () => {},
		} as unknown as MockKV;
		const env = createEnv({ kv: failingKv });
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		try {
			await expect(
				getCachedTranslation(env, "Hello", "ja"),
			).resolves.toBeNull();
		} finally {
			consoleError.mockRestore();
		}
	});

	it("KV.put が例外を投げても cacheTranslation は例外を投げない", async () => {
		const failingKv = {
			get: async () => null,
			put: async () => {
				throw new Error("KV put failed");
			},
		} as unknown as MockKV;
		const env = createEnv({ kv: failingKv });
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		try {
			await expect(
				cacheTranslation(env, "Hello", "ja", "こんにちは"),
			).resolves.toBeUndefined();
		} finally {
			consoleError.mockRestore();
		}
	});
});
