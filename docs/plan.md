# Discord 翻訳 Bot 開発プラン

## 1. 概要

Discord でメッセージを右クリック →「アプリ」→ 翻訳コマンドを選ぶと、そのメッセージが
事前に設定した自分の母国語に翻訳されて表示される Bot。

- 使用できるユーザーをギルド管理者がロールで制限できる
- Tech Stack: **TypeScript + Cloudflare Workers**
- 制約: **Worker の CPU 時間を最小化**する設計 / インフラは **Cloudflare だけで完結**

## 2. 全体アーキテクチャ

インフラは Cloudflare のサービスのみ (Worker 1 本 + KV + Workers AI)。サーバレスで
常時起動プロセスなし。

```
Discord Client (右クリック → アプリ)
        │ Interaction (HTTPS POST)
        ▼
┌─────────────────────────────── Cloudflare ───────────────────────────┐
│  Worker (単一 fetch handler)                                         │
│   1. Ed25519 署名検証 (WebCrypto, ネイティブ)                          │
│   2. 即座に DEFERRED (type 5) を返答  ← 3 秒制約 & CPU 時間の削減      │
│   3. ctx.waitUntil() で後続処理                                       │
│        ├─ KV: ロール権限チェック用ギルド設定 / ユーザー言語の取得        │
│        ├─ Workers AI: 翻訳 (GPU 側で実行され Worker CPU に載らない)     │
│        └─ Discord REST: followup webhook で結果送信                   │
│                                                                      │
│  Bindings:                                                           │
│   - AI  (Workers AI)                                                 │
│   - KV  (設定ストア)                                                  │
│   - Secrets: DISCORD_PUBLIC_KEY, DISCORD_BOT_TOKEN (webhook 作成用)   │
└──────────────────────────────────────────────────────────────────────┘
```

### 翻訳エンジン選定

