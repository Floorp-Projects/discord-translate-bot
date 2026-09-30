# /translate-send コマンド設計 — Modal 入力 + webhook によるユーザー名義送信

ユーザーが「送りたい文」をコマンド経由で入力し、翻訳してチャンネルに投稿する
`/translate-send` コマンドの設計。**本ドキュメントは設計のみで実装は含まない。**
本プロジェクトは discord.js 等を使わず、Cloudflare Workers 上で raw の Discord
REST API (HTTP エンドポイント + JSON ペイロード) を `fetch` で直接扱うため、
本ドキュメントのコード例もすべて raw API ベースで記述する。

## 1. 目的・概要

- ユーザーが自分の送りたい文を `/translate-send` で入力 → Workers AI で翻訳 →
  そのチャンネルに翻訳文を投稿する、いわば「翻訳付き送信」コマンド。
- 既存の Translate (コンテキストメニュー) は「他人のメッセージを自分向けに読む」
  コマンドだが、本コマンドは「自分の発言を翻訳して送る」コマンド。結果は
  ephemeral ではなく**チャンネル全体に公開される**。
- 課題: 通常の bot メッセージとして送信すると **bot の名前 + BOT タグ**で
  表示され、「誰が発言したのか」が一見分からない。
- 解決策: チャンネル webhook を使って**実行者のユーザー名義・アバター**で
  送信する (§4)。webhook メッセージにも `BOT` タグ自体は付くが、名義・アバターが
  実行者のものになり「誰が発言したか」は名義で分かる (§4.1)。webhook が使えない
  環境では bot 名義 + `Requested by` 埋め込みでフォールバックする。

## 2. コマンド定義 (raw JSON)

`src/commands.ts` の `ApplicationCommandDefinition` 形式に従う。
登録は既存どおり `scripts/register-commands.ts` が `COMMANDS` 一式を
`PUT /applications/{app_id}/commands` で上書き登録する (スクリプト自体の変更は不要)。

```jsonc
{
  "name": "translate-send",
  "type": 1, // CHAT_INPUT (slash command)
  "description": "Translate your text and send it to this channel as you",
  "options": [
    {
      "name": "text",
      "description": "Text to translate (opens a dialog if omitted)",
      "type": 3, // STRING
      "required": false,
      "max_length": 2000
    },
    {
      "name": "language",
      "description": "Target language (default: English)",
      "type": 3, // STRING
      "required": false,
      "choices": [ "...LANGUAGE_CHOICES (set-language と同じ 25 言語) ..." ]
    },
    {
      "name": "include_original",
      "description": "Attach the original text as a quote (default: on)",
      "type": 5, // BOOLEAN
      "required": false
    }
  ]
}
```

| オプション | 型 | required | 既定値 | 内容 |
| --- | --- | --- | --- | --- |
| `text` | 3: STRING | false | — (省略時 Modal) | 翻訳して送りたい原文。`max_length: 2000` (Discord のメッセージ本文上限に合わせる。API 上の上限は 6000 まで指定可能) |
| `language` | 3: STRING | false | `en` | 翻訳先言語。choices は `/set-language` と同じ 25 言語 |
| `include_original` | 5: BOOLEAN | false | `true` | 翻訳文に原文を引用形式 (§5) で添付するか |

補足:

- **`text` 省略時は Modal を開く** (§3)。コマンドの大半の用途は短文入力のため、
  入力欄付きダイアログを既定の UX にする。
- **`language` / `include_original` は省略時に Modal を開く際、各 String Select の
  初期選択 (option 単位の `default: true`) として反映される** (§3)。指定ありの場合は
  指定値が初期選択になり、省略時は既定値 (`en` / `true`) が初期選択になる。
  値の引き回し (custom_id へのエンコード) は不要で、選択結果は Modal 提出時に
  Select の `values` として返る。
- **choices は 25 が上限**。`src/commands.ts` の `LANGUAGE_CHOICES` はちょうど
  25 言語で、既に `set-language` と共有される共通定数として切り出されているため、
  本コマンドはこれをそのまま参照すればよい (言語の追加/削除は 2 コマンドに自動反映)。
  新たに言語を増やす場合は choices 上限に注意し、超える見込みがあれば autocomplete 化
  (plan.md §4 の方針を踏襲)。
