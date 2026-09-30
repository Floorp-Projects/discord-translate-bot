import { LANGUAGE_NAMES } from "../commands";
import { setUserLang } from "../store";
import {
	buildEphemeralResponse,
	type Env,
	getUserId,
	type Interaction,
	type InteractionResponse,
} from "../types";

/**
 * /set-language language:<choice> のハンドラ。
 * 翻訳のような重処理がないため defer / waitUntil 不要。
 * KV 書き込み後に type 4 (CHANNEL_MESSAGE_WITH_SOURCE, ephemeral) で即応答する
 * (docs/plan.md §6.2)。
 */
export async function handleSetLanguage(
	env: Env,
	interaction: Interaction,
): Promise<InteractionResponse> {
	// DM 実行では user、ギルド内では member.user に入る (src/types.ts getUserId)
	const userId = getUserId(interaction);
	if (userId === null) {
		return buildEphemeralResponse("実行者を特定できませんでした。");
	}

	const lang = getLanguageOption(interaction);
	// in 演算子ではなく Object.hasOwn でプロトタイプチェーンを拾わない
	// ("toString" 等の inherited プロパティが言語として通らないようにする)
	if (lang === null || !Object.hasOwn(LANGUAGE_NAMES, lang)) {
		// 通常は Discord 側で choices に制限されるが、直接 API 実行に備えて防御
		return buildEphemeralResponse(
			"不正な言語が指定されました。選択肢から言語を選んでください。",
		);
	}

	await setUserLang(env, userId, lang);
	return buildEphemeralResponse(
		`翻訳先の言語を ${LANGUAGE_NAMES[lang]} に設定しました。`,
	);
}

/** options から language の文字列値を取り出す (無ければ null) */
function getLanguageOption(interaction: Interaction): string | null {
	const option = interaction.data?.options?.find(
		(opt) => opt.name === "language",
	);
	return typeof option?.value === "string" ? option.value : null;
}
