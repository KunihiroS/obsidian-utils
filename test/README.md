# Test assets for title extraction bug

## Files

- `bug_fix_plan.md`
  - バグ修正計画書
- `fixtures/arxiv_abs_2509_19783_decoded_quotes.html`
  - `citation_title` 内に実際の `"` を含む再現ケース
- `fixtures/arxiv_abs_content_first_quotes.html`
  - `content` 属性が先に来るパターンの再現ケース
- `fixtures/arxiv_abs_missing_citation_title.html`
  - `citation_title` が存在しない異常系
- `title_parser.test.mjs`
  - `src/title_parser.ts` をローカルで検証するテストスクリプト

## Intended usage

- `src/title_extractor.ts` の `extractCitationTitleFromAbsHtml` の手動確認用データです。
- 期待値:
  - `arxiv_abs_2509_19783_decoded_quotes.html`
    - `Agentic Metacognition: Designing a "Self-Aware" Low-Code Agent for Failure Prediction and Human Handoff`
  - `arxiv_abs_content_first_quotes.html`
    - `A "Quoted" Title With Content First`
  - `arxiv_abs_missing_citation_title.html`
    - `citation_title not found` エラー

## Notes

- ここでは `requestUrl` のデコード後を模した HTML も含めています。
- 必要に応じて今後ケースを追加してください。
- 実行コマンド: `pnpm test`