- **BOOLEAN 型オプションに choices は付与できない** (API 仕様)。on/off の提示は
  description で行う。
- **Discord API にはオプション値のサーバー側デフォルト機構がない**ため、既定値は
  ハンドラで解釈する: `language` の options 値が無ければ `en`、`include_original` の
  値が無ければ (undefined/null) `true` として扱う。
- **`language` の既定値を `en` とする理由**: 本コマンドの用途は「母語 → 共通言語への
  発信」であるのに対し、`user:{id}` に保存された設定言語 (plan.md §5) は受信側翻訳
  (Translate が他人のメッセージを読むための翻訳先 = 母国語) の既定であって発信側の
  意味を持たない。母国語を発信側の既定に流用すると「母語で書いた文を母語へ翻訳」と
  いう無意味な既定になるため、共通言語として最も無難な `en` を既定とする。
- 既存 `CommandOption` インターフェースには `max_length` フィールドが無いため
  `max_length?: number` の追加が必要 (§8)。

## 3. Modal 設計 (raw API)

### 3.1 Modal を開く (interaction callback type 9)

`text` 省略で実行された場合、コマンド interaction への初回応答 (3 秒以内) として
interaction callback `type: 9 (MODAL)` を返す。`InteractionResponseType`
(`src/types.ts`) に `Modal: 9` を追加する。

Modal のコンポーネント体系は **2025-08-25 の Discord「New Modal Components」拡張**
に準拠し、すべての入力コンポーネントを **Label (type 18) でラップする**。
1 つの Label の内側に置ける入力コンポーネントは 1 個のみ。本コマンドの Modal は
**3 つの Label** で構成する:

1. **言語の String Select (type 3)** — `LANGUAGE_CHOICES` と同じ 25 言語を選択肢とし、
   コマンド実行時の `language` 値 (省略時は既定 `en`) に該当する option に
   `default: true` を付けて初期選択にする。
2. **原文添付の String Select (type 3)** — 「含める / 含めない」の 2 択
   (value はそれぞれ `"1"` / `"0"`)。コマンド実行時の `include_original` 値
   (省略時は既定 `true`) に応じて初期選択を切り替える。
3. **本文の Text Input (type 4)** — Paragraph (style 2)、`max_length: 4000`。

String Select の初期選択は **option 単位の `default: true`** で指定する
(`default_values` は User/Role Select 専用のため使えない)。また本拡張により
Text Input 直下の `label` フィールドは非推奨となり、**Label 側の `label` を
使う**。Label の構造は `{ type: 18, label (45 字以内), description? (100 字以内),
component }`。

```jsonc
{
  "type": 9,
  "data": {
    "custom_id": "ts",
    "title": "翻訳して送信",
    "components": [
      {
        "type": 18, // Label
        "label": "翻訳先の言語",
        "component": {
          "type": 3, // String Select
          "custom_id": "language",
          "required": true,
          "options": [
            // LANGUAGE_CHOICES (set-language と同じ 25 言語)。該当 1 件に default: true
            { "label": "English", "value": "en", "default": true },
            { "label": "Japanese", "value": "ja" }
            // ... 残り 23 言語
          ]
        }
      },
      {
        "type": 18, // Label
        "label": "原文の添付",
        "component": {
          "type": 3, // String Select
          "custom_id": "include_original",
          "required": true,
          "options": [
            { "label": "含める（引用で原文を表示）", "value": "1", "default": true },
            { "label": "含めない（翻訳文のみ）", "value": "0" }
          ]
        }
      },
      {
        "type": 18, // Label
        "label": "送信したいテキスト",
        "component": {
          "type": 4, // Text Input
          "custom_id": "text",
          "style": 2, // 1: Short / 2: Paragraph
          "placeholder": "翻訳したい文章を入力...",
          "min_length": 1,
          "max_length": 4000,
          "required": true
        }
      }
    ]
  }
}
```

言語・原文添付は **Modal 内の Select で直接選択される**ため、modal の `custom_id`
は **固定値 `"ts"` に簡素化**した (旧設計の `ts:<language>:<include_original 0|1>`
エンコードは不要)。プレフィックス `ts` で他の modal と区別する。長さは 100 字制限に
対して十分短い。

