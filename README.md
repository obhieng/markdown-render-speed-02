![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)
![rank](https://make.fun/badge/markdown-render-speed-02/obhieng/markdown-render-speed-02/rank.svg)
![reward](https://make.fun/badge/markdown-render-speed-02/obhieng/markdown-render-speed-02/reward.svg)

# markdown-render-speed-02

A fast drop-in replacement for [marked](https://github.com/markedjs/marked) 18.1.3,
written from scratch for make.fun's
["Make Markdown rendering faster"](https://make.fun/bounty/markdown-render-speed-02)
bounty ($250 in USDC). `parse(markdown)` returns byte-identical HTML to marked
18.1.3 with default options (GFM on, breaks off, pedantic off, async off) —
CommonMark 0.31.2 + GFM 0.29, including tables, task lists, strikethrough,
autolinks, and the exact HTML serialization marked produces where it departs
from the spec.

## Run it

```sh
node --experimental-strip-types main.ts
```

`main.ts` reads `/input/cases.json`, renders each case alone with `parse()`
from `parse.js`, and writes `/output/html.json` (a JSON array of HTML strings,
in order). Outside a container, set `MAKEFUN_INPUT_DIR` and
`MAKEFUN_OUTPUT_DIR` to point at your own input/output directories. Requires
Node 22+. No dependencies, no install, no network.
