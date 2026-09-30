import { LANGUAGE_NAMES } from "../commands";
import {
	createChannelWebhook,
	editOriginalInteractionResponse,
	executeWebhook,
	listChannelWebhooks,
	sendFollowup,
} from "../discord";
import { isAllowedToTranslate } from "../permissions";
import { getChannelWebhook, getGuildConfig, setChannelWebhook } from "../store";
import { translateText } from "../translate";
import {
	buildEphemeralResponse,
	type ChannelWebhook,
	type Env,
	EPHEMERAL_FLAG,
	type Interaction,
	type InteractionResponse,
	InteractionResponseType,
	type WebhookExecuteMessage,
} from "../types";
import { truncateToDiscordLimit } from "./translate";

/** チャンネルに作成する webhook の名前 (KV 欠落時の一覧検索にも使う) */
export const WEBHOOK_NAME = "Translate Bot";

/** 送信メッセージ本文の上限 (Discord のメッセージ上限 — handlers/translate.ts と同じ値) */
export const MAX_CONTENT_LENGTH = 2000;

/** 受け付ける本文の最大長 (Modal TextInput の上限に合わせる。超過分は組み立て時に切り詰める) */
export const MAX_INPUT_LENGTH = 4000;

/** modal custom_id のプレフィックス (他の modal との区別 — §3.2) */
export const MODAL_CUSTOM_ID_PREFIX = "ts:";

/** modal 内 Text Input コンポーネントの custom_id */
export const MODAL_TEXT_CUSTOM_ID = "text";

/**
 * /translate-send のオプション (既定値解釈済み)。
 * Discord API にはオプション値のサーバー側デフォルト機構がないため
 * ハンドラで解釈する (§2): language 省略時 en / include_original 省略時 true。
 */
export interface TranslateSendOptions {
	/** 翻訳する本文 (null = text 省略 → Modal を開く) */
	text: string | null;
	/** 翻訳先言語コード */
	language: string;
	/** 原文を引用形式で添付するか */
	includeOriginal: boolean;
}

/**
 * 同期パス (defer 前) の検証結果。
 * allowed: false の場合は response (type 4 ephemeral エラー) をそのまま Discord へ返す。
 */
export type TranslateSendPrecheck =
	| { allowed: true; options: TranslateSendOptions }
	| { allowed: false; response: InteractionResponse };

/**
 * type 5 (DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, ephemeral) の応答ペイロード。
 * 同期パスの検証を通った場合に index.ts が即返す。
 * ephemeral にする理由: 「考え中…」表示も最終的な @original (✅ 確認) も
 * 実行者にのみ見せ、チャンネルに残る公開メッセージを webhook 投稿 1 本にする (§6)。
 */
export function buildSendDeferredResponse(): InteractionResponse {
	return {
		type: InteractionResponseType.DeferredChannelMessageWithSource,
		data: { flags: EPHEMERAL_FLAG },
	};
}

/**
 * slash command の options から /translate-send のオプションを取り出す
 * (既定値解釈込み)。存在しない / 型不一致のオプションは既定値に落とす。
 */
export function parseCommandOptions(
	interaction: Interaction,
): TranslateSendOptions {
	const options = interaction.data?.options ?? [];
	let text: string | null = null;
	let language = "en";
	let includeOriginal = true;
	for (const option of options) {
		if (option.name === "text" && typeof option.value === "string") {
			text = option.value;
		} else if (option.name === "language" && typeof option.value === "string") {
			language = option.value;
		} else if (
			option.name === "include_original" &&
			typeof option.value === "boolean"
		) {
			includeOriginal = option.value;
		}
	}
	return { text, language, includeOriginal };
}

/**
 * 同期パス: 権限チェックとオプション値の検証のみを行う。
 * KV 読み取り 1 回と純粋な検証で済むため defer 前に実行し、
 * 拒否時は defer せず type 4 ephemeral エラーで即応する (最速パス — §6, §7)。
 * Modal 提出時 (§3.2) の再検証 (defense in depth) にも同じ関数を使う。
 */
