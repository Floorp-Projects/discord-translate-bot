import { describe, expect, it, vi } from "vitest";
import { TRANSLATE_MODEL, translateText } from "../src/translate";
import { createEnv } from "./test-utils";

/** translateText にモック AI を注入して run の呼び出しを記録する */
function createAIWith(response: unknown) {
	const run = vi.fn().mockResolvedValue(response);
	return { run, env: createEnv({ aiRun: run }) };
}

/** モック AI を注入したまま翻訳を実行し、run と結果を返す */
async function translateWith(
	response: unknown,
	text = "Hello, world!",
	targetLangCode = "ja",
) {
	const { run, env } = createAIWith(response);
	const result = await translateText(env, text, targetLangCode);
	return { run, result };
}

/** run の 1 回目の呼び出しから (モデル名, パラメータ) を取り出す */
function firstRunCall(run: ReturnType<typeof vi.fn>): [string, RunParams] {
	return run.mock.calls[0] as [string, RunParams];
}

interface RunParams {
	messages: Array<{ role: string; content: string }>;
	reasoning_effort?: string;
	temperature?: number;
	max_completion_tokens?: number;
}

describe("translateText", () => {
	it("モデル @cf/deepseek-ai/deepseek-v4-flash-0731 で AI.run を 1 回呼ぶ", async () => {
		const { run } = await translateWith({
			choices: [{ message: { content: "bonjour" } }],
		});
		expect(run).toHaveBeenCalledTimes(1);
		const [model] = firstRunCall(run);
		expect(model).toBe(TRANSLATE_MODEL);
		expect(model).toBe("@cf/deepseek-ai/deepseek-v4-flash-0731");
	});

	it("翻訳向けパラメータ (reasoning_effort none / temperature 0 / max_completion_tokens 2048) を渡す", async () => {
		const { run } = await translateWith({
			choices: [{ message: { content: "bonjour" } }],
		});
		const [, params] = firstRunCall(run);
		expect(params.reasoning_effort).toBe("none");
		expect(params.temperature).toBe(0);
		expect(params.max_completion_tokens).toBe(2048);
		expect(params.messages).toHaveLength(2);
	});

	it("system に固定プロンプト、user にターゲット言語の英語名と原文を含める", async () => {
		const { run } = await translateWith(
			{ choices: [{ message: { content: "bonjour" } }] },
			"Hello, world!",
			"ja",
		);
		const [, params] = firstRunCall(run);
		const [system, user] = params.messages;
		expect(system.role).toBe("system");
		expect(system.content).toContain("translation engine");
		expect(system.content).toContain("Output ONLY the translation");
		expect(user.role).toBe("user");
		expect(user.content).toContain("Japanese");
		expect(user.content).toContain("Hello, world!");
	});

	it("choices 形式の応答は前後空白を trim して返す", async () => {
		const { result } = await translateWith({
			choices: [{ message: { content: "  bonjour  " } }],
		});
		expect(result).toBe("bonjour");
	});

	it("response 形式の応答も trim して返す", async () => {
		const { result } = await translateWith({ response: " hola " });
		expect(result).toBe("hola");
	});

	it("LANGUAGE_NAMES に無い言語コードはそのままプロンプトに入る", async () => {
		const { run } = await translateWith({ response: "x" }, "Hi", "xx");
		const [, params] = firstRunCall(run);
		expect(params.messages[1]?.content).toContain("xx");
	});

	it.each([
		{ choices: [{ message: { content: "" } }] },
		{ choices: [{ message: { content: "   " } }] },
		{ choices: [] },
		{ response: "" },
		{ response: "   " },
		{},
		undefined,
	])("空応答・想定外の形式 (%#) は例外になる", async (response) => {
		const { env } = createAIWith(response);
		await expect(translateText(env, "Hello", "ja")).rejects.toThrow();
	});
});
