
# dev memo: paper_extractor（arXiv 論文取得・要約プラグイン）

## Plugin name

- `paper_extractor`
- Repository: https://github.com/KunihiroS/paper-extractor

## 概要

本SWはObsidianのプラグインであり、以下の個別機能を有する。

- `paper_fetcher`
  - arXiv URL から論文データを取得して保存する
- `title_extractor`
  - 論文タイトルを取得して、対象ノートのタイトル（ファイル名）を更新する
- `summary_generator`
  - 論文を要約して、対象ノートの下に追記する

## 重要: 廃止/上書きされた機能（現行仕様）

以下は**旧仕様**であり、現行実装では**廃止/上書き済み**。

- **起動方法**
  - 旧: リボン押下
  - 現行: **コマンドパレットのみ**（リボンは廃止）
- **URL取得方法**
  - 旧: ノート内 `###### url_01:` から抽出
  - 現行: **コマンド実行時の入力**（PromptでURL入力）
- **対象ノート**
  - 旧: アクティブノート
  - 現行: **新規ノートを自動作成**（Vaultルート）
- **テンプレ適用**
  - 旧: 手動テンプレ適用を前提
  - 現行: **テンプレファイルを自動適用**（`{{url}}` 必須 / `{{date}}` `{{time}}` を置換）

## 前提条件

- 個人利用を想定している。
- ノートはプラグインが新規作成する（Vaultルート）。
- 新規作成時の本文は「設定で指定したテンプレートファイル」から生成される。
  - テンプレートは Vault 内のファイルで、ユーザが自由に編集できる。
  - テンプレートには `{{url}}` が必須。
  - `{{date}}` と `{{time}}` は作成時に現在日時へ置換される。

以下は完成形イメージのサンプル。

```指定テンプレートsample
###### Created:
{{date}} {{time}}
###### タグ:
#paper
###### url_01:
{{url}}
###### url_02: 

###### memo: 

---

```

## 想定ユーザフロー

- 各個別機能は以下の通り一連の処理として連続します。

```
- title_extractor

1. ユーザーがコマンドパレットから `Create paper note from arXiv URL` を実行する
2. Prompt に arXiv URL を入力する
3. プラグインがテンプレートを適用して新規ノートを作成する
4. タイトルをノートのファイル名に反映する（ファイル名リネーム）

- paper_fetcher

5. arXiv論文を取得し指定ディレクトリに保存する

- summary_generator

6. arXiv論文を要約して、対象ノートの下に追記する
```

## 個別機能詳細

### paper_fetcher

- arXiv URL から論文データを取得して保存する。

#### 目的

- コマンド実行時に入力された arXiv URL（入力URL）を元に、arXiv から論文データを取得して **対象ノートと同階層の添付ディレクトリに保存**する。
- 1st iteration は **arXiv のみ**対応（将来拡張で他サイト対応の余地は残す）。

#### 対象ノートの定義

- 本プラグインが**新規作成したノート**を対象にする。
  - 新規ノートは Vault ルートに作成する。
  - 一時名で作成後、`title_extractor` によりファイル名リネームされる。
- `paper_fetcher` は対象ノート（`TFile`）と入力URLを引数で受け取って実行する（アクティブノートは参照しない）。

#### 入力テンプレ（前提）

- ノート本文は、設定 `templatePath` で指定された Vault 内テンプレートから生成する。
- テンプレート変数（置換）
  - 必須: `{{url}}`
  - 任意: `{{date}}` / `{{time}}`
- `paper_fetcher` はテンプレート本文からURLを抽出しない（入力URLを引数で受け取る）。

#### arXiv URL の変換ルール

##### 入力

- `https://arxiv.org/abs/<id>`
  - 例: `https://arxiv.org/abs/2601.05175`

##### 取得対象
- 下記両方のデータを取得して保存する
  - HTML: `https://arxiv.org/html/<id>`
  - PDF: `https://arxiv.org/pdf/<id>`

#### 保存先ルール（Vault内）

- 対象ノート: `path/to/{noteBaseName}.md`
- 保存フォルダ: `path/to/{noteBaseName}/`
  - フォルダが無ければ作成する
- 保存ファイル:
  - HTML: `<id>.html`
  - PDF: `<id>.pdf`

#### 実行トリガー（MVP）

- 常時監視はしない。
- **ユーザが明示操作**して開始する。
  - コマンドパレットから `Create paper note from arXiv URL` を実行

#### UX（通知）

- MVP は Obsidian の標準通知で良い。
  - 開始: `Notice` で「開始」
  - 完了: `Notice` で「保存先パス」
  - 失敗: `Notice` で「失敗理由（概要）」
- 詳細は `console.error` 等に出す（ユーザが開発者ツールで追える）。

#### ログ（原因追跡のため必須）
- プラグインの動作履歴を.logとして残す
- PDF/HTML の保存先（`{noteBaseName}/`）のフォルダ作成に失敗した場合でも原因が追跡できるよう、ログは保存先と分離する
- ログ保存先ディレクトリは設定画面でユーザが指定する（Vault内パス、必須）
  - 未設定の場合は `paper_fetcher` は中断する（Noticeで通知）
- ログファイルは日別とし、同一日のログに追記する
  - 保存先: `{logDir}/`
  - ファイル名: `paper_extractor_YYYYMMDD.log`
- ログは1行ごとにタイムスタンプを付与して追記する
  - 例: `2026-01-15T20:14:00.123Z result=OK ...`
- ログには少なくとも以下を含める
  - `notePath`, `noteBaseName`, `folderPath`（作成対象）, `id`
  - `folderCreateError`（フォルダ作成に失敗した場合）
  - HTML/PDF の取得URLとステータス（または例外）
  - 成功時も `result=OK` のような成功ログを必ず1行以上出力する
  - 1回の実行（1操作）が1ブロックになるよう、開始/終了が分かる形式で追記する