export async function precheckTranslateSend(
	env: Env,
	interaction: Interaction,
	options: TranslateSendOptions,
): Promise<TranslateSendPrecheck> {
	// 権限チェック: ギルド設定が未設定なら全員許可 (src/permissions.ts)
	const guildConfig =
		interaction.guild_id === undefined
			? null
			: await getGuildConfig(env, interaction.guild_id);
	if (!isAllowedToTranslate(guildConfig, interaction.member?.roles)) {
		return {
			allowed: false,
			response: buildEphemeralResponse(
				"このサーバーでは翻訳コマンドを使用する権限がありません。",
			),
		};
	}

	// 言語値の検証: in 演算子ではなく Object.hasOwn でプロトタイプチェーンを拾わない
	// (直接 API 実行・旧 modal 再利用に備えたサーバー側再検証 — §7)
	if (!Object.hasOwn(LANGUAGE_NAMES, options.language)) {
		return {
			allowed: false,
			response: buildEphemeralResponse(
				"不正な言語が指定されました。選択肢から言語を選んでください。",
			),
		};
	}

	// 文字数検証 (Discord 側で制限されるが直接 API 実行に備えて再検証)
	if (options.text !== null && options.text.length > MAX_INPUT_LENGTH) {
		return {
			allowed: false,
			response: buildEphemeralResponse(
				`テキストが長すぎます。${MAX_INPUT_LENGTH} 文字以内で指定してください。`,
			),
		};
	}
	if (options.text !== null && options.text.trim() === "") {
		return {
			allowed: false,
			response: buildEphemeralResponse("翻訳する内容がありません。"),
		};
	}

	return { allowed: true, options };
}

/**
 * modal の custom_id を組み立てる。
 * エンコード形式: "ts:<language>:<include_original 0|1>" (§3.2)。
 * 長さは custom_id の 100 字制限に対して十分短い。
 */
export function encodeModalCustomId(
	language: string,
	includeOriginal: boolean,
): string {
	return `${MODAL_CUSTOM_ID_PREFIX}${language}:${includeOriginal ? "1" : "0"}`;
}

/**
 * modal の custom_id を防御的にデコードする (§3.2)。
 * プレフィックス・形式・言語値 (Object.hasOwn — setLanguage.ts と同じパターン)・
 * フラグ値のいずれかが不正な場合は null を返す。
 */
export function decodeModalCustomId(
	customId: string,
): { language: string; includeOriginal: boolean } | null {
	if (!customId.startsWith(MODAL_CUSTOM_ID_PREFIX)) {
		return null;
	}
	const parts = customId.slice(MODAL_CUSTOM_ID_PREFIX.length).split(":");
	if (parts.length !== 2) {
		return null;
	}
	const [language, flag] = parts;
	if (!Object.hasOwn(LANGUAGE_NAMES, language)) {
		return null;
	}
	if (flag !== "0" && flag !== "1") {
		return null;
	}
	return { language, includeOriginal: flag === "1" };
}

/**
 * text 省略時に開く Modal (interaction callback type 9) の応答ペイロード (§3.1)。
 * language / include_original は custom_id にエンコードして引き回す
 * (Modal 提出の interaction には slash command のオプション値が渡らないため)。
 */
export function buildModalResponse(
	language: string,
	includeOriginal: boolean,
): InteractionResponse {
	return {
		type: InteractionResponseType.Modal,
		data: {
			custom_id: encodeModalCustomId(language, includeOriginal),
			title: "翻訳して送信",
			components: [
				{
					type: 1, // Action Row
					components: [
						{
							type: 4, // Text Input
							custom_id: MODAL_TEXT_CUSTOM_ID,
							style: 2, // Paragraph (複数行)
							label: "送信したいテキスト",
							placeholder: "翻訳したい文章を入力...",
							min_length: 1,
							max_length: MAX_INPUT_LENGTH,
							required: true,
						},
					],
				},
			],
		},
	};
}

