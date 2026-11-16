"""The canvas layout of the Data Sampel BPJS pipeline: stages are columns left to right (1 Data Mentah | 2 Data Bersih |
3 Siap Analisis), each legend colour a horizontal lane, and inside a lane a layered drawing — a node one column right of
the inputs it reads in its stage (pulled right to just before the node that reads it, so no edge runs long for
nothing), outputs right after their node, the order in each column from its neighbours' (barycentre sweeps) and every
card level with the cards it connects to, as far as the cards above and below it allow. Lanes are ordered so the
edges between them are short. Each stage has its note above its columns and each lane a label on its left.

Card sizes are the Builder's (web/src/components/pipeline/Graph.tsx: NODE_W, NODE_H, a join's port rows)."""

from __future__ import annotations

import itertools
import math

NODE_W, NODE_H, JOIN_H = 220, 64, 112
COL_W = NODE_W + 100  # a column: a card and the room its edges bend in
ROW_GAP = 36  # between two cards of a column
STAGE_GAP = 120  # extra room between two stages
LANE_GAP = 80  # between two lanes, the next lane's label included
LABEL_H = 40
X0 = 80
GRID = 20  # the canvas grid (web/src/lib/graphLayout.ts GRID)


def _snap(v: float) -> int:
    return int(round(v / GRID) * GRID)


def _isotonic(target: list[float]) -> list[float]:
    """The non-decreasing sequence closest to `target` (least squares; pool adjacent violators)."""
    blocks: list[list[float]] = []  # [sum, count]
    for t in target:
        blocks.append([t, 1])
        while len(blocks) > 1 and blocks[-2][0] / blocks[-2][1] > blocks[-1][0] / blocks[-1][1]:
            s, c = blocks.pop()
            blocks[-1][0] += s
            blocks[-1][1] += c
    out: list[float] = []
    for s, c in blocks:
        out += [s / c] * c
    return out


def _fit(order: list[str], want: dict[str, float], h: dict[str, int], top: float) -> dict[str, float]:
    """y of a column's cards, in this order: each as close to where it wants to be as the cards above it allow."""
    offset, acc = [], 0.0
    for m in order:
        offset.append(acc)
        acc += h[m] + ROW_GAP
    z = _isotonic([want[m] - o for m, o in zip(order, offset)])
    return {m: max(zi, top) + o for m, zi, o in zip(order, z, offset)}