##### セキュリティ（VaultがGit管理されている場合の事故防止）

- ログには秘密情報を絶対に出力しない（APIキー、トークン、Authorizationヘッダ、`.env` の中身等）
  - OpenAI/Gemini 等のHTTPリクエストをログに出す場合でも、ヘッダ/ボディをそのまま出力しない
  - エラー情報は `reason` と、必要最小限の `error`（メッセージ）に留める
  - 例外メッセージに秘密情報が混入する可能性がある場合は、マスキングしてからログに残す

##### セキュリティ（.log をGit管理する前提での保証）

- `.log` は Git 管理する前提とする
- そのため、運用ルールに依存せず、実装として「秘密情報がログに混入しないこと」を強制する
  - ログ出力は `logger` 層に集約し、出力前に必ず redaction（マスキング）を通す
  - `appendLogLine` / `startLogBlock` / `endLogBlock` の全経路で強制する
  - APIキー/トークン/Authorization 等のパターンを検出した場合は置換してから保存する
  - 例外/エラーのメッセージもそのまま書き込まず、必要ならredactionしてから保存する

- 実装状況
  - `logger.ts` で強制redaction（`redact` / `safeRedact`）を実装済み
  - `Error.message` は `formatErrorForLog` 経由で `errorSummary`（redact + 1行化 + 200文字上限）として保存する
  - redaction失敗時は元メッセージを保存せず、固定メッセージのみを保存する

##### ログ補強（summary_generator開発時にまとめて実施）

- `summary_generator` 実装に着手するタイミングで、ログの原因追跡性をまとめて補強する
  - 例: HTTP非2xx時の詳細（ステータス別の情報）、例外メッセージの明示、必要ならログのパースしやすさ改善
  - セキュリティ観点の補強も含む（秘密情報のマスキング/出力禁止の徹底、VaultがGit管理の場合のログ混入事故対策）

#### 連打・並行実行（実行中は無効化）

- `paper_fetcher` / `title_extractor` / `summary_generator` は「実行中フラグ」を持ち、二重実行を防ぐ
- 実行中にコマンドが押下された場合は開始せず、`Notice` で「実行中」を通知する

#### 準正常系・エラー処理

- **保存先ディレクトリが存在しない**
  - 作成して保存する
- **保存先ディレクトリが既に存在する**
  - **中断しない**（フォルダ統合を避ける目的で中断していた旧挙動を廃止する）
  - 取得したファイルのみ上書きする
    - HTML: `<id>.html`
    - PDF: `<id>.pdf`
  - フォルダ内の他ファイルは削除しない（プラグイン外で生成された添付を巻き込まない）
  - 例外: 保存先パスが「フォルダ」ではなく「ファイル」の場合はエラーとして中断する
  - ログ
    - 既存フォルダ検出は `reason=FOLDER_ALREADY_EXISTS` 等で1行残す
    - 上書き対象（html/pdf）と成功/失敗（HTTP status / errorSummary）を必ず残す
  - Notice
    - 通常は従来どおり（成功/失敗の要点のみ）
- **保存先に同名ファイルが存在する**
  - 上書きする
- **URLから取得できない（404等）**
  - ユーザにエラー通知する（Notice）
  - 失敗理由（HTTP status 等）はログに残す
- **入力URLが不正 / arXiv URL ではない**
  - エラー通知して中断する

#### 競合懸念（他プラグインとの整合）

- 既存運用として、ノート `{hoge}.md` の添付は `./{hoge}/` に置く前提。
- 本プラグインも同ルールに従って保存する。
- 競合の可能性:
  - 他プラグインが同じファイル名を生成・上書きする
  - 添付管理プラグインがファイルを移動/リネームする
- MVP では「ファイル名を固定して上書き」運用で割り切る。

#### 決定事項（MVP仕様サマリ）

- **対象**: プラグインが新規作成したノート（Vaultルート、一時名→リネーム）
- **URL入力**: コマンド実行時に Prompt で入力
- **対応**: arXivのみ
- **取得**: `html` と `pdf` を両方取得して保存
  - `https://arxiv.org/html/<id>`
  - `https://arxiv.org/pdf/<id>`
- **保存先**: 対象ノートと同階層の `{noteTitle}/`（無ければ作成）
- **保存ファイル名**:
  - HTML: `<id>.html`
  - PDF: `<id>.pdf`
- **上書き**: 常に上書き（片方失敗でも、成功した方は保存）
- **ログ**: `{noteTitle}/` とは別の `{logDir}/`（設定必須）に日別ログとして追記
- **通知**: `Notice` で開始/完了/失敗を通知（MVPはこれで十分）

#### 実装メモ（設計の方向性）

- 取得: Obsidian の `requestUrl`（想定）
- 保存: `app.vault.adapter` でフォルダ作成と `write`（html）
- 対象ノート: プラグインが作成した `TFile` を引き回す

#### Implementation plan (MVP)

1. コマンドパレットから `Create paper note from arXiv URL` を実行
2. Prompt で arXiv URL を入力
3. テンプレートを読み込み、`{{url}}`（必須）と `{{date}}`/`{{time}}` を置換
4. Vault ルートに新規ノートを一時名で作成
5. `title_extractor` でタイトル取得→ノートをリネーム
6. `paper_fetcher` で HTML/PDF を `{noteBaseName}/<id>.{html,pdf}` に保存
7. `summary_generator` で HTML を要約してノート末尾へ挿入/置換

### title_extractor

#### 目的
- 論文タイトルを取得して、対象ノートのファイル名を更新する（ファイル名リネーム）