/**
 * MODAL_SUBMIT (type 5) の本文を取り出す。
 * components[0].components[0].value は固定添字でよい (§3.2) が、
 * 想定外の形状 (直接 API 実行等) に備えて防御的にパースする。
 * 取り出せない場合は null。
 */
export function extractModalText(interaction: Interaction): string | null {
	const components = interaction.data?.components;
	if (!Array.isArray(components) || components.length === 0) {
		return null;
	}
	const row: unknown = components[0];
	if (typeof row !== "object" || row === null) {
		return null;
	}
	const rowComponents = (row as { components?: unknown }).components;
	if (!Array.isArray(rowComponents) || rowComponents.length === 0) {
		return null;
	}
	const input: unknown = rowComponents[0];
	if (typeof input !== "object" || input === null) {
		return null;
	}
	const value = (input as { value?: unknown }).value;
	return typeof value === "string" ? value : null;
}

/**
 * MODAL_SUBMIT (type 5) の処理。custom_id と本文を防御的に取り出し、
 * precheck 相当の再検証 (権限・言語・文字数 — defense in depth §7) を行ってから
 * ephemeral defer 応答を返し、重い処理を waitUntil へ逃がす。
 * 以降の followup / @original 更新はすべて Modal 提出の新 token を使う (§3.2)。
 */
export async function handleTranslateSendModalSubmit(
	env: Env,
	interaction: Interaction,
	ctx: ExecutionContext,
): Promise<Response> {
	const customId = interaction.data?.custom_id;
	const decoded =
		typeof customId === "string" ? decodeModalCustomId(customId) : null;
	if (decoded === null) {
		// 不正な custom_id / 言語値 → ephemeral エラーで即応 (§3.2)
		return Response.json(
			buildEphemeralResponse(
				"不正なリクエストです。もう一度コマンドを実行してください。",
			),
		);
	}

	const text = extractModalText(interaction);
	if (text === null || text.trim() === "") {
		return Response.json(buildEphemeralResponse("翻訳する内容がありません。"));
	}

	// precheck 相当の再検証 (権限の再判定を含む — §7)
	const precheck = await precheckTranslateSend(env, interaction, {
		text,
		language: decoded.language,
		includeOriginal: decoded.includeOriginal,
	});
	if (!precheck.allowed) {
		// defer 前に ephemeral エラーで即応
		return Response.json(precheck.response);
	}

	// 重い処理 (Workers AI / webhook 送信 / @original 更新) はすべて waitUntil へ
	ctx.waitUntil(handleTranslateSendProcess(env, interaction, precheck.options));
	return Response.json(buildSendDeferredResponse());
}

/**
 * /translate-send の後続処理。index.ts が type 5 (ephemeral defer) を返した後に
 * ctx.waitUntil 経由で呼ばれる (env はテストでモック注入可)。
 * 翻訳 → webhook 送信 (失敗時フォールバック) → @original を確認メッセージへ更新。
 * 全体を try/catch し、失敗時は @original を ephemeral エラーメッセージへ更新する。
 */
export async function handleTranslateSendProcess(
	env: Env,
	interaction: Interaction,
	options: TranslateSendOptions,
): Promise<void> {
	try {
		const translated = await translateText(
			env,
			options.text ?? "",
			options.language,
		);

		if (await sendAsExecutor(env, interaction, translated, options)) {
			await updateOriginalSuccess(env, interaction, options.language);
			return;
		}

		// webhook 経路が使えない → bot 名義 + Requested by フッターでフォールバック (§4.5)
		if (await sendFallbackFollowup(env, interaction, translated, options)) {
			await updateOriginalSuccess(env, interaction, options.language);
			return;
		}
		// followup 自体も失敗した場合はログのみ (エラー応答の連鎖を避ける)
	} catch (error) {
		console.error("TranslateSend processing failed:", error);
		await updateOriginalError(env, interaction);
	}
}