| 方式 | 長所 | 短所 |
| --- | --- | --- |
| **LLM 翻訳 `@cf/deepseek-ai/deepseek-v4-flash-0731` (採用)** | 元言語の検出が不要 (1 回の呼び出しで完結) / DeepSeek の多言語品質が高い / `reasoning_effort: "none"` を指定でき翻訳に不要な推論トークンを排除 / 安価 ($0.44 per M input, $1.32 per M output, $0.014 per M cached input) | 推論デフォルトが `high` のため `reasoning_effort` の明示指定が必須 |
| LLM 翻訳 `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (代替) | 実績のある定番 / reasoning パラメータが不要でシンプル | 多言語品質で DeepSeek に劣る場面がある |
| LLM 翻訳 `@cf/google/gemma-4-26b-a4b-it` (代替・低コスト候補) | 最安クラス ($0.10 per M input, $0.30 per M output ≒ DeepSeek の約 1/4) / 4B active MoE で推論が高速 / コンテキスト 256K | active 4B と小型のため日本語など低リソース言語の翻訳品質は V4 Flash (13B active) に劣る可能性 / `reasoning_effort` の様な制御パラメータがなく思考トークンを API レベルで抑制できない |
| M2M100 `@cf/meta/m2m100-1.2M` (代替) | 翻訳専用で最安クラス | `source_lang` が必須 → 言語検出が別途必要で 2 回呼びになり逆に割高 |

採用モデルの呼び出し設定 (`translate.ts`):

```ts
const result = await env.AI.run("@cf/deepseek-ai/deepseek-v4-flash-0731", {
  messages: [
    { role: "system", content: SYSTEM_PROMPT },  // 「翻訳のみを出力。原文の体裁を維持」を固定
    { role: "user", content: `Translate the following text into ${lang}:\n${text}` },
  ],
  reasoning_effort: "none",       // 翻訳では推論不要 → レイテンシと出力トークン代を削減
  max_completion_tokens: 4096,    // 長文暴走の上限 (入力自体も 2,000 文字で制限)
  temperature: 0,
});
```

推論は Workers AI の GPU 側で走るため、モデルをどれにしても **Worker の CPU 時間はほぼ増えない**。
`translate.ts` をアダプタにしてモデルは差し替え可能にする。

最終決定は Phase 4 の前に Playground でサンプル文 (日↔英・韓・中など) の翻訳品質を比較して行う。
**品質重視なら DeepSeek V4 Flash、コスト重視なら Gemma 4**。個人利用のボリュームならどちらも月数ドル未満なので、実質は品質で選んでよい。

## 3. CPU 時間最小化の設計指針

1. **即時 defer 応答**: Discord は 3 秒以内の応答必須。受信したら `DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE` (type 5, ephemeral) を即返し、重い処理はすべて `ctx.waitUntil()` に逃がす。待機中の I/O は CPU 時間にカウントされない (wall clock は 30 秒まで許容)。
2. **署名検証は WebCrypto の Ed25519**: `crypto.subtle.verify("Ed25519", ...)` を使用。tweetnacl 等の JS 実装ライブラリを使わない (ネイティブ実装より CPU を消費するため)。
3. **フレームワーク不使用**: Hono 等を導入せず、単一の `fetch` handler + 素の switch 文でルーティング。
4. **KV / Workers AI は binding 経由**: REST API を fetch する代わりにバインディングを使う (ネイティブ実装で CPU 微少)。
5. **JSON パースは 1 回だけ**: interaction payload のみパースし、以降は必要なフィールドだけを渡す。
6. **設定値は KV キャッシュ前提**: 設定変更は低頻度なので読み取りのみで運用 (キャッシュ API 追加は Phase 5 の任意最適化)。

## 4. Discord 側の設計

### コマンド定義

| コマンド | 種別 | 内容 |
| --- | --- | --- |
| `Translate` | Message Context Menu (type 3) | メッセージを自分の母国語に翻訳 |
| `/set-language language:<choice>` | Slash | ユーザー自身の母国語を設定 (ja / en / ko / zh / …最大 25 言語を choices で提供、必要なら後で autocomplete 化) |
| `/translate-config roles:<role...>` | Slash | ギルドで Bot 使用を許可するロールを設定。`default_member_permissions` でサーバー管理者のみ実行可能にする |
| `/translate-send text:<text> language:<choice> include_original:<bool>` | Slash | 入力した文を翻訳しそのチャンネルへ送信。**チャンネル webhook で実行者の名義・アバターで投稿** (作成できない環境では bot 名義でフォールバック)。`text` 省略時は Modal で入力 (最大 4,000 字)、`language` 既定 `en`、`include_original` 既定 `true` |

- コマンド登録は `scripts/register-commands.ts` (global command: `PUT /applications/{app_id}/commands`) を `npm run register` で手動実行。Bot が常時 online である必要はない。
- Interactions Endpoint URL: `https://<worker>.workers.dev/api/interactions` を Discord Developer Portal に設定 (PING 検証を通す)。

### 権限モデル

- インスタンス処理時に `interaction.member.roles` と `guild:{id}.allowedRoleIds` の積集合を判定。
- **ギルド設定が未設定 (= ロール未登録) の場合は全ユーザーに許可** (セットアップ不要で試せる)。1 つでもロールが設定されていたら、そのロール保持者のみ使用可。
- 権限なしユーザーには ephemeral で拒否メッセージを返す (エラーも通常応答として返せるので defer 不要の最速パス)。
- 結果メッセージは **ephemeral (flags = 64)**: 翻訳結果は実行者にのみ見え、チャンネルを汚さない。

## 5. データモデル (KV)

設定は「低頻度書き込み・読み取り専用・単純構造」のため D1 ではなく KV を採用
(binding read は CPU 微少・無料枠で十分・インフラ構成がシンプル)。

| キー | 値 (JSON) | 用途 |
| --- | --- | --- |
| `user:{userId}` | `{"lang":"ja"}` | ユーザーの母国語 |
| `guild:{guildId}` | `{"allowedRoleIds":["123","456"]}` | Bot 使用許可ロール |

- ユーザー言語未設定の場合: ギルド既定言語 (Phase 2 で `guild:{id}.defaultLang` に追加検討) → それも無ければ設定を促す ephemeral エラー。
- 整合性は KV の (稀な) 数秒遅延で足りる。
- (Phase 5, 任意) 翻訳キャッシュ: `cache:{sha256(source + target)}` → 翻訳済み文字列。Neurons 節約。ハッシュは `crypto.subtle.digest("SHA-256")`。