#### UX
- title_extractor は単独起動しない（コマンド `Create paper note from arXiv URL` の内部で実行される）
- 実行順序は `title_extractor` → `paper_fetcher` → `summary_generator`
- 通知は `Notice`（英語）で行う

#### 機能詳細
- タイトル取得は `https://arxiv.org/abs/<id>` のメタタグ（`citation_title`）のみを参照する
- フォールバックは実装しない（取得できなければエラー通知し、手運用で対応する）
- Obsidianのノートタイトルで使えない文字は、`_` に置換する

#### 実行順序（安全設計）

- title_extractor は **paper_fetcher より先に**実行する
- 目的:
  - 「無題ノート」等の仮名のままダウンロードして添付フォルダが作られ、後からリネーム/移動/衝突で状況が複雑化するのを避ける

#### 事前検査（副作用ゼロで中断）

- タイトルが取得できること（`citation_title`）
- タイトルをノート名として利用できる形式に正規化（禁止文字を `_` に置換など）
- 正規化後の `newTitle` が空文字にならないこと
- **`/{newTitle}` が既に存在する場合は常に中断**（フォルダ統合を絶対に避ける）
- **`newTitle.md` が既に存在する場合は中断**（ノート名衝突を事前に明示して止める）

#### リネーム

- 事前検査が全て通った場合にのみ、対象ノートを `newTitle.md` にリネームする

#### 競合懸念（添付管理プラグインとの整合）

- 既存運用として、ノート `{hoge}.md` の添付は `./{hoge}/` に置く
- Custom Attachment Location の確認結果（前提）:
  - ノートタイトル変更に追随して、対のディレクトリ名変更が実行される
  - 対ディレクトリ名変更に追随して、埋め込みファイルリンクも変更される
  - ノート削除後も対ディレクトリが残る
  - 対ディレクトリが残ったまま同名ノートを作ると、残ったディレクトリが再利用される（添付が混在し得る）
  - 同名の添付が発生した場合、サフィックス（例: `foo 1.jpg`）で別名保存される

#### 準正常系
- メタタグが見つからない、取得できないなどの場合は、エラー通知し、対象ノートのタイトルは変更しない

### summary_generator

#### 目的
- 論文を要約して、対象ノートの下に追記する

#### 状態
- 実装済み
- OpenAI API を利用して要約を生成する（OpenAI固定 / Provider切替は未実装）

#### 実行トリガー（統合）

- `summary_generator` は単独コマンドではなく、コマンド `Create paper note from arXiv URL` の処理末尾に統合する
  - 実行順序は `title_extractor` → `paper_fetcher` → `summary_generator`
  - 途中で失敗した場合は、その時点で中断する（後続処理は実行しない）

#### 入力（要約対象）

- `paper_fetcher` が保存した HTML ファイルを入力とする
  - `path/to/{noteBaseName}/<id>.html`
- ネットワークからの再取得（`abs` 再取得等）は行わない
- HTML が存在しない（未取得/保存されていない/読めない）場合は要約を諦めて中断する
  - `Notice` で「HTML が無いため要約できない」等を通知する
  - ログに `result=NG` と `reason=<原因コード>` を必ず残す
    - 例: `result=NG reason=HTML_MISSING htmlPath=...`
    - 例: `result=NG reason=HTML_READ_FAILED htmlPath=... error=...`

##### 失敗時ログの reason（原因コード）

- `summary_generator` の失敗時は `result=NG` に加えて `reason=<原因コード>` を必須とする
- `reason` は機械的に集計/検索しやすい短い識別子とし、必要に応じて `error=...` や `path=...` 等の補足情報を付与する
- `reason` の例:
  - `HTML_MISSING`
  - `HTML_READ_FAILED`
  - `PROMPT_READ_FAILED`
  - `ENV_READ_FAILED`
  - `OPENAI_API_KEY_MISSING`
  - `OPENAI_REQUEST_FAILED`
  - `NOTE_WRITE_FAILED`
  - `NOTE_MOVED_OR_DELETED`

#### 出力（挿入位置・再実行時の挙動）

- ノート末尾に要約ブロックを挿入する
- 再実行時は「追記」ではなく「置換」とする
  - 置換の安定性のため、以下の目印コメントで囲む
    - `<!-- paper_extractor:summary:start -->`
    - `<!-- paper_extractor:summary:end -->`
  - 既存ブロックがあればその範囲を置換し、無ければ末尾に追加する

##### 置換ルール（実装を単純化するための前提）

- 検出は文字列探索（`indexOf` 等）で行う
  - `startMarker` と `endMarker` の両方が存在し、`startMarker` が `endMarker` より前にある場合のみ「置換」する
  - 上記以外（片方だけ存在、順序逆、複数存在など）は「既存ブロック無し」と見なし、末尾に追加する
- 置換時は `startMarker` から `endMarker` まで（両端のマーカー行を含む）を新しいブロックで置き換える
- 末尾に追加する場合は、ノート末尾に `\n\n` を付与してからブロックを挿入する（末尾の改行有無に依存しない）

#### 生成方式（OpenAI固定）

- OpenAI API を利用して要約を生成する（OpenAI固定 / Provider切替はしない）

##### 将来のProvider切替に備えた設計（実装を分離する）

- 現時点では OpenAI 固定とするが、将来的に Gemini 等へ拡張しやすいように、`summary_generator` は「LLM呼び出し部分」を直接持たない
- `summary_generator` は以下を担う（プロバイダ非依存のオーケストレーション）
  - HTML読み込み（無い場合は中断）
  - システムプロンプト読み込み
  - 進捗通知（Notice）
  - ノート末尾への挿入/置換
  - ログ（result/reason）
