# タイトル内引用符によるファイル名バグの修正

## ステータス
未着手: 2026-03-20

## 問題の概要

arXiv論文 [2509.19783](https://arxiv.org/abs/2509.19783) を処理した際、2つのファイルが作成され、一方はタイトルが途中で切れ、もう一方はタイトル無しで要約のみが書かれる、という予期しない動作が発生。

## 根本原因

[title_extractor.ts](file:///home/kunihiros/dev/paper-extractor/src/title_extractor.ts) の [extractCitationTitleFromAbsHtml](file:///home/kunihiros/dev/paper-extractor/src/title_extractor.ts#12-29) 関数に2つの問題がある。

### 問題1: HTML文字参照のデコード未対応

arXivのHTMLでは引用符が **`&#34;`**（数値文字参照）でエンコードされている：

```html
<meta name="citation_title" content="Agentic Metacognition: Designing a &#34;Self-Aware&#34; Low-Code Agent for Failure Prediction and Human Handoff" />
```

Obsidianの `requestUrl` がレスポンスを返す時点で `&#34;` → `"` にデコードされると、content属性値の中に実際の `"` 文字が現れる。

### 問題2: 正規表現がcontent属性値内の引用符に対応できない

```typescript
// 現行コード (L16)
const contentMatch = tag.match(/content=["']([^"']+)["']/i);
```

`[^"']+` はクォート文字（`"` / `'`）以外にマッチするため、デコード後のタイトル中の `"` で**マッチが途中停止**する。

結果として抽出されるタイトル：
- `Agentic Metacognition: Designing a ` ← `"` の直前で切れる

> [!IMPORTANT]
> ユーザーの仮説「サニタイズ関数の問題」ではなく、**HTML解析の正規表現**が根本原因。サニタイズ関数 [sanitizeTitleAsNoteBaseName](file:///home/kunihiros/dev/paper-extractor/src/title_extractor.ts#30-34) 自体は正しく動作する（そこに到達できれば）。

### なぜ2つのファイルが生成されるか

パイプラインの流れを追うと：

1. [main.ts](file:///home/kunihiros/dev/paper-extractor/src/main.ts) L92: [createTempNote](file:///home/kunihiros/dev/paper-extractor/src/main.ts#135-147) で仮ノート（`untitled_<timestamp>.md`）作成
2. [main.ts](file:///home/kunihiros/dev/paper-extractor/src/main.ts) L93: [extractAndRenameNoteTitle](file:///home/kunihiros/dev/paper-extractor/src/title_extractor.ts#35-104) でタイトル取得 → 途中で切れたタイトル名にリネーム
3. [main.ts](file:///home/kunihiros/dev/paper-extractor/src/main.ts) L100: [fetchAndSaveArxiv](file:///home/kunihiros/dev/paper-extractor/src/paper_fetcher.ts#15-142) → 途中切れタイトルのフォルダにHTMLを保存
4. [main.ts](file:///home/kunihiros/dev/paper-extractor/src/main.ts) L102: [generateSummary](file:///home/kunihiros/dev/paper-extractor/src/summary_generator.ts#38-245) → **`noteFile.basename`（途中切れタイトル）のフォルダからHTMLを探す**が、もし`renameFile`後のパスとフォルダ生成のタイミング問題でズレが発生すると、異なるパスで処理が進む可能性がある

実際にはリネーム成功後のパスで一貫して処理が進むため、もう一つの可能性はObsidianがファイルリネーム時にインデクシング処理を走らせ、途中切れタイトルのファイルと別パスのファイルの両方が作成される内部挙動。

---

## Proposed Changes

### Title Extractor

#### [MODIFY] [title_extractor.ts](file:///home/kunihiros/dev/paper-extractor/src/title_extractor.ts)

**変更1**: [extractCitationTitleFromAbsHtml](file:///home/kunihiros/dev/paper-extractor/src/title_extractor.ts#12-29) の正規表現を修正

現行:
```typescript
const contentMatch = tag.match(/content=["']([^"']+)["']/i);
```

修正後: content属性値全体を正しく取り出するため、content属性の開始クォートと**同じ**終了クォートを探す。属性値の終了は `"` + 空白 or `>` or `/` で判定する。

```typescript
// content="..." のパターン: 属性終了は " の後に空白・>・/ が続く位置
const contentMatch = tag.match(/content="([^"]*(?:"[^"]*)*?)"\s*[\/>]/i)
    || tag.match(/content='([^']*(?:'[^']*)*?)'\s*[\/>]/i);
```

ただし上記は複雑になりすぎるため、よりシンプルなアプローチを採用する：

**方針**: HTMLを正規表現で完全に解析するのは難しいため、`DOMParser`（ブラウザ環境・Obsidian内で利用可能）を使ってメタタグを安全に解析する。

```typescript
function extractCitationTitleFromAbsHtml(html: string): string {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const meta = doc.querySelector('meta[name="citation_title"]');
    if (meta) {
        const content = meta.getAttribute('content');
        if (content) return content;
    }
    throw new Error('citation_title not found');
}
```

`DOMParser` を使うことで：
- HTML文字参照（`&#34;`、`&quot;`、`&amp;` 等）が自動的にデコードされる
- 属性値内の引用符も正しく処理される
- **将来の他の特殊文字にも自動対応**

**変更2**: [sanitizeTitleAsNoteBaseName](file:///home/kunihiros/dev/paper-extractor/src/title_extractor.ts#30-34) に追加の無効文字対応

現状の正規表現 `[\\/:*?"<>|]` で主要な文字はカバーされているが、Obsidianが禁止する `#`、`^`、`[`、`]` も追加しておく安全策。

```typescript
function sanitizeTitleAsNoteBaseName(input: string): string {
    const collapsed = input.replace(/\s+/g, ' ').trim();
    return collapsed.replace(/[\\/:*?"<>|#^[\]]/g, '_').trim();
}
```

> [!WARNING]
> `DOMParser` はブラウザ/Electron環境のグローバルAPIです。Obsidianプラグインはこの環境で動作するため利用可能ですが、Node.jsのみの環境（ユニットテスト等）では利用できません。必要に応じてポリフィルまたはテスト時のモック対応が必要です。

---

## Verification Plan

### Manual Verification

本プロジェクトにはテストフレームワークが導入されていないため、以下の手動検証を提案します：

1. **ビルド**: `pnpm run build` でエラーなくビルドが通ること確認
2. **問題URLでの再現確認**: Obsidian Vault に [main.js](file:///home/kunihiros/dev/paper-extractor/main.js) をコピーし、以下の URL で動作確認
   - `https://arxiv.org/abs/2509.19783`（問題の論文 — タイトルに `"` と `:` を含む）
   - **期待結果**:
     - 1つのノートファイルのみが `Agentic Metacognition_ Designing a _Self-Aware_ Low-Code Agent for Failure Prediction and Human Handoff.md` として作成される（`"` と `:` が `_` に変換）
     - タイトルが途中で切れた別ノートが作成されない
     - 添付フォルダが1つだけ作成される
     - 要約が上記ノートに追記される
3. **特殊文字の追加確認**: 可能であれば、`citation_title` に以下を含むケースでも手動確認する
   - `'` を含むタイトル
   - `&amp;` など他のHTML文字参照を含むタイトル
   - `#`、`^`、`[`、`]` を含むタイトル
   - **期待結果**: タイトル抽出が途中で切れず、禁止文字のみ `_` に置換される
4. **異常系確認**: `citation_title` が取得できないケースで、ノートが不正なタイトルにリネームされないことを確認する
   - **期待結果**:
     - エラー通知される
     - タイトル変更が行われない
     - 追加の不正ファイル/フォルダが生成されない

### Regression Focus

今回の修正では、単にタイトル文字列が正しく取得できることだけではなく、以下の副作用が解消されていることを確認対象に含める：

- **二重生成防止**: ノートファイルが複数作成されないこと
- **保存先整合性**: HTML/PDF 保存先フォルダが最終ノート名と一致すること
- **要約追記先整合性**: `summary_generator` が正しいノートに対して処理すること

### Deploy / Verification Steps

1. **ビルド**: `pnpm run build`
2. **成果物確認**:
   - `main.js`
   - `manifest.json`
   - `styles.css`（存在する場合のみ）
3. **Vaultへ配置（手動）**:
   - `VaultFolder/.obsidian/plugins/paper_extractor/` に上記成果物をコピー
4. **Obsidianで再読み込み**:
   - アプリ再起動、またはプラグイン再読み込みで反映
5. **デプロイ後確認**:
   - `https://arxiv.org/abs/2509.19783` で問題が再発しないこと
   - ノート/添付フォルダの二重生成がないこと
6. **ドキュメント更新確認**:
   - 少なくとも `CHANGELOG.md` の更新要否を確認する
