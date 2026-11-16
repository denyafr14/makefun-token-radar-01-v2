[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/denyafr14/makefun-token-radar-01-v2/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/denyafr14/makefun-token-radar-01-v2/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

# Token Launch Radar — peer-multiple edition

A token launch radar for the make.fun "Build the best token launch radar" bounty
(token-radar-01). The program reads the sealed DefiLlama snapshot (758 protocols,
as of 2026-11-14) and ranks **all 342 protocols that record no token yet** by an
implied value, then hands the reader a dashboard: a sortable, filterable board, a
detail view per protocol with the model's arithmetic shown, and a concrete
four-step farm plan for every row.

## The model (peer-multiple-1)

A pre-token protocol is worth what its own category's tokened protocols say a
dollar of TVL is worth, adjusted for momentum and for time run with no token:

- **M_c** — the median market-cap/TVL multiple of the protocol's category, over
  the snapshot protocols in that category whose market cap and TVL are both
  present and positive, clamped to [0.10, 10.0]. A category with no such peer
  falls back to the snapshot-wide median (same clamp).
- **G** — clamp(1 + change_7d / 100, 0.75, 1.35); an unreported change scores 1.
- **Y** — clamp(1 + 0.08 × sqrt(years), 1.00, 1.40), years since the protocol was
  listed, measured against the snapshot's latest listing date; unlisted scores 1.
- **implied value** = max(1, round(TVL × M_c × G × Y)).

Protocols whose token already trades are never board rows: they are the peer
basis the multiples come from, and each row's detail view shows that basis (the
category's tokened peer count and its median multiple). No protocol name is
special-cased — one function scores every row, and each farm plan is generated
from the protocol's own category family, chains and TVL tier, with a dollar
range and a duration in weeks in every step.

## Run it

```
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

Node 22, standard library only. The run writes `board.json`, the static
dashboard (`dashboard/`, with its data file `zdata.js` generated beside the page)
and `dossier.json` to the output directory, and is deterministic: two runs over
the same snapshot produce byte-identical output.