- LLM呼び出しは Provider 層として分離する
  - `LlmProvider` interface（`summarize(input) -> text`）を定義
  - OpenAI は `OpenAiProvider` として adapter 実装
  - 将来 Gemini を追加する場合は `GeminiProvider` を追加するだけで済むようにする
- Provider の生成は `createProvider(settings)` のような factory に寄せ、`summary_generator` 側は `LlmProvider` にのみ依存する

##### 将来HTML→PDF入力へ変更しやすくするための設計（入力ソースを分離する）

- 現時点では入力はHTML固定とするが、将来的にPDF入力（Gemini等のPDF要約）へ寄せたくなった場合に備え、入力ソース取得を `summary_generator` から分離する
- `summary_generator` は「要約対象ドキュメントの取得」を直接実装せず、Source 層に委譲する
  - `DocumentSource` / `SourceLoader` のような interface を用意し、`load()` で要約対象を取得する
  - 例: `HtmlSource`（Vault内の `<id>.html` を読む） / `PdfSource`（Vault内の `<id>.pdf` や PDF URL を扱う）
- Provider 層の入力型は将来のファイル入力を許容できる形にしておく
  - 現時点: `htmlText` のみを渡して要約
  - 将来: `text` に加えて `file`（PDFのURL/base64/file_id 等）を渡せる拡張を想定
  - これにより「入力がHTMLかPDFか」の差分は Source/Provider 側に閉じ、`summary_generator` は共通処理（通知・挿入/置換・ログ）に集中できる

#### システムプロンプト

- システムプロンプトは Vault 内のファイルから読み込む
  - パスは設定で指定する（例: `.obsidian/paper_extractor/system_prompt_summary.md`）
- プロンプトの内容は公開されても問題ない前提

#### APIキー管理（Gitに乗せない）

- APIキーは Vault 内に保存しない
- Vault 外の `.env` ファイルから読み込む
  - 例: `~/.config/paper_extractor/.env`
  - 期待するキー名: `OPENAI_API_KEY`
- `.env` ファイルのパスは設定で指定する（絶対パス固定）
- OpenAI のモデル名も Vault 外の `.env` ファイルから読み込む
  - 期待するキー名: `OPENAI_MODEL`
  - 未指定の場合はデフォルト値を用いる

##### `.env` サンプル（Vault外）

```dotenv
# Required
OPENAI_API_KEY="sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

# Optional (default: gpt-5.2)
OPENAI_MODEL="gpt-5.2"
```

#### 進捗通知（長時間処理）

- 高性能モデル利用により時間がかかる前提のため、段階的に `Notice` で進捗を通知する
  - 例: `(1/4) reading html` / `(2/4) loading prompt` / `(3/4) requesting AI` / `(4/4) writing note`
- OpenAI応答待ちの間、3秒ごとに `AI response waiting...` を定期表示する
- 失敗時は `Notice` に失敗理由（概要）を表示する（英語統一）

#### 非同期中のノート切替の扱い

- 実行開始時点で対象ノート（`TFile` または path）を確定し、そのノートに対して書き込む
- LLM応答待ちの間にユーザが別ノートを開いても、書き込み先は「開始時に確定したノート」を維持する
- 対象ノートが削除/リネームされた場合は失敗として扱い、`Notice` で通知する

## 開発指針

### メンテナンス方針

- 仕様変更時は `dev_memo.md` を更新してから実装に入る
- 破壊的変更（起動方法、URL取得方法、ノート生成方法、テンプレ仕様、ログ仕様など）の場合は、既存ユーザ向けの移行手順を併記する

### デプロイ手順（手動インストール / ローカル）

1. ビルド
   - `pnpm run build`
2. Vaultへ配置（手動）
   - Vault の `VaultFolder/.obsidian/plugins/paper_extractor/` を作成（無ければ）
   - このリポジトリ直下の下記ファイルをコピー
     - `main.js`
     - `manifest.json`
     - `styles.css`（あれば）
3. Obsidianで有効化
   - **Settings → Community plugins** で `paper_extractor` を有効化
4. 反映
   - `main.js` を更新したら、Obsidian をリロード（アプリ再起動 or コマンドでリロード）

## 実装計画（仕様変更：コマンド起動・URL入力・新規ノート・テンプレ適用）

### 目的

- リリース済みのプラグインを機能更新する
- コマンドパレット起動のみ（リボン廃止）
- arXiv URL は実行時にユーザ入力（Prompt）
- 新規ノートを Vault ルートに作成して処理
- テンプレートファイルを適用し、`{{url}}` を必須置換

### 影響範囲

- **UI/起動導線**
  - リボン起動の廃止（`addRibbonIcon` 削除）
  - コマンドパレット起動のみ（旧コマンド廃止、新コマンド追加）
  - URL入力のPrompt（1行入力ダイアログ）導入
- **設定**
  - テンプレートパス設定の追加（Vault内パス、必須）
  - 未設定時は処理中断＋Notice
- **テンプレート処理**
  - `{{url}}` 置換必須（未検出なら中断）
  - 将来のメタ情報注入に備えた拡張可能な実装が必要
- **ノート作成/保存先**
  - 新規ノートは Vault ルート固定
  - 一時名で作成し、`title_extractor` でリネーム
- **入出力フロー**
  - `url_01` 依存を撤廃し、入力URLを処理パイプラインへ引き回す
  - 既存の「アクティブノート前提」APIを置換
- **既存モジュール改修**
  - `main.ts`：フロー再設計（Prompt→テンプレ適用→新規ノート→3処理連結）
  - `settings.ts`：テンプレートパス設定追加
  - `note.ts`：テンプレ読み込み/URL注入/必須検証のユーティリティ追加
  - `title_extractor.ts`：対象ノート/URLの引数化
  - `paper_fetcher.ts`：対象ノート/URLの引数化
  - `summary_generator.ts`：対象ノート/URLの引数化
