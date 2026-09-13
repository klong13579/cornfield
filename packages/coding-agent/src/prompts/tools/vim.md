Vim-style `edit` mode. The tool name stays `edit`; every call requires `file`.

- `{"file": "path"}` — view file.
- `{"file": "path", "steps": [{"kbd": ["…"], "insert": "…"}]}` — edit file.

`steps` run in order; each step runs `kbd`, then optionally types `insert`.
- `kbd`: Vim keystrokes only (`dd`, `G`, `o`, `cc`, `gg`, …). Never put text here.
- `insert`: raw text content.
- Non-final `kbd` entries must end in NORMAL mode (`<Esc>`); a step using `insert` must end its `kbd` in INSERT mode (`o`, `i`, `a`, `cc`, …).

Useful patterns: `NGo` = insert below line N, `NGO` = above, `5Gcc` = replace line N, `ggdGi` = replace whole file, `:%s/old/new/g` = search/replace, `:3,5d` = delete range. Multi-location edits run bottom-up (highest line first).

## Supported
Motions: `h j k l w b e 0 $ ^ gg G { } f F t T % / ; ,` with counts
Operators: `d c y p` + text objects (`iw aw ip ap i" a" i( a(`)
Insert: `i a o O I A cc C s S R`; Visual: `v V`; Ex: `:w :q :s :%s :N,Md :%d :e`