> **注記**: Label + Select を用いる Modal ペイロードは新 API のため、デプロイ前に
> 実機での表示確認を推奨する。

Discord 側の制限値:

| 項目 | 上限 |
| --- | --- |
| `title` / Label の `label` | 各 45 字 |
| Label の `description` | 100 字 |
| `custom_id` (modal・コンポーネントとも) | 100 字 |
| 1 Label あたりの入力コンポーネント数 | 1 個 |
| Text Input コンポーネント数 | 1 modal あたり 5 個 |
| `style` | 1 = Short (単行) / 2 = Paragraph (複数行) |
| 入力値 (`min_length` / `max_length`) | 1〜4000 字 |

### 3.2 Modal 提出時 (interaction type 5: MODAL_SUBMIT) の扱い

**Modal 提出の interaction には slash command のオプション値が渡ってこない**
(`data` には `custom_id` と入力コンポーネントのみ入る)。`language` /
`include_original` は Modal 内の Select で直接選択されるため、MODAL_SUBMIT の
payload から選択値を読み取る (custom_id へのエンコードは不要)。

- Modal 提出の payload は以下の構造:

```jsonc
{
  "type": 5, // MODAL_SUBMIT
  "token": "<新しい interaction token>",
  "channel_id": "...",
  "member": { "...": "..." },
  "data": {
    "custom_id": "ts",
    "components": [
      {
        "type": 18, // Label
        "label": "翻訳先の言語",
        "component": { "type": 3, "custom_id": "language", "values": ["ja"] }
      },
      {
        "type": 18, // Label
        "label": "原文の添付",
        "component": { "type": 3, "custom_id": "include_original", "values": ["1"] }
      },
      {
        "type": 18, // Label
        "label": "送信したいテキスト",
        "component": { "type": 4, "custom_id": "text", "value": "ユーザーが入力した本文" }
      }
    ]
  }
}
```

- `data.components` には **Label (type 18) が並び、入力本体はその内側の
  `component` に入る**。Text Input は `value: string`、String Select は
  `values: string[]` で提出される。
- パースは**防御的に行う**: 固定添字アクセスはせず `data.components` を走査し、
  Label 以外の要素 (旧形式の Action Row 等)・型違い・空配列などは無視する。
  各入力は `custom_id` (`language` / `include_original` / `text`) で識別する。
- **サーバー側の再検証を維持する** (直接 API 実行・旧 modal 再利用に備える — §7):
  - `language`: `Object.hasOwn(LANGUAGE_NAMES, lang)` で検証 (継承プロパティ対策も
    兼ねる — `src/handlers/setLanguage.ts` と同じパターン)。不正な値は ephemeral
    エラーで即応する。
  - `include_original`: select の値は `"0"` / `"1"` のみ許容し、それ以外は
    ephemeral エラーで即応する。
- **Modal 提出後は新しい interaction token で応答する**。元のコマンドの token は
  初回応答 (type 9) で消費済みのため使えない。以降の defer / followup /
  `@original` 更新はすべて Modal 提出の token を使う (§6)。

なお、Modal の送信・提出の流れは Discord クライアントが処理するため、type 9 を
返した時点で Worker 側のその interaction への仕事は終わる。翻訳などの重処理は
一切行わない (plan.md §3 の CPU 時間最小化指針どおり)。

## 4. 送信方式: webhook によるユーザー名義送信 (本設計の核心)

### 4.1 課題: bot 名義 + BOT タグ

通常の interaction followup (bot メッセージ) で送信すると、メッセージの名義は
bot になり `BOT` タグが付く。「実行者自身の発言」として翻訳文を届けるという
コマンドの目的に対し、名義を実行者のものに変えられないのは本質的な制約。

webhook メッセージは `username` / `avatar_url` を自由に指定して送信できるため、
**実行者の表示名とアバターで投稿**することで「そのユーザーが翻訳文を送った」
ことを名義で示せる。ただし **webhook メッセージ (webhook_id を持つメッセージ) も
Discord クライアント上では `BOT` タグ付きで表示される** 点に注意 (倫理面は §7)。
username/avatar_url のオーバーライドで名義・アバターは実行者のものになるが、
BOT タグ自体は残る。一方で、メッセージから「どのアプリケーション由来か」は
特定できない。**実装前にクライアントでの実際の表示 (BOT タグの付き方) を
実機確認し、本節の記述と食い違いがあれば修正すること。**

