import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	handleTranslate,
	truncateToDiscordLimit,
} from "../src/handlers/translate";
import worker, { MAX_BODY_LENGTH } from "../src/index";
import { translationCacheKey } from "../src/store";
import type { Env, Interaction } from "../src/types";
import {
	buildSignedInteractionRequest,
	createEnv,
	createMockCtx,
	type Ed25519TestKeys,
	freshTimestamp,
	generateEd25519KeyPair,
	MockKV,
	signHex,
	toHex,
} from "./test-utils";

const GUILD_ID = "111111111111111111";
const USER_ID = "222222222222222222";
const ROLE_ALLOWED = "333333333333333333";
const TOKEN = "interaction-token-abc";
const FOLLOWUP_URL = `https://discord.com/api/v10/webhooks/app123/${TOKEN}`;

interface TranslateOptions {
	content?: string;
	/** 実行者が保持するロール */
	roles?: string[];
	/** false で resolved (対象メッセージ) を外す */
	withResolved?: boolean;
}

/** Translate (メッセージコンテキストメニュー) の interaction フィクスチャ */
function buildTranslateInteraction(
	options: TranslateOptions = {},
): Interaction {
	const withResolved = options.withResolved ?? true;
	const content = options.content ?? "Hello, world!";
	return {
		id: "interaction-1",
		application_id: "app123",
		type: 2,
		token: TOKEN,
		guild_id: GUILD_ID,
		channel_id: "channel-1",
		data: {
			id: "command-1",
			name: "Translate",
			type: 3,
			target_id: "message-1",
			...(withResolved
				? {
						resolved: {
							messages: { "message-1": { id: "message-1", content } },
						},
					}
				: {}),
		},
		member: {
			user: { id: USER_ID, username: "tester" },
			roles: options.roles ?? ["role-member"],
		},
	};
}

/** スラッシュコマンド (CHAT_INPUT) の interaction フィクスチャ */
function buildChatInputInteraction(
	name: string,
	options: Array<{ name: string; type: number; value: string }>,
	overrides: Partial<Interaction> = {},
): Interaction {
	return {
		id: "interaction-2",
		application_id: "app123",
		type: 2,
		token: TOKEN,
		guild_id: GUILD_ID,
		channel_id: "channel-1",
		data: { id: "command-2", name, type: 1, options },
		member: {
			user: { id: USER_ID, username: "tester" },
			roles: ["role-member"],
		},
		...overrides,
	};
}