/**
 * webhook で実行者名義送信する。成功で true、webhook 経路が使えない場合は false
 * (呼び出し側でフォールバックへ落ちる)。
 *
 * - スレッド内実行 → 初期実装ではフォールバック送信に簡略化 (§4.2)
 * - Bot Token 未設定 / webhook 取得 (作成) 失敗 → false
 * - webhook 実行 404 (削除済み) → 再取得して KV 更新、再送信 1 回 (§4.4)
 * - 実行失敗 (username 禁止語の 400 等) → false
 */
async function sendAsExecutor(
	env: Env,
	interaction: Interaction,
	translated: string,
	options: TranslateSendOptions,
): Promise<boolean> {
	const channelId = interaction.channel_id;
	if (channelId === undefined) {
		return false;
	}
	// DM チャンネルには webhook を作成できないため常にフォールバック (§4.2)
	if (interaction.guild_id === undefined) {
		return false;
	}
	if (isThreadChannel(interaction)) {
		// スレッド自体には webhook を作成できないため簡略化してフォールバック (§4.2)
		return false;
	}

	const payload = buildWebhookExecutePayload(interaction, translated, options);

	const webhook = await resolveChannelWebhook(env, channelId, true);
	if (webhook === null) {
		return false;
	}
	let response = await executeWebhookWithRetry(webhook, payload);
	if (response.ok) {
		return true;
	}
	if (response.status !== 404) {
		// 400 (username 禁止語 "discord" / "clyde" 等) はユーザー起因のため
		// フォールバック条件に含める (§4.3, §4.5)
		console.error(
			`Webhook execution failed: ${response.status} ${await responseTextSafe(response)}`,
		);
		return false;
	}

	// webhook が削除されている → 作成し直して KV 更新、再送信 1 回 (§4.4)
	const recreated = await resolveChannelWebhook(env, channelId, false);
	if (recreated === null) {
		return false;
	}
	response = await executeWebhookWithRetry(recreated, payload);
	if (!response.ok) {
		console.error(
			`Webhook execution failed after recreation: ${response.status}`,
		);
		return false;
	}
	return true;
}

/**
 * 実行チャンネルの webhook を取得する (useCache=false で KV を無視して再取得)。
 *
 * - Bot Token 未設定 → null (常時フォールバック運用 — §4.5)
 * - KV キャッシュ (webhook:{channelId}) を優先
 * - KV 欠落時は一覧から name === WEBHOOK_NAME を再利用してから新規作成
 *   (作成は常に list-再確認の後 — チャンネルあたり 10 本の上限を
 *   自前の重複で埋めないため。並行実行時の重複は設計上許容 — §4.4)
 * - 失敗時 (403 等) は null (フォールバック)
 */
async function resolveChannelWebhook(
	env: Env,
	channelId: string,
	useCache: boolean,
): Promise<ChannelWebhook | null> {
	const botToken = env.DISCORD_BOT_TOKEN;
	if (botToken === undefined || botToken === "") {
		return null;
	}
	if (useCache) {
		const cached = await getChannelWebhook(env, channelId);
		if (cached !== null) {
			return cached;
		}
	}
	try {
		// KV 欠落: 既存の自前 webhook を再利用して重複作成を回避する
		const listResponse = await listChannelWebhooks(botToken, channelId);
		if (listResponse.ok) {
			const reused = findBotWebhook(await listResponse.json());
			if (reused !== null) {
				await setChannelWebhook(env, channelId, reused);
				return reused;
			}
		}

		const createResponse = await createChannelWebhook(
			botToken,
			channelId,
			WEBHOOK_NAME,
		);
		if (!createResponse.ok) {
			// Manage Webhooks 権限なし (403) 等 → フォールバック (§4.2, §4.5)
			console.error(`Webhook creation failed: ${createResponse.status}`);
			return null;
		}
		const created = parseChannelWebhook(await createResponse.json());
		if (created === null) {
			return null;
		}
		await setChannelWebhook(env, channelId, created);
		return created;
	} catch (error) {
		console.error("Webhook resolution failed:", error);
		return null;
	}
}