- **通知/ログ**
  - Noticeは英語統一を維持
  - 失敗原因コードの追加（テンプレ未指定/プレースホルダ欠如など）
- **サンプル機能の撤去**
  - `open-modal-*` / `replace-selected` / status bar / interval などのサンプルUI撤去
- **テスト更新**
  - URL入力、テンプレ未設定、`{{url}}` 不在、ノート作成失敗などのテスト追加

### 実装ステップ

1. **設定追加**
   - `templatePath`（Vault内パス、必須）を `settings.ts` に追加

2. **テンプレ適用ユーティリティ**
   - `loadTemplateAndInjectUrl(templatePath, url)` を追加
   - `{{url}}` が存在しない場合は `TEMPLATE_URL_PLACEHOLDER_MISSING` で中断
   - `templatePath` 未設定時は実行初期で中断（Noticeで通知）

3. **コマンドフロー刷新（main.ts）**
   - 新コマンド: `Create paper note from arXiv URL`
   - Prompt で URL 入力 → 検証 → テンプレ適用 → 新規ノート作成
   - title_extractor → paper_fetcher → summary_generator の順で実行
   - 旧コマンド・リボン・サンプルコマンドは削除
   - 新規ノートの一時名は `untitled_<timestamp>.md` 形式で衝突回避

4. **既存処理の引数化**
   - `extractAndRenameActiveNoteTitle` → `extractAndRenameNoteTitle(app, logDir, noteFile, url)`
   - `fetchAndSaveArxivFromActiveNote` → `fetchAndSaveArxiv(app, logDir, noteFile, url)`
   - `generateSummaryForActiveNote` → `generateSummary(app, settings, noteFile, url)`
   - `extractUrl01FromNoteBody` は廃止 or `@deprecated` 明記

5. **通知・ログの整合**

6. **テスト項目**
   - テンプレ未指定 / `{{url}}` 無し / URL不正 / 新規ノート作成失敗
   - 旧フロー削除後の基本動作確認

7. **移行ガイド（既存ユーザ向け）**
   - 旧フロー（アクティブノート/`url_01`依存/リボン起動）の廃止を明記
   - 新フロー（コマンド起動/URL入力/テンプレ適用）への切替手順を記載

8. **第三者レビューの追記事項**
   - `@deprecated` マークの付与（廃止予定のAPI/関数）
   - 一時名規則の明記（`untitled_<timestamp>.md`）
   - テンプレ未設定時のUX（Notice表示/エラー処理）
   - 既存ユーザへの移行ガイドの提供（ドキュメント/Notice）

## コードレビュワー向け：今回の修正要点

### 変更の狙い

- 既存の「アクティブノート + url_01」前提のフローを廃止し、**URL入力 + 新規ノート作成 + テンプレ適用**に刷新
- リボン起動・サンプルUIを削除し、**コマンドパレット起動のみ**に統一

### 主な改修点（ファイル別）

- `src/main.ts`
  - 新コマンド `Create paper note from arXiv URL` を追加
  - URL入力Prompt → テンプレ読み込み/`{{url}}` 置換 → 新規ノート作成（Vaultルート）
  - title_extractor → paper_fetcher → summary_generator の順で連結実行
  - リボン/サンプルコマンド/ステータスバー/interval を削除
- `src/note.ts`
  - `{{url}}` 注入ユーティリティ追加
  - `extractUrl01FromNoteBody` を `@deprecated`
- `src/title_extractor.ts`
- `src/paper_fetcher.ts`
- `src/summary_generator.ts`
  - いずれも **TFile + inputUrl 引数化**（アクティブノート依存を除去）
- `src/settings.ts`
  - `templatePath` 設定追加（Vault内パス・必須）

### 仕様/UXの注意点

- テンプレ未設定/`{{url}}` 不在時は **即中断 + Notice**
- 新規ノート名は `untitled_<timestamp>.md`（衝突回避）

### 主要ファイル差分の確認ポイント

- 旧API呼び出しの残存がないか（`extractAndRenameActiveNoteTitle` など）
- `templatePath` のバリデーションと `{{url}}` 検証が実装済みか
- 新フロー開始時に `logDir` / `templatePath` の必須チェックを行っているか

## 実装検討: 外部呼び出し（API公開）

ユーザ操作（コマンドパレット）に加えて、他プラグインやコンソール等から本プラグインの処理を呼び出せるようにする。

### 目的

- 他プラグインから arXiv URL を渡してノート作成+処理を実行したい
- Console / Templater 等から手動で実行できるようにしたい

### 想定する公開方法

- `app.plugins.getPlugin("paper_extractor")` でプラグインインスタンスを取得し、公開メソッドを呼び出す
- 必要に応じて `window` へ公開（Console等からアクセスしやすい）
  - ただし公開範囲が広くなるため、既定では無効（設定で opt-in を検討）

### 公開するAPI（案）

- `createPaperNoteFromUrl(url: string): Promise<string>`
  - コマンド `Create paper note from arXiv URL` と同等の処理を実行
  - 戻り値は作成したノートのパス（またはファイル名）

### 前提/注意点

- プラグインが無効な場合/未インストールの場合を考慮し、呼び出し側は存在チェックが必須
- 実行中フラグのロジックは外部呼び出しでも共通化する（二重実行防止）
- 外部呼び出し経由でもログ/Noticeの整合を保つ

## 備忘録: Obsidian プラグインからの MCP 連携

### 制約

- `@modelcontextprotocol/sdk` の `StdioClientTransport` は `child_process.spawn` 前提
- Obsidian（Electron）環境では spawn に制限あり

### 回避策

- HTTP API があるサービスなら MCP を使わず直接呼び出し
- HTTP bridge 経由で外部 MCP サーバーに接続
- Obsidian 外部で MCP 処理し、結果をファイル経由で受け渡し

