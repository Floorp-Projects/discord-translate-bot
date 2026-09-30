import type { ChannelWebhook, Env, GuildConfig } from "./types";

/** user:{userId} の値 (例: {"lang":"ja"}) */
interface UserLangValue {
	lang?: unknown;
}

/** guild:{guildId} の値 (例: {"allowedRoleIds":["123"]}) */
interface GuildConfigValue {
	allowedRoleIds?: unknown;
}

/** webhook:{channelId} の値 (例: {"id":"...","token":"..."}) */
interface ChannelWebhookValue {
	id?: unknown;
	token?: unknown;
}

/**
 * ユーザーの翻訳先言語を取得する (キー: user:{userId}, 値: {"lang":"ja"})。
 * 未設定・空文字・壊れた JSON・不正な型はすべて null 扱いにする。
 */
export async function getUserLang(
	env: Env,
	userId: string,
): Promise<string | null> {
	const raw = await env.KV.get(`user:${userId}`);
	if (raw === null) {
		return null;
	}
	try {
		const value = JSON.parse(raw) as UserLangValue;
		return typeof value.lang === "string" && value.lang !== ""
			? value.lang
			: null;
	} catch {
		// 壊れた値は未設定扱い (docs/plan.md §5)
		return null;
	}
}

/** ユーザーの翻訳先言語を保存する (キー: user:{userId}) */
export async function setUserLang(
	env: Env,
	userId: string,
	lang: string,
): Promise<void> {
	await env.KV.put(`user:${userId}`, JSON.stringify({ lang }));
}

/**
 * ギルドの Bot 使用許可ロール設定を取得する (キー: guild:{guildId})。
 * 未設定・壊れた JSON・型不一致はすべて null 扱い
 * (null は「全員許可」を意味する — src/permissions.ts 参照)。
 */
export async function getGuildConfig(
	env: Env,
	guildId: string,
): Promise<GuildConfig | null> {
	const raw = await env.KV.get(`guild:${guildId}`);
	if (raw === null) {
		return null;
	}
	try {
		const value = JSON.parse(raw) as GuildConfigValue;
		if (!Array.isArray(value.allowedRoleIds)) {
			return null;
		}
		const allowedRoleIds = value.allowedRoleIds.filter(
			(id): id is string => typeof id === "string",
		);
		return { allowedRoleIds };
	} catch {
		return null;
	}
}

/** ギルドの Bot 使用許可ロールを保存する (キー: guild:{guildId}) */
export async function setGuildConfig(
	env: Env,
	guildId: string,
	allowedRoleIds: string[],
): Promise<void> {
	await env.KV.put(`guild:${guildId}`, JSON.stringify({ allowedRoleIds }));
}

/**
 * チャンネルに紐づく Bot 作成 webhook のキャッシュを取得する
 * (キー: webhook:{channelId} — docs/translate-send-command.md §4.4)。
 * 未設定・壊れた JSON・不正な型はすべて null 扱いにする。
 */
export async function getChannelWebhook(
	env: Env,
	channelId: string,
): Promise<ChannelWebhook | null> {
	const raw = await env.KV.get(`webhook:${channelId}`);
	if (raw === null) {
		return null;
	}
	try {
		const value = JSON.parse(raw) as ChannelWebhookValue;
		if (
			typeof value.id !== "string" ||
			value.id === "" ||
			typeof value.token !== "string" ||
			value.token === ""
		) {
			return null;
		}
		return { id: value.id, token: value.token };
	} catch {
		return null;
	}
}

/** チャンネルに紐づく Bot 作成 webhook のキャッシュを保存する (キー: webhook:{channelId}) */
export async function setChannelWebhook(
	env: Env,
	channelId: string,
	webhook: ChannelWebhook,
): Promise<void> {
	await env.KV.put(
		`webhook:${channelId}`,
		JSON.stringify({ id: webhook.id, token: webhook.token }),
	);
}
