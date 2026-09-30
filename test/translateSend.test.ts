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
	buildAvatarUrl,
	buildWebhookMessageContent,
	decodeModalCustomId,
	encodeModalCustomId,
	MAX_RETRY_AFTER_SECONDS,
	resolveDisplayName,
	WEBHOOK_NAME,
} from "../src/handlers/translateSend";
import worker from "../src/index";
import type { Env, Interaction } from "../src/types";
import {
	buildSignedInteractionRequest,
	createEnv,
	createMockCtx,
	type Ed25519TestKeys,
	generateEd25519KeyPair,
	MockKV,
} from "./test-utils";

const GUILD_ID = "111111111111111111";
const USER_ID = "222222222222222222";
const CHANNEL_ID = "channel-1";
const ROLE_ALLOWED = "333333333333333333";
const TOKEN = "interaction-token-abc";
const BOT_TOKEN = "bot-token-test";

/** discord.ts が叩く Discord API パス (@original 更新) */
const ORIGINAL_PATCH_PATH = `/api/v10/webhooks/app123/${TOKEN}/messages/@original`;

const JSON_HEADERS = { "Content-Type": "application/json" };

function jsonResponse(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: JSON_HEADERS,
	});
}

/** 権限などの既定値を満たす member フィクスチャ */
function buildMember(
	overrides: Partial<NonNullable<Interaction["member"]>> = {},
): NonNullable<Interaction["member"]> {
	return {
		user: { id: USER_ID, username: "tester" },
		roles: ["role-member"],
		...overrides,
	};
}

interface SendCommandFixture {
	/** 省略時は text オプション自体を付けない (Modal 開封パス) */
	text?: string;
	language?: string;
	includeOriginal?: boolean;
	member?: Interaction["member"];
	overrides?: Partial<Interaction>;
}

/** /translate-send (CHAT_INPUT) の interaction フィクスチャ */
function buildSendCommandInteraction(
	fixture: SendCommandFixture = {},
): Interaction {
	const options: Array<{
		name: string;
		type: number;
		value: string | boolean;
	}> = [];
	if (fixture.text !== undefined) {
		options.push({ name: "text", type: 3, value: fixture.text });
	}
	if (fixture.language !== undefined) {
		options.push({ name: "language", type: 3, value: fixture.language });
	}
	if (fixture.includeOriginal !== undefined) {
		options.push({
			name: "include_original",
			type: 5,
			value: fixture.includeOriginal,
		});
	}
	return {
		id: "interaction-send-1",
		application_id: "app123",
		type: 2,
		token: TOKEN,
		guild_id: GUILD_ID,
		channel_id: CHANNEL_ID,
		channel: { id: CHANNEL_ID, type: 0 },
		data: { id: "cmd-send-1", name: "translate-send", type: 1, options },
		member: fixture.member ?? buildMember(),
		...fixture.overrides,
	};
}

interface ModalSubmitFixture {
	customId?: string;
	text?: string;
	/** components を外す (想定外形状への防御確認) */
	omitComponents?: boolean;
	member?: Interaction["member"];
	overrides?: Partial<Interaction>;
}

/** MODAL_SUBMIT (type 5) の interaction フィクスチャ */
function buildModalSubmitInteraction(
	fixture: ModalSubmitFixture = {},
): Interaction {
	return {
		id: "modal-submit-1",
		application_id: "app123",
		type: 5,
		token: TOKEN,
		guild_id: GUILD_ID,
		channel_id: CHANNEL_ID,
		channel: { id: CHANNEL_ID, type: 0 },
		data: {
			custom_id: fixture.customId ?? "ts:ja:1",
			...(fixture.omitComponents
				? {}
				: {
						components: [
							{
								type: 1,
								components: [
									{
										type: 4,
										custom_id: "text",
										value: fixture.text ?? "Hello",
									},
								],
							},
						],
					}),
		},
		member: fixture.member ?? buildMember(),
		...fixture.overrides,
	};
}

/** fetch モックが記録した Discord API への 1 呼び出し */
interface ApiCall {
	method: string;
	path: string;
	url: URL;
	init: RequestInit;
	body: Record<string, unknown> | null;
}

/** URL ルーター式 fetch モックの応答設定 (テスト内で差し替え可) */
interface DiscordApiResponses {
	/** GET /channels/{id}/webhooks (既定: 空配列) */
	listWebhooks?: () => Response;
	/** POST /channels/{id}/webhooks (既定: 新規 webhook) */
	createWebhook?: () => Response;
	/** POST /webhooks/{id}/{token}?wait=true — 順に消費 (尽きたら最後の応答を繰り返す) */
	execute?: Response[];
	/** followup POST /webhooks/{app_id}/{token} (既定: 200) */
	followup?: () => Response;
	/** PATCH /webhooks/{app_id}/{token}/messages/@original (既定: 200) */
	patchOriginal?: () => Response;
}

interface DiscordApiMock {
	fetch: ReturnType<typeof vi.fn>;
	calls: ApiCall[];
	responses: DiscordApiResponses;
	listCalls(): ApiCall[];
	createCalls(): ApiCall[];
	executeCalls(): ApiCall[];
	followupCalls(): ApiCall[];
	patchOriginalCalls(): ApiCall[];
}

