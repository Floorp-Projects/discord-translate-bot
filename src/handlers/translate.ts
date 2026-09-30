import { LANGUAGE_NAMES } from "../commands";
import { sendFollowup } from "../discord";
import { isAllowedToTranslate } from "../permissions";
import { getGuildConfig, getUserLang } from "../store";
import { translateText } from "../translate";
import {
	buildEphemeralResponse,
	type Env,
	EPHEMERAL_FLAG,
	getUserId,
	type Interaction,
	type InteractionResponse,
	InteractionResponseType,
} from "../types";

/** 翻訳対象メッセージの文字数上限 (Discord のメッセージ上限に合わせる) */
export const MAX_CONTENT_LENGTH = 2000;

/**
 * 同期パス (defer 前) の検証結果。
 * allowed: false の場合は response (type 4 ephemeral エラー) をそのまま Discord へ返す。
 */
export type TranslatePrecheck =
	| { allowed: true }
	| { allowed: false; response: InteractionResponse };

/**
 * type 5 (DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, ephemeral) の応答ペイロード。
 * 同期パスの検証を通った場合に index.ts が即返す。
 */
export function buildTranslateResponse(): InteractionResponse {
	return {
		type: InteractionResponseType.DeferredChannelMessageWithSource,
		data: { flags: EPHEMERAL_FLAG },
	};
}

/**
 * 同期パス: 権限チェックと対象メッセージの検証のみを行う。
 * KV 読み取り 1 回と純粋な検証で済むため defer 前に実行し、
 * 文字数オーバー等は defer せず type 4 ephemeral エラーで即応する
 * (waitUntil 不要の最速パス — docs/plan.md §3, §6.1)。
 */
export async function precheckTranslate(
	env: Env,
	interaction: Interaction,
): Promise<TranslatePrecheck> {
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

	const content = getTargetMessageContent(interaction);
	if (content === null || content.trim() === "") {
		return {
			allowed: false,
			response: buildEphemeralResponse("翻訳する内容がありません。"),
		};
	}
	if (content.length > MAX_CONTENT_LENGTH) {
		return {
			allowed: false,
			response: buildEphemeralResponse(
				`メッセージが長すぎます。${MAX_CONTENT_LENGTH} 文字以内のメッセージのみ翻訳できます。`,
			),
		};
	}

	return { allowed: true };
}

/**
 * Translate の後続処理。index.ts が type 5 (ephemeral defer) を返した後に
 * ctx.waitUntil 経由で呼ばれる純関数 (env はテストでモック注入可)。
 * ユーザー言語の KV 読み取り・Workers AI・followup 送信という重い I/O は
 * すべてここに集約される。
 * 全体を try/catch し、失敗時は同 webhook で ephemeral エラーメッセージを送る。
 */
export async function handleTranslate(
	env: Env,
	interaction: Interaction,
): Promise<void> {
	try {
		const content = await buildResultMessage(env, interaction);
		const response = await sendFollowup(env.DISCORD_APP_ID, interaction.token, {
			content,
			flags: EPHEMERAL_FLAG,
		});
		if (response.ok) {
			return;
		}
		// response.text() 自体も失敗しうるため、ログ化は例外を握って安全に行う
		const body = await response
			.text()
			.catch((readError: unknown) => String(readError));
		console.error(`Translate followup failed: ${response.status} ${body}`);
		// この時点でユーザーには何も表示されていないため、エラーメッセージの
		// 再送を 1 回だけ試みる (sendErrorFollowup は失敗を握り潰すため再帰しない)
		await sendErrorFollowup(env, interaction);
	} catch (error) {
		console.error("Translate processing failed:", error);
		// sendErrorFollowup は例外を投げないため、ここで連鎖・無限再帰にはならない
		await sendErrorFollowup(env, interaction);
	}
}

/**
 * 成功時は翻訳結果、ユーザー起因の失敗時は案内メッセージを組み立てる。
 * 予期しない失敗 (Workers AI エラー等) は例外として投げ、呼び出し側の
 * エラーフロー (sendErrorFollowup) へ流す。
 */
async function buildResultMessage(
	env: Env,
	interaction: Interaction,
): Promise<string> {
	const userId = getUserId(interaction);
	if (userId === null) {
		return "実行者を特定できませんでした。";
	}

	// 未設定なら翻訳はせず設定を促す
	const lang = await getUserLang(env, userId);
	if (lang === null) {
		return "翻訳先の言語が未設定です。/set-language で言語を設定してください。";
	}

	// precheck 済みだが token 有効期間内の再実行などで到達しうるため防御しておく
	const content = getTargetMessageContent(interaction);
	if (content === null || content.trim() === "") {
		return "翻訳する内容がありません。";
	}

	const translated = await translateText(env, content, lang);
	const langName = LANGUAGE_NAMES[lang] ?? lang;
	return truncateToDiscordLimit(`🌐 **${langName}**\n${translated}`);
}

/**
 * followup の content を Discord のメッセージ上限に収める (最終防衛線)。
 * 入力は MAX_CONTENT_LENGTH で制限してあるが、翻訳「出力」は言語対によって
 * 膨張しうる。上限超過のまま送ると followup が 400 になり、ユーザーには
 * 何も表示されないため、プレフィックスを含めた総長が上限以下になるよう
 * 末尾を切り詰めて … (省略) を付ける。
 */
export function truncateToDiscordLimit(content: string): string {
	if (content.length <= MAX_CONTENT_LENGTH) {
		return content;
	}
	// 末尾の … (1 文字) 分も上限内に収める
	return `${content.slice(0, MAX_CONTENT_LENGTH - 1)}…`;
}

/** 例外発生時の ephemeral エラー followup。これ自体も失敗したらログのみ (ユーザーには応答なしになる) */
async function sendErrorFollowup(
	env: Env,
	interaction: Interaction,
): Promise<void> {
	try {
		const response = await sendFollowup(env.DISCORD_APP_ID, interaction.token, {
			content:
				"翻訳中にエラーが発生しました。しばらくしてからもう一度お試しください。",
			flags: EPHEMERAL_FLAG,
		});
		if (!response.ok) {
			console.error(`Error followup failed: ${response.status}`);
		}
	} catch (error) {
		console.error("Error followup could not be sent:", error);
	}
}

/** コンテキストメニューの対象メッセージの内容を取り出す (解決できなければ null) */
function getTargetMessageContent(interaction: Interaction): string | null {
	const targetId = interaction.data?.target_id;
	if (targetId === undefined) {
		return null;
	}
	return interaction.data?.resolved?.messages?.[targetId]?.content ?? null;
}
