import { COMMANDS } from "../src/commands";

/**
 * Discord へグローバルコマンドを登録するスクリプト (ローカル or CI 実行)。
 *
 *   DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... npm run register
 *
 * PUT なので既存のグローバルコマンドはこの定義一式で上書きされる。
 * Bot Token は Worker コードには置かず、このスクリプトでのみ使う
 * (docs/plan.md §7)。
 */
async function main(): Promise<void> {
	const appId = process.env.DISCORD_APP_ID;
	const botToken = process.env.DISCORD_BOT_TOKEN;

	if (
		appId === undefined ||
		appId === "" ||
		botToken === undefined ||
		botToken === ""
	) {
		console.error(
			"Environment variables DISCORD_APP_ID and DISCORD_BOT_TOKEN are required.",
		);
		process.exitCode = 1;
		return;
	}

	const endpoint = `https://discord.com/api/v10/applications/${appId}/commands`;
	const response = await fetch(endpoint, {
		method: "PUT",
		headers: {
			Authorization: `Bot ${botToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(COMMANDS),
	});

	if (!response.ok) {
		console.error(
			`Command registration failed: ${response.status}\n${await response.text()}`,
		);
		process.exitCode = 1;
		return;
	}

	const registered = (await response.json()) as Array<{
		id: string;
		name: string;
	}>;
	console.log(
		`Registered ${registered.length} command(s): ${registered.map((c) => c.name).join(", ")}`,
	);
}

main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
