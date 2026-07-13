# KUN-1036 LLM Fallback Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** 要約生成をOpenAI、Codex OAuth backend direct、Geminiの固定順で安全にフォールバックさせる。

**Architecture:** Provider adapterとProvider chainを分離し、各adapterは完成文字列だけを返す。summary generatorはローカル前提確認後にchainを実行し、最初の成功結果だけをidempotent blockへ一度書き込む。

**Tech Stack:** TypeScript、Obsidian `requestUrl`、Node `fs/promises`、Node標準test harness + jiti、esbuild。

---

### Task 1: Provider chainのREDテストを追加する

**Objective:** 固定順、short-circuit、全Provider失敗、timeout、attempt記録をテストで契約化する。

**Files:**
- Create: `test/llm_fallback.test.mjs`
- Create: `src/llm/fallback.ts`
- Modify: `package.json:7-12`

**Step 1:** fake providerを使い、OpenAI成功時に後続を呼ばないテストを書く。

**Step 2:** OpenAI失敗→Codex成功、OpenAI/Codex失敗→Gemini成功、全失敗を追加する。

**Step 3:** timeoutしたProviderのlate completionが成功結果にならず、次Providerへ進むテストを書く。

**Step 4:** `pnpm run test` を実行し、未実装APIでFAILすることを確認する。

**Step 5:** 最小の`ProviderAttempt`、`FallbackResult`、`summarizeWithFallback()`を実装する。

**Step 6:** 再実行してPASSを確認する。

### Task 2: Provider chain生成を固定順へ変更する

**Objective:** credential/model不足を含め、3経路を常に固定順のattemptとして生成する。

**Files:**
- Modify: `src/llm/env.ts:4-12,45-62`
- Modify: `src/llm/createProvider.ts:1-75`
- Test: `test/llm_fallback.test.mjs`

**Step 1:** `.env`から`CODEX_MODEL`を読み、未設定時に`gpt-5.4-mini`を採用するテストを書く。

**Step 2:** API key/model不足でもchain生成自体は成功し、該当attemptだけが失敗するテストを書く。

**Step 3:** `createProviderChain()`を実装し、`LLM_PROVIDER`を選択スイッチとして使わない固定順へ変更する。

**Step 4:** テストを実行してPASSを確認する。

### Task 3: Codex OAuth backend direct adapterをTDD実装する

**Objective:** Codex authをread-onlyで再利用し、Responses SSEから完成要約を取得する。

**Files:**
- Create: `src/llm/providers/codex_oauth_provider.ts`
- Test: `test/codex_oauth_provider.test.mjs`
- Modify: `package.json:7-12`

**Step 1:** dependency injectionしたfake auth reader/HTTP clientで、auth missing・token missing・account ID missing・unknown auth mode/shapeをテストする。

**Step 2:** `tokens.account_id`優先、request body/header名、`throw:false`、SSE delta結合とcompleted判定をテストする。secret値そのものはassert failure outputへ含めない。

**Step 3:** 初回401でauthを再読込し、account ID一致時だけ一度再試行するテストを書く。不一致/欠落時は再送せず、二度目の401では失敗する。

**Step 4:** providerがauth readerへreadだけを要求し、write APIを持たないことをテスト構造で固定する。raw auth/HTTP/parser errorは固定コードへ変換し、JWT、refresh token、account ID、auth JSON断片をevent/errorへ渡さないことを確認する。

**Step 5:** Linux safe-open境界（`O_NOFOLLOW`、regular file、owner、permission、1 MiB上限、partial JSON）をfake file handleでテストする。

**Step 6:** malformed/failed/completedなし/空出力を含むSSE失敗境界をテストする。

**Step 7:** 最小実装を追加し、対象テストをPASSさせる。

### Task 4: Summary generatorへchainを統合する

**Objective:** ローカル前提の外側でProvider連鎖を動かし、成功結果を一度だけ書き込む。

**Files:**
- Modify: `src/summary_generator.ts:131-197,230-242`
- Modify: `src/logger.ts:10-56`（必要なredaction export/testabilityのみ）
- Modify: `manifest.json`（Node filesystemを使うruntime実態に合わせdesktop-only化）
- Test: `test/llm_fallback.test.mjs`
- Create: `test/summary_generator.test.mjs`

**Step 1:** attempt callbackの開始/失敗/成功イベントとnormalized reasonをテストする。

**Step 2:** summary generatorがchain結果のprovider/modelを最終ログへ記録するよう変更する。

**Step 3:** `generateSummary()`統合テストで、Codex/Gemini成功のsingle write、timeout後late Primaryの隔離、既存summary block置換、全経路失敗時の本文byte-identicalを確認する。

**Step 4:** HTML missing/read error、prompt missing/invalid/read errorでchain未起動、note moved/read/write failureで後続Providerへ戻らないlocal-stage exclusionテストを追加する。

**Step 5:** allowlist外のError/TypeError/non-Error throwを含む全Provider-stage failureが次attemptへ進むtable testを追加する。

**Step 6:** fake JWT、refresh token、account ID、auth JSON、Authorizationを含むProvider errorがattempt/end logの全sinkへ入らないテストを追加する。

**Step 7:** テストを実行してPASSを確認する。

### Task 5: 設定・READMEを実効動作へ合わせる

**Objective:** 必須credential、固定順、Codex read-only境界、全失敗時動作を文書化する。

**Files:**
- Modify: `src/settings.ts:67-76`
- Modify: `README.md:20-74,123-150`

**Step 1:** Settingsの`.env`説明を固定fallback chainに合わせる。

**Step 2:** READMEの`.env`例へ任意`CODEX_MODEL`を追加し、`LLM_PROVIDER`選択方式を廃止予定/非使用として整理する。

**Step 3:** Provider-stage/local-stage境界、Codex auth read-only、401再読込、Gemini fallback、secret handlingを記載する。

### Task 6: 全体検証と成果物境界を確認する

**Objective:** source変更が全gateを通り、生成物・秘密値をコミットしないことを確認する。

**Files:**
- Verify only

**Step 1:** `pnpm run test`を実行し全テストPASSを確認する。

**Step 2:** `pnpm run lint`を実行しPASSを確認する。

**Step 3:** `pnpm run build`を実行しPASSを確認する。

**Step 4:** `git diff --check`、`git status --short`、secret-like pattern検索を実行する。

**Step 5:** generated `main.js`をコミット対象から除外し、test temp artifactが残っていないことを確認する。

**Step 6:** Linear KUN-1036へTDD/verification結果を書き戻す。稼働中Vaultへの配布、PR merge、Linear Doneは別gateとして残す。