### 4.2 webhook の作成 (要 Bot Token + Manage Webhooks 権限)

チャンネルごとに 1 本の webhook を作成して再利用する。

```http
POST /channels/{channel_id}/webhooks
Authorization: Bot <DISCORD_BOT_TOKEN>
Content-Type: application/json

{ "name": "Translate Bot" }
```

応答 (必要なフィールドのみ):

```jsonc
{ "id": "123456789012345678", "token": "xxxxx", "name": "Translate Bot" }
```

- **Bot の実行に Manage Webhooks 権限 (1 << 29 = 536870912) が必要** (チャンネル/
  カテゴリの上書きを含む)。無い場合は 403 が返る → フォールバック (§4.5)。
- DM チャンネルには webhook を作成できない → 常にフォールバック。
- スレッド内で実行された場合 (`interaction.channel_id` がスレッド)、スレッド自体には
  webhook を作成できないため、`GET /channels/{channel_id}` で親チャンネルを解決して
  親に webhook を作成し、実行時に `?thread_id=<スレッド ID>` を付ける。初期実装では
  単純化してスレッド内はフォールバック送信にしてもよい。
- **アーキテクチャ上の重要な変更点**: webhook 作成は interaction token では実行できず
  Bot Token が必須のため、既存の「Bot Token は Worker に置かない」設計
  (plan.md §6.1 / §7 / §11) を変更し、`DISCORD_BOT_TOKEN` を Worker secret として
  追加する。使用箇所は webhook 作成 (と後述の回復用一覧取得) のみに限定し、
  リスク見直しは §7 で扱う。

### 4.3 webhook の実行 (認証不要 — URL 内 token)

```http
POST /webhooks/{webhook_id}/{webhook_token}?wait=true
Content-Type: application/json

{
  "content": "<翻訳文 (+ 原文引用)>",
  "username": "<実行者の表示名>",
  "avatar_url": "https://cdn.discordapp.com/avatars/<user.id>/<hash>.png",
  "allowed_mentions": { "parse": [] }
}
```

- webhook 実行は URL に token を含むため Authorization ヘッダ不要 (interaction
  followup と同じ仕組み)。
- `wait` はクエリパラメータとして渡す。`true` なら 200 + 作成されたメッセージ本体、
  省略/false なら 204 のみ返る。成否の確認にはどちらでもよいが、本設計では
  `?wait=true` で実行し 200 を確認する。
- `username`: **`member.nick || user.global_name || user.username`** の優先順位で
  実行者の表示名を使う (ギルドでの見た目に一致させる)。現在の `src/types.ts` の
  `Interaction` にはこれらのフィールドが無いため型の拡張が必要 (§8)。
- **`username` には禁止語制約がある**: "discord" / "clyde" を含む文字列
  (大文字小文字無視の部分一致) は 400 エラーになる。実行者の表示名
  (nick / global_name / username) にこれらが含まれるユーザーは webhook 実行が
  常に失敗するため、**§4.5 のフォールバック (bot 名義送信) に落ちる**。
  エラー判別は 400 をフォールバック条件に含めるだけでよく、UX の差異は
  ユーザーに伝えない (§4.5)。
- `avatar_url`: `interaction.member.user.avatar` (ハッシュ) から組み立てる。
  ハッシュが無い (既定アバターのユーザー) 場合は、`avatar_url` を省略して
  webhook 側の既定アバターに任せても動作するが、名義の一貫性のため**ユーザーの
  既定アバター** `https://cdn.discordapp.com/embed/avatars/N.png` を組み立てる
  方式を推奨する (N は既定アバターの色インデックス: 旧体系では
  `user.discriminator % 5`、新体系では `(BigInt(user.id) >> 22n) % 6n`。
  snowflake は 53 bit を超えるため Number ではなく BigInt で計算する)。
  webhook 既定アバターだと名義だけ実行者でアバターは bot のもの、という
  不自然な見た目になるため。
- **`allowed_mentions.parse: []` はセキュリティ上必須**。ユーザー入力の翻訳文に
  `@everyone` / `@here` / ユーザー/ロール メンションが含まれていても、実行者名義の
  webhook メッセージでそれらが実際に ping を飛ばすことを防止する (ping 偽装防止)。

