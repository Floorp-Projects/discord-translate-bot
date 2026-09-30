import type {
	ChannelWebhook,
	FollowupMessage,
	WebhookExecuteMessage,
} from "./types";

const DISCORD_API_BASE = "https://discord.com/api/v10";

/**
 * interaction token を使って followup メッセージを送信する。
 * トークン自体が認証なので Authorization ヘッダは不要。
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

/**
 * defer 済み interaction の応答メッセージ (@original) を編集する
 * (PATCH /webhooks/{app_id}/{token}/messages/@original)。
 * interaction token 自体が認証なので Authorization ヘッダは不要。
 * 編集で変更できる flags は SUPPRESSED_EMBEDS のみのため、ephemeral の
 * 確認メッセージ更新では flags を含めない
 * (docs/translate-send-command.md §6)。
 */
export async function editOriginalInteractionResponse(
	appId: string,
	interactionToken: string,
	payload: FollowupMessage,
): Promise<Response> {
	return fetch(
		`${DISCORD_API_BASE}/webhooks/${appId}/${interactionToken}/messages/@original`,
		{
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		},
	);
}

/**
 * webhook を実行する (POST /webhooks/{id}/{token}?wait=true)。
 * URL 内の webhook token 自体が認証なので Authorization ヘッダは不要。
 * wait=true により 200 + 作成されたメッセージ本体が返る (成否確認用)。
 */
export async function executeWebhook(
	webhook: ChannelWebhook,
	payload: WebhookExecuteMessage,
): Promise<Response> {
	return fetch(
		`${DISCORD_API_BASE}/webhooks/${webhook.id}/${webhook.token}?wait=true`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		},
	);
}

// ---------------------------------------------------------------------------
// 以下は Bot Token (DISCORD_BOT_TOKEN secret) を使う関数。
// 使用箇所は webhook 作成 / 一覧取得のみに限定する
// (docs/translate-send-command.md §4.2, §7)。
// ---------------------------------------------------------------------------

/**
 * チャンネルに webhook を作成する (Manage Webhooks 権限が必要)。
 * 権限が無い場合は 403 が返る → 呼び出し側でフォールバックする。
 */
export async function createChannelWebhook(
	botToken: string,
	channelId: string,
	name: string,
): Promise<Response> {
	return fetch(`${DISCORD_API_BASE}/channels/${channelId}/webhooks`, {
		method: "POST",
		headers: {
			Authorization: `Bot ${botToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ name }),
	});
}

/**
 * チャンネルの webhook 一覧を取得する。
 * KV キャッシュ欠落時に自前の webhook を再利用 (重複作成の回避) するために使う。
 */
export async function listChannelWebhooks(
	botToken: string,
	channelId: string,
): Promise<Response> {
	return fetch(`${DISCORD_API_BASE}/channels/${channelId}/webhooks`, {
		headers: { Authorization: `Bot ${botToken}` },
	});
}