/** 一覧レスポンスから自前の webhook (name 一致 + 実行 token を持つもの) を探す */
function findBotWebhook(payload: unknown): ChannelWebhook | null {
	if (!Array.isArray(payload)) {
		return null;
	}
	for (const item of payload) {
		if (typeof item !== "object" || item === null) {
			continue;
		}
		if ((item as { name?: unknown }).name !== WEBHOOK_NAME) {
			continue;
		}
		const webhook = parseChannelWebhook(item);
		if (webhook !== null) {
			return webhook;
		}
	}
	return null;
}

/** webhook API レスポンスを防御的にパースする (id / token は必須) */
function parseChannelWebhook(payload: unknown): ChannelWebhook | null {
	if (typeof payload !== "object" || payload === null) {
		return null;
	}
	const record = payload as Record<string, unknown>;
	if (typeof record.id !== "string" || record.id === "") {
		return null;
	}
	if (typeof record.token !== "string" || record.token === "") {
		return null;
	}
	return { id: record.id, token: record.token };
}

/**
 * 429 の Retry-After で実際に待機する上限秒数。
 * 後続処理は ctx.waitUntil (wall clock 約 30 秒) 内で完結する必要があるため、
 * 待機 + 再送 + フォールバック + @original 更新の分を見て 15 秒に抑える。
 * これを超える Retry-After は信頼せず待機しない (再送せずフォールバックへ流す)。
 */
export const MAX_RETRY_AFTER_SECONDS = 15;

/**
 * webhook を実行する。429 (レート制限) の場合は Retry-After で指定された秒数
 * 待機して 1 回だけ再送する (即フォールバックは UX が不安定になるため避ける — §4.4)。
 * ただし Retry-After が MAX_RETRY_AFTER_SECONDS を超える場合は、待機だけで
 * waitUntil の wall clock を消費して再送もフォールバックも実行できなくなるため、
 * 待機・再送せず 429 のレスポンスをそのまま返す (fail としてフォールバックへ流れる)。
 * 再送でも 429 が返った場合も、そのレスポンスをそのまま呼び出し側に返す
 * (fail としてフォールバックへ流れる)。
 */
async function executeWebhookWithRetry(
	webhook: ChannelWebhook,
	payload: WebhookExecuteMessage,
): Promise<Response> {
	const response = await executeWebhook(webhook, payload);
	if (response.status !== 429) {
		return response;
	}
	const retryAfterSeconds = await parseRetryAfterSeconds(response);
	if (retryAfterSeconds > MAX_RETRY_AFTER_SECONDS) {
		return response;
	}
	if (retryAfterSeconds > 0) {
		await waitSeconds(retryAfterSeconds);
	}
	return executeWebhook(webhook, payload);
}

/** 429 レスポンスから待機秒数を取り出す (Retry-After ヘッダ → body の retry_after) */
async function parseRetryAfterSeconds(response: Response): Promise<number> {
	const header = response.headers.get("Retry-After");
	if (header !== null) {
		const value = Number(header);
		if (Number.isFinite(value) && value > 0) {
			return value;
		}
	}
	try {
		const body = (await response.json()) as { retry_after?: unknown };
		if (typeof body.retry_after === "number" && body.retry_after > 0) {
			return body.retry_after;
		}
	} catch {
		// body が JSON でない場合は待機なしで再送
	}
	return 0;
}