### 4.4 webhook キャッシュ戦略

webhook はチャンネルごとに 1 本作成すれば足りるため、KV にキャッシュして再利用する。

| キー | 値 (JSON) |
| --- | --- |
| `webhook:{channelId}` | `{"id":"...","token":"..."}` |

- **KV を推奨する理由**: Workers の isolate は起動/再起動・多重化されるため、
  isolate ごとの in-memory `Map` はキャッシュとして当てにできず、毎回 webhook 一覧取得
  (Bot Token 要) か新規作成が発生する。KV なら恒久的に再利用できる
  (`src/store.ts` の get / put パターンをそのまま踏襲)。
- in-memory `Map` は同一 isolate 内のホットパス用 L1 キャッシュとして併用してよい
  (任意最適化。KV 読み取り 1 回の節約)。
- 実行時に 404 (webhook が削除されている) → 作成し直して KV を更新、再送信 1 回。
- webhook にはチャンネル単位の作成数上限 (**10 本/チャンネル** が公式に文書化された
  値) があるため、KV 値の欠落時は新規作成の前に
  `GET /channels/{channel_id}/webhooks` (Bot Token 要) で
  `name === "Translate Bot"` の既存 webhook を検索して再利用する
  (重複作成の回避 — 上限を自前の重複で埋めないため)。
- **並行実行時の競合**: 同一チャンネルで KV 未キャッシュのまま並行実行されると、
  list-再確認してもレースウィンドウは残り、重複 webhook が作られ得る。実害は小さい
  (各リクエストの送信は 1 回だけなので、残るのは使われない webhook のみ) が、
  上限 10 本/チャンネルを埋める可能性があるため、作成は常に list-再確認の後とする。
- **webhook 実行の 429 (レート制限)**: 同一チャンネルでの同時利用で 429 +
  `Retry-After` が返りうる。**`Retry-After` で指定された秒数だけ待機して 1 回再送 →
  それでも失敗した場合にフォールバック (§4.5)** とする。429 を即フォールバックに
  すると UX が不安定になるため避ける。ただし `Retry-After` が 15 秒を超える場合は
  待機だけで waitUntil の wall clock (約 30 秒) を消費して再送もフォールバックも
  実行できなくなるため、待機・再送せず直ちにフォールバックする。

### 4.5 フォールバック (bot 名義送信)

Manage Webhooks 権限がない (作成 403) / DM 実行 / webhook 実行が失敗した場合は、
通常の interaction followup で bot 名義送信し、帰属を embed footer で明示する。

```http
POST /webhooks/{app_id}/{interaction_token}
Content-Type: application/json

{
  "content": "<翻訳文>\n\n> <原文>",
  "embeds": [ { "footer": { "text": "Requested by @<username>" } } ],
  "allowed_mentions": { "parse": [] }
}
```

- followup に `flags` を付けなければ**公開メッセージ**になる (defer の ephemeral
  flag は followup に継承されないため、ここで明示的に制御できる)。
- **`allowed_mentions: { "parse": [] }` は webhook 経路 (§4.3) と同様に必須**。
  原文 (ユーザー入力) を bot 名義で公開送信するため、`@everyone` 等を
  仕込まれても ping が飛ばないようにする (ping 偽装防止)。
- その後 `@original` は他パスと同様に ephemeral の「✅ 翻訳して送信しました」に
  更新する (§6)。訳文自体は followup で公開済み。
- 既存 `FollowupMessage` 型 (`src/types.ts`) は `content` / `flags` のみのため、
  `embeds` の追加が必要 (§8)。
- **ユーザー名義での送信は webhook 一択**: interaction followup には
  `username` / `avatar_url` を指定する項目が無く (bot のアプリケーション名義に
  なる)、followup 側でメッセージの名義を実行者にする手段は存在しない。したがって
  **Bot Token を Worker に置かない「常時フォールバック運用」でも機能自体は成立
  する** (費用対: UX が常に bot 名義 + `Requested by` 埋め込みになる)。
  Bot Token の Worker 配置 (§4.2) は「ユーザー名義 UX」と「secret 管理コスト・
  リスク (§7)」のトレードオフとして判断する。
