# discord-translate-bot

Discord でメッセージを右クリック →「アプリ」→ **Translate** を選ぶと、そのメッセージが自分に設定した母国語へ翻訳されて表示される Bot です。

- **完全サーバーレス**: Cloudflare Workers 1 本 + KV + Workers AI で完結 (常時起動プロセスなし)
- **CPU 時間最小化の設計**: 受信したら即 defer 応答し、翻訳などの重い処理はすべて `ctx.waitUntil()` で実行
- **署名検証は WebCrypto (Ed25519) ネイティブ実装** — JS 暗号ライブラリ不使用

## 機能

| コマンド | 種別 | 内容 |
| --- | --- | --- |
| `Translate` | Message Context Menu (メッセージ右クリック → アプリ) | メッセージを自分の言語へ翻訳。結果は ephemeral (実行者にのみ表示) |
| `/set-language` | Slash | 自分の翻訳先言語を設定 (25 言語から選択) |
| `/translate-config` | Slash (**管理者のみ**、`default_member_permissions: "8"`) | Bot の使用を許可するロールを設定 |

- 翻訳結果は ephemeral (flags 64) なのでチャンネルを汚しません
- **ギルド設定が未設定の間は全員が Translate を使用できます**。`/translate-config` でロールを 1 つでも設定すると、そのロール保持者のみに制限されます
- 言語未設定のまま Translate を実行すると、`/set-language` を促す ephemeral エラーが返ります

### `/translate-config` の仕様 (単一ロール置き換え)

Discord の slash コマンドオプションはロールの複数選択に対応していないため、`roles` オプション (type 9: ROLE) は **「許可ロールをこの 1 つに置き換える」** セマンティクスで動作します。実行するたびに既存の設定が上書きされます (複数ロールの許可や設定の解除には対応していません)。

## 翻訳モデルについて

