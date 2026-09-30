import { describe, expect, it } from "vitest";
import {
	getGuildConfig,
	getUserLang,
	setGuildConfig,
	setUserLang,
} from "../src/store";
import { createEnv, MockKV } from "./test-utils";

describe("getUserLang", () => {
	const USER_ID = "user-1";

	function envWithRawValue(raw: string | null): ReturnType<typeof createEnv> {
		const kv = new MockKV();
		if (raw !== null) {
			kv.store.set(`user:${USER_ID}`, raw);
		}
		return createEnv({ kv });
	}

	it("未設定のキーは null を返す", async () => {
		await expect(
			getUserLang(envWithRawValue(null), USER_ID),
		).resolves.toBeNull();
	});

	it('正しい形式 ({"lang":"ja"}) は言語コードを返す', async () => {
		const env = envWithRawValue(JSON.stringify({ lang: "ja" }));
		await expect(getUserLang(env, USER_ID)).resolves.toBe("ja");
	});

	it("setUserLang で保存した値は getUserLang で読み戻せる", async () => {
		const kv = new MockKV();
		const env = createEnv({ kv });
		await setUserLang(env, USER_ID, "fr");
		expect(kv.store.get(`user:${USER_ID}`)).toBe(
			JSON.stringify({ lang: "fr" }),
		);
		await expect(getUserLang(env, USER_ID)).resolves.toBe("fr");
	});

	it.each([
		["壊れた JSON", "{not-json"],
		["空オブジェクト (lang なし)", "{}"],
		["数値の lang", JSON.stringify({ lang: 123 })],
		["空文字の lang", JSON.stringify({ lang: "" })],
		["null の lang", JSON.stringify({ lang: null })],
		["配列ルート", JSON.stringify(["ja"])],
		["JSON null リテラル", "null"],
		["文字列リテラル", '"ja"'],
	])(
		"壊れた値・型不一致の値 (%s) は null (未設定扱い)",
		async (_label, raw) => {
			await expect(
				getUserLang(envWithRawValue(raw), USER_ID),
			).resolves.toBeNull();
		},
	);
});

describe("getGuildConfig", () => {
	const GUILD_ID = "guild-1";

	function envWithRawValue(raw: string | null): ReturnType<typeof createEnv> {
		const kv = new MockKV();
		if (raw !== null) {
			kv.store.set(`guild:${GUILD_ID}`, raw);
		}
		return createEnv({ kv });
	}

	it("未設定のキーは null を返す (全員許可扱い)", async () => {
		await expect(
			getGuildConfig(envWithRawValue(null), GUILD_ID),
		).resolves.toBeNull();
	});

	it("正しい形式は allowedRoleIds を返す", async () => {
		const env = envWithRawValue(
			JSON.stringify({ allowedRoleIds: ["r1", "r2"] }),
		);
		await expect(getGuildConfig(env, GUILD_ID)).resolves.toEqual({
			allowedRoleIds: ["r1", "r2"],
		});
	});

	it("setGuildConfig で保存した値は getGuildConfig で読み戻せる", async () => {
		const kv = new MockKV();
		const env = createEnv({ kv });
		await setGuildConfig(env, GUILD_ID, ["role-a"]);
		expect(kv.store.get(`guild:${GUILD_ID}`)).toBe(
			JSON.stringify({ allowedRoleIds: ["role-a"] }),
		);
		await expect(getGuildConfig(env, GUILD_ID)).resolves.toEqual({
			allowedRoleIds: ["role-a"],
		});
	});

	it.each([
		["壊れた JSON", "{not-json"],
		["allowedRoleIds が文字列", JSON.stringify({ allowedRoleIds: "x" })],
		["allowedRoleIds が数値", JSON.stringify({ allowedRoleIds: 123 })],
		["空オブジェクト (キーなし)", "{}"],
		["配列ルート", "[]"],
		["JSON null リテラル", "null"],
	])(
		"壊れた値・型不一致の値 (%s) は null (全員許可扱い)",
		async (_label, raw) => {
			await expect(
				getGuildConfig(envWithRawValue(raw), GUILD_ID),
			).resolves.toBeNull();
		},
	);

	it("配列に非文字列が混在していても文字列のみ採用する", async () => {
		const env = envWithRawValue(
			JSON.stringify({ allowedRoleIds: ["r1", 42, null, "r2", {}] }),
		);
		await expect(getGuildConfig(env, GUILD_ID)).resolves.toEqual({
			allowedRoleIds: ["r1", "r2"],
		});
	});

	it("空配列は null ではなく空配列の設定として返す (全員許可)", async () => {
		const env = envWithRawValue(JSON.stringify({ allowedRoleIds: [] }));
		await expect(getGuildConfig(env, GUILD_ID)).resolves.toEqual({
			allowedRoleIds: [],
		});
	});
});