- webhook 有無で UX が変わることはユーザーに伝えない。確認メッセージの文言は
  共通とし、フォールバックかどうかをユーザーが意識しない設計にする。

## 5. メッセージの組み立て

- `include_original: true` (既定) の場合、翻訳文の後に空行を挟んで原文を引用形式で
  添付する。原文が複数行の場合は各行の行頭に `> ` を付ける:

  ```
  <翻訳文>

  > <原文>
  ```

- `include_original: false` の場合は翻訳文のみ。
- **メッセージ本文は Discord の上限 2000 字**。翻訳文 + 原文の合計が超過する場合は
  **原文側を優先的に切り詰める** (翻訳文が本体であるため全文維持を優先)。
  原文を切り詰めても (あるいは引用を丸めても) 上限を超える場合は、最終防衛線として
  全体を 2000 字に末尾カット + `…` で切り詰める (`handlers/translate.ts` の
  `truncateToDiscordLimit` と同じ方針・上限値)。
- 入力上限との関係: `text` オプションは 2000 字、Modal 入力は 4000 字まで許容する。
  Modal から 2000 字超が入力された場合も上記の切り詰めルールで 2000 字以内に収める
  (入力段階では全文を受け取り、組み立て時に調整)。
- **翻訳結果の前後に余計な説明・見出しを付けない**。LLM 翻訳の出力自体は
  `src/translate.ts` のシステムプロンプト (「翻訳のみを出力。説明/引用符を追加しない」)
  で拘束済みであり、コマンド側も既存 Translate の `🌐 **English**` のような
  プレフィックスを付けない。これは「実行者の発言として送る」メッセージであるため。

## 6. インタラクションフローとタイムアウト対策

### パターン A: `text` オプションあり

```
Discord ──/translate-send text:… language:… ──► Worker
           ① precheck (defer 前の同期パス):
              権限判定 (isAllowedToTranslate) / 言語値の検証 / 文字数検証
                NG → type 4 ephemeral エラーで即応 (waitUntil 不要・終了)
Discord ◄────────── type 5 defer (flags: 64) ── Worker     … 3 秒以内
           ② ctx.waitUntil で後続処理:
                1. translateText(env, text, lang)          … Workers AI (数秒)
                2. webhook 取得 (KV) or 作成 (Bot Token)
                3. POST /webhooks/{webhook_id}/{webhook_token}?wait=true
                                                          … チャンネルへ公開投稿
                 4. PATCH /webhooks/{app_id}/{token}/messages/@original
                    { "content": "✅ 翻訳して送信しました (English)" }
                                                           … 実行者のみ視認
           失敗時: フォールバック (§4.5) or ephemeral エラー更新
```

### パターン B: `text` 省略 (Modal)

```
Discord ──/translate-send (text 省略) ──► Worker
           ① precheck (同上)
Discord ◄────── type 9 (MODAL) ───────── Worker               … 3 秒以内
           (ユーザーが Modal に入力・提出)
Discord ──type 5: MODAL_SUBMIT (新 token)──► Worker
            custom_id "ts" を確認
            Modal 内 Select で選択された言語・原文添付 (values) と
            Text Input の本文 (value) を取得
           ② precheck 相当の再検証 (権限・言語・文字数)
                NG → type 4 ephemeral エラーで即応
Discord ◄────── type 5 defer (flags: 64) ─ Worker             … 3 秒以内
           ③ ctx.waitUntil: 翻訳 → webhook 送信 → PATCH @original (✅ 確認)
              ※ ここからの token はすべて Modal 提出の新 token
```

設計上の要点:

- **defer が必須な理由**: Discord は初回応答 3 秒以内を要求する一方、Workers AI の
  翻訳には数秒かかる (plan.md §3 と同じ根拠)。type 5 で先に応答し、重い処理は
  `ctx.waitUntil()` へ逃がす。wall clock 30 秒・interaction token 15 分の制約には
  十分収まる。
- **defer を ephemeral (flags: 64) にする理由**: 「考え中…」表示も最終的な
  `@original` (✅ 確認) も実行者にのみ見せる。もし defer を非 ephemeral にすると
  `@original` が公開メッセージ化し、webhook 投稿と**二重に見える**ため。
  確認メッセージを ephemeral にすることで、チャンネルに残る公開メッセージは
  webhook 投稿の 1 本だけになる。
