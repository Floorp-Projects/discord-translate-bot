import { vi } from "vitest";
import type { Env } from "../src/types";

/** 16 進エンコード用の文字テーブル */
const HEX = "0123456789abcdef";

export function toHex(bytes: Uint8Array): string {
	let hex = "";
	for (const byte of bytes) {
		hex += HEX[(byte >> 4) & 0xf] + HEX[byte & 0xf];
	}
	return hex;
}

/** テスト用 Ed25519 鍵ペア (公開鍵は生バイト 32 個分の hex — verify.ts の importKey("raw") と同じ形式) */
export interface Ed25519TestKeys {
	privateKey: CryptoKey;
	publicKey: CryptoKey;
	publicKeyHex: string;
}

interface GeneratedKeyPair {
	privateKey: CryptoKey;
	publicKey: CryptoKey;
}

/** workerd の WebCrypto (Secure Curves) で Ed25519 鍵ペアを生成する */
export async function generateEd25519KeyPair(): Promise<Ed25519TestKeys> {
	const keyPair = (await crypto.subtle.generateKey("Ed25519", true, [
		"sign",
		"verify",
	])) as unknown as GeneratedKeyPair;
	const raw = (await crypto.subtle.exportKey(
		"raw",
		keyPair.publicKey,
	)) as ArrayBuffer;
	return {
		privateKey: keyPair.privateKey,
		publicKey: keyPair.publicKey,
		publicKeyHex: toHex(new Uint8Array(raw)),
	};
}

/** message (timestamp + body) を秘密鍵で署名し hex 文字列で返す */
export async function signHex(
	privateKey: CryptoKey,
	message: string,
): Promise<string> {
	const signature = await crypto.subtle.sign(
		"Ed25519",
		privateKey,
		new TextEncoder().encode(message),
	);
	return toHex(new Uint8Array(signature));
}

/** Interactions Endpoint 向けの Request を組む (ヘッダは呼び出し側で上書き可) */
export function buildInteractionRequest(
	body: string,
	headers: Record<string, string> = {},
): Request {
	return new Request("https://bot.example.com/api/interactions", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body,
	});
}

/** 現在時刻に近い Unix 秒の文字列 (verify.ts の ±5 分新鮮性チェックを通る値) */
export function freshTimestamp(): string {
	return String(Math.floor(Date.now() / 1000));
}

/** interaction を JSON 化して Ed25519 署名付き Request にする */
export async function buildSignedInteractionRequest(
	privateKey: CryptoKey,
	interaction: unknown,
	timestamp = freshTimestamp(),
): Promise<Request> {
	const body = JSON.stringify(interaction);
	const signature = await signHex(privateKey, timestamp + body);
	return buildInteractionRequest(body, {
		"X-Signature-Ed25519": signature,
		"X-Signature-Timestamp": timestamp,
	});
}

/** MockKV.put に渡された options の記録用 */
export interface MockKVPutOptions {
	expirationTtl?: number;
}

/** store.ts が使う get / put だけを持つインメモリ KV モック */
export class MockKV {
	readonly store = new Map<string, string>();
	/** キーごとに最後の put 呼び出しで渡された options (expirationTtl 検証用) */
	readonly putOptions = new Map<string, MockKVPutOptions | undefined>();

	async get(key: string): Promise<string | null> {
		return this.store.get(key) ?? null;
	}

	async put(
		key: string,
		value: string,
		options?: MockKVPutOptions,
	): Promise<void> {
		this.putOptions.set(key, options);
		this.store.set(key, value);
	}
}

/** waitUntil を記録する ExecutionContext モック */
export interface MockExecutionContext {
	ctx: ExecutionContext;
	waitUntilPromises: Promise<unknown>[];
	/** waitUntil された後続処理 (handleTranslate 等) の完了を待つ */
	drain(): Promise<void>;
}

export function createMockCtx(): MockExecutionContext {
	const waitUntilPromises: Promise<unknown>[] = [];
	const ctx = {
		waitUntil: (promise: Promise<unknown>) => {
			waitUntilPromises.push(promise);
		},
		passThroughOnException: () => {},
	} as unknown as ExecutionContext;
	return {
		ctx,
		waitUntilPromises,
		drain: () => Promise.allSettled(waitUntilPromises).then(() => {}),
	};
}

export interface MockEnvOptions {
	kv?: MockKV;
	aiRun?: ReturnType<typeof vi.fn>;
	publicKeyHex?: string;
	appId?: string;
}

/** テスト用 Env (モック KV + モック AI + 固定文字列の Discord 設定) */
export function createEnv(options: MockEnvOptions = {}): Env {
	return {
		AI: { run: options.aiRun ?? vi.fn() },
		KV: (options.kv ?? new MockKV()) as unknown as KVNamespace,
		DISCORD_TRANSLATE_BOT_PUBLIC_KEY: options.publicKeyHex ?? "",
		DISCORD_APP_ID: options.appId ?? "app123",
	} as unknown as Env;
}
