import { handleConfig } from "./handlers/config";
import { handleSetLanguage } from "./handlers/setLanguage";
import {
	buildTranslateResponse,
	handleTranslate,
	precheckTranslate,
} from "./handlers/translate";
import {
	buildModalResponse,
	buildSendDeferredResponse,
	handleTranslateSendModalSubmit,
	handleTranslateSendProcess,
	MODAL_CUSTOM_ID_PREFIX,
	parseCommandOptions,
	precheckTranslateSend,
} from "./handlers/translateSend";
import {
	ApplicationCommandType,
	buildEphemeralResponse,
	type Env,
	type Interaction,
	InteractionResponseType,
	InteractionType,
} from "./types";
import { verifyDiscordSignature } from "./verify";

/** Discord Developer Portal に登録する Interactions Endpoint */
const INTERACTIONS_PATH = "/api/interactions";

/**
 * 署名検証前に課すリクエストボディの上限 (JS 文字列長 = UTF-16 code unit 数)。
 * Discord interaction の実 payload は高々数十 KB であり、これを超えるボディは
 * 不正リクエストとして検証前に拒否する。subtle.verify はボディ長に比例した
 * CPU を消費するため、認証前の CPU 消費増幅 (DoS / 課金攻撃) を防ぐ目的。
 */
export const MAX_BODY_LENGTH = 64 * 1024;

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);
		if (request.method !== "POST" || url.pathname !== INTERACTIONS_PATH) {
			return new Response("Not Found", { status: 404 });
		}

		// body は 1 回だけ読み、JSON パースも 1 回だけ (docs/plan.md §3)
		const body = await request.text();
		// 署名検証 (CPU がボディ長に比例) の前にサイズ上限をチェックする
		if (body.length > MAX_BODY_LENGTH) {
			return new Response("Payload Too Large", { status: 413 });
		}
		if (
			!(await verifyDiscordSignature(
				request,
				body,
				env.DISCORD_TRANSLATE_BOT_PUBLIC_KEY,
			))
		) {
			return new Response("Unauthorized", { status: 401 });
		}

		let interaction: Interaction;
		try {
			interaction = JSON.parse(body) as Interaction;
		} catch {
			return new Response("Bad Request", { status: 400 });
		}

		switch (interaction.type) {
			case InteractionType.Ping:
				return Response.json({ type: InteractionResponseType.Pong });

			case InteractionType.ApplicationCommand:
				try {
					return await handleApplicationCommand(env, interaction, ctx);
				} catch (error) {
					// KV 読み書き失敗などの予期しない例外。
					// この時点ではまだ Discord へ応答していないため ephemeral エラーで即応できる
					console.error("Interaction handling failed:", error);
					return Response.json(
						buildEphemeralResponse(
							"内部エラーが発生しました。しばらくしてからもう一度お試しください。",
						),
					);
				}

			case InteractionType.ModalSubmit:
				return await handleModalSubmit(env, interaction, ctx);

			default:
				// MessageComponent (3) / Autocomplete (4) は未使用
				return new Response("Unsupported interaction type", { status: 400 });
		}
	},
} satisfies ExportedHandler<Env>;

/**
 * MODAL_SUBMIT (type 5) の振り分け。
 * custom_id プレフィックス "ts:" (/translate-send の modal) のみ処理し、
 * それ以外は不明リクエストとして ephemeral エラーで即応する
 * (docs/translate-send-command.md §3.2, §8)。
 */
async function handleModalSubmit(
	env: Env,
	interaction: Interaction,
	ctx: ExecutionContext,
): Promise<Response> {
	try {
		if (
			interaction.data?.custom_id?.startsWith(MODAL_CUSTOM_ID_PREFIX) === true
		) {
			return await handleTranslateSendModalSubmit(env, interaction, ctx);
		}
		return Response.json(
			buildEphemeralResponse(
				"不正なリクエストです。もう一度コマンドを実行してください。",
			),
		);
	} catch (error) {
		// KV 読み書き失敗などの予期しない例外。まだ Discord へ応答していないため
		// ephemeral エラーで即応できる
		console.error("ModalSubmit handling failed:", error);
		return Response.json(
			buildEphemeralResponse(
				"内部エラーが発生しました。しばらくしてからもう一度お試しください。",
			),
		);
	}
}

