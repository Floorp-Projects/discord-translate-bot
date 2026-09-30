import { beforeAll, describe, expect, it } from "vitest";
import { verifyDiscordSignature } from "../src/verify";
import {
	buildInteractionRequest,
	type Ed25519TestKeys,
	generateEd25519KeyPair,
	signHex,
	toHex,
} from "./test-utils";

const BODY = JSON.stringify({ type: 1 });

/**
 * 現在時刻の Unix 秒。verify.ts は timestamp の ±5 分新鮮性を要求するため
 * 固定値は使えない (署名が正しくても古い timestamp は拒否される)。
 */
const freshTimestamp = (): string => String(Math.floor(Date.now() / 1000));

describe("verifyDiscordSignature", () => {
	let keys: Ed25519TestKeys;

	beforeAll(async () => {
		keys = await generateEd25519KeyPair();
	});

	/** 正しい鍵で timestamp + body に署名したヘッダ付き Request を組む */
	async function buildValidRequest(
		body = BODY,
		timestamp = freshTimestamp(),
	): Promise<Request> {
		const signature = await signHex(keys.privateKey, timestamp + body);
		return buildInteractionRequest(body, {
			"X-Signature-Ed25519": signature,
			"X-Signature-Timestamp": timestamp,
		});
	}

	/** 任意の署名 hex / timestamp / body で Request を組む */
	function buildRequestWithSignature(
		signatureHex: string,
		timestamp = freshTimestamp(),
		body = BODY,
	): Request {
		return buildInteractionRequest(body, {
			"X-Signature-Ed25519": signatureHex,
			"X-Signature-Timestamp": timestamp,
		});
	}

	it("正しい署名 (timestamp + body を秘密鍵で署名) は true を返す", async () => {
		const request = await buildValidRequest();
		await expect(
			verifyDiscordSignature(request, BODY, keys.publicKeyHex),
		).resolves.toBe(true);
	});

	it("ランダムバイトの署名は false を返す", async () => {
		const random = new Uint8Array(64);
		crypto.getRandomValues(random);
		const request = buildRequestWithSignature(toHex(random));
		await expect(
			verifyDiscordSignature(request, BODY, keys.publicKeyHex),
		).resolves.toBe(false);
	});

	it("タイムスタンプ改変 (署名が別 timestamp に対するもの) は false を返す", async () => {
		// 署名は "9999999999" + body に対して作り、ヘッダの timestamp だけ新鮮な値にする
		// (ヘッダの timestamp は新鮮性チェックを通るので、署名不一致で false になる)
		const signature = await signHex(keys.privateKey, `9999999999${BODY}`);
		const request = buildRequestWithSignature(signature);
		await expect(
			verifyDiscordSignature(request, BODY, keys.publicKeyHex),
		).resolves.toBe(false);
	});

	it("本文改変 (署名が別 body に対するもの) は false を返す", async () => {
		const request = await buildValidRequest();
		const tamperedBody = JSON.stringify({ type: 1, tampered: true });
		await expect(
			verifyDiscordSignature(request, tamperedBody, keys.publicKeyHex),
		).resolves.toBe(false);
	});

	it("X-Signature-Ed25519 ヘッダ欠落は例外ではなく false を返す", async () => {
		const signature = await signHex(keys.privateKey, freshTimestamp() + BODY);
		const request = buildInteractionRequest(BODY, {
			"X-Signature-Timestamp": freshTimestamp(),
		});
		await expect(
			verifyDiscordSignature(request, BODY, keys.publicKeyHex),
		).resolves.toBe(false);
		// 未使用変数を避けるため署名が正しい形式であることだけ確認しておく
		expect(signature).toHaveLength(128);
	});

	it("X-Signature-Timestamp ヘッダ欠落は例外ではなく false を返す", async () => {
		const signature = await signHex(keys.privateKey, freshTimestamp() + BODY);
		const request = buildInteractionRequest(BODY, {
			"X-Signature-Ed25519": signature,
		});
		await expect(
			verifyDiscordSignature(request, BODY, keys.publicKeyHex),
		).resolves.toBe(false);
	});

	it("署名 hex が奇数長は false を返す", async () => {
		const signature = await signHex(keys.privateKey, freshTimestamp() + BODY);
		const request = buildRequestWithSignature(signature.slice(0, 127));
		await expect(
			verifyDiscordSignature(request, BODY, keys.publicKeyHex),
		).resolves.toBe(false);
	});

	it("署名 hex に非 16 進文字が含まれる場合は false を返す", async () => {
		const signature = await signHex(keys.privateKey, freshTimestamp() + BODY);
		const request = buildRequestWithSignature(`zz${signature.slice(2)}`);
		await expect(
			verifyDiscordSignature(request, BODY, keys.publicKeyHex),
		).resolves.toBe(false);
	});

	it("署名が 64 バイト (hex 128 文字) 以外は false を返す", async () => {
		const signature = await signHex(keys.privateKey, freshTimestamp() + BODY);
		// 62 バイト分 (偶数長だが短い)
		const tooShort = buildRequestWithSignature(signature.slice(0, 124));
		await expect(
			verifyDiscordSignature(tooShort, BODY, keys.publicKeyHex),
		).resolves.toBe(false);
		// 66 バイト分 (偶数長だが長い)
		const tooLong = buildRequestWithSignature(`${signature}cafe`);
		await expect(
			verifyDiscordSignature(tooLong, BODY, keys.publicKeyHex),
		).resolves.toBe(false);
	});

	it("空の署名ヘッダは false を返す", async () => {
		const request = buildRequestWithSignature("");
		await expect(
			verifyDiscordSignature(request, BODY, keys.publicKeyHex),
		).resolves.toBe(false);
	});

	it("公開鍵が空文字は false を返す", async () => {
		const request = await buildValidRequest();
		await expect(verifyDiscordSignature(request, BODY, "")).resolves.toBe(
			false,
		);
	});

	it("公開鍵が不正な hex でも例外ではなく false を返す", async () => {
		const request = await buildValidRequest();
		await expect(
			verifyDiscordSignature(request, BODY, "not-a-hex-key"),
		).resolves.toBe(false);
	});

	it("公開鍵の鍵長が不正 (32 バイト以外) でも例外ではなく false を返す", async () => {
		const request = await buildValidRequest();
		// 31 バイト分の hex → importKey が例外を投げるが false に丸められる
		const wrongLengthKey = "ab".repeat(31);
		await expect(
			verifyDiscordSignature(request, BODY, wrongLengthKey),
		).resolves.toBe(false);
	});

	it("古いが許容内 (4 分 59 秒前) のタイムスタンプは許可される", async () => {
		const timestamp = String(Math.floor(Date.now() / 1000) - 299);
		const request = await buildValidRequest(BODY, timestamp);
		await expect(
			verifyDiscordSignature(request, BODY, keys.publicKeyHex),
		).resolves.toBe(true);
	});

	it("6 分前のタイムスタンプは正しい署名でも false を返す (リプレイ対策)", async () => {
		const timestamp = String(Math.floor(Date.now() / 1000) - 361);
		const request = await buildValidRequest(BODY, timestamp);
		await expect(
			verifyDiscordSignature(request, BODY, keys.publicKeyHex),
		).resolves.toBe(false);
	});

	it("6 分後の未来タイムスタンプも正しい署名でも false を返す", async () => {
		const timestamp = String(Math.floor(Date.now() / 1000) + 361);
		const request = await buildValidRequest(BODY, timestamp);
		await expect(
			verifyDiscordSignature(request, BODY, keys.publicKeyHex),
		).resolves.toBe(false);
	});

	it("非数値のタイムスタンプは false を返す (例外にならない)", async () => {
		const request = await buildValidRequest(BODY, "not-a-number");
		await expect(
			verifyDiscordSignature(request, BODY, keys.publicKeyHex),
		).resolves.toBe(false);
	});
});
