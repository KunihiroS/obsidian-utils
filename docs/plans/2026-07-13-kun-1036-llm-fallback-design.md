# KUN-1036 LLMフォールバック設計

## 目的

要約生成を `OpenAI API Key → Codex OAuth backend direct → Gemini API Key` の固定順で試行し、Provider段階の失敗時に次経路へ進む。ローカル前提確認とノート書き込みはProvider連鎖の外側に置き、完成した要約を一度だけ書き込む。

## 承認済み方針

- Codex経路はCLI subprocessではなく、既存の `~/.codex/auth.json` をread-onlyで利用するbackend direct adapterとする。
- Codex authは各要約要求で読み直す。401時のみ一度再読込・再試行し、なお失敗する場合はGeminiへ進む。
- refresh tokenは使用せず、Codex所有のauth stateを更新しない。独自refreshはtoken rotationとCodex CLIとの競合を起こし得るため採用しない。
- `CODEX_MODEL` は任意設定とし、未設定時はcontrolled probeで成功した `gpt-5.4-mini` を使う。
- Providerで発生した例外は種類を問わず次経路へ進む。HTML、prompt、note read/writeなどのローカル失敗はフォールバック対象外とする。

## 構造

### Provider adapter

- `OpenAiChatProvider`: 既存OpenAI Chat Completions経路。
- `CodexOAuthProvider`: Codex auth JSONの安全な読取、JWT payloadからのaccount ID解決、Responses SSE要求、401時一回再読込を担当する。
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
- fake secretを含むerrorのredaction
- `pnpm run test`、`pnpm run lint`、`pnpm run build`

## 非対象

- OAuth refresh tokenの使用・更新
- Codex auth JSONへの書き込み
- Codex CLI subprocess
- Provider間の途中出力継続
- 稼働中Vaultへの配布とLinear Done