function waitSeconds(seconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/**
 * webhook 実行ペイロードを組み立てる。
 * username / avatar_url には必ず実行者本人の値のみを使う
 * (名義スプーフィング防止 — §7)。allowed_mentions はセキュリティ上必須 (§4.3)。
 */
function buildWebhookExecutePayload(
	interaction: Interaction,
	translated: string,
	options: TranslateSendOptions,
): WebhookExecuteMessage {
	const displayName = resolveDisplayName(interaction);
	const avatarUrl = buildAvatarUrl(interaction);
	return {
		content: buildWebhookMessageContent(
			translated,
			options.text,
			options.includeOriginal,
		),
		...(displayName !== null ? { username: displayName } : {}),
		...(avatarUrl !== null ? { avatar_url: avatarUrl } : {}),
		allowed_mentions: { parse: [] },
	};
}

/**
 * webhook の username に使う実行者の表示名を決定する。
 * 優先順位: member.nick → user.global_name → user.username (§4.3)。
 * どれも無い場合は null (username を省略して webhook 既定名義で送る)。
 */
export function resolveDisplayName(interaction: Interaction): string | null {
	const member = interaction.member;
	const user = member?.user ?? interaction.user;
	if (
		member?.nick !== undefined &&
		member.nick !== null &&
		member.nick !== ""
	) {
		return member.nick;
	}
	if (
		user?.global_name !== undefined &&
		user.global_name !== null &&
		user.global_name !== ""
	) {
		return user.global_name;
	}
	if (user?.username !== undefined && user.username !== "") {
		return user.username;
	}
	return null;
}

/**
 * webhook の avatar_url を組み立てる (§4.3)。
 * - アバター hash あり → https://cdn.discordapp.com/avatars/{user.id}/{hash}.png
 * - hash なし (既定アバター) → https://cdn.discordapp.com/embed/avatars/N.png
 *   (N: 旧体系 discriminator % 5 / 新体系 (BigInt(user.id) >> 22n) % 6n。
 *   snowflake は 53 bit 超のため Number ではなく BigInt で計算する)
 * - ユーザー ID が取れない場合は null (avatar_url を省略)
 */
export function buildAvatarUrl(interaction: Interaction): string | null {
	const user = interaction.member?.user ?? interaction.user;
	if (user === undefined) {
		return null;
	}
	if (user.avatar !== undefined && user.avatar !== null && user.avatar !== "") {
		return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`;
	}
	let index = 0;
	try {
		if (
			user.discriminator !== undefined &&
			user.discriminator !== null &&
			user.discriminator !== "0"
		) {
			index = Number(user.discriminator) % 5;
		} else {
			index = Number((BigInt(user.id) >> 22n) % 6n);
		}
	} catch {
		// 不正な snowflake → 既定の色インデックス 0
		index = 0;
	}
	return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

/**
 * 送信メッセージ本文を組み立てる (§5)。
 * - include_original: true (既定) → 翻訳文 + 空行 + 引用形式の原文
 *   (原文が複数行の場合は各行の行頭に "> " を付ける)
 * - include_original: false → 翻訳文のみ
 * - 2000 字上限: 超過時は原文側を優先的に切り詰め (翻訳文が本体のため全文維持)、
 *   それでも超える (引用を丸めても超える) 場合は最終防衛線として
 *   全体を 2000 字に末尾カット + "…" (truncateToDiscordLimit と同じ方針)。
 * - 翻訳文の前後に余計な説明・見出しを付けない (§5)
 */
export function buildWebhookMessageContent(
	translated: string,
	original: string | null,
	includeOriginal: boolean,
): string {
	if (!includeOriginal || original === null || original === "") {
		return truncateToDiscordLimit(translated);
	}
	const full = `${translated}\n\n${quoteOriginal(original)}`;
	if (full.length <= MAX_CONTENT_LENGTH) {
		return full;
	}
	// 原文側を優先的に切り詰める。引用化による増分は各行頭 "> " (2 × 行数) と
	// 行間改行 (行数 - 1) の合計 3n - 1。切り詰め位置に "…" を足す。
	const lineCount = original.split("\n").length;
	const quoteOverhead = 3 * lineCount - 1;
	const budget = MAX_CONTENT_LENGTH - translated.length - 2 - 1 - quoteOverhead;
	if (budget >= 1) {
		const truncated = `${translated}\n\n${quoteOriginal(`${original.slice(0, budget)}…`)}`;
		// 行数の減少で見積もりが変わるケースもありうるため最終防衛線を重ねる
		return truncateToDiscordLimit(truncated);
	}
	// 引用を丸めても上限超過 (翻訳文単独で 2000 字超) → 全体を切り詰める
	return truncateToDiscordLimit(translated);
}

/** 原文を引用形式にする (複数行の場合は各行の行頭に "> " を付ける) */
function quoteOriginal(original: string): string {
	return original
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n");
}

/**
 * フォールバック送信 (§4.5): interaction followup で bot 名義送信し、
 * 帰属を embed footer ("Requested by @<名前>") で明示する。
 * flags を付けないため公開メッセージになる (defer の ephemeral は継承されない)。
 * 成功で true。
 */
async function sendFallbackFollowup(
	env: Env,
	interaction: Interaction,
	translated: string,
	options: TranslateSendOptions,
): Promise<boolean> {
	try {
		const displayName = resolveDisplayName(interaction);
		const response = await sendFollowup(env.DISCORD_APP_ID, interaction.token, {
			content: buildWebhookMessageContent(
				translated,
				options.text,
				options.includeOriginal,
			),
			embeds: [
				{ footer: { text: `Requested by @${displayName ?? "unknown"}` } },
			],
			// ユーザー入力の原文を含む公開メッセージのため ping 偽装防止は
			// webhook 実行パスと同様に必須 (§4.3, §4.5)
			allowed_mentions: { parse: [] },
		});
		if (response.ok) {
			return true;
		}
		console.error(`Fallback followup failed: ${response.status}`);
		return false;
	} catch (error) {
		console.error("Fallback followup could not be sent:", error);
		return false;
	}
}

/**
 * @original を ephemeral 確認メッセージ「✅ 翻訳して送信しました (<言語名>)」へ
 * 更新する (§6)。PATCH のペイロードに flags は含めない
 * (ephemeral は defer (flags 64) 時点で確定済み)。
 * フォールバック / webhook のどちらの経路でも文言は共通 (§4.5)。
 */
async function updateOriginalSuccess(
	env: Env,
	interaction: Interaction,
	language: string,
): Promise<void> {
	try {
		const langName = LANGUAGE_NAMES[language] ?? language;
		const response = await editOriginalInteractionResponse(
			env.DISCORD_APP_ID,
			interaction.token,
			{ content: `✅ 翻訳して送信しました (${langName})` },
		);
		if (!response.ok) {
			console.error(`@original update failed: ${response.status}`);
		}
	} catch (error) {
		console.error("@original update could not be sent:", error);
	}
}

/** 例外発生時の @original ephemeral エラー更新。これ自体も失敗したらログのみ */
async function updateOriginalError(
	env: Env,
	interaction: Interaction,
): Promise<void> {
	try {
		const response = await editOriginalInteractionResponse(
			env.DISCORD_APP_ID,
			interaction.token,
			{
				content:
					"翻訳中にエラーが発生しました。しばらくしてからもう一度お試しください。",
			},
		);
		if (!response.ok) {
			console.error(`Error @original update failed: ${response.status}`);
		}
	} catch (error) {
		console.error("Error @original update could not be sent:", error);
	}
}

/**
 * 実行チャンネルがスレッドかどうか (thread type: 10 NEWS / 11 PUBLIC / 12 PRIVATE)。
 * interaction に付随する partial channel オブジェクトを見るため追加 API 呼び出しは不要。
 * 欠損時はスレッドではないものとして扱う。
 */
function isThreadChannel(interaction: Interaction): boolean {
	const type = interaction.channel?.type;
	return type === 10 || type === 11 || type === 12;
}

/** response.text() 自体も失敗しうるため例外を握って安全に文字列化する */
async function responseTextSafe(response: Response): Promise<string> {
	return response.text().catch((readError: unknown) => String(readError));
}