/** discord.com への全 fetch を URL とメソッドで振り分けるモック */
function createDiscordApiMock(
	responses: DiscordApiResponses = {},
): DiscordApiMock {
	const calls: ApiCall[] = [];
	let executeCount = 0;

	const isChannelWebhooks = (path: string): boolean =>
		/^\/api\/v10\/channels\/[^/]+\/webhooks$/.test(path);
	const isWebhookPost = (path: string): boolean =>
		/^\/api\/v10\/webhooks\/[^/]+\/[^/]+$/.test(path);

	const fetchMock = vi.fn(
		async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const url = new URL(String(input));
			const method = (init?.method ?? "GET").toUpperCase();
			let body: Record<string, unknown> | null = null;
			if (typeof init?.body === "string") {
				try {
					body = JSON.parse(init.body) as Record<string, unknown>;
				} catch {
					body = null;
				}
			}
			calls.push({ method, path: url.pathname, url, init: init ?? {}, body });

			// チャンネル webhook の一覧取得 (GET) / 作成 (POST)
			if (isChannelWebhooks(url.pathname)) {
				if (method === "GET") {
					return responses.listWebhooks
						? responses.listWebhooks()
						: jsonResponse([]);
				}
				if (method === "POST") {
					return responses.createWebhook
						? responses.createWebhook()
						: jsonResponse({
								id: "wh-created-1",
								token: "created-webhook-token",
								name: WEBHOOK_NAME,
							});
				}
			}

			// defer 済み interaction の @original 更新
			if (method === "PATCH" && url.pathname.endsWith("/messages/@original")) {
				return responses.patchOriginal
					? responses.patchOriginal()
					: jsonResponse({});
			}

			// webhook 実行 (?wait=true) と interaction followup (POST /webhooks/{id}/{token})
			if (isWebhookPost(url.pathname) && method === "POST") {
				if (url.searchParams.get("wait") === "true") {
					const queue = responses.execute;
					const response =
						queue === undefined || queue.length === 0
							? jsonResponse({ id: "sent-message-1", channel_id: CHANNEL_ID })
							: queue[Math.min(executeCount, queue.length - 1)];
					executeCount++;
					return response;
				}
				return responses.followup ? responses.followup() : jsonResponse({});
			}

			return new Response("unmocked request", { status: 500 });
		},
	);

	const callsMatching = (method: string, pattern: RegExp): ApiCall[] =>
		calls.filter((call) => call.method === method && pattern.test(call.path));

	return {
		fetch: fetchMock,
		calls,
		responses,
		listCalls: () =>
			callsMatching("GET", /^\/api\/v10\/channels\/[^/]+\/webhooks$/),
		createCalls: () =>
			callsMatching("POST", /^\/api\/v10\/channels\/[^/]+\/webhooks$/),
		executeCalls: () =>
			calls.filter(
				(call) =>
					call.method === "POST" &&
					isWebhookPost(call.path) &&
					call.url.searchParams.get("wait") === "true",
			),
		followupCalls: () =>
			calls.filter(
				(call) =>
					call.method === "POST" &&
					isWebhookPost(call.path) &&
					call.url.searchParams.get("wait") !== "true",
			),
		patchOriginalCalls: () => callsMatching("PATCH", /\/messages\/@original$/),
	};
}

describe("encodeModalCustomId / decodeModalCustomId", () => {
	it("エンコードは 'ts:<language>:<1|0>' 形式", () => {
		expect(encodeModalCustomId("en", true)).toBe("ts:en:1");
		expect(encodeModalCustomId("ja", false)).toBe("ts:ja:0");
	});

	it("デコードはエンコード結果を復元できる", () => {
		expect(decodeModalCustomId("ts:en:1")).toEqual({
			language: "en",
			includeOriginal: true,
		});
		expect(decodeModalCustomId("ts:ja:0")).toEqual({
			language: "ja",
			includeOriginal: false,
		});
	});

	it("ts: プレフィックス外は null", () => {
		expect(decodeModalCustomId("other-modal:en:1")).toBeNull();
		expect(decodeModalCustomId("ts-en:1")).toBeNull();
		expect(decodeModalCustomId("")).toBeNull();
	});

	it("言語不正・継承プロパティ名は null (Object.hasOwn 防御)", () => {
		expect(decodeModalCustomId("ts:zz:1")).toBeNull();
		expect(decodeModalCustomId("ts:toString:1")).toBeNull();
		expect(decodeModalCustomId("ts:constructor:0")).toBeNull();
	});

	it("フラグ不正・セグメント数不正は null", () => {
		expect(decodeModalCustomId("ts:en:2")).toBeNull();
		expect(decodeModalCustomId("ts:en:true")).toBeNull();
		expect(decodeModalCustomId("ts:en")).toBeNull();
		expect(decodeModalCustomId("ts:en:1:extra")).toBeNull();
		expect(decodeModalCustomId("ts:")).toBeNull();
	});
});

