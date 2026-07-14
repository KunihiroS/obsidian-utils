# KUN-1036 LLMフォールバック設計

## 目的

要約生成を `OpenAI API Key → Codex OAuth backend direct → Gemini API Key` の固定順で試行し、Provider段階の失敗時に次経路へ進む。ローカル前提確認とノート書き込みはProvider連鎖の外側に置き、完成した要約を一度だけ書き込む。

## 承認済み方針

- Codex経路はCLI subprocessではなく、既存の `~/.codex/auth.json` をread-onlyで利用するbackend direct adapterとする。
- Codex authは各要約要求で読み直す。401時のみ一度再読込し、初回と再読込後のaccount IDが完全一致する場合だけ再試行する。不一致・欠落・二度目の401はCodex失敗としてGeminiへ進む。
- refresh tokenは使用せず、Codex所有のauth stateを更新しない。独自refreshはtoken rotationとCodex CLIとの競合を起こし得るため採用しない。
- `CODEX_MODEL` は任意設定とし、未設定時はcontrolled probeで成功した `gpt-5.4-mini` を使う。
- Providerで発生した例外は種類を問わず次経路へ進む。HTML、prompt、note read/writeなどのローカル失敗はフォールバック対象外とする。

## 構造

### Provider adapter

- `OpenAiChatProvider`: 既存OpenAI Chat Completions経路。
- `CodexOAuthProvider`: Codex auth JSONの安全なread-only読取、Responses SSE要求、401時のaccount一致付き一回再読込を担当する。
- `GeminiProvider`: 既存Gemini generateContent経路。

各adapterは `LlmProvider.summarize()` で完成文字列を返し、Vaultへ書き込まない。

### Provider chain

`createProviderChain()` は固定順のattempt descriptorを生成する。credential/model不足もProvider-stage failureとして表現し、chain全体の生成を失敗させない。

`summarizeWithFallback()` は各attemptを順に実行し、最初の成功でshort-circuitする。各要求へ同じper-provider timeoutを適用し、失敗を正規化して安全なattempt logへ渡す。全失敗時だけ集約エラーを返す。

### Summary generator

既存のHTML/prompt読取を完了してからProvider chainを開始する。成功結果を受け取った後だけ最新noteを再取得し、既存idempotent summary blockを一度更新する。Providerのlate completionは書き込み経路へ接続しない。

## Codex外部契約

2026-07-13にCodex CLI 0.135.0の公式source（`openai/codex` tag `rust-v0.135.0`）とcontrolled live probeで確認した。

- Base URL: `https://chatgpt.com/backend-api/codex`
- Responses endpoint: `/responses`
- Auth header names: `Authorization`, `ChatGPT-Account-ID`
- Transport: HTTP POST + SSE
- Probe result: HTTP 200、`response.created`から`response.completed`、期待markerを確認

このrouteは公開安定APIとは扱わず、adapterへ隔離する。endpoint/header/model/auth driftはCodex Provider failureとしてGeminiへ進む。

### Auth file安全境界

- 対応modeは現在実証済みのtop-level `auth_mode="chatgpt"`、`tokens.access_token`、`tokens.account_id`に限定する。`tokens.account_id`を第一契約とし、未知mode、keyring-only、Agent Identity、未知shapeは安全なProvider failureにする。未知fieldは無視する。
- Linuxでは`O_RDONLY | O_NOFOLLOW`でopenし、同じfile descriptorを`fstat`してregular file、現在user所有、group/world permissionなし、上限1 MiB以下を確認してから同じdescriptorで読む。symlink、directory、owner不一致、緩いpermission、巨大/partial JSONは固定エラーコードで失敗する。
- JWT claimをaccount IDの推測fallbackとして利用しない。token/account/auth JSONの値はadapter外へ返さない。
- Codex adapterはraw filesystem/HTTP/parser error、response body、headersを上位へ返さず、`CODEX_AUTH_*`、`CODEX_HTTP_*`、`CODEX_RESPONSE_*`の固定コードへ変換する。logger redactionは二次防御とする。

### Transport・timeout境界

- Obsidian `requestUrl`は`throw:false`で使用し、HTTP statusをadapterで判定する。SSEはstreaming表示せず、buffered responseとして解析する。
- `requestUrl`にはAbortSignalがなく、timeout後も通信自体はcancelできない。chainはlate resultを隔離してnote writeへ接続しないが、次Provider要求と一時的に重なる可能性を互換性制約として受容する。
- 真のtransport cancellationやdesktop helper/subprocessは本Issueで追加しない。
- Node filesystem/home依存は既存実装にも存在するため、runtime実態に合わせ`manifest.json`をdesktop-onlyへ修正する。

## エラーとログ

ログにはprovider、model、attempt順、結果、正規化reason、最終成功経路を記録する。token、API key、Authorization値、account ID、auth JSON内容は記録しない。

正規化reasonは観測可能性のために使い、フォールバック可否を限定するallowlistには使わない。Provider adapter/timeoutから投げられたすべての失敗が次経路へ進む。

## テスト

- Primary成功時のshort-circuit
- OpenAI失敗→Codex成功
- OpenAI/Codex失敗→Gemini成功
- 全失敗とno-write
- config/auth/HTTP/timeout/invalid/emptyを含むProvider失敗
- local-stage failureでchainを起動しない境界
- Codex SSE parse、401一回再読込、auth file read-only
- 401再読込時のaccount一致、不一致時no-retry
- auth fileのsymlink/owner/permission/size/schema境界
- buffered/non-cancellable timeout後もlate resultがsingle writeへ入らないこと
- fake secretを含むerrorのredaction
- `pnpm run test`、`pnpm run lint`、`pnpm run build`

## 非対象

- OAuth refresh tokenの使用・更新
- Codex auth JSONへの書き込み
- Codex CLI subprocess
- Provider間の途中出力継続
- 稼働中Vaultへの配布とLinear Done