Workers AI の [`@cf/deepseek-ai/deepseek-v4-flash-0731`](https://developers.cloudflare.com/workers-ai/models/) を使用しています (`src/translate.ts` の `TRANSLATE_MODEL` 定数)。`reasoning_effort: "none"` を明示して翻訳に不要な推論トークンを排除しています。

> [!WARNING]
> **このモデルは Workers Free プランでは利用できません。Workers Paid プランが必要です。**
>
> モデルの差し替えは `src/translate.ts` の `TRANSLATE_MODEL` 定数を書き換えるだけで可能です。

## セットアップ

### 1. Discord Application の作成

1. [Discord Developer Portal](https://discord.com/developers/applications) で **New Application** を作成
2. **General Information** ページの **APPLICATION ID** を控える (後で `DISCORD_APP_ID` として使用)
3. **Bot** ページの **PUBLIC KEY** を控える (後で `DISCORD_TRANSLATE_BOT_PUBLIC_KEY` として使用)

### 2. Bot の招待

**OAuth2 → URL Generator** で `bot` と `applications.commands` のスコープを付けて URL を生成し、サーバーへ招待します。翻訳結果は interaction token 経由で送信されるため、Bot が常時 online である必要はありません (特権 Intent も不要です)。

### 特定のサーバーだけで動かす (推奨: Public Bot を OFF)

[Discord Developer Portal](https://discord.com/developers/applications) で対象アプリを開き、**Bot** タブの **Public Bot** を OFF にして保存します。

- OFF にすると **オーナー (あなた) 以外は Bot をサーバーに招待できなくなり**、自分が招待したサーバーだけで動作します
- コード・設定の変更は不要です。個人利用ではこの設定を推奨します
- 注記: `/translate-config` のロール制限は「サーバー内のどのユーザーが使えるか」の制御であり、「どのサーバーで動くか」の制御ではありません (サーバー選別は Public Bot OFF で行います)

### 3. Cloudflare Worker の準備

```bash
# KV namespace を作成し、表示された id を wrangler.jsonc の kv_namespaces[0].id に置き換える
npx wrangler kv namespace create translate-kv

# 署名検証用の公開鍵を secret として登録
npx wrangler secret put DISCORD_TRANSLATE_BOT_PUBLIC_KEY
```

`wrangler.jsonc` の `vars.DISCORD_APP_ID` に手順 1 で控えた Application ID を設定します。

### 4. コマンド登録とデプロイ

```bash
# グローバルコマンドを登録 (反映まで数分かかることがある)
DISCORD_APP_ID=<Application ID> DISCORD_BOT_TOKEN=<Bot Token> npm run register

# デプロイ
npm run deploy
```

`DISCORD_BOT_TOKEN` は **Developer Portal の Bot ページで Reset Token して取得**します。トークンは Worker には配置せず、この登録スクリプト (または CI) でしか使いません。

main push すると CI がデプロイ後にコマンド登録まで自動実行するため、ローカルでの `npm run register` は初回セットアップ時や CI を使わない場合のみで十分です。

### 5. Interactions Endpoint URL の設定

Developer Portal の **General Information → Interactions Endpoint URL** に次の URL を設定します。保存時に Discord から PING が送られ、検証が通れば完了です。

```
https://<worker-name>.<account>.workers.dev/api/interactions
```

## ローカル開発

```bash
cp .dev.vars.example .dev.vars   # DISCORD_TRANSLATE_BOT_PUBLIC_KEY / DISCORD_APP_ID を記入
npm run dev                      # wrangler dev (http://localhost:8787/api/interactions)
```

KV・Workers AI は Miniflare がローカルで再現します。実機の Discord と繋げる場合は ngrok などでトンネルし、Interactions Endpoint URL に設定してください。

| コマンド | 内容 |
| --- | --- |
| `npm run dev` | ローカル開発サーバー起動 |
| `npm run register` | Discord へグローバルコマンド登録 |
| `npm run deploy` | Cloudflare Workers へデプロイ |
| `npm test` | Vitest (`@cloudflare/vitest-plugin`) |
| `npm run lint` | Biome チェック |
| `npm run check` | tsc 型チェック (src / scripts の両設定) |
| `npm run format` | Biome フォーマット適用 |

## CI / デプロイ

`.github/workflows/ci.yml` が以下を自動実行します。

- **PR**: `npm ci` → lint → 型チェック → テスト
- **main への push**: 上記に加えて `cloudflare/wrangler-action@v3` で自動デプロイし、続けて `npm run register` で Discord コマンドを自動登録

Repository secrets として次の 2 つを設定してください。

| Secret | 説明 |
| --- | --- |
| `CLOUDFLARE_WORKER_EDIT_API_TOKEN` | Workers デプロイ権限を持つ Cloudflare API トークン |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare アカウント ID |
| `DISCORD_BOT_TOKEN` | Bot トークン — コマンド登録用。Developer Portal の Bot ページで Reset Token して取得 |
| `DISCORD_APP_ID` | Application ID |

コマンド定義だけを再登録したい場合は、Actions の該当 run の **Re-run all jobs** で再実行できます (workflow_dispatch にも対応しています)。

## アーキテクチャ

設計の詳細は [docs/plan.md](docs/plan.md) を参照してください。

```
Discord Client (右クリック → アプリ)
        │ Interaction (HTTPS POST, Ed25519 署名)
        ▼
Cloudflare Worker (src/index.ts)
  1. WebCrypto Ed25519 署名検証 (src/verify.ts)
  2. 権限チェック・文字数チェック → NG なら ephemeral エラー即応 (defer しない最速パス)
  3. OK → type 5 (ephemeral defer) を即返し、重い処理は ctx.waitUntil() へ
        ├─ KV: ギルド許可ロール / ユーザー言語 (src/store.ts)
        ├─ Workers AI: 翻訳 (src/translate.ts)
        └─ Discord REST: followup webhook で ephemeral 結果送信 (src/discord.ts)
```

- KV: `user:{userId}` = `{"lang":"ja"}` (翻訳先言語) / `guild:{guildId}` = `{"allowedRoleIds":["123"]}` (許可ロール)
- followup は interaction token を使うため **Worker に Bot Token は不要**
