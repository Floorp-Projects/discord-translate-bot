/**
 * Workers bindings / secrets (docs/plan.md §7 参照)。
 * Bot Token は Worker に置かない (followup は interaction token を使用する)。
 */
export interface Env {
	/** Workers AI */
	AI: Ai;
	/** 設定ストア (ユーザー言語 / ギルド許可ロール) */
	KV: KVNamespace;
	/** secret: Interactions 署名検証用の公開鍵 (hex) */
	DISCORD_TRANSLATE_BOT_PUBLIC_KEY: string;
	/** var: followup webhook 用アプリケーション ID */
	DISCORD_APP_ID: string;
}

/** Interaction.type — Discord の Interaction オブジェクトの種別 */
export const InteractionType = {
	/** エンドポイント登録時に Discord が送る検証用 PING */
	Ping: 1,
	/** スラッシュコマンド & コンテキストメニューコマンド */
	ApplicationCommand: 2,
	MessageComponent: 3,
	ApplicationCommandAutocomplete: 4,
	ModalSubmit: 5,
} as const;

/** ApplicationCommandType — interaction.data.type に入るコマンド種別 */
export const ApplicationCommandType = {
	ChatInput: 1,
	User: 2,
	/** メッセージ右クリック → アプリ (Translate はこれ) */
	Message: 3,
} as const;

/** InteractionResponseType — Worker から Discord への応答種別 */
export const InteractionResponseType = {
	Pong: 1,
	/** type 4: 即時応答メッセージ */
	ChannelMessageWithSource: 4,
	/** type 5: 「考え中…」表示。重い処理は ctx.waitUntil() へ逃がす */
	DeferredChannelMessageWithSource: 5,
} as const;

/** flags ビット: 実行者にのみ表示される (チャンネルを汚さない) */
export const EPHEMERAL_FLAG = 64;

/** ギルド設定 (キー: guild:{guildId}) — Bot 使用を許可するロール一覧 */
export interface GuildConfig {
	allowedRoleIds: string[];
}

/** スラッシュ / コンテキストメニューコマンド共通の interaction.data */
export interface InteractionCommandData {
	id: string;
	name: string;
	/** ApplicationCommandType (1: CHAT_INPUT, 2: USER, 3: MESSAGE) */
	type: number;
	/** コンテキストメニューの対象リソース ID (Translate では対象メッセージ) */
	target_id?: string;
	/** コンテキストメニューの場合、解決済みリソースが入る */
	resolved?: {
		messages?: Record<string, InteractionMessage>;
	};
	options?: Array<{
		name: string;
		type: number;
		value: string | number | boolean;
	}>;
}

/** followup / 応答で参照されるメッセージの最小限の情報 */
export interface InteractionMessage {
	id: string;
	content: string;
	author?: { id: string; username?: string };
}

export interface Interaction {
	id: string;
	application_id: string;
	type: number;
	/** 応答 / followup に使える 15 分有効なトークン (Bot Token 不要) */
	token: string;
	guild_id?: string;
	channel_id?: string;
	data?: InteractionCommandData;
	/** ギルド内実行時のみ存在 */
	member?: {
		user?: { id: string; username?: string };
		/** 実行者が保持するロール ID (Phase 3 の権限チェックで使用) */
		roles?: string[];
		/** 実行者の権限ビットフィールド (10 進数文字列、ギルド内実行時のみ) */
		permissions?: string;
	};
	/** DM 実行時のみ存在 */
	user?: { id: string; username?: string };
	/** コンテキストメニューの対象メッセージ */
	message?: InteractionMessage;
}

/** type 4 (即時応答) / type 5 (defer) の応答ペイロード */
export interface InteractionResponse {
	type: number;
	data?: {
		content?: string;
		flags?: number;
	};
}

/** followup webhook (POST /webhooks/{app_id}/{token}) のペイロード */
export interface FollowupMessage {
	content?: string;
	flags?: number;
}

/**
 * type 4 (CHANNEL_MESSAGE_WITH_SOURCE) の ephemeral 応答を組み立てる。
 * /set-language, /translate-config の即応答と、defer 前のエラー即応で使う
 * (重い処理がなく defer / waitUntil 不要の最速パス — docs/plan.md §6.2)。
 */
export function buildEphemeralResponse(content: string): InteractionResponse {
	return {
		type: InteractionResponseType.ChannelMessageWithSource,
		data: { content, flags: EPHEMERAL_FLAG },
	};
}

/**
 * interaction から実行者のユーザー ID を取り出す。
 * ギルド内では member.user、DM では user に入るため両方を見る。
 * どちらも無い場合は null (呼び出し側で防御する)。
 */
export function getUserId(interaction: Interaction): string | null {
	return interaction.member?.user?.id ?? interaction.user?.id ?? null;
}
