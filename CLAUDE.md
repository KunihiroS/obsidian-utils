# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm install          # install dependencies
pnpm run dev          # watch build (esbuild, outputs main.js)
pnpm run build        # type-check (tsc --noEmit) then production bundle
pnpm run lint         # eslint (typescript-eslint + eslint-plugin-obsidianmd)
```

No automated test suite. Testing is manual: copy `main.js` + `manifest.json` + `styles.css` to `<Vault>/.obsidian/plugins/paper_extractor/` and reload Obsidian.

## Architecture

This is an **Obsidian Community Plugin**. TypeScript in `src/` is bundled by esbuild into `main.js` (the release artifact).

### Pipeline (triggered by the single command "Create paper note from arXiv URL")

```
main.ts (orchestrator)
  └─ note.ts            loadTemplateAndInjectUrl()   → inject URL into template, create temp note
  └─ title_extractor.ts extractAndRenameNoteTitle()  → fetch <meta citation_title>, rename note
  └─ paper_fetcher.ts   fetchAndSaveArxiv()          → download HTML + PDF into sibling folder
  └─ summary_generator.ts generateSummary()          → read HTML, call LLM, write summary block
```

`main.ts` uses `runExclusive` (a simple `isBusy` flag) to prevent concurrent runs.

### Module responsibilities

| File | Responsibility |
|---|---|
| `src/main.ts` | Plugin lifecycle, command registration, URL prompt modal, pipeline orchestration |
| `src/settings.ts` | `MyPluginSettings` interface, defaults, settings tab UI |
| `src/arxiv.ts` | Parse arXiv ID from URL, build HTML/PDF download URLs |
| `src/note.ts` | Load Vault template, replace `{{url}}` / `{{date}}` / `{{time}}` |
| `src/title_extractor.ts` | Fetch arXiv HTML, extract `<meta name="citation_title">`, rename note |
| `src/paper_fetcher.ts` | Download HTML/PDF via `requestUrl`, write to attachment folder |
| `src/summary_generator.ts` | Summary pipeline; idempotent block (HTML comment markers) |
| `src/logger.ts` | Structured key=value log blocks, appended to daily log files, redacts secrets |
| `src/llm/types.ts` | `LlmProvider` interface (`summarize()`) |
| `src/llm/env.ts` | Read external `.env` file (Vault-external, absolute path) |
| `src/llm/createProvider.ts` | Builds the fixed OpenAI → Codex → Gemini provider chain from `.env` |
| `src/llm/providers/` | Concrete providers: `openai_chat_provider.ts`, `codex_oauth_provider.ts`, `gemini_provider.ts` |

### Key design decisions

- **LLM credentials** live in an external `.env` file (absolute path configured in settings), never inside the Vault.
- **Summary blocks** are wrapped in `<!-- paper_extractor:summary:start/end -->` markers, making re-runs idempotent (replace rather than append).
- **Attachment folder** mirrors the note path: note at `path/to/Title.md` → attachments at `path/to/Title/<arxivId>.html/.pdf`.
- **`createProviderChain`** always attempts providers in the fixed OpenAI API key → Codex OAuth → Gemini API key order; missing configuration and provider failures fall through to the next attempt.
- **`isDesktopOnly: true`** in `manifest.json` — uses Node/filesystem APIs not available on mobile.

## TypeScript strictness

`tsconfig.json` enables `noImplicitAny`, `noImplicitReturns`, `strictNullChecks`, `noUncheckedIndexedAccess`, `useUnknownInCatchVariables`. Always satisfy these; do not cast to `any` without justification.

## Releasing

1. Bump `version` in `manifest.json` (SemVer, no leading `v`).
2. Run `pnpm run version` to update `versions.json` and stage both files.
3. Create a GitHub release tagged exactly as the version string.
4. Attach `main.js`, `manifest.json`, `styles.css` as release assets.

## AMC Context Model
```yaml
purpose: ユーザーが特定の研究資料（特に arXiv）を効率的に収集・管理し、外部 LLM API（OpenAI/Gemini）や MCP サーバーを介した高度な要約機能を持つ、自動化された研究ノート作成ワークフローを構築すること。
purpose_confirmed: false
approach: null
plan:
  completed: []
  current: null
  next: []
```