/**
 * アプリケーションコマンド (スラッシュ & コンテキストメニュー) の振り分け。
 *
 * コンテキストメニューは interaction.type = 2 (APPLICATION_COMMAND) として届き、
 * コマンド種別は interaction.data.type (3 = MESSAGE) で判別する。
 *
 * Translate 以外は軽い KV 書き込み 1 回で完結するため defer 不要の即応 (type 4)。
 * 応答を返す前に例外が起きても、上の try/catch が ephemeral エラーで拾う。
 */
async function handleApplicationCommand(
	env: Env,
	interaction: Interaction,
	ctx: ExecutionContext,
): Promise<Response> {
	const commandType = interaction.data?.type;
	const commandName = interaction.data?.name;

	// メッセージ右クリック → アプリ → Translate
	if (
		commandType === ApplicationCommandType.Message &&
		commandName === "Translate"
	) {
		// defer 前の同期パス: 権限チェックと対象メッセージ検証のみ (CPU 時間最小化 — docs/plan.md §3, §6.1)
		const precheck = await precheckTranslate(env, interaction);
		if (!precheck.allowed) {
			// defer せず ephemeral エラーで即応 (waitUntil 不要の最速パス)
			return Response.json(precheck.response);
		}
		// 重い処理 (ユーザー言語の KV 読み取り / Workers AI / followup) はすべて waitUntil へ
		ctx.waitUntil(handleTranslate(env, interaction));
		return Response.json(buildTranslateResponse());
	}

	if (commandType === ApplicationCommandType.ChatInput) {
		switch (commandName) {
			case "set-language":
				// KV 書き込み後に type 4 ephemeral で即応 (defer 不要 — docs/plan.md §6.2)
				return Response.json(await handleSetLanguage(env, interaction));
			case "translate-config":
				return Response.json(await handleConfig(env, interaction));
			case "translate-send":
				return await handleTranslateSendCommand(env, interaction, ctx);
		}
	}

	// 未知のコマンド / data のない不正 payload → ephemeral エラー
	return Response.json(buildEphemeralResponse("不明なコマンドです。"));
}

/**
 * /translate-send の振り分け (docs/translate-send-command.md §6)。
 *
 * defer 前の同期パス: 権限チェック / 言語値検証 / 文字数検証のみ。
 * - text あり → type 5 defer (ephemeral) → 重い処理は waitUntil へ
 * - text なし → type 9 (MODAL) で入力ダイアログを開く (§3.1)。
 *   この interaction は type 9 応答で完了し、翻訳などの重処理は一切行わない (§3.2)。
 */
async function handleTranslateSendCommand(
	env: Env,
	interaction: Interaction,
	ctx: ExecutionContext,
): Promise<Response> {
	const options = parseCommandOptions(interaction);
	const precheck = await precheckTranslateSend(env, interaction, options);
	if (!precheck.allowed) {
		// defer せず ephemeral エラーで即応 (waitUntil 不要の最速パス)
		return Response.json(precheck.response);
	}

	if (precheck.options.text === null) {
		// text 省略 → Modal を開く (§3)
		return Response.json(
			buildModalResponse(
				precheck.options.language,
				precheck.options.includeOriginal,
			),
		);
	}

	// 重い処理 (Workers AI / webhook 送信 / @original 更新) はすべて waitUntil へ
	ctx.waitUntil(handleTranslateSendProcess(env, interaction, precheck.options));
	return Response.json(buildSendDeferredResponse());
}
