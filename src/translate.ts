import { LANGUAGE_NAMES } from "./commands";
import type { Env } from "./types";

/**
 * Workers AI で使う翻訳モデル。
 * モデルの差し替えはこの定数 1 行で可能 (docs/plan.md §2 翻訳エンジン選定)。
 * 注意: このモデルは Workers Free プランでは利用不可 (Workers Paid が必要)。
 */
export const TRANSLATE_MODEL = "@cf/deepseek-ai/deepseek-v4-flash-0731";

/**
 * 出力トークンの上限 (入力自体は 2,000 文字で制限 — handlers/translate.ts)。
 * 翻訳出力が Discord の 2,000 文字上限を超える場合は送信側で切り詰められるため
 * (handlers/translate.ts truncateToDiscordLimit)、2,048 で十分 (コスト・レイテンシ削減)。
 */
const MAX_COMPLETION_TOKENS = 2048;

/**
 * 翻訳のみを出力させるシステムプロンプト。
 * 原文の体裁 (改行 / Markdown / 絵文字など) を維持し、説明や引用符を付けさせない。
 */
const SYSTEM_PROMPT =
	"You are a translation engine. Output ONLY the translation of the user's text. " +
	"Preserve the original formatting exactly: line breaks, Markdown, emoji, mentions and URLs. " +
	"Do not add explanations, notes, quotations or any other text around the translation.";

/**
 * テキストを指定言語へ翻訳する (Workers AI バインディング経由)。
 * 推論は GPU 側で走るため Worker の CPU 時間はほぼ増えない (docs/plan.md §3)。
 *
 * @param env Workers bindings (AI を使用)
 * @param text 翻訳する本文
 * @param targetLangCode 翻訳先の言語コード (/set-language の choices 値)
 * @returns 翻訳結果 (前後空白を trim)。空応答や想定外の形式は例外。
 */
export async function translateText(
	env: Env,
	text: string,
	targetLangCode: string,
): Promise<string> {
	// LLM の翻訳精度を上げるため、言語コードではなく英語名 ("Japanese" 等) を渡す
	const langName = LANGUAGE_NAMES[targetLangCode] ?? targetLangCode;

	const result: unknown = await env.AI.run(TRANSLATE_MODEL, {
		messages: [
			{ role: "system", content: SYSTEM_PROMPT },
			{
				role: "user",
				content: `Translate the following text into ${langName}:\n${text}`,
			},
		],
		// DeepSeek のデフォルトは推論 "high" のため、翻訳では明示的に無効化する
		// (レイテンシと出力トークン代の削減 — docs/plan.md §2)
		reasoning_effort: "none",
		// max_tokens は非推奨のため max_completion_tokens を使う
		max_completion_tokens: MAX_COMPLETION_TOKENS,
		temperature: 0,
	});

	return extractTranslation(result);
}

/**
 * Workers AI の応答を防御的にパースする。
 * OpenAI 互換の { choices: [{ message: { content } }] } 形式と、
 * 旧来の { response: string } 形式の両方に対応。
 * 空文字 / undefined / 想定外の形式は例外として呼び出し側のエラーフローへ流す。
 */
function extractTranslation(result: unknown): string {
	if (typeof result !== "object" || result === null) {
		throw new Error(`Unexpected Workers AI response type: ${typeof result}`);
	}
	const record = result as Record<string, unknown>;

	const fromChoices = extractFromChoices(record.choices);
	if (fromChoices !== null) {
		return fromChoices;
	}

	if (typeof record.response === "string" && record.response.trim() !== "") {
		return record.response.trim();
	}

	throw new Error("Workers AI returned an empty translation");
}

/** choices 形式から最初の空でない message.content を取り出す */
function extractFromChoices(choices: unknown): string | null {
	if (!Array.isArray(choices)) {
		return null;
	}
	for (const choice of choices) {
		if (typeof choice !== "object" || choice === null) {
			continue;
		}
		const message = (choice as Record<string, unknown>).message;
		if (typeof message !== "object" || message === null) {
			continue;
		}
		const content = (message as Record<string, unknown>).content;
		if (typeof content === "string" && content.trim() !== "") {
			return content.trim();
		}
	}
	return null;
}