- ✅ 確認メッセージには翻訳先言語名を含める (例: 「✅ 翻訳して送信しました
  (English)」)。言語名は `LANGUAGE_NAMES[lang]` から取得。
- **PATCH `@original` のペイロードに `flags` を含めない**: ephemeral は defer
  (type 5, flags: 64) 時点で `@original` に確定しており、メッセージ編集 API で
  変更可能な flags は SUPPRESSED_EMBEDS (1 << 12) のみのため、送っても冗長。
- Modal 提出後も 3 秒制限は同様に適用されるため、パターン B の ②→defer 間の
  検証は軽量 (KV 読み取り 1 回 + 純粋な検証) に保つ (既存 `precheckTranslate` と
  同じ構成)。

## 7. 権限・セキュリティ

| 項目 | 内容 |
| --- | --- |
| 翻訳可否ロール判定 | 既存 `src/permissions.ts` の `isAllowedToTranslate` (ギルド設定: `guild:{id}`) を本コマンドにも**適用すべき**。翻訳機能の一部であり、荒らし (実行者名義での大量投稿) 防止の観点からも既存の権限モデルに乗せる。拒否時は defer 前に type 4 ephemeral で即応 (既存 Translate と同じ最速パス)。Modal 提出時にも再度判定する (defense in depth — 過去に開いた modal の再利用等に備える) |
| bot に必要な権限 | webhook 作成のために **Manage Webhooks (1 << 29)** が必要。ギルド管理者が bot ロールに付与する。無くても機能はフォールバックで維持される (§4.5) |
| ping 偽装防止 | `allowed_mentions: { "parse": [] }` で webhook メッセージからのあらゆるメンション ping を無効化 (§4.3)。**セキュリティ上必須**。bot 自身に Manage Webhooks / Mentions Everyone 等の権限を付与しすぎない |
| 名義スプーフィング防止 (倫理) | `username` / `avatar_url` には**必ず実行者本人の値のみ**を使う。ユーザー入力や任意の値を名義に渡す設計にはしない。実行者の名前で第三者になりすまして投稿できる機能にしないための要件であり、権限チェック (上段) と合わせて悪用防止とする。なお webhook メッセージも `BOT` タグ付きで表示されるため (§4.1)「人間の通常発言」と完全に同一の見た目にはならず、bot 代理送信であることは UI 上判別可能 |
| Bot Token の Worker 配置 | 本機能により `DISCORD_BOT_TOKEN` を Worker secret に置くことになり、plan.md §11「Bot Token 漏洩」の前提が変わる。`wrangler secret put DISCORD_BOT_TOKEN` で管理し、コード上の使用箇所は webhook 作成・一覧取得の REST 呼び出しのみに限定する |
| custom_id / 入力値の検証 | `custom_id` や options 値は Discord 側で検証される前提だが、直接 API 実行・旧 modal 再利用に備え、サーバー側で必ず再検証する (`Object.hasOwn(LANGUAGE_NAMES, …)` 等 — `setLanguage.ts` パターン) |

## 8. 実装タスクチェックリスト

- [ ] `src/commands.ts`: `translate-send` 定義を `COMMANDS` に追加。
      `CommandOption` に `max_length?: number` を追加。choices は既存
      `LANGUAGE_CHOICES` を参照 (重複定義しない)
- [ ] `scripts/register-commands.ts`: 変更不要 (COMMANDS 一式を PUT するため)。
      `DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... npm run register` を再実行して登録
- [ ] `src/types.ts`:
      - `InteractionResponseType` に `Modal: 9` を追加
      - `InteractionResponse.data` を拡張 (type 9 MODAL 応答用):
        `custom_id` / `title` / `components` (§3.1 のペイロードを型に反映)
      - `Interaction` を拡張: `member.nick`、`member.user.global_name`、
        `member.user.avatar`、MODAL_SUBMIT 用の `data.custom_id` / `data.components`
        (型は既存の防御的なパース方針に合わせ `unknown` 含みで定義)
      - `FollowupMessage` に `embeds` を追加
      - webhook 用の型 (`ChannelWebhook` 等) を追加