def arrange(nodes: list[dict], outputs: list[dict], reads: dict[str, list[str]], stage_of: dict[str, int], lanes: list[tuple[str, str]],
            stage_notes: dict[int, tuple[str, str]]) -> list[dict]:
    """Sets x, y of `nodes` and `outputs`; returns the text nodes (the stage notes and the lane labels).
    reads: node id → the nodes it reads (inputs and label books); lanes: (legend id, name) top to bottom by preference;
    stage_notes: stage → (text node id, text)."""
    by_id = {n["id"]: n for n in nodes}
    lane = {n["id"]: n.get("color") or "" for n in nodes}
    succ: dict[str, list[str]] = {n["id"]: [] for n in nodes}
    for n in nodes:
        for r in reads[n["id"]]:
            succ[r].append(n["id"])

    # columns inside each stage: right of the inputs read in the stage, then pulled right towards the node that reads it
    depth: dict[str, int] = {}

    def asap(nid: str) -> int:
        if nid not in depth:
            same = [r for r in reads[nid] if stage_of[r] == stage_of[nid]]
            depth[nid] = 1 + max(map(asap, same)) if same else 0
        return depth[nid]

    for n in nodes:
        asap(n["id"])
    outs_of: dict[str, list[dict]] = {}
    for o in outputs:
        outs_of.setdefault(o["node"], []).append(o)
    # a helper is pulled right; a node with an output stays right after what it reads (source → table → output)
    for nid in sorted(depth, key=lambda i: -depth[i]):
        later = [s for s in succ[nid] if stage_of[s] == stage_of[nid]]
        if later and stage_of[nid] > 1 and nid not in outs_of:
            depth[nid] = max(depth[nid], min(depth[s] for s in later) - 1)

    # the cards: nodes and outputs (an output is a card right after its node, in its lane)
    h = {n["id"]: (JOIN_H if n["kind"] == "join" else NODE_H) for n in nodes}
    card_lane, card_stage, card_depth = dict(lane), dict(stage_of), dict(depth)
    nb_in = {nid: [r for r in reads[nid]] for nid in by_id}
    nb_out = {nid: list(succ[nid]) for nid in by_id}
    for o in outputs:
        k = "out:" + o["id"]
        h[k] = NODE_H
        card_lane[k], card_stage[k], card_depth[k] = lane[o["node"]], stage_of[o["node"]], depth[o["node"]] + 1
        nb_in[k], nb_out[k] = [o["node"]], []
        nb_out[o["node"]].append(k)
    width = {s: 1 + max(d for c, d in card_depth.items() if card_stage[c] == s) for s in sorted(set(card_stage.values()))}
    start, x_of_stage, acc = {}, {}, 0
    for s in sorted(width):
        start[s] = acc
        x_of_stage[s] = X0 + acc * COL_W + (s - 1) * STAGE_GAP
        acc += width[s]
    gcol = {c: start[card_stage[c]] + card_depth[c] for c in card_depth}

    # the lane order with the shortest edges between lanes (the preferred order breaks ties)
    pref = [l for l, _ in lanes] + sorted({v for v in lane.values()} - {l for l, _ in lanes})
    pref = [l for l in pref if any(v == l for v in lane.values())]
    weight: dict[tuple[str, str], int] = {}
    for nid in by_id:
        for r in reads[nid]:
            if lane[r] != lane[nid]:
                key = tuple(sorted((lane[r], lane[nid])))
                weight[key] = weight.get(key, 0) + 1

    def cost(order: tuple[str, ...]) -> tuple[int, int]:
        at = {l: i for i, l in enumerate(order)}
        return sum(w * abs(at[a] - at[b]) for (a, b), w in weight.items()), sum(abs(i - pref.index(l)) for i, l in enumerate(order))

    lane_order = list(min(itertools.permutations(pref), key=cost)) if len(pref) <= 8 else pref

    names = dict(lanes)
    text: list[dict] = []
    # the stage notes first: the lanes start below the tallest
    span = {s: (x_of_stage[s], x_of_stage[s] + width[s] * COL_W - (COL_W - NODE_W)) for s in width}
    notes = []
    for s, (tid, body) in sorted(stage_notes.items()):
        if s not in span:
            continue
        x0, x1 = span[s]
        w = min(1400, max(300, x1 - x0))
        per_line = max(20, int((w - 16) / 6.6))  # text-xs, about 6.6 px a character
        lines = sum(max(1, math.ceil(len(part) / per_line)) for part in body.split("\n"))
        notes.append({"id": tid, "x": _snap(x0), "y": 40, "w": _snap(w), "h": _snap(lines * 18 + 40), "text": body})
    text += notes
    top = 40 + max((t["h"] for t in notes), default=0) + 60

    y: dict[str, float] = {}
    for ln in lane_order:
        members = [c for c in card_lane if card_lane[c] == ln]
        if not members:
            continue
        top += LABEL_H + 16
        cols: dict[int, list[str]] = {}
        for c in members:  # the file's order first: nodes as they were written, outputs after
            cols.setdefault(gcol[c], []).append(c)
        same = lambda c, xs: [x for x in xs if card_lane.get(x) == ln]  # noqa: E731
        # a card with no neighbour in its lane goes towards the lane its neighbours are in
        rank = {l: i for i, l in enumerate(lane_order)}
        here = rank[ln]

        def lean(c: str) -> float:
            others = [rank[card_lane[x]] for x in nb_in[c] + nb_out[c] if card_lane.get(x) != ln]
            return 0.0 if not others else (sum(others) / len(others) - here)

        for c in sorted(cols):
            y.update(_fit(cols[c], {m: top + i * (NODE_H + ROW_GAP) for i, m in enumerate(cols[c])}, h, top))
        # sweeps right, left, right…: order each column by where its neighbours in the lane are (the ones it reads,
        # then the ones reading it; both in the last sweeps), then place each card as level with them as it fits
        for sweep in range(10):
            forward, both = sweep % 2 == 0, sweep >= 8
            for c in sorted(cols, reverse=not forward):
                def bary(m: str) -> float | None:
                    ys_ = [y[x] for x in same(m, nb_in[m] + nb_out[m] if both else nb_in[m] if forward else nb_out[m]) if x in y]
                    return sum(ys_) / len(ys_) if ys_ else None

                b = {m: bary(m) for m in cols[c]}
                alone = {m: not same(m, nb_in[m] + nb_out[m]) for m in cols[c]}
                cols[c].sort(key=lambda m: b[m] if b[m] is not None else y[m] + (1e4 * lean(m) if alone[m] else 0))
                y.update(_fit(cols[c], {m: b[m] if b[m] is not None else y[m] for m in cols[c]}, h, top))
        # snapped to the grid, still clear of each other
        bottom = top
        for c in cols:
            free = top
            for m in sorted(cols[c], key=lambda m: y[m]):
                y[m] = max(_snap(y[m]), math.ceil(free / GRID) * GRID)
                free = y[m] + h[m] + ROW_GAP
                bottom = max(bottom, y[m] + h[m])
        # the lane's label on its left, and again where the last stage starts (the canvas is wide)
        label = f"**{names.get(ln, ln.removeprefix('lg-'))}**"
        text.append({"id": f"lane_{ln.removeprefix('lg-')}", "x": 40, "y": _snap(top - LABEL_H - 12), "w": 300, "h": LABEL_H, "color": ln, "text": label})
        last = max(width)
        if last > 1 and any(card_stage[c] == last for c in members):
            text.append({"id": f"lane_{ln.removeprefix('lg-')}_{last}", "x": _snap(x_of_stage[last] - 40), "y": _snap(top - LABEL_H - 12), "w": 300,
                         "h": LABEL_H, "color": ln, "text": label})
        top = bottom + LANE_GAP

    def x_of(c: str) -> int:
        s = card_stage[c]
        return _snap(x_of_stage[s] + card_depth[c] * COL_W)

    for n in nodes:
        n["x"], n["y"] = x_of(n["id"]), int(y[n["id"]])
    for o in outputs:
        k = "out:" + o["id"]
        o["x"], o["y"] = x_of(k), int(y[k])
    return text