describe("interaction handler (worker.fetch 経由)", () => {
	let keys: Ed25519TestKeys;
	let kv: MockKV;
	let aiRun: ReturnType<typeof vi.fn>;
	let env: Env;
	/** discord.com への followup POST をインターセプトする fetch モック */
	let followupFetch: ReturnType<typeof vi.fn>;

	beforeAll(async () => {
		keys = await generateEd25519KeyPair();
	});

	beforeEach(() => {
		kv = new MockKV();
		aiRun = vi.fn();
		env = createEnv({ kv, aiRun, publicKeyHex: keys.publicKeyHex });
		followupFetch = vi.fn(async () => new Response("{}", { status: 200 }));
		vi.stubGlobal("fetch", followupFetch);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	/** 署名付き interaction を worker.fetch に POST する */
	async function postInteraction(interaction: unknown) {
		const mock = createMockCtx();
		const request = await buildSignedInteractionRequest(
			keys.privateKey,
			interaction,
		);
		const response = await worker.fetch(request, env, mock.ctx);
		return { response, mock };
	}

	/** インターセプトした followup (fetch 呼び出し) の内容を解析する */
	function parseFollowup(callIndex = 0) {
		const [url, init] = followupFetch.mock.calls[callIndex] as [
			string,
			RequestInit,
		];
		const body = JSON.parse(String(init.body)) as {
			content?: string;
			flags?: number;
		};
		return { url, init, body };
	}

	describe("PING", () => {
		it("type 1 (PING) には { type: 1 } (PONG) を返す", async () => {
			const { response } = await postInteraction({ type: 1, token: TOKEN });
			expect(response.status).toBe(200);
			await expect(response.json()).resolves.toEqual({ type: 1 });
		});
	});

	describe("HTTP パス (署名検証・ボディ検査)", () => {
		/** 署名ヘッダを自分で組み立てて worker.fetch に POST する */
		async function postRaw(
			body: string,
			headers: Record<string, string>,
			method = "POST",
		): Promise<Response> {
			// GET / HEAD は Request コンストラクタで body を持てない
			const withBody = method !== "GET" && method !== "HEAD";
			const request = new Request("https://bot.example.com/api/interactions", {
				method,
				headers: { "Content-Type": "application/json", ...headers },
				...(withBody ? { body } : {}),
			});
			return worker.fetch(request, env, createMockCtx().ctx);
		}

		it("不正な署名 (ランダムバイト) は 401 を返す", async () => {
			const random = new Uint8Array(64);
			crypto.getRandomValues(random);
			const response = await postRaw(JSON.stringify({ type: 1 }), {
				"X-Signature-Ed25519": toHex(random),
				"X-Signature-Timestamp": freshTimestamp(),
			});
			expect(response.status).toBe(401);
		});

		it("署名ヘッダ欠落は 401 を返す", async () => {
			const response = await postRaw(JSON.stringify({ type: 1 }), {});
			expect(response.status).toBe(401);
		});

		it("GET リクエストは 404 を返す", async () => {
			const response = await postRaw("", {}, "GET");
			expect(response.status).toBe(404);
		});

		it("正しい署名でも不正な JSON ボディは 400 を返す", async () => {
			const body = "{not-json";
			const response = await postRaw(body, {
				"X-Signature-Ed25519": await signHex(
					keys.privateKey,
					freshTimestamp() + body,
				),
				"X-Signature-Timestamp": freshTimestamp(),
			});
			expect(response.status).toBe(400);
		});

		it("MAX_BODY_LENGTH 超 (64KB 超) のボディは署名ヘッダがなくても 413 を返す", async () => {
			// 署名検証前の段階で弾かれることを確認するため署名ヘッダは付けない
			const body = "x".repeat(MAX_BODY_LENGTH + 1);
			const response = await postRaw(body, {});
			expect(response.status).toBe(413);
		});

		it("ちょうど MAX_BODY_LENGTH のボディは 413 ではなく署名検証に進む (401)", async () => {
			const body = "x".repeat(MAX_BODY_LENGTH);
			const response = await postRaw(body, {});
			expect(response.status).toBe(401);
		});

		it("6 分前のタイムスタンプで正しい署名でも 401 (新鮮性チェック)", async () => {
			const body = JSON.stringify({ type: 1, token: TOKEN });
			const timestamp = String(Math.floor(Date.now() / 1000) - 361);
			const response = await postRaw(body, {
				"X-Signature-Ed25519": await signHex(keys.privateKey, timestamp + body),
				"X-Signature-Timestamp": timestamp,
			});
			expect(response.status).toBe(401);
		});
	});

	describe("Translate (メッセージコンテキストメニュー)", () => {
		it("ギルド設定なし (全員許可) は ephemeral defer (type 5, flags 64) で応答し後続処理を waitUntil する", async () => {
			const { response, mock } = await postInteraction(
				buildTranslateInteraction(),
			);
			expect(response.status).toBe(200);
			await expect(response.json()).resolves.toEqual({
				type: 5,
				data: { flags: 64 },
			});
			expect(mock.waitUntilPromises).toHaveLength(1);
			await mock.drain();
		});

		it("allowedRoleIds に実行者のロールが含まれる場合は defer する", async () => {
			kv.store.set(
				`guild:${GUILD_ID}`,
				JSON.stringify({ allowedRoleIds: [ROLE_ALLOWED] }),
			);
			const interaction = buildTranslateInteraction({
				roles: [ROLE_ALLOWED],
			});
			const { response, mock } = await postInteraction(interaction);
			await expect(response.json()).resolves.toEqual({
				type: 5,
				data: { flags: 64 },
			});
			expect(mock.waitUntilPromises).toHaveLength(1);
			await mock.drain();
		});

		it("2,000 文ちょうどのメッセージは上限内なので defer する", async () => {
			const interaction = buildTranslateInteraction({
				content: "a".repeat(2000),
			});
			const { response, mock } = await postInteraction(interaction);
			await expect(response.json()).resolves.toEqual({
				type: 5,
				data: { flags: 64 },
			});
			await mock.drain();
		});

		it("許可ロールを保持しない実行者は defer せず ephemeral (type 4, flags 64) で拒否する", async () => {
			kv.store.set(
				`guild:${GUILD_ID}`,
				JSON.stringify({ allowedRoleIds: [ROLE_ALLOWED] }),
			);
			const interaction = buildTranslateInteraction({ roles: ["role-other"] });
			const { response, mock } = await postInteraction(interaction);
			await expect(response.json()).resolves.toEqual({
				type: 4,
				data: {
					content: expect.stringContaining("権限がありません"),
					flags: 64,
				},
			});
			expect(mock.waitUntilPromises).toHaveLength(0);
			expect(followupFetch).not.toHaveBeenCalled();
		});

		it("2,000 文字超のメッセージは defer せず ephemeral エラーで即応する", async () => {
			const interaction = buildTranslateInteraction({
				content: "あ".repeat(2001),
			});
			const { response, mock } = await postInteraction(interaction);
			await expect(response.json()).resolves.toEqual({
				type: 4,
				data: {
					content: expect.stringContaining("長すぎます"),
					flags: 64,
				},
			});
			expect(mock.waitUntilPromises).toHaveLength(0);
			expect(followupFetch).not.toHaveBeenCalled();
		});

		it("空 content のメッセージは defer せず ephemeral エラーで即応する", async () => {
			const interaction = buildTranslateInteraction({ content: "   " });
			const { response, mock } = await postInteraction(interaction);
			await expect(response.json()).resolves.toEqual({
				type: 4,
				data: {
					content: expect.stringContaining("翻訳する内容がありません"),
					flags: 64,
				},
			});
			expect(mock.waitUntilPromises).toHaveLength(0);
			expect(followupFetch).not.toHaveBeenCalled();
		});

		it("対象メッセージが解決できない場合も ephemeral エラーで即応する", async () => {
			const interaction = buildTranslateInteraction({ withResolved: false });
			const { response, mock } = await postInteraction(interaction);
			await expect(response.json()).resolves.toEqual({
				type: 4,
				data: {
					content: expect.stringContaining("翻訳する内容がありません"),
					flags: 64,
				},
			});
			expect(mock.waitUntilPromises).toHaveLength(0);
		});
	});

	describe("set-language", () => {
		it("有効な言語なら KV の user:{id} に書き込み ephemeral (type 4) で応答する", async () => {
			const interaction = buildChatInputInteraction("set-language", [
				{ name: "language", type: 3, value: "ja" },
			]);
			const { response } = await postInteraction(interaction);
			await expect(response.json()).resolves.toEqual({
				type: 4,
				data: { content: expect.stringContaining("Japanese"), flags: 64 },
			});
			expect(kv.store.get(`user:${USER_ID}`)).toBe(
				JSON.stringify({ lang: "ja" }),
			);
			expect(followupFetch).not.toHaveBeenCalled();
		});

		it("不正な言語値は ephemeral エラーで応答し KV に書き込まない", async () => {
			const interaction = buildChatInputInteraction("set-language", [
				{ name: "language", type: 3, value: "klingon" },
			]);
			const { response } = await postInteraction(interaction);
			await expect(response.json()).resolves.toEqual({
				type: 4,
				data: { content: expect.stringContaining("不正な言語"), flags: 64 },
			});
			expect(kv.store.size).toBe(0);
		});

		it("継承プロパティ名 (toString) は言語として拒否する (Object.hasOwn 防御)", async () => {
			const interaction = buildChatInputInteraction("set-language", [
				{ name: "language", type: 3, value: "toString" },
			]);
			const { response } = await postInteraction(interaction);
			await expect(response.json()).resolves.toEqual({
				type: 4,
				data: { content: expect.stringContaining("不正な言語"), flags: 64 },
			});
			expect(kv.store.size).toBe(0);
		});

		it("DM 実行 (user フィールド) でも言語を保存できる", async () => {
			const interaction = buildChatInputInteraction(
				"set-language",
				[{ name: "language", type: 3, value: "en" }],
				{
					guild_id: undefined,
					channel_id: undefined,
					member: undefined,
					user: { id: "dm-user-1" },
				},
			);
			const { response } = await postInteraction(interaction);
			await expect(response.json()).resolves.toEqual({
				type: 4,
				data: { content: expect.stringContaining("English"), flags: 64 },
			});
			expect(kv.store.get("user:dm-user-1")).toBe(
				JSON.stringify({ lang: "en" }),
			);
		});
	});

	describe("translate-config", () => {
		it("管理者は guild:{id} に許可ロールを書き込み ephemeral (type 4) で応答する", async () => {
			const interaction = buildChatInputInteraction(
				"translate-config",
				[{ name: "roles", type: 9, value: ROLE_ALLOWED }],
				{
					member: {
						user: { id: USER_ID, username: "admin" },
						permissions: "8",
					},
				},
			);
			const { response } = await postInteraction(interaction);
			await expect(response.json()).resolves.toEqual({
				type: 4,
				data: {
					content: expect.stringContaining(`<@&${ROLE_ALLOWED}>`),
					flags: 64,
				},
			});
			expect(kv.store.get(`guild:${GUILD_ID}`)).toBe(
				JSON.stringify({ allowedRoleIds: [ROLE_ALLOWED] }),
			);
		});

		it("管理者権限がない実行者は KV に書き込まず拒否する", async () => {
			const interaction = buildChatInputInteraction(
				"translate-config",
				[{ name: "roles", type: 9, value: ROLE_ALLOWED }],
				{
					member: {
						user: { id: USER_ID, username: "member" },
						permissions: "0",
					},
				},
			);
			const { response } = await postInteraction(interaction);
			await expect(response.json()).resolves.toEqual({
				type: 4,
				data: { content: expect.stringContaining("管理者のみ"), flags: 64 },
			});
			expect(kv.store.size).toBe(0);
		});

		it("permissions 欠損のメンバーも拒否する (fail-closed)", async () => {
			const interaction = buildChatInputInteraction(
				"translate-config",
				[{ name: "roles", type: 9, value: ROLE_ALLOWED }],
				{
					// permissions フィールドなしの member
					member: { user: { id: USER_ID, username: "no-perm-field" } },
				},
			);
			const { response } = await postInteraction(interaction);
			await expect(response.json()).resolves.toEqual({
				type: 4,
				data: { content: expect.stringContaining("管理者のみ"), flags: 64 },
			});
			expect(kv.store.size).toBe(0);
		});

		it("permissions がビットフィールドとして解釈できない文字列でも拒否する (fail-closed)", async () => {
			const interaction = buildChatInputInteraction(
				"translate-config",
				[{ name: "roles", type: 9, value: ROLE_ALLOWED }],
				{
					member: {
						user: { id: USER_ID, username: "broken-perm" },
						permissions: "not-a-bitfield",
					},
				},
			);
			const { response } = await postInteraction(interaction);
			await expect(response.json()).resolves.toEqual({
				type: 4,
				data: { content: expect.stringContaining("管理者のみ"), flags: 64 },
			});
			expect(kv.store.size).toBe(0);
		});
	});

	describe("未知のコマンド", () => {
		it("未知のコマンド名は ephemeral エラーで応答する", async () => {
			const interaction = buildChatInputInteraction("totally-unknown", []);
			const { response } = await postInteraction(interaction);
			await expect(response.json()).resolves.toEqual({
				type: 4,
				data: { content: expect.stringContaining("不明なコマンド"), flags: 64 },
			});
		});

		it("data のない不正 payload も ephemeral エラーで応答する", async () => {
			const { response } = await postInteraction({ type: 2, token: TOKEN });
			await expect(response.json()).resolves.toEqual({
				type: 4,
				data: { content: expect.stringContaining("不明なコマンド"), flags: 64 },
			});
		});
	});

	describe("handleTranslate (waitUntil 後続処理)", () => {
		it("defer 応答後に waitUntil で翻訳結果が ephemeral followup として送られる (統合)", async () => {
			kv.store.set(`user:${USER_ID}`, JSON.stringify({ lang: "ja" }));
			aiRun.mockResolvedValue({
				choices: [{ message: { content: "Bonjour !" } }],
			});
			const { response, mock } = await postInteraction(
				buildTranslateInteraction(),
			);
			await expect(response.json()).resolves.toEqual({
				type: 5,
				data: { flags: 64 },
			});
			await mock.drain();
			expect(aiRun).toHaveBeenCalledTimes(1);
			expect(followupFetch).toHaveBeenCalledTimes(1);
			const { url, body } = parseFollowup();
			expect(url).toBe(FOLLOWUP_URL);
			expect(body.flags).toBe(64);
			expect(body.content).toContain("Bonjour !");
		});

		it("言語未設定ユーザーには AI を呼ばず設定案内を ephemeral followup する", async () => {
			await handleTranslate(env, buildTranslateInteraction());
			expect(aiRun).not.toHaveBeenCalled();
			expect(followupFetch).toHaveBeenCalledTimes(1);
			const { init, body } = parseFollowup();
			expect(init.method).toBe("POST");
			expect(body.flags).toBe(64);
			expect(body.content).toContain("未設定");
			expect(body.content).toContain("/set-language");
		});

		it("言語設定済みユーザーには AI の翻訳結果を ephemeral followup する", async () => {
			kv.store.set(`user:${USER_ID}`, JSON.stringify({ lang: "ja" }));
			aiRun.mockResolvedValue({
				choices: [{ message: { content: "  bonjour  " } }],
			});
			await handleTranslate(env, buildTranslateInteraction());
			expect(aiRun).toHaveBeenCalledTimes(1);
			const { url, body } = parseFollowup();
			expect(url).toBe(FOLLOWUP_URL);
			expect(body.flags).toBe(64);
			expect(body.content).toBe("🌐 **Japanese**\nbonjour");
		});

		it("AI が例外を投げても例外は外に漏れずエラー followup が送られる", async () => {
			kv.store.set(`user:${USER_ID}`, JSON.stringify({ lang: "ja" }));
			aiRun.mockRejectedValue(new Error("AI is down"));
			const consoleError = vi
				.spyOn(console, "error")
				.mockImplementation(() => {});
			try {
				await expect(
					handleTranslate(env, buildTranslateInteraction()),
				).resolves.toBeUndefined();
			} finally {
				consoleError.mockRestore();
			}
			expect(followupFetch).toHaveBeenCalledTimes(1);
			const { body } = parseFollowup();
			expect(body.flags).toBe(64);
			expect(body.content).toContain("エラーが発生しました");
		});

		it("翻訳出力が長大でも followup content は 2000 文字以下に切り詰められ末尾は …", async () => {
			kv.store.set(`user:${USER_ID}`, JSON.stringify({ lang: "ja" }));
			aiRun.mockResolvedValue({
				choices: [{ message: { content: "あ".repeat(3000) } }],
			});
			await handleTranslate(env, buildTranslateInteraction());
			expect(aiRun).toHaveBeenCalledTimes(1);
			expect(followupFetch).toHaveBeenCalledTimes(1);
			const { body } = parseFollowup();
			expect(body.content).toBeDefined();
			expect(body.content?.length).toBeLessThanOrEqual(2000);
			expect(body.content?.endsWith("…")).toBe(true);
			expect(body.content?.startsWith("🌐 **Japanese**\n")).toBe(true);
		});

		it("プレフィックス込でちょうど 2000 文字の結果は切り詰められない", async () => {
			kv.store.set(`user:${USER_ID}`, JSON.stringify({ lang: "ja" }));
			const prefix = "🌐 **Japanese**\n";
			const translated = "a".repeat(2000 - prefix.length);
			aiRun.mockResolvedValue({
				choices: [{ message: { content: translated } }],
			});
			await handleTranslate(env, buildTranslateInteraction());
			const { body } = parseFollowup();
			expect(body.content).toBe(`${prefix}${translated}`);
			expect(body.content?.endsWith("…")).toBe(false);
		});

		it("同一の原文+言語がキャッシュ済みなら AI を呼ばずキャッシュ済み翻訳を ephemeral followup する", async () => {
			kv.store.set(`user:${USER_ID}`, JSON.stringify({ lang: "ja" }));
			const cacheKey = await translationCacheKey("Hello, world!", "ja");
			kv.store.set(cacheKey, "こんにちは、世界！");
			await handleTranslate(env, buildTranslateInteraction());
			expect(aiRun).not.toHaveBeenCalled();
			expect(followupFetch).toHaveBeenCalledTimes(1);
			const { url, body } = parseFollowup();
			expect(url).toBe(FOLLOWUP_URL);
			expect(body.flags).toBe(64);
			// AI 実行時と同一フォーマット (🌐 **Japanese**\n<訳>) で送られる
			expect(body.content).toBe("🌐 **Japanese**\nこんにちは、世界！");
		});

		it("キャッシュ未ヒット時は AI を呼び、翻訳結果を cache キーに TTL 2 週間で書き込む", async () => {
			kv.store.set(`user:${USER_ID}`, JSON.stringify({ lang: "ja" }));
			aiRun.mockResolvedValue({
				choices: [{ message: { content: "Bonjour !" } }],
			});
			await handleTranslate(env, buildTranslateInteraction());
			expect(aiRun).toHaveBeenCalledTimes(1);
			const cacheKey = await translationCacheKey("Hello, world!", "ja");
			expect(kv.store.get(cacheKey)).toBe("Bonjour !");
			expect(kv.putOptions.get(cacheKey)?.expirationTtl).toBe(1209600);
		});

		it("AI が失敗した場合はキャッシュを書き込まない", async () => {
			kv.store.set(`user:${USER_ID}`, JSON.stringify({ lang: "ja" }));
			aiRun.mockRejectedValue(new Error("AI is down"));
			const consoleError = vi
				.spyOn(console, "error")
				.mockImplementation(() => {});
			try {
				await expect(
					handleTranslate(env, buildTranslateInteraction()),
				).resolves.toBeUndefined();
			} finally {
				consoleError.mockRestore();
			}
			const cacheKeys = [...kv.store.keys()].filter((key) =>
				key.startsWith("cache:"),
			);
			expect(cacheKeys).toHaveLength(0);
		});

		it("followup 送信が非 OK でもエラーメッセージの再送を 1 回試みる", async () => {
			kv.store.set(`user:${USER_ID}`, JSON.stringify({ lang: "ja" }));
			aiRun.mockResolvedValue({
				choices: [{ message: { content: "bonjour" } }],
			});
			// 1 回目の followup を失敗させる
			followupFetch = vi.fn(
				async () => new Response("rate limited", { status: 429 }),
			);
			vi.stubGlobal("fetch", followupFetch);
			const consoleError = vi
				.spyOn(console, "error")
				.mockImplementation(() => {});
			try {
				await handleTranslate(env, buildTranslateInteraction());
			} finally {
				consoleError.mockRestore();
			}
			expect(followupFetch).toHaveBeenCalledTimes(2);
			const first = parseFollowup(0).body;
			const second = parseFollowup(1).body;
			expect(first.content).toContain("bonjour");
			expect(second.flags).toBe(64);
			expect(second.content).toContain("エラーが発生しました");
		});
	});

	describe("truncateToDiscordLimit", () => {
		it("上限 (2000 文字) 以下の入力はそのまま返す", () => {
			expect(truncateToDiscordLimit("hello")).toBe("hello");
			const exactlyLimit = truncateToDiscordLimit("a".repeat(2000));
			expect(exactlyLimit).toHaveLength(2000);
			expect(exactlyLimit.endsWith("…")).toBe(false);
		});

		it("上限超の入力は 2000 文字に切り詰められ末尾に … を付ける", () => {
			const truncated = truncateToDiscordLimit("a".repeat(2001));
			expect(truncated).toHaveLength(2000);
			expect(truncated).toBe(`${"a".repeat(1999)}…`);
			const huge = truncateToDiscordLimit("あ".repeat(5000));
			expect(huge).toHaveLength(2000);
			expect(huge.endsWith("…")).toBe(true);
		});
	});
});