- [ ] `src/discord.ts`: REST ヘルパーを追加
      (`createChannelWebhook` / `listChannelWebhooks` / `executeWebhook` /
      `editOriginalInteractionResponse`)。Bot Token を使う関数と使わない関数を
      コメントで明確に区別する
- [ ] `src/store.ts`: `getChannelWebhook` / `setChannelWebhook`
      (キー: `webhook:{channelId}`) を追加
- [ ] `src/handlers/translateSend.ts` (新規): precheck (権限・言語・文字数) と
      Modal 応答構築、waitUntil 側の翻訳 → webhook 送信 → `@original` 更新、
      フォールバック一式
- [ ] `src/index.ts`: `InteractionType.ModalSubmit` (type 5) のルーティングを追加
      (現在は `Unsupported interaction type` で 400 を返す箇所)。custom_id `ts`
      (言語・原文添付は Modal 内 Select で選択) で translateSend ハンドラへ振り分け。
      `translate-send` コマンドの振り分けも追加
- [ ] `Env` に `DISCORD_BOT_TOKEN` (secret) を追加し、
      `npx wrangler secret put DISCORD_BOT_TOKEN` で設定
- [ ] `wrangler.jsonc` / `docs/plan.md` / `README.md` の更新 (§4.2 の Bot Token
      設計変更に伴うもので、未更新だと既存ドキュメントが自己矛盾するため必須):
      - plan.md §4 (コマンド一覧) に `translate-send` を追加
      - plan.md §11 (リスク表): 「Bot Token 漏洩」行の前提変更 (Worker に
        `DISCORD_BOT_TOKEN` を secret として置くようになったこと) に加え、
        **Modal 入力の 4000 字許容が「メッセージ長上限 2,000」による悪用
        (長文連投) 対策の前提を緩める変更である旨**を追記
      - plan.md §2 アーキテクチャ図の Secrets 行「(CI 用 DISCORD_BOT_TOKEN)」を
        Worker secret としても使う記述に更新
      - plan.md §6.1「followup は interaction token を使うため Bot Token 不要
        (Worker に Bot Token を置かない)」段落の書き換え
      - plan.md §7 Bindings (Env に `DISCORD_BOT_TOKEN` 追加) と
        「Bot Token は Worker に置かない」段落の更新
      - README.md L76 付近「トークンは Worker には配置せず…」の記述を更新
      - README のコマンド表 (`/translate-send` の追加) とセットアップ手順
        (`wrangler secret put DISCORD_BOT_TOKEN` の追加)
- [ ] テスト (Vitest、`test/handlers.test.ts` の既存パターンに準拠 —
      `buildSignedInteractionRequest` + `worker.fetch` 経由、`MockKV`、
      `vi.stubGlobal("fetch")` で Discord REST 呼び出しをアサート):
      - `text` 省略時の type 9 応答 (title / custom_id / Modal 内 Select
        (言語・原文添付) + TextInput 定義の検証)
      - MODAL_SUBMIT の受信 → `custom_id` パース → type 5 ephemeral defer → waitUntil
      - `language` 省略時 `en`、`include_original` 省略時 `true` の既定解釈
      - webhook 実行ペイロード (username の優先順位 nick → global_name → username、
        avatar_url、`allowed_mentions.parse: []`、content の引用形式)
      - 2 回目の実行で KV キャッシュを再利用し webhook 作成 API を呼ばない
      - 作成 403 / DM 実行でフォールバック (followup の embed footer を検証)
      - 翻訳文 + 原文で 2000 字超の場合の切り詰め (原文優先カット → 全体カット)
      - 許可ロール非保持者の拒否 (defer しない ephemeral エラー)
      - **Modal 提出時の権限再チェック** (defense in depth — 許可ロール非保持の
        MODAL_SUBMIT も defer 前に拒否される)
      - 不正な custom_id / 言語値の拒否
      - **`test/test-utils.ts` の `createEnv` を拡張**し `DISCORD_BOT_TOKEN`
        (テスト用ダミー値) を注入できるようにする
      - **フォールバック系**: スレッド実行 (初期実装でフォールバックに簡略化する
        場合はその挙動)、username 禁止語 ("discord" / "clyde") による 400 →
        フォールバック、webhook 実行 429 + Retry-After → 待機再送 1 回 →
        失敗時フォールバック (§4.4)
