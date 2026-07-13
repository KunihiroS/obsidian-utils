# paper_extractor

paper_extractor is an Obsidian plugin that helps you create a paper note from an arXiv URL and then:

- Renames the note based on the paper title (from `citation_title`).
- Downloads arXiv HTML/PDF and saves them next to the note.
- Generates a summary and appends/replaces it in the note.

The plugin is designed to be used from the **Command Palette**.

## How it works

1. Run the command **Create paper note from arXiv URL**.
2. Enter an arXiv URL (e.g. `https://arxiv.org/abs/2601.05175`).
3. The plugin creates a new note in the Vault root from a user-defined template.
4. The note is renamed to the extracted paper title.
5. HTML/PDF are downloaded into a sibling folder.
6. A summary is generated and written into the note.

## Settings

Open **Settings → Community plugins → paper_extractor**.

### Required

- **Log directory (Vault path)** (`logDir`)
  - Example: `paper_extractor/logs`
- **Template path (Vault path)** (`templatePath`)
  - Example: `templates/paper_extractor.md`
  - The template must contain `{{url}}`.
- **System prompt path (Vault path)** (`systemPromptPath`)
  - Required for `summary_generator`.
  - Example: `.obsidian/paper_extractor/system_prompt_summary.md`
- **.env path (absolute path)** (`envPath`)
  - Required for `summary_generator`.
  - Example: `/home/you/.config/paper_extractor/.env`
- **Summary enabled** (`summaryEnabled`)
  - Default: `true`
  - If disabled, `summary_generator` is skipped.

`.env` file example:

```dotenv
########################################
# OpenAI API key
########################################
OPENAI_API_KEY="YOUR_OPENAI_API_KEY"
OPENAI_MODEL="gpt-5.2"

########################################
# Codex OAuth (optional model override)
########################################
# Defaults to gpt-5.4-mini when omitted or empty
CODEX_MODEL="gpt-5.4-mini"

########################################
# Gemini API key
########################################
GEMINI_API_KEY="YOUR_GEMINI_API_KEY"
GEMINI_MODEL="gemini-3-flash-preview"
```

Summary generation behavior:

- Providers are attempted in a fixed order: OpenAI API key → Codex OAuth → Gemini API key. There is no provider selector.
- Missing configuration or a provider failure falls through to the next provider. The configured timeout applies separately to each provider attempt; its default is 180 seconds and it must be a positive, supported value.
- If every provider fails, the run fails and the existing summary block is not written or replaced.
- If `summaryEnabled` is disabled in Settings, summary generation is skipped without reading provider configuration or writing a summary.

### Codex OAuth

Codex OAuth support is desktop-only and uses the Linux/POSIX Codex authentication path `~/.codex/auth.json`. The plugin reads this file in read-only mode on every Codex request. Authentication requires `auth_mode` to be `chatgpt`, plus an access token and account ID.

The plugin never refreshes credentials, writes the auth file, or runs the Codex CLI. After an HTTP 401 response, it reloads the file and retries once only when the account ID is unchanged. An account switch or another authentication failure ends the Codex attempt and falls through to Gemini.

Before reading credentials, the plugin verifies POSIX ownership and permissions, rejects symbolic links, and enforces an auth-file size limit. Codex OAuth is therefore unavailable on mobile and unsupported non-POSIX environments.

## Template format

Your template file is a regular Markdown file stored inside the Vault. The plugin replaces these placeholders:

- `{{url}}` (required)
- `{{date}}` (optional, replaced as `YYYY-MM-DD`)
- `{{time}}` (optional, replaced as `HH:mm`)

Template example:

```text
###### Created:
{{date}} {{time}}
###### Tags:
#paper
###### url_01:
{{url}}
###### memo:

---
```

The summary is written as a dedicated block delimited by markers and is **replaced on re-runs** (idempotent behavior). It is appended to the end of the note if no previous block exists.

### Note

- A new note is created in the **Vault root**.
- Temporary name: `untitled_<timestamp>.md` (collision-safe)
- Then renamed based on `citation_title`.

### Attachments (HTML/PDF)

If the note path is:

- `path/to/<noteBaseName>.md`

Then downloaded files are saved to:

- Folder: `path/to/<noteBaseName>/`
- Files:
  - `<arxivId>.html`
  - `<arxivId>.pdf`

Behavior when the folder already exists:

- If the folder exists: the plugin continues and overwrites only the fetched files (`<arxivId>.html` / `<arxivId>.pdf`).
- If the path exists but is not a folder: the run aborts.

### Logs

- Logs are appended daily into `logDir`.
- File name: `paper_extractor_YYYYMMDD.log`
- Logs include provider-attempt transitions and the final selected provider/model.
- Sensitive values, API keys, access tokens, account IDs, and auth-file contents are not logged; additional redaction is applied before writing logs.

## Troubleshooting

- **"logDir is required"**
  - Set **Log directory (Vault path)**.
- **"templatePath is required" / "Template missing {{url}} placeholder"**
  - Set **Template path (Vault path)** and ensure your template contains `{{url}}`.
- **"Failed to read template"**
  - Verify the template path exists and is Vault-relative (not absolute).
- **Summary generation fails**
  - Verify `systemPromptPath` (Vault path) exists.
  - Verify `envPath` (absolute path) exists.
  - Verify `summaryEnabled` and the OpenAI/Gemini key and model pairs in `.env`.
  - For Codex OAuth, verify Codex is logged in with ChatGPT authentication and that `~/.codex/auth.json` has the current user as owner, restrictive POSIX permissions, a supported size, and is not a symbolic link.
  - Inspect the safe provider-attempt transitions in the log to see which fixed-order attempts failed.
  - See "Summary generation behavior" above.
- **"Already running"**
  - The plugin prevents concurrent runs. Wait for the current run to finish.

## Security & privacy

- API keys must not be stored inside the Vault.
- The plugin reads LLM credentials from an external `.env` file.
- Codex credentials remain in the external read-only `~/.codex/auth.json`; the plugin neither refreshes nor writes them and never invokes the Codex CLI.
- Keep `.env` and `~/.codex/auth.json` owned by the current user with restrictive filesystem permissions. Do not use a symbolic link for the Codex auth file.
- Logs enforce redaction and contain provider/model metadata and fixed failure reasons, not credentials or raw provider errors.

## Development

### Install

```bash
pnpm install
```

### Watch build

```bash
pnpm run dev
```

### Production build

```bash
pnpm run build
```

### Manual install (local)

Copy these files into your Vault:

- `main.js`
- `manifest.json`
- `styles.css` (if present)

Target folder:

`<Vault>/.obsidian/plugins/paper_extractor/`

Reload Obsidian and enable the plugin.

## Releasing

- Update `manifest.json` version.
- Update `versions.json` (plugin version → minimum Obsidian version).
- Create a GitHub release and attach `main.js`, `manifest.json`, and `styles.css`.

## Future development

- **External API / programmatic invocation**
  - Expose a stable API surface so other plugins (and optionally the Console/Templater) can run the same workflow programmatically.
  - Example direction:
    - `app.plugins.getPlugin("paper_extractor")` and a public method like `createPaperNoteFromUrl(url)`.
    - Optional `window` exposure behind an opt-in setting.