describe("resolveDisplayName (webhook username の優先順)", () => {
	it("member.nick → user.global_name → user.username の順で決まる", () => {
		const all = {
			member: {
				user: { id: USER_ID, username: "tester", global_name: "Global" },
				nick: "Nick",
			},
		} as Interaction;
		expect(resolveDisplayName(all)).toBe("Nick");

		const noNick = {
			member: {
				user: { id: USER_ID, username: "tester", global_name: "Global" },
			},
		} as Interaction;
		expect(resolveDisplayName(noNick)).toBe("Global");

		const usernameOnly = {
			member: { user: { id: USER_ID, username: "tester" } },
		} as Interaction;
		expect(resolveDisplayName(usernameOnly)).toBe("tester");
	});

	it("空文字の nick / global_name はスキップされ username にフォールバックする", () => {
		expect(
			resolveDisplayName({
				member: {
					user: { id: USER_ID, username: "tester", global_name: "" },
					nick: "",
				},
			} as Interaction),
		).toBe("tester");
	});

	it("いずれも無い場合は null (webhook 既定名義)", () => {
		expect(resolveDisplayName({} as Interaction)).toBeNull();
		expect(
			resolveDisplayName({
				member: { user: { id: USER_ID } },
			} as Interaction),
		).toBeNull();
	});

	it("DM 実行 (user フィールド) でも username にフォールバックする", () => {
		expect(
			resolveDisplayName({
				user: { id: USER_ID, username: "dmer", global_name: null },
			} as unknown as Interaction),
		).toBe("dmer");
	});
});

describe("buildAvatarUrl (webhook avatar)", () => {
	it("アバター hash ありは cdn の avatars URL", () => {
		expect(
			buildAvatarUrl({
				member: { user: { id: USER_ID, avatar: "a_hash" } },
			} as Interaction),
		).toBe(`https://cdn.discordapp.com/avatars/${USER_ID}/a_hash.png`);
	});

	it("hash なし + 旧 discriminator は discriminator % 5", () => {
		expect(
			buildAvatarUrl({
				member: { user: { id: USER_ID, discriminator: "1234" } },
			} as Interaction),
		).toBe("https://cdn.discordapp.com/embed/avatars/4.png");
	});

	it("hash なし + 新体系 (discriminator 0) は snowflake から計算", () => {
		expect(
			buildAvatarUrl({
				member: { user: { id: USER_ID, discriminator: "0" } },
			} as Interaction),
		).toBe("https://cdn.discordapp.com/embed/avatars/3.png");
	});

	it("不正な snowflake はインデックス 0 にフォールバック", () => {
		expect(
			buildAvatarUrl({
				member: { user: { id: "not-a-snowflake" } },
			} as Interaction),
		).toBe("https://cdn.discordapp.com/embed/avatars/0.png");
	});

	it("ユーザーが取れない場合は null (avatar_url 省略)", () => {
		expect(buildAvatarUrl({} as Interaction)).toBeNull();
	});
});

describe("buildWebhookMessageContent (本文組み立て)", () => {
	it("include_original true は翻訳文 + 空行 + 引用形式の原文", () => {
		expect(buildWebhookMessageContent("Bonjour", "Hello", true)).toBe(
			"Bonjour\n\n> Hello",
		);
	});

	it("複数行の原文は行ごとに引用される", () => {
		expect(buildWebhookMessageContent("Bonjour", "Hello\nWorld", true)).toBe(
			"Bonjour\n\n> Hello\n> World",
		);
	});

	it("include_original false は翻訳文のみ", () => {
		expect(buildWebhookMessageContent("Bonjour", "Hello", false)).toBe(
			"Bonjour",
		);
	});

	it("2000 字超過時は原文が優先的に切り詰められ、翻訳文は全文保持される", () => {
		const translated = "b".repeat(1900);
		const original = "a".repeat(100);
		const content = buildWebhookMessageContent(translated, original, true);
		// 上限ちょうどに収まる
		expect(content).toHaveLength(2000);
		// 翻訳文は全文保持
		expect(content.startsWith(translated)).toBe(true);
		// 原文は 95 文字 + "…" に切り詰められる
		expect(content).toBe(`${translated}\n\n> ${"a".repeat(95)}…`);
	});

	it("翻訳文単独で 2000 字超の場合は最終防衛線で全体が切り詰められる", () => {
		const content = buildWebhookMessageContent(
			"b".repeat(2500),
			"original",
			true,
		);
		expect(content).toHaveLength(2000);
		expect(content.endsWith("…")).toBe(true);
		expect(content.startsWith("b".repeat(1999))).toBe(true);
	});
});

