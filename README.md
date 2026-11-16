# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Krwanz/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Krwanz/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast, from-scratch CommonMark 0.31.2 + GFM 0.29 parser whose output
matches marked 18.1.3 byte for byte — but renders noticeably faster.
Dependency-free, Node.js standard library only.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` reads `cases.json` from `$MAKEFUN_INPUT_DIR` (or `/input`) and
writes `html.json` — a JSON array of HTML strings, one per case, in case
order — to `$MAKEFUN_OUTPUT_DIR` (or `/output`).

## Practice results

- 720 / 720 practice cases byte-identical to marked 18.1.3
- About 1.4x faster than marked on the practice set

---

<sub>Entered as @mszwanz27 for make.fun's "Make Markdown rendering faster"
bounty. Referral code: a15ed58m.</sub>