## 6. 処理フロー

### 6.1 Translate (Message Context Menu)

```
POST /api/interactions
  ├─ 署名不正          → 401
  ├─ type 1 (PING)     → type 1 を返す
  └─ type 3 (MESSAGE_CONTEXT, name=Translate)
       ├─ 権限チェック (member.roles × guild 設定)
       │    └─ NG → ephemeral で即拒否応答 (waitUntil 不要)
       ├─ OK → type 5 defer (ephemeral) を返す   ← ここで Worker は実質完了
       └─ ctx.waitUntil(() =>
            1. KV: user:{id} から言語取得
            2. Workers AI: 翻訳実行
            3. POST /webhooks/{app_id}/{interaction_token} で ephemeral followup
            4. 失敗時は同 webhook でエラーメッセージ)
```

- followup は interaction token を使うため Bot Token 不要。ただし `/translate-send` の
  チャンネル webhook 作成 (docs/translate-send-command.md §4.2) には **Bot Token が必要**で、
  `DISCORD_BOT_TOKEN` を Worker secret として配置する。使用は webhook の作成・一覧取得のみに
  限定した secret 限定管理とし、メッセージ送信には使わない。
- interaction token の有効期限は 15 分。wall clock 30 秒制約内に十分収まる。
- 同一 interaction につき followup は 1 回なので Discord のレート制限は実質無関係。

### 6.2 /set-language, /translate-config

即応 (type 4: CHANNEL_MESSAGE_WITH_SOURCE, ephemeral) して KV に書き込むだけ。
翻訳のような重処理がないため defer / waitUntil 不要。

## 7. プロジェクト構成

```
.
├── src/
│   ├── index.ts             # fetch handler: 署名検証 → ルーティング
│   ├── verify.ts            # WebCrypto Ed25519 検証
│   ├── commands.ts          # コマンド定義 JSON (register script と共有)
│   ├── translate.ts         # Workers AI アダプタ (モデル差し替え可能)
│   ├── store.ts             # KV アクセス (get/set)
│   ├── discord.ts           # followup webhook 送信
│   └── handlers/
│       ├── translate.ts     # context menu 処理
│       ├── setLanguage.ts
│       └── config.ts        # ロール設定
├── scripts/
│   └── register-commands.ts # Discord API へコマンド登録 (ローカル or CI 実行)
├── test/
│   ├── verify.test.ts
│   ├── handlers.test.ts
│   └── translate.test.ts
├── wrangler.jsonc
├── vitest.config.ts
├── package.json
└── tsconfig.json
```

### Bindings (Env)

```ts
interface Env {
  AI: Ai;                      // Workers AI
  KV: KVNamespace;             // 設定ストア
  DISCORD_PUBLIC_KEY: string;  // secret: 署名検証用
  DISCORD_APP_ID: string;      // var: followup webhook 用
  DISCORD_BOT_TOKEN?: string;  // secret: チャンネル webhook 作成・一覧取得用 (/translate-send)。未設定なら bot 名義フォールバック
}
```

`DISCORD_BOT_TOKEN` は Worker secret (`wrangler secret put`) として配置する。
ただし使用目的を限定する: チャンネル webhook の作成・一覧取得 (`/translate-send`) のみで、
メッセージ送信 (followup / webhook 実行) には使わない — それらは interaction token と
URL 内の webhook token が認証を担うため。コマンド登録スクリプトは従来どおり
環境変数 or CI secret で同じトークンを使う。

## 8. 実装ステップ

