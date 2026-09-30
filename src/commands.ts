/** コマンド選択肢 (/set-language, /translate-send の language) */
export interface CommandChoice {
	name: string;
	value: string;
}

export interface CommandOption {
	name: string;
	description: string;
	/** 3: STRING, 9: ROLE など */
	type: number;
	required?: boolean;
	choices?: CommandChoice[];
	/** STRING の入力上限 (Discord API では最大 6000 まで指定可能) */
	max_length?: number;
}

/** コマンド登録 API (PUT /applications/{id}/commands) に送る定義 */
export interface ApplicationCommandDefinition {
	name: string;
	/** 1: CHAT_INPUT, 2: USER, 3: MESSAGE (コンテキストメニュー) */
	type: number;
	/** コンテキストメニューでは指定しない */
	description?: string;
	options?: CommandOption[];
	/** "8" = Administrator のみ実行可 */
	default_member_permissions?: string;
}

/**
 * 言語コード → 英語名のマップ。
 * /set-language の choices 生成元であり、Phase 4 の翻訳プロンプトでも使う
 * (例: `Translate the following text into Japanese`)。
 */
export const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
	ja: "Japanese",
	en: "English",
	ko: "Korean",
	zh: "Chinese",
	es: "Spanish",
	fr: "French",
	de: "German",
	pt: "Portuguese",
	ru: "Russian",
	it: "Italian",
	id: "Indonesian",
	vi: "Vietnamese",
	th: "Thai",
	ar: "Arabic",
	hi: "Hindi",
	tr: "Turkish",
	pl: "Polish",
	nl: "Dutch",
	sv: "Swedish",
	uk: "Ukrainian",
	da: "Danish",
	fi: "Finnish",
	no: "Norwegian",
	cs: "Czech",
	hu: "Hungarian",
};

/** language の choices (Discord の上限は 25) */
export const LANGUAGE_CHOICES: readonly CommandChoice[] = Object.entries(
	LANGUAGE_NAMES,
).map(([value, name]) => ({ name, value }));

/**
 * 登録するコマンド一式。register script (scripts/register-commands.ts) と共有する。
 * - Translate: メッセージコンテキストメニュー (type 3)
 * - set-language: ユーザーの母国語を設定
 * - translate-config: Bot 使用許可ロールを設定 (管理者のみ)
 * - translate-send: 自分の発言を翻訳してチャンネルへ送信
 *   (docs/translate-send-command.md §2)
 */
export const COMMANDS: readonly ApplicationCommandDefinition[] = [
	{
		name: "Translate",
		type: 3, // MESSAGE context menu
	},
	{
		name: "set-language",
		type: 1, // CHAT_INPUT
		description: "Set your native language used for message translation",
		options: [
			{
				name: "language",
				description: "Your native language",
				type: 3, // STRING
				required: true,
				choices: [...LANGUAGE_CHOICES],
			},
		],
	},
	{
		name: "translate-config",
		type: 1,
		description:
			"Configure the role allowed to use the translation bot in this guild",
		default_member_permissions: "8", // Administrator
		options: [
			{
				name: "roles",
				description: "Role allowed to use the bot",
				type: 9, // ROLE
				required: true,
			},
		],
	},
	{
		name: "translate-send",
		type: 1, // CHAT_INPUT
		description: "Translate your text and send it to this channel as you",
		options: [
			{
				name: "text",
				description: "Text to translate (opens a dialog if omitted)",
				type: 3, // STRING
				required: false,
				max_length: 2000, // Discord のメッセージ本文上限に合わせる (§2)
			},
			{
				name: "language",
				description: "Target language (default: English)",
				type: 3, // STRING
				required: false,
				choices: [...LANGUAGE_CHOICES],
			},
			{
				// BOOLEAN には choices を付けられないため on/off は description で示す
				name: "include_original",
				description: "Attach the original text as a quote (default: on)",
				type: 5, // BOOLEAN
				required: false,
			},
		],
	},
];
