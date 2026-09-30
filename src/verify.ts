const SIGNATURE_HEADER = "X-Signature-Ed25519";
const TIMESTAMP_HEADER = "X-Signature-Timestamp";

/** Ed25519 署名は 64 バイト (= hex 128 文字) */
const SIGNATURE_BYTE_LENGTH = 64;

/** タイムスタンプの許容ずれ (秒)。リプレイ攻撃の窓を ±5 分に狭める (公式ドキュメント推奨値) */
const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

/**
 * ヘッダのタイムスタンプが現在時刻の ±5 分以内かを判定する。
 * 過去に傍受した正当リクエストの再送 (リプレイ) を拒否するためのチェック。
 * 数値としてパースできない / 無限大の場合も false。
 */
function isTimestampFresh(timestamp: string): boolean {
	const seconds = Number(timestamp);
	if (!Number.isFinite(seconds)) {
		return false;
	}
	return Math.abs(Date.now() / 1000 - seconds) <= TIMESTAMP_TOLERANCE_SECONDS;
}

function hexToBytes(hex: string): Uint8Array | null {
	if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
		return null;
	}
	const pairs = hex.match(/../g);
	if (pairs === null) {
		return null;
	}
	return Uint8Array.from(pairs, (pair) => Number.parseInt(pair, 16));
}

/**
 * Discord Interactions の Ed25519 署名を WebCrypto (Secure Curves) で検証する。
 * JS 実装ライブラリ (tweetnacl 等) は使わずネイティブ実装で CPU 時間を最小化する
 * (docs/plan.md §3)。
 *
 * ヘッダ欠落・不正形式・検証失敗はすべて false を返す (例外を投げさせない)。
 */
export async function verifyDiscordSignature(
	request: Request,
	body: string,
	publicKeyHex: string,
): Promise<boolean> {
	try {
		const signatureHex = request.headers.get(SIGNATURE_HEADER);
		const timestamp = request.headers.get(TIMESTAMP_HEADER);
		if (
			signatureHex === null ||
			timestamp === null ||
			publicKeyHex.length === 0
		) {
			return false;
		}

		// 古い (遠い未来の) timestamp は署名が正しくても拒否する (リプレイ対策)。
		// 検証コストの高い importKey / verify の前に弾く
		if (!isTimestampFresh(timestamp)) {
			return false;
		}

		const signature = hexToBytes(signatureHex);
		if (signature === null || signature.length !== SIGNATURE_BYTE_LENGTH) {
			return false;
		}

		const publicKey = hexToBytes(publicKeyHex);
		if (publicKey === null) {
			return false;
		}

		const key = await crypto.subtle.importKey(
			"raw",
			publicKey,
			"Ed25519",
			false,
			["verify"],
		);
		const message = new TextEncoder().encode(timestamp + body);
		return await crypto.subtle.verify("Ed25519", key, signature, message);
	} catch {
		// 不正な鍵長など importKey / verify が例外になる場合もすべて不正署名扱い
		return false;
	}
}
