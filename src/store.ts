import type { Env, GuildConfig } from "./types";

/** user:{userId} の値 (例: {"lang":"ja"}) */
interface UserLangValue {
	lang?: unknown;
}

/** guild:{guildId} の値 (例: {"allowedRoleIds":["123"]}) */
interface GuildConfigValue {
	allowedRoleIds?: unknown;
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
 * 翻訳結果キャッシュの TTL (秒)。2 週間 (docs/plan.md §5 の任意項目)。
 * 同一の原文 + 翻訳先言語の再翻訳では、TTL 内なら Workers AI 呼び出しをスキップする。
 */
export const TRANSLATION_CACHE_TTL_SECONDS = 14 * 24 * 60 * 60; // 1,209,600 秒

/**
 * 翻訳結果キャッシュの KV キー (`cache:{sha256 の hex}`) を生成する。
 * 入力は `${langCode}:${text}` を SHA-256 でハッシュする
 * (原文が長い場合や特殊文字を含む場合でもキー長が一定に保たれる)。
 */
export async function translationCacheKey(
	text: string,
	langCode: string,
): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(`${langCode}:${text}`),
	);
	let hex = "";
	for (const byte of new Uint8Array(digest)) {
		hex += byte.toString(16).padStart(2, "0");
	}
	return `cache:${hex}`;
}

/**
 * 翻訳結果のキャッシュを取得する。ヒットすれば翻訳文字列、なければ null。
 * キャッシュの読み取り失敗は翻訳フローを壊さない (KV 異常時は null 扱いで AI 実行にフォールバック)。
 */
export async function getCachedTranslation(
	env: Env,
	text: string,
	langCode: string,
): Promise<string | null> {
	try {
		const key = await translationCacheKey(text, langCode);
		const value = await env.KV.get(key);
		return typeof value === "string" && value !== "" ? value : null;
	} catch (error) {
		console.error("Translation cache read failed:", error);
		return null;
	}
}

/**
 * 翻訳結果を KV へキャッシュする (TTL: 2 週間)。
 * キャッシュの書き込み失敗は翻訳フローを壊さない (ログのみで静かに諦める)。
 */
export async function cacheTranslation(
	env: Env,
	text: string,
	langCode: string,
	translated: string,
): Promise<void> {
	try {
		const key = await translationCacheKey(text, langCode);
		await env.KV.put(key, translated, {
			expirationTtl: TRANSLATION_CACHE_TTL_SECONDS,
		});
	} catch (error) {
		console.error("Translation cache write failed:", error);
	}
}