| Phase | 内容 | 完了条件 |
| --- | --- | --- |
| 0 | セットアップ: wrangler / TypeScript / Vitest (`@cloudflare/vitest-pool-workers`) / Biome | `wrangler dev` が起動する |
| 1 | 署名検証 + PING 応答 | Developer Portal の Interactions Endpoint 検証が通る |
| 2 | コマンド登録スクリプト + Translate 受信 → defer → ダミー followup | 右クリック → アプリで「処理中…」が表示される |
| 3 | `/set-language` `/translate-config` + KV 実装 | 設定が保存・読み出せる。権限チェックも動く |
| 4 | Workers AI 翻訳統合 + followup 表示 | 右クリックで翻訳結果が ephemeral 表示される |
| 5 | エラーハンドリング強化 / テスト整備 / (任意) 翻訳キャッシュ・ギルド既定言語 | テストグリーン、異常系でユーザーにエラーが見える |
| 6 | デプロイ: secrets 設定、GitHub Actions (test → `wrangler deploy` on main) | main push で自動デプロイされる |

## 9. テスト戦略

- **実行環境**: Vitest + `@cloudflare/vitest-pool-workers` (Miniflare 上で AI / KV binding をモック・再現)。
- **署名検証**: テスト用 Ed25519 鍵ペアを生成し、正署名 / 不正署名 / タイムスタンプ改変を検証。
- **ハンドラ**: interaction payload のフィクスチャ (type 1 / 3 / 2) ごとに応答 JSON をアサート。
- **翻訳アダプタ**: `env.AI.run` をモックし、プロンプト組立と応答パースを検証。
- **静的検査**: `tsc --noEmit` + Biome。
- **手動 E2E**: `wrangler dev` + ngrok で実際の Discord に接続して確認。

## 10. デプロイ / 運用

```bash
npx wrangler kv namespace create KV      # binding 作成
npx wrangler secret put DISCORD_PUBLIC_KEY
npm run register                          # コマンド登録
npm run deploy                            # wrangler deploy
```

- `wrangler.jsonc` で `observability.enabled = true` (Workers ダッシュボードでログ確認)。
- CI: GitHub Actions — PR で lint/test、main マージで deploy (`CLOUDFLARE_API_TOKEN` を repository secret に)。
- コスト概算: Workers $5/mo (Paid) または Free 枠 / Workers AI は 1 日 10k Neurons まで無料 (翻訳 1 回 = 数十〜数百 Neurons 程度、個人利用なら無料枠内) / KV Free 枠で十分。

## 11. リスクと代替案

| リスク | 対策 |
| --- | --- |
| WebCrypto Ed25519 が環境により使えない | workerd は Ed25519 をサポート済み。万が一問題があれば tweetnacl に限定フォールバック (CPU 増と引き換え) |
| LLM 翻訳の品質・フォーマット崩れ | プロンプトで「翻訳のみを出力」を固定。`translate.ts` アダプタでモデル差し替え可能に |
| 3 秒制約超過 | defer を最初の処理として実装済み。waitUntil で wall clock 30 秒 |
| KV の反映遅延で権限が一瞬古くなる | 許容 (設定変更は低頻度)。厳密性が必要になったら D1 へ移行 |
| Bot Token 漏洩 | `/translate-send` 向けに `DISCORD_BOT_TOKEN` を Worker secret として配置する (`wrangler secret put`)。コード上の使用はチャンネル webhook の作成・一覧取得のみに限定し、メッセージ送信には使わない。登録スクリプトはローカル実行 or CI secret |
| 悪用 (長文連投で Neurons 消費) | メッセージ長上限 (例: 2,000 文字) を設け、超過はエラー応答。ただし `/translate-send` の Modal 入力は最大 4,000 字を許容するため、この前提は従来より緩む (入力は全文を受け、送信メッセージは組み立て時に Discord 上限 2,000 字へ切り詰め)。悪用の抑止は実行者を許可ロールに限定できる権限チェック (§4 権限モデル) で担保する |

## 12. 受け入れ基準

- [ ] メッセージ右クリック → アプリ → Translate で、自分の母国語の翻訳が ephemeral で表示される
- [ ] 許可ロール未保持ユーザーは拒否メッセージが表示される
- [ ] ロール未設定のギルドでは全員が使用できる
- [ ] `/set-language` で設定した言語が翻訳先に使われる
- [ ] PING に即応し、初期応答は常に 3 秒以内
- [ ] `npm test` / `tsc --noEmit` / lint がすべてグリーン
