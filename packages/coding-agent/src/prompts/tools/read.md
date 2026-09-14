Reads the content at the specified path or URL.

<instruction>
Multi-purpose: files, directories, archives, SQLite databases, images, documents (PDF/DOCX/PPTX/XLSX/RTF/EPUB/ipynb), and URLs.
- You **MUST** parallelize reads when exploring related files. For URLs, `read` returns clean extracted text/markdown (reader-mode) — reach for `read` first, not a browser.
## Parameters
- `path` — file path or URL (required)
- `sel` — optional selector for line ranges or raw mode
- `timeout` — seconds, for URLs only
## Selectors
|`sel` value|Behavior|
|---|---|
|*(omitted)*|Read full file (up to {{DEFAULT_LIMIT}} lines)|
|`50`|Read from line 50 onward|
|`50-200`|Read lines 50-200|
|`50+150`|Read 150 lines starting at line 50|
|`20+1`|Read exactly one line|
## Filesystem
- Reading a directory path returns a list of dirents.
{{#if IS_HASHLINE_MODE}}
- Reading a file returns lines prefixed with anchors (line+hash): `41th|def alpha():`
{{else}}
{{#if IS_LINE_NUMBER_MODE}}
- Reading a file returns lines prefixed with line numbers: `41|def alpha():`
{{/if}}
{{/if}}
- Archives (`.tar`, `.tar.gz`, `.tgz`, `.zip`): `archive.ext:path/inside/archive` reads a member.
- SQLite (`.sqlite`, `.sqlite3`, `.db`, `.db3`): `file.db:table?limit=50&offset=100`, `file.db?q=SELECT …`, etc.
## Inspection & URLs
- Extracts text from PDF, Word, PowerPoint, Excel, RTF, EPUB, Jupyter; inspects images.
- URLs use reader-mode by default; `sel="raw"` for untouched HTML, `timeout` to override the default.
- If `read` fails to fetch (timeout, bot wall, JS-rendered), use the `browser` tool instead of retrying `read`.
</instruction>

<critical>
- You **MUST** use `read` for every file/dir/archive/URL read — never `cat`/`head`/`tail`/`ls`/`curl`/`wget` in shell.
- You **MUST** prefer `read` over a browser; only use a browser if `read` fails.
- You **MUST** always include the `path` parameter. For line ranges use `sel` (e.g. `sel="50-200"`), never shell line filters.
</critical>