## 開発計画と進捗

- [x] `paper_fetcher` 実装
- [x] `title_extractor` 実装
  - [x] 要件整理
  - [x] 実装
  - [x] テスト
- [x] 連打・並行実行防止（実行中フラグ）
- [x] ログ（`.log`）の強制redaction（Git管理前提の事故防止）
  - [x] `logger` 層での強制redaction（保存前のマスキング、失敗時は固定メッセージのみ）
  - [x] エラー情報の保存を `formatErrorForLog`（`errorSummary`）へ統一
  - [x] 合成データでのredaction検証（ダミーAPIキー/Authorizationが `***REDACTED***` になることを確認）
  - [x] Vaultへデプロイ（`main.js` / `manifest.json` / `styles.css` を配置）
- [x] `summary_generator` 実装
  - [x] 要件整理
  - [x] 実装
  - [x] 通知英語化・定期Notice（3秒ごと）
  - [x] テスト
- [ ] OpenAI API `/v1/responses` へのマイグレーション
  - [ ] `/v1/responses` API 仕様調査（リクエスト/レスポンス形式）
  - [ ] `callOpenAiResponses()` 実装（`/v1/chat/completions` とは別関数）
  - [ ] エンドポイント自動選択（モデルに応じたフォールバック or 設定）
  - [ ] `/v1/chat/completions` 廃止（将来的に `/v1/responses` へ統一）
  - 背景: `gpt-5.1-codex-mini` 等の新モデルは `/v1/responses` のみ対応
- [x] AIプロバイダ層の分離（設計思想の実装）
  - [x] `LlmProvider` interface 定義（`summarize(input) -> text`）
  - [x] `OpenAiChatProvider` 実装（`/v1/chat/completions` 用）
  - [x] `GeminiProvider` 実装（Gemini API `generateContent` 用）
  - [ ] `OpenAiResponsesProvider` 実装（`/v1/responses` 用）
  - [x] `createProvider(settings)` factory 実装
  - [x] `summary_generator` から LLM 呼び出しロジックを分離し `LlmProvider` に依存
  - [x] 将来の拡張: `GeminiProvider` 等の追加を容易にする
  - 背景: 現状は `summary_generator.ts` にOpenAI呼び出しがベタ書きされており設計思想が未実装
- [x] ログ補強（`summary_generator` 開発時にまとめて実施）
  - [x] セキュリティ（redaction強制）
  - [x] 追跡性の追加（OpenAI APIエラー時の詳細情報: `type`, `code`, `message` をログ出力）  
- [ ] Auto Tagging
  - [ ] 仕様検討
    - 要約文章から適切なタグをつける
      - タグは `{{tags}}` プレースホルダで置換
      - 参照ファイル(ex. tag_list.md)から適切なtagを選ぶ, 既存のタグから選ぶ, 新しいタグを作る
  - [ ] 実装
  - [ ] テスト
- [ ] メタ情報の充実化
  - [ ] プレースホルダ（オプション）
    - `{{author}}`（著者）
    - `{{pub_date}}`（公開日）
    - `{{updated_date}}`（更新日）
    - `{{category}}`（カテゴリー）
  - [ ] テンプレート内に存在するプレースホルダのみ置換（現行の `{{date}}` / `{{time}}` と同様に未指定なら無視）
  - 参考
    ```
    タグ取得のAPI
      Obsidian APIには主に以下の方法があります：

      getAllTags(cache): 特定のファイルのメタデータキャッシュから、フロントマターと本文の両方のタグを配列として取得します

      app.metadataCache.getTags(): vault全体のすべてのタグを取得する非公式メソッドです。公式ドキュメントには記載されていませんが、多くのプラグイン開発者が利用しています

      実装例
      vault内のすべてのタグを取得する典型的な実装パターンは以下です：
      ​

      typescript
      import { getAllTags } from 'obsidian';

      const files = app.vault.getMarkdownFiles();
      const tagSet = new Set<string>();

      for (const file of files) {
        const cache = app.metadataCache.getCache(file.path);
        if (cache) {
          getAllTags(cache)?.forEach((tag) => {
            tagSet.add(tag);
          });
        }
      }
      この方法では、各ファイルのメタデータキャッシュからタグを取得するため、ファイル本体を再パースする必要がなく効率的です。Tag Wranglerなどの人気プラグインでも、このAPIを使ってタグの一覧表示やリネーム機能を実装しています。
    ```
- [ ] 外部連携（API公開）
  - [x] 実装方針の記載（dev_memo の「実装検討: 外部呼び出し（API公開）」）
  - [ ] 実装（公開メソッド/API surface）
- [x] 既存の添付ディレクトリがある場合は中断せず、内部ファイルを上書きするように修正
- [x] ドキュメント更新
  - [x] `dev_memo.md` を現行フロー（コマンド起動・URL入力・新規ノート・テンプレ適用）に合わせて整理
  - [x] 外部呼び出し（API公開）機能の実装検討セクションを追加
  - [x] `README.md` を現行仕様に合わせて英語で刷新
  - [x] `.env` の準正常系（`summaryEnabled` / `LLM_PROVIDER` / `OPENAI_MODEL`）の挙動説明を追記
  - [x] Troubleshooting の冗長な重複説明を簡潔化
