/**
 * Workers bindings / secrets (docs/plan.md §7 参照)。
 * DISCORD_BOT_TOKEN は webhook 作成・一覧取得でのみ使う
 * (docs/translate-send-command.md §4.2)。
 */
export interface Env {
	/** Workers AI */
	AI: Ai;
	/** 設定ストア (ユーザー言語 / ギルド許可ロール / webhook キャッシュ) */
	KV: KVNamespace;
	/** secret: Interactions 署名検証用の公開鍵 (hex) */
	DISCORD_TRANSLATE_BOT_PUBLIC_KEY: string;
	/** var: followup webhook 用アプリケーション ID */
	DISCORD_APP_ID: string;
	/**
	 * secret: webhook 作成 / 一覧取得用 Bot Token
	 * (docs/translate-send-command.md §4.2)。
	 * 未設定・空文字でも Bot は動作する (webhook 送信はフォールバックに落ちる)。
	 */
	DISCORD_BOT_TOKEN?: string;
}

/** Interaction.type — Discord の Interaction オブジェクトの種別 */
export const InteractionType = {
	/** エンドポイント登録時に Discord が送る検証用 PING */
	Ping: 1,
	/** スラッシュコマンド & コンテキストメニューコマンド */
	ApplicationCommand: 2,
	MessageComponent: 3,
	ApplicationCommandAutocomplete: 4,
	/** Modal の提出 */
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
	/** type 9: Modal を開く (docs/translate-send-command.md §3.1) */
	Modal: 9,
} as const;

/** flags ビット: 実行者にのみ表示される (チャンネルを汚さない) */
export const EPHEMERAL_FLAG = 64;

/** ギルド設定 (キー: guild:{guildId}) — Bot 使用を許可するロール一覧 */
export interface GuildConfig {
	allowedRoleIds: string[];
}

/**
 * Modal 内の Text Input (type 4) コンポーネント
 * (docs/translate-send-command.md §3.1)。
 */
export interface ModalTextInput {
	type: 4;
	custom_id: string;
	/** 1: Short (単行) / 2: Paragraph (複数行) */
	style: 1 | 2;
	label: string;
	placeholder?: string;
	min_length?: number;
	max_length?: number;
	required?: boolean;
}

/** Modal 内の Action Row (type 1) — Text Input を 1 つだけ持つ */
export interface ModalActionRow {
	type: 1;
	components: ModalTextInput[];
}

/** スラッシュ / コンテキストメニューコマンド共通の interaction.data */
export interface InteractionCommandData {
	/** MODAL_SUBMIT (type 5) の data には存在しないため optional */
	id?: string;
	/** MODAL_SUBMIT (type 5) の data には存在しないため optional */
	name?: string;
	/** ApplicationCommandType (1: CHAT_INPUT, 2: USER, 3: MESSAGE) */
	type?: number;
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
	/**
	 * MODAL_SUBMIT (type 5) のみ: modal の custom_id
	 * (/translate-send では "ts:<language>:<include_original 0|1>")
	 */
	custom_id?: string;
	/**
	 * MODAL_SUBMIT (type 5) のみ: 提出されたコンポーネント
	 * (ActionRow 配列 — 想定外の形状がありうるため unknown で受け、
	 * ハンドラ側で防御的にパースする)
	 */
	components?: unknown;
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
	/**
	 * 実行チャンネル (interaction に付随する partial オブジェクト)。
	 * スレッド判定 (type 10/11/12) に使う
	 * (docs/translate-send-command.md §4.2)
	 */
	channel?: { id?: string; type?: number };
	data?: InteractionCommandData;
	/** ギルド内実行時のみ存在 */
	member?: {
		user?: {
			id: string;
			username?: string;
			/** 表示名 (webhook username の第 2 優先) */
			global_name?: string;
			/** アバターのハッシュ (既定アバターのユーザーは null / 未設定) */
			avatar?: string | null;
			/** 旧体系の 4 桁識別子 (既定アバターの色インデックス計算に使用) */
			discriminator?: string;
		};
		/** ギルド内でのニックネーム (webhook username の最優先) */
		nick?: string | null;
		/** 実行者が保持するロール ID (Phase 3 の権限チェックで使用) */
		roles?: string[];
		/** 実行者の権限ビットフィールド (10 進数文字列、ギルド内実行時のみ) */
		permissions?: string;
	};
	/** DM 実行時のみ存在 */
	user?: {
		id: string;
		username?: string;
		/** 表示名 (webhook username の第 2 優先) */
		global_name?: string;
		/** アバターのハッシュ (既定アバターのユーザーは null / 未設定) */
		avatar?: string | null;
		/** 旧体系の 4 桁識別子 (既定アバターの色インデックス計算に使用) */
		discriminator?: string;
	};
	/** コンテキストメニューの対象メッセージ */
	message?: InteractionMessage;
}

/** type 4 (即時応答) / type 5 (defer) / type 9 (MODAL) の応答ペイロード */
export interface InteractionResponse {
	type: number;
	data?: {
		content?: string;
		flags?: number;
		/** type 9 (MODAL) 応答: modal の custom_id (100 字以内) */
		custom_id?: string;
		/** type 9 (MODAL) 応答: modal のタイトル (45 字以内) */
		title?: string;
		/** type 9 (MODAL) 応答: modal を構成するコンポーネント */
		components?: ModalActionRow[];
	};
}

/** followup の embed (フォールバック送信の帰属表示に footer のみ使用) */
export interface FollowupEmbed {
	footer?: { text: string };
}

/** followup webhook (POST /webhooks/{app_id}/{token}) のペイロード */
export interface FollowupMessage {
	content?: string;
	flags?: number;
	embeds?: FollowupEmbed[];
	/**
	 * ping 偽装防止: ユーザー入力を含む公開メッセージではすべての
	 * メンション形式を無効化する (セキュリティ上必須 — §4.3, §4.5)
	 */
	allowed_mentions?: { parse: string[] };
}

/** チャンネル webhook (webhook 実行に使う token を含む) */
export interface ChannelWebhook {
	id: string;
	token: string;
	name?: string;
}

/** webhook 実行 (POST /webhooks/{id}/{token}?wait=true) のペイロード */
export interface WebhookExecuteMessage {
	content?: string;
	/** 実行者の表示名 (member.nick → global_name → username の優先順) */
	username?: string;
	/** 実行者のアバター URL */
	avatar_url?: string;
	/**
	 * ping 偽装防止: すべてのメンション形式を無効化する
	 * (セキュリティ上必須 — docs/translate-send-command.md §4.3)
	 */
	allowed_mentions?: { parse: string[] };
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
