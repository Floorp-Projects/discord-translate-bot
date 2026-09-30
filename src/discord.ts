import type { FollowupMessage } from "./types";

const DISCORD_API_BASE = "https://discord.com/api/v10";

/**
 * interaction token を使って followup メッセージを送信する。
 * トークン自体が認証なので Authorization ヘッダは不要。
 * (Bot Token は Worker に置かない設計 — docs/plan.md §6.1)
 */
export async function sendFollowup(
	appId: string,
	interactionToken: string,
	payload: FollowupMessage,
): Promise<Response> {
	return fetch(`${DISCORD_API_BASE}/webhooks/${appId}/${interactionToken}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});
}