- [ ] Deep Research アドバンス機能（GPT Researcher 連携）
  - 概要: 論文要約後、GPT Researcher MCP Server https://github.com/assafelovic/gpt-researcher を呼び出して統合リサーチレポートを生成
  - 入力: 対象論文 PDF + 要約
  - 処理: Vault 内関連ノート検索 + Web 検索（関連論文、著者の他論文、引用関係等）
  - 出力: `{noteBaseName}/research_report.md`
  - 依存: GPT Researcher MCP Server (`deep_research`, `write_report` 等のツール)
  - Deploy: 案1 Cloud Run+公式Docker(ローカルのVaultを対象にできない、複雑) , 案2: ローカルDocker(こっちのほうがシンプル？各PCでDocker操作は必要)
  - 要検討事項: embeddingの構築をするかしないか
  - [ ] 方針検討
  - [ ] 設計
  - [ ] 実装
  - [ ] テスト
- [ ] Deep Research シンプル機能（GPT Researcher 連携）
  - 概要: 論文要約後、OpenAIもしくはGeminiのDR APIを使いWebのソースからDeep Researchを行い、指定のディレクトリのレポートを保存する。
  - DR対象: Webソースとし、Vault内は対象外
  - メリット: AI ProviderのAPIを利用することで開発工数がかなり下がる。
  - [ ] 方針検討
  - [ ] 設計
  - [ ] 実装
  - [ ] テスト

# Deep Research シンプル機能の実装詳細

本計画は、論文ノート生成フローの最後に provider-native Deep Research（Gemini）を自動実行し、Webソース由来の調査レポートをVaultに保存するための要件整理と詳細設計を定義します。

## スコープ

- 対象（やること）
  - 既存フロー（ノート作成→リネーム→HTML/PDF取得→要約）の**要約完了後**に、Deep Research（シンプル）を**自動実行**する。
  - Deep Research は **provider-native Deep Research API** を使い、**Webソースのみ**を対象に調査する（Vault内検索はしない）。
  - 調査レポート（Markdown）を Vault 内の指定フォルダへ保存する。
  - ログは既存と同様に redaction 強制、`reason` を付与し、ユーザーには Notice で進捗/結果を通知する。

- 非対象（やらないこと）
  - PageIndex 統合（中止）。
  - GPT Researcher MCP Server 連携（アドバンス機能側）。
  - Vault 内コンテンツを対象とした Deep Research。

## 現状アーキテクチャ（リポジトリ確認済み）

- **コマンド/オーケストレーション**: `src/main.ts`
  - テンプレノート作成 → タイトルリネーム → HTML/PDF取得 → 要約生成（`summary_generator`）を直列で実行。
  - `runExclusive` で並行実行を防止。

- **LLM provider 抽象**: `src/llm/*`
  - `createProvider(settings)` が `settings.envPath` の `.env` を読み込み provider を選択。
  - `.env` の `LLM_PROVIDER` により `openai` / `gemini` を切替。
  - 既存: OpenAI は `OPENAI_MODEL` 空でスキップ（`OPENAI_MODEL_EMPTY_SKIP`）。
  - 既存インターフェース: `LlmProvider.summarize({systemPrompt,userContent})`。

- **要約生成オーケストレーション**: `src/summary_generator.ts`
  - 保存済みHTMLを読み込み、system prompt を読み込み、`createProvider` → `provider.summarize`。
  - 要約ブロックをノートへ upsert。

## 要件（A: Deep Research シンプル）

### ユーザーストーリー

- ユーザーとして、論文ノート作成と要約が完了したら、同じ対象ノートに紐づく Deep Research（Web調査）を自動実行し、調査レポートをVaultに保存したい。

### 入力

- DRクエリ/指示（固定。ユーザーが作成）
  - `deepResearchPromptPath`（Vault相対パス）で指定したファイルの内容をそのまま使う
- 論文コンテキスト
  - 生成済みの要約（summary ブロック）全文を入力に含める
  - arXiv URL を入力に含める

- 論文コンテキストの投入方式（決定）
  - 方針: **固定プロンプト（Deep Research 指示） + 追加コンテキスト**の形で投入する。
  - 追加コンテキストは **要約全文 + arXiv URL** を渡す。

- 実装上の扱い
  - 固定のDRクエリ/指示（`deepResearchPromptPath` の中身）は、そのまま投入する。
  - こちらでは DRクエリ/指示の生成や要約・言い換え等の加工はしない。
  - 要約全文 + arXiv URL を渡して Deep Research を実行する。
- 要約抽出（既存）
  - 既存の summary ブロック抽出処理を流用する。

### 出力

- Vault 内に Markdown レポートを保存する。
- 保存先: **paper_extractor が生成した添付ディレクトリ内**
  - 例: `path/to/<noteBaseName>/<arxivId>_deep_research.md`
- ファイル名は衝突回避・検索性重視
  - 例: `<arxivId>_deep_research.md`（同一論文で上書き運用）

### 安全性/課金コントロール

- 本機能は自動実行だが、事故防止のために **明示的にONできる設定**を設ける（例: `deepResearchEnabled`）。
- Deep Research は Gemini 固定のため、`.env` の `LLM_PROVIDER` が `openai` の場合は **DRはスキップ**し、ログに理由を記録する。
- トグルがONでGemini の認証情報が取得できない場合は、**エラーでログに記録してDRを終了**。
  - 具体例: `.env` から `GEMINI_API_KEY` を取得できない。
- ログは秘密情報を絶対に出さない（既存の redaction 方針を踏襲）。
- Notice で進捗を通知する（開始/調査中/完了/失敗）。
  - 調査中 Notice は `deepResearchNoticeIntervalSec`（秒）で表示する。
  - Notice messageは "DR: <arxivId> undergoing" とする。

### UX

- 実行タイミング
  - **要約（`summary_generator`）の直後に自動実行**。
- 対象ノート
  - 既存フローの対象ノート（要約を書き込んだノート）をそのまま Deep Research の対象とする。
- 長時間処理の扱い
  - Gemini Deep Research が非同期/ポーリング型フォアグラウンド（最小実装）で開始し、将来は永続化（再起動再開）を検討。