describe("/translate-send (worker.fetch 経由)", () => {
	let keys: Ed25519TestKeys;
	let kv: MockKV;
	let aiRun: ReturnType<typeof vi.fn>;
	let env: Env;
	/** discord.com への全 fetch を振り分けるモック */
	let api: DiscordApiMock;

	beforeAll(async () => {
		keys = await generateEd25519KeyPair();
	});

	beforeEach(() => {
		kv = new MockKV();
		aiRun = vi.fn();
		env = createEnv({
			kv,
			aiRun,
			publicKeyHex: keys.publicKeyHex,
			botToken: BOT_TOKEN,
		});
		api = createDiscordApiMock();
		vi.stubGlobal("fetch", api.fetch);
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

	/** Workers AI が固定の翻訳結果を返すようにする */
	function mockTranslation(content: string) {
		aiRun.mockResolvedValue({ choices: [{ message: { content } }] });
	}

	/** フォールバック (bot 名義 followup + Requested by フッター) の共通検証 */
	function expectFallbackFollowup(displayName: string, content: string) {
		const followups = api.followupCalls();
		expect(followups).toHaveLength(1);
		expect(followups[0].path).toBe(`/api/v10/webhooks/app123/${TOKEN}`);
		expect(followups[0].body).toEqual({
			content,
			embeds: [{ footer: { text: `Requested by @${displayName}` } }],
			// ping 偽装防止: webhook 実行パス (§4.3) と同様に全メンション無効化
			allowed_mentions: { parse: [] },
		});
		// flags を付けないため公開メッセージになる
		expect(followups[0].body?.flags).toBeUndefined();
	}

	it("text 省略時は type 9 (MODAL) で custom_id 'ts:en:1' (既定値エンコード) を返す", async () => {
		const { response, mock } = await postInteraction(
			buildSendCommandInteraction(),
		);
		expect(response.status).toBe(200);
		const payload = (await response.json()) as {
			type: number;
			data: {
				custom_id?: string;
				title?: string;
				components?: Array<{
					components: Array<Record<string, unknown>>;
				}>;
			};
		};
		expect(payload.type).toBe(9);
		expect(payload.data.custom_id).toBe("ts:en:1");
		expect(payload.data.title).toBe("翻訳して送信");
		expect(payload.data.components?.[0]?.components?.[0]).toMatchObject({
			type: 4,
			custom_id: "text",
			style: 2,
			label: "送信したいテキスト",
			min_length: 1,
			max_length: 4000,
			required: true,
		});
		// Modal を開くだけなので翻訳・Discord API 呼び出し・後続処理は一切ない
		expect(aiRun).not.toHaveBeenCalled();
		expect(api.fetch).not.toHaveBeenCalled();
		expect(mock.waitUntilPromises).toHaveLength(0);
	});

	it("language: ja + include_original: false 指定時は custom_id 'ts:ja:0' になる", async () => {
		const { response } = await postInteraction(
			buildSendCommandInteraction({ language: "ja", includeOriginal: false }),
		);
		const payload = (await response.json()) as {
			data: { custom_id?: string };
		};
		expect(payload.data.custom_id).toBe("ts:ja:0");
	});

	it("text あり: ephemeral defer → 翻訳 → webhook 送信 → @original を確認メッセージに更新", async () => {
		mockTranslation("Bonjour !");
		const { response, mock } = await postInteraction(
			buildSendCommandInteraction({ text: "Hello, world!" }),
		);
		await expect(response.json()).resolves.toEqual({
			type: 5,
			data: { flags: 64 },
		});
		expect(mock.waitUntilPromises).toHaveLength(1);
		await mock.drain();

		// webhook 実行: ?wait=true 付きで 1 回
		const executed = api.executeCalls();
		expect(executed).toHaveLength(1);
		expect(executed[0].url.toString()).toBe(
			"https://discord.com/api/v10/webhooks/wh-created-1/created-webhook-token?wait=true",
		);
		expect(executed[0].body).toEqual({
			content: "Bonjour !\n\n> Hello, world!",
			username: "tester",
			avatar_url: "https://cdn.discordapp.com/embed/avatars/3.png",
			allowed_mentions: { parse: [] },
		});

		// webhook 送信の後に @original が ephemeral 確認メッセージへ更新される
		const patches = api.patchOriginalCalls();
		expect(patches).toHaveLength(1);
		expect(patches[0].path).toBe(ORIGINAL_PATCH_PATH);
		expect(api.calls.indexOf(executed[0])).toBeLessThan(
			api.calls.indexOf(patches[0]),
		);
		// PATCH ペイロードに flags は含めない (ephemeral は defer 時点で確定済み)
		expect(patches[0].body).toEqual({
			content: "✅ 翻訳して送信しました (English)",
		});

		// フォールバック (bot 名義 followup) は発生しない
		expect(api.followupCalls()).toHaveLength(0);

		// webhook 作成は Bot Token 認証 + "Translate Bot" 名義
		const created = api.createCalls();
		expect(created).toHaveLength(1);
		expect(
			(created[0].init.headers as Record<string, string>).Authorization,
		).toBe(`Bot ${BOT_TOKEN}`);
		expect(created[0].body).toEqual({ name: WEBHOOK_NAME });

		// 作成した webhook が KV にキャッシュされる
		expect(kv.store.get(`webhook:${CHANNEL_ID}`)).toBe(
			JSON.stringify({ id: "wh-created-1", token: "created-webhook-token" }),
		);
	});

	it("language 未指定は既定 'en' で翻訳される", async () => {
		mockTranslation("Bonjour !");
		const { mock } = await postInteraction(
			buildSendCommandInteraction({ text: "Hello" }),
		);
		await mock.drain();
		expect(aiRun).toHaveBeenCalledTimes(1);
		const [, params] = aiRun.mock.calls[0] as [
			string,
			{ messages: Array<{ role: string; content: string }> },
		];
		expect(params.messages[1].content).toContain("into English");
		expect(api.patchOriginalCalls()[0].body).toEqual({
			content: "✅ 翻訳して送信しました (English)",
		});
	});

	it("include_original 未指定は true (原文が引用形式で含まれる)", async () => {
		mockTranslation("Bonjour !");
		const { mock } = await postInteraction(
			buildSendCommandInteraction({ text: "Hello, world!" }),
		);
		await mock.drain();
		expect(api.executeCalls()[0].body?.content).toBe(
			"Bonjour !\n\n> Hello, world!",
		);
	});

	it("include_original: false は翻訳文のみ (原文の引用なし)", async () => {
		mockTranslation("Bonjour !");
		const { mock } = await postInteraction(
			buildSendCommandInteraction({
				text: "Hello, world!",
				includeOriginal: false,
			}),
		);
		await mock.drain();
		expect(api.executeCalls()[0].body?.content).toBe("Bonjour !");
	});

	it("webhook 名義: member.nick が最優先で、avatar hash ありは cdn URL になる", async () => {
		mockTranslation("Hola");
		const { mock } = await postInteraction(
			buildSendCommandInteraction({
				text: "Hi",
				member: {
					user: {
						id: USER_ID,
						username: "tester",
						global_name: "Global Name",
						avatar: "avatarhash123",
					},
					nick: "Nick Name",
					roles: ["role-member"],
				},
			}),
		);
		await mock.drain();
		const { body } = api.executeCalls()[0];
		expect(body?.username).toBe("Nick Name");
		expect(body?.avatar_url).toBe(
			`https://cdn.discordapp.com/avatars/${USER_ID}/avatarhash123.png`,
		);
		// ping 偽装防止: すべてのメンション形式を無効化
		expect(body?.allowed_mentions).toEqual({ parse: [] });
	});

	it("text が空白のみのコマンドは ephemeral エラーで即応する", async () => {
		const { response, mock } = await postInteraction(
			buildSendCommandInteraction({ text: "   " }),
		);
		await expect(response.json()).resolves.toEqual({
			type: 4,
			data: {
				content: expect.stringContaining("翻訳する内容がありません"),
				flags: 64,
			},
		});
		expect(mock.waitUntilPromises).toHaveLength(0);
		expect(api.fetch).not.toHaveBeenCalled();
	});

	it("4001 文字の text は defer せず ephemeral エラーで即応する", async () => {
		const { response, mock } = await postInteraction(
			buildSendCommandInteraction({ text: "あ".repeat(4001) }),
		);
		await expect(response.json()).resolves.toEqual({
			type: 4,
			data: { content: expect.stringContaining("長すぎます"), flags: 64 },
		});
		expect(mock.waitUntilPromises).toHaveLength(0);
		expect(api.fetch).not.toHaveBeenCalled();
	});

	it("4,000 文字ちょうどの text は受理され、webhook 本文は 2000 字以内に収まる", async () => {
		mockTranslation("Bonjour !");
		const { mock } = await postInteraction(
			buildSendCommandInteraction({ text: "a".repeat(4000) }),
		);
		await mock.drain();
		// 原文が優先的に切り詰められ、翻訳文は保持される
		expect(api.executeCalls()[0].body?.content).toBe(
			`Bonjour !\n\n> ${"a".repeat(1986)}…`,
		);
		expect(
			String(api.executeCalls()[0].body?.content).length,
		).toBeLessThanOrEqual(2000);
	});

	it("不正な language は defer せず ephemeral エラーで即応する", async () => {
		const { response, mock } = await postInteraction(
			buildSendCommandInteraction({ text: "Hello", language: "klingon" }),
		);
		await expect(response.json()).resolves.toEqual({
			type: 4,
			data: { content: expect.stringContaining("不正な言語"), flags: 64 },
		});
		expect(mock.waitUntilPromises).toHaveLength(0);
		expect(api.fetch).not.toHaveBeenCalled();
	});

	describe("MODAL_SUBMIT", () => {
		it("defer → 翻訳 → webhook 送信 → @original を ephemeral 確認に更新 (custom_id から ja を復元)", async () => {
			mockTranslation("Bonjour !");
			const { response, mock } = await postInteraction(
				buildModalSubmitInteraction({
					customId: "ts:ja:1",
					text: "Hello, world!",
				}),
			);
			await expect(response.json()).resolves.toEqual({
				type: 5,
				data: { flags: 64 },
			});
			await mock.drain();

			const executed = api.executeCalls();
			expect(executed).toHaveLength(1);
			expect(executed[0].body?.content).toBe("Bonjour !\n\n> Hello, world!");
			const patches = api.patchOriginalCalls();
			expect(patches).toHaveLength(1);
			expect(patches[0].body).toEqual({
				content: "✅ 翻訳して送信しました (Japanese)",
			});
			expect(api.followupCalls()).toHaveLength(0);
		});

		it("ts: プレフィックス外の custom_id は拒否される", async () => {
			const { response, mock } = await postInteraction(
				buildModalSubmitInteraction({ customId: "other-modal:ja:1" }),
			);
			await expect(response.json()).resolves.toEqual({
				type: 4,
				data: {
					content: expect.stringContaining("不正なリクエスト"),
					flags: 64,
				},
			});
			expect(mock.waitUntilPromises).toHaveLength(0);
			expect(api.fetch).not.toHaveBeenCalled();
			expect(aiRun).not.toHaveBeenCalled();
		});

		it("言語不正の custom_id (ts:zz:1) は拒否される", async () => {
			const { response, mock } = await postInteraction(
				buildModalSubmitInteraction({ customId: "ts:zz:1" }),
			);
			await expect(response.json()).resolves.toEqual({
				type: 4,
				data: {
					content: expect.stringContaining("不正なリクエスト"),
					flags: 64,
				},
			});
			expect(mock.waitUntilPromises).toHaveLength(0);
			expect(api.fetch).not.toHaveBeenCalled();
		});

		it("フラグ不正の custom_id (ts:ja:2) は拒否される", async () => {
			const { response, mock } = await postInteraction(
				buildModalSubmitInteraction({ customId: "ts:ja:2" }),
			);
			await expect(response.json()).resolves.toEqual({
				type: 4,
				data: {
					content: expect.stringContaining("不正なリクエスト"),
					flags: 64,
				},
			});
			expect(mock.waitUntilPromises).toHaveLength(0);
			expect(api.fetch).not.toHaveBeenCalled();
		});

		it("継承プロパティ名 (ts:toString:1) は言語として拒否する (Object.hasOwn 防御)", async () => {
			const { response, mock } = await postInteraction(
				buildModalSubmitInteraction({ customId: "ts:toString:1" }),
			);
			await expect(response.json()).resolves.toEqual({
				type: 4,
				data: {
					content: expect.stringContaining("不正なリクエスト"),
					flags: 64,
				},
			});
			expect(mock.waitUntilPromises).toHaveLength(0);
		});

		it("空白のみの本文は ephemeral エラーで拒否される", async () => {
			const { response, mock } = await postInteraction(
				buildModalSubmitInteraction({ text: "   " }),
			);
			await expect(response.json()).resolves.toEqual({
				type: 4,
				data: {
					content: expect.stringContaining("翻訳する内容がありません"),
					flags: 64,
				},
			});
			expect(mock.waitUntilPromises).toHaveLength(0);
			expect(api.fetch).not.toHaveBeenCalled();
		});

		it("components がない提出も ephemeral エラーで拒否される", async () => {
			const { response, mock } = await postInteraction(
				buildModalSubmitInteraction({ omitComponents: true }),
			);
			await expect(response.json()).resolves.toEqual({
				type: 4,
				data: {
					content: expect.stringContaining("翻訳する内容がありません"),
					flags: 64,
				},
			});
			expect(mock.waitUntilPromises).toHaveLength(0);
			expect(api.fetch).not.toHaveBeenCalled();
		});

		it("4001 文字の本文は Modal 提出時に再検証され defer しない (defense in depth)", async () => {
			const { response, mock } = await postInteraction(
				buildModalSubmitInteraction({ text: "あ".repeat(4001) }),
			);
			await expect(response.json()).resolves.toEqual({
				type: 4,
				data: { content: expect.stringContaining("長すぎます"), flags: 64 },
			});
			expect(mock.waitUntilPromises).toHaveLength(0);
			expect(api.fetch).not.toHaveBeenCalled();
			expect(aiRun).not.toHaveBeenCalled();
		});
	});

	describe("webhook KV キャッシュ", () => {
		it("初回は list → 作成 → KV 保存、2 回目はキャッシュ再利用で list/作成しない", async () => {
			mockTranslation("Bonjour !");
			// 1 回目: KV 未キャッシュ → 一覧 (空) → 新規作成
			const first = await postInteraction(
				buildSendCommandInteraction({ text: "Hello" }),
			);
			await first.mock.drain();
			expect(api.listCalls()).toHaveLength(1);
			expect(api.createCalls()).toHaveLength(1);
			expect(kv.store.get(`webhook:${CHANNEL_ID}`)).toBe(
				JSON.stringify({ id: "wh-created-1", token: "created-webhook-token" }),
			);

			// 2 回目: KV キャッシュを利用 → 一覧も作成も増えない
			const second = await postInteraction(
				buildSendCommandInteraction({ text: "Hello" }),
			);
			await second.mock.drain();
			expect(api.listCalls()).toHaveLength(1);
			expect(api.createCalls()).toHaveLength(1);
			expect(api.executeCalls()).toHaveLength(2);
		});

		it("KV 欠落時は一覧から 'Translate Bot' を再利用し、新規作成しない", async () => {
			mockTranslation("Bonjour !");
			api.responses.listWebhooks = () =>
				jsonResponse([
					{ id: "wh-other", token: "other-token", name: "Other Bot" },
					{ id: "wh-existing", token: "existing-token", name: WEBHOOK_NAME },
				]);
			const { mock } = await postInteraction(
				buildSendCommandInteraction({ text: "Hello" }),
			);
			await mock.drain();
			expect(api.createCalls()).toHaveLength(0);
			expect(api.executeCalls()[0].url.pathname).toBe(
				"/api/v10/webhooks/wh-existing/existing-token",
			);
			// 再利用した webhook が KV に保存される
			expect(kv.store.get(`webhook:${CHANNEL_ID}`)).toBe(
				JSON.stringify({ id: "wh-existing", token: "existing-token" }),
			);
		});

		it("webhook 実行 404 (削除済み) は再作成して KV 更新し、1 回だけ再送する", async () => {
			mockTranslation("Bonjour !");
			kv.store.set(
				`webhook:${CHANNEL_ID}`,
				JSON.stringify({ id: "wh-old", token: "old-token" }),
			);
			api.responses.execute = [
				new Response(JSON.stringify({ message: "Unknown Webhook" }), {
					status: 404,
					headers: JSON_HEADERS,
				}),
				jsonResponse({ id: "sent-message-1" }),
			];
			const { mock } = await postInteraction(
				buildSendCommandInteraction({ text: "Hello" }),
			);
			await mock.drain();

			const executed = api.executeCalls();
			expect(executed).toHaveLength(2);
			expect(executed[0].url.pathname).toBe(
				"/api/v10/webhooks/wh-old/old-token",
			);
			expect(executed[1].url.pathname).toBe(
				"/api/v10/webhooks/wh-created-1/created-webhook-token",
			);
			// 再作成は一覧 (旧 webhook は消えている) → 作成 の順
			expect(api.listCalls()).toHaveLength(1);
			expect(api.createCalls()).toHaveLength(1);
			// KV は新しい webhook に更新される
			expect(kv.store.get(`webhook:${CHANNEL_ID}`)).toBe(
				JSON.stringify({ id: "wh-created-1", token: "created-webhook-token" }),
			);
			// 再送で成功したためフォールバックには落ちない
			expect(api.followupCalls()).toHaveLength(0);
			expect(api.patchOriginalCalls()[0].body).toEqual({
				content: "✅ 翻訳して送信しました (English)",
			});
		});
	});

	describe("フォールバック (bot 名義 + Requested by フッター)", () => {
		it("Bot Token 未設定 (botToken: '') では webhook API を呼ばず followup でフォールバックする", async () => {
			env = createEnv({ kv, aiRun, publicKeyHex: keys.publicKeyHex });
			mockTranslation("Bonjour !");
			const { mock } = await postInteraction(
				buildSendCommandInteraction({ text: "Hello, world!" }),
			);
			await mock.drain();
			// Bot Token 不在のため一覧取得・作成・実行は一切発生しない
			expect(api.listCalls()).toHaveLength(0);
			expect(api.createCalls()).toHaveLength(0);
			expect(api.executeCalls()).toHaveLength(0);
			expectFallbackFollowup("tester", "Bonjour !\n\n> Hello, world!");
			expect(api.patchOriginalCalls()[0].body).toEqual({
				content: "✅ 翻訳して送信しました (English)",
			});
		});

		it("フォールバック followup にも allowed_mentions が設定される (原文に @everyone があっても ping しない)", async () => {
			env = createEnv({ kv, aiRun, publicKeyHex: keys.publicKeyHex });
			mockTranslation("Bonjour !");
			const { mock } = await postInteraction(
				buildSendCommandInteraction({ text: "hi @everyone @here" }),
			);
			await mock.drain();
			const followups = api.followupCalls();
			expect(followups).toHaveLength(1);
			// ping 偽装防止: webhook 実行パス (§4.3) と同様にすべてのメンションを無効化 (§4.5)
			expect(followups[0].body?.allowed_mentions).toEqual({ parse: [] });
		});

		it("webhook 作成が 403 の場合もフォールバックする", async () => {
			mockTranslation("Bonjour !");
			api.responses.createWebhook = () =>
				new Response("Missing Permissions", { status: 403 });
			const consoleError = vi
				.spyOn(console, "error")
				.mockImplementation(() => {});
			const { mock } = await postInteraction(
				buildSendCommandInteraction({ text: "Hello" }),
			);
			try {
				await mock.drain();
			} finally {
				consoleError.mockRestore();
			}
			expect(api.createCalls()).toHaveLength(1);
			expect(api.executeCalls()).toHaveLength(0);
			expectFallbackFollowup("tester", "Bonjour !\n\n> Hello");
		});

		it("DM (ギルドチャンネル外) ではフォールバックになる", async () => {
			mockTranslation("Bonjour !");
			const { mock } = await postInteraction(
				buildSendCommandInteraction({
					text: "Hello",
					overrides: {
						guild_id: undefined,
						channel_id: "dm-channel-1",
						channel: { id: "dm-channel-1", type: 1 },
						member: undefined,
						user: { id: "dm-user-1", username: "dmer" },
					},
				}),
			);
			await mock.drain();
			expect(api.listCalls()).toHaveLength(0);
			expect(api.createCalls()).toHaveLength(0);
			expect(api.executeCalls()).toHaveLength(0);
			expectFallbackFollowup("dmer", "Bonjour !\n\n> Hello");
		});

		it("スレッド内 (channel.type 11) ではフォールバックになる", async () => {
			mockTranslation("Bonjour !");
			const { mock } = await postInteraction(
				buildSendCommandInteraction({
					text: "Hello",
					overrides: {
						channel_id: "thread-1",
						channel: { id: "thread-1", type: 11 },
					},
				}),
			);
			await mock.drain();
			expect(api.listCalls()).toHaveLength(0);
			expect(api.createCalls()).toHaveLength(0);
			expect(api.executeCalls()).toHaveLength(0);
			expectFallbackFollowup("tester", "Bonjour !\n\n> Hello");
		});

		it("webhook 実行が 400 (username に 'discord' を含む) だとフォールバックする", async () => {
			mockTranslation("Bonjour !");
			kv.store.set(
				`webhook:${CHANNEL_ID}`,
				JSON.stringify({ id: "wh-cached", token: "cached-token" }),
			);
			api.responses.execute = [
				new Response(
					JSON.stringify({ message: "Name can not contain discord" }),
					{
						status: 400,
						headers: JSON_HEADERS,
					},
				),
			];
			const consoleError = vi
				.spyOn(console, "error")
				.mockImplementation(() => {});
			const { mock } = await postInteraction(
				buildSendCommandInteraction({
					text: "Hello",
					member: buildMember({ nick: "discord fan" }),
				}),
			);
			try {
				await mock.drain();
			} finally {
				consoleError.mockRestore();
			}
			// 404 ではないため再作成せず 1 回だけ実行して諦める
			expect(api.executeCalls()).toHaveLength(1);
			expect(api.createCalls()).toHaveLength(0);
			expectFallbackFollowup("discord fan", "Bonjour !\n\n> Hello");
		});

		it("webhook 実行が 429 (Retry-After) は待機して 1 回再送し、失敗ならフォールバックする", async () => {
			mockTranslation("Bonjour !");
			kv.store.set(
				`webhook:${CHANNEL_ID}`,
				JSON.stringify({ id: "wh-cached", token: "cached-token" }),
			);
			api.responses.execute = [
				new Response("rate limited", {
					status: 429,
					headers: { "Retry-After": "1" },
				}),
				new Response("still rate limited", {
					status: 429,
					headers: { "Retry-After": "5" },
				}),
			];
			const consoleError = vi
				.spyOn(console, "error")
				.mockImplementation(() => {});
			const { mock } = await postInteraction(
				buildSendCommandInteraction({ text: "Hello" }),
			);
			try {
				// Retry-After (1 秒) の待機を含む
				await mock.drain();
			} finally {
				consoleError.mockRestore();
			}
			// 429 では再作成せず同じ webhook で再送する
			expect(api.executeCalls()).toHaveLength(2);
			expect(api.createCalls()).toHaveLength(0);
			expect(api.executeCalls()[0].url.pathname).toBe(
				api.executeCalls()[1].url.pathname,
			);
			// 2 回目の再送も失敗したため bot 名義 followup にフォールバック
			expectFallbackFollowup("tester", "Bonjour !\n\n> Hello");
			expect(api.patchOriginalCalls()[0].body).toEqual({
				content: "✅ 翻訳して送信しました (English)",
			});
		});

		it("webhook 実行が 429 でも再送が成功すれば webhook 経路を継続する (body の retry_after)", async () => {
			mockTranslation("Bonjour !");
			kv.store.set(
				`webhook:${CHANNEL_ID}`,
				JSON.stringify({ id: "wh-cached", token: "cached-token" }),
			);
			// Retry-After ヘッダなし → body の retry_after を見る (0 なので待機なしで再送)
			api.responses.execute = [
				jsonResponse({ retry_after: 0 }, 429),
				jsonResponse({ id: "sent-message-1" }),
			];
			const { mock } = await postInteraction(
				buildSendCommandInteraction({ text: "Hello" }),
			);
			await mock.drain();
			expect(api.executeCalls()).toHaveLength(2);
			expect(api.followupCalls()).toHaveLength(0);
			expect(api.patchOriginalCalls()[0].body).toEqual({
				content: "✅ 翻訳して送信しました (English)",
			});
		});

		it("429 の Retry-After が上限 (15 秒) を超える場合は待機・再送せずフォールバックする", async () => {
			mockTranslation("Bonjour !");
			kv.store.set(
				`webhook:${CHANNEL_ID}`,
				JSON.stringify({ id: "wh-cached", token: "cached-token" }),
			);
			// waitUntil の wall clock (約 30 秒) を待機だけで消費させないため、
			// 上限超の Retry-After は待機せず再送もしない (§4.4)
			api.responses.execute = [
				new Response("rate limited", {
					status: 429,
					headers: { "Retry-After": String(MAX_RETRY_AFTER_SECONDS + 1) },
				}),
			];
			const consoleError = vi
				.spyOn(console, "error")
				.mockImplementation(() => {});
			const { mock } = await postInteraction(
				buildSendCommandInteraction({ text: "Hello" }),
			);
			try {
				await mock.drain();
			} finally {
				consoleError.mockRestore();
			}
			// 待機・再送せず 1 回だけ実行して諦める
			expect(api.executeCalls()).toHaveLength(1);
			expect(api.createCalls()).toHaveLength(0);
			// bot 名義 followup にフォールバックする
			expectFallbackFollowup("tester", "Bonjour !\n\n> Hello");
			expect(api.patchOriginalCalls()[0].body).toEqual({
				content: "✅ 翻訳して送信しました (English)",
			});
		});
	});

	describe("権限チェック (defense in depth)", () => {
		beforeEach(() => {
			kv.store.set(
				`guild:${GUILD_ID}`,
				JSON.stringify({ allowedRoleIds: [ROLE_ALLOWED] }),
			);
		});

		it("コマンド実行時に許可ロールを持たない実行者は ephemeral エラーで拒否される", async () => {
			const { response, mock } = await postInteraction(
				buildSendCommandInteraction({
					text: "Hello",
					member: buildMember({ roles: ["role-other"] }),
				}),
			);
			await expect(response.json()).resolves.toEqual({
				type: 4,
				data: {
					content: expect.stringContaining("権限がありません"),
					flags: 64,
				},
			});
			expect(mock.waitUntilPromises).toHaveLength(0);
			expect(api.fetch).not.toHaveBeenCalled();
			expect(aiRun).not.toHaveBeenCalled();
		});

		it("Modal 提出時も権限を再チェックし、許可ロールなしは defer せず拒否する", async () => {
			const { response, mock } = await postInteraction(
				buildModalSubmitInteraction({
					member: buildMember({ roles: ["role-other"] }),
				}),
			);
			await expect(response.json()).resolves.toEqual({
				type: 4,
				data: {
					content: expect.stringContaining("権限がありません"),
					flags: 64,
				},
			});
			expect(mock.waitUntilPromises).toHaveLength(0);
			expect(api.fetch).not.toHaveBeenCalled();
			expect(aiRun).not.toHaveBeenCalled();
		});

		it("Modal 提出時も許可ロールを持てば通常どおり defer する", async () => {
			mockTranslation("Bonjour !");
			const { response, mock } = await postInteraction(
				buildModalSubmitInteraction({
					member: buildMember({ roles: [ROLE_ALLOWED] }),
				}),
			);
			await expect(response.json()).resolves.toEqual({
				type: 5,
				data: { flags: 64 },
			});
			await mock.drain();
			expect(api.executeCalls()).toHaveLength(1);
		});
	});
});
