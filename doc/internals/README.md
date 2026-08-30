# Internals

Why the library is built the way it is. The rest of [`doc/`](../README.md) explains how to
*use* timeseries.js; these pages explain the decisions underneath it — what a mechanism
protects against, what breaks quietly when a rule is dropped, and which pieces look
redundant but are not.

Read the page for the subsystem you are about to touch. Nothing here is needed to use the
library.

| Page | Covers |
|---|---|
| [renderers.md](renderers.md) | The renderer contract and its four declarations (`values`, `stacked`, `cumulative`, `lanes`), the plot shapes, the span/area/lane/ladder/waterfall families, series colours and the point hit test |
| [core.md](core.md) | The draw loop and slot lifecycle, the DOM overlays, resolution tiers and the cross-fade, the rate axis, partial bins, zero-size canvases, the snap grid, module exports, option merging, pointer coordinates |
| [sources.md](sources.md) | The source contract, the CalDAV and Zabbix clients, their ring caches, and the CORS wall both demos are shaped by |
| [packaging.md](packaging.md) | What the version number promises, what the release script checks before it writes, the `exports` map, and the three distribution channels |
| [roadmap.md](roadmap.md) | Planned work: the constructor's start window and follow state, and the ranked data-source candidates |

## Where a fact belongs

Three levels, and mixing them is what made this split necessary:

- **`CLAUDE.md`** — what holds for *every* task in this repo: the commands, the hard
  prohibitions, and the pointer to the page below that explains each one.
- **`doc/*.md`** — the reference set for someone *using* the library: shapes, options,
  methods, recipes.
- **`doc/internals/*.md`** — the reasoning for someone *changing* it.

A rule that must not be broken belongs in `CLAUDE.md` as one line, with its argument
here. Moving the line itself down here is how it stops being read.