## 詳細設計

### 1) 実行ポイント（エントリポイント）

- `src/main.ts` の既存パイプラインに組み込む
  - `await generateSummary(...)` の後に `await runDeepResearchSimple(...)` を呼ぶ。
  - これにより「当然その対象（要約対象ノート）」を担保。

（補助）デバッグ/手動実行用コマンドは将来追加しても良いが、MVPでは不要。

### 2) 設定（MyPluginSettings）

追加（Vault path は Vault 相対を基本とする）:

- `deepResearchEnabled: boolean`（デフォルト: false）
  - true の時だけ自動実行
- `deepResearchPromptPath: string`（Deep Research 用の prompt。要約用とは別ファイル）
- `deepResearchNoticeIntervalSec: number`（デフォルト: 5）
- `deepResearchMode: 'foreground' | 'background'`（初期は `foreground`、将来 `background`）

将来（phase 2）:
- `deepResearchJobs: Array<{ id, startedAt, notePath, outputPath, status }>` を `saveData()` で永続化

### 3) `.env` 変数

方針: **Gemini 固定**。

- 必須
  - `LLM_PROVIDER=gemini`
  - `GEMINI_API_KEY=...`
  - `GEMINI_MODEL=...`（既存の provider 初期化に必要）

Deep Research でモデルを分けたい場合は、将来
- `GEMINI_DR_MODEL`
を追加する（MVPでは `GEMINI_MODEL` を流用しても良い）。

重要: Gemini のキーが取得できない場合は **エラーで中止**（スキップしない）。

- `LLM_PROVIDER=openai` の場合
  - Deep Research は **実行しない（スキップ）**
  - ログに理由を記録する（例: `DR_PROVIDER_NOT_GEMINI_SKIP`）

### 4) Provider 抽象の拡張

要約用 `summarize` と Deep Research は責務が異なるため、同じメソッドに混ぜない。

- 新規インターフェース案: `DeepResearchProvider`
  - `start(params) -> { id }`（非同期開始）
  - `get(id) -> { status, output }`

または provider が同期1発で返せるなら
- `run(params) -> markdownReport`

Factory は
- `createDeepResearchProvider(settings)` を新設（`createProvider` とは分離）
を推奨。

### 5) オーケストレーション（新規モジュール）

`src/deep_research_simple.ts`（仮）を追加し、責務を `main.ts` から分離する。

- 入力: `app`, `settings`, `noteFile`, `inputUrl`
- `summary` ブロックを抽出
- prompt 読み込み（`deepResearchPromptPath`）
- Gemini Deep Research API 呼び出し
- レポート保存（`deepResearchOutputDir`）

### 6) ログ/Reason 設計

既存の `startLogBlock` / `endLogBlock` 形式に合わせる。

- 例: `component=deep_research_simple notePath=... id=... provider=gemini model=...`

reason 候補:
- `DR_DISABLED_SKIP`（設定OFFのためスキップ）
- `DR_ENV_PATH_MISSING` / `DR_ENV_READ_FAILED`
- `DR_LLM_PROVIDER_INVALID`（`LLM_PROVIDER!=gemini`）
- `DR_GEMINI_API_KEY_MISSING`（必須。ここは NG で中止）
- `DR_GEMINI_MODEL_MISSING`（必須。ここは NG で中止）
- `DR_PROMPT_READ_FAILED`
- `DR_INPUT_MISSING`（summary ブロックが無い等）
- `DR_REQUEST_FAILED`
- `DR_WRITE_FAILED`
- `DR_OK`

### 7) バックグラウンド/再開（phase 2）

Gemini がポーリング必須の場合、以下を永続化して再起動後に再開できる設計にする。

- job id
- output path
- started time

`onload()` で未完了ジョブを定期チェックする（`registerInterval`）。

## 決定事項（ユーザー確定）

- 対象ノート: 要約の対象ノート（同一 `noteFile`）
- 実行タイミング: 自動（要約の直後）
- DRクエリ/指示: 固定（ユーザーが用意した文面を `deepResearchPromptPath` から読み込んで使用）
- Provider: Gemini 固定
  - `.env` から Gemini のキーが取れない場合は **エラーで中止**

## 受け入れ条件（Acceptance criteria）

- `deepResearchEnabled=true` の場合、要約完了後に Deep Research が自動実行される。
- `.env` が読めない、または `LLM_PROVIDER!=gemini` の場合は NG で中止し、Notice と `reason` が残る。
- `GEMINI_API_KEY` / `GEMINI_MODEL` が取得できない場合は NG で中止し、AIリクエストは行わない。
- 成功時、VaultにレポートMarkdownが作成され、Noticeで完了が分かる。
- ログに秘密情報が出ない（redaction強制）。

## 失敗時の影響範囲（重要）

- Deep Research は **要約の後段**で動くため、DRが失敗しても
  - タイトルリネーム
  - HTML/PDF保存
  - 要約の書き込み
 には影響しない（既に完了している前段をロールバックしない）。
- 失敗時は
  - Noticeで失敗を通知
  - ログに `result=NG reason=...` を残す
  だけを行い、コマンド全体としては「DR失敗」で終了する。

## Reference
Instruction prompt sample:

```
This is instruction prompt to creat deep research report based on added {context}.

# Condition
{context} is a scientific paper acquired from arxive site.
Created Deep research output is for human reader who understand the abstract and details of {context}.

# Needs
Deep research aims to investigate web to find out the following additional info cohered with {context}
- Domain information
  - Overview of the specific domain that {context} related make clear overall understanding to the research domain.
- Histrical trend
  - The historical information of the domain, how the domain technologies developed, what was the original science tech and more.
- Similar researches list
  - Similar and competitive recent researched to {context}

# Requirement
The output must be in Lang:JA.
```