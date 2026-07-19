"""The generative SIMULATION cards (waves / lightning / fire / aurora / rain /
clouds) — the physical rewrites of docs/generative-cards/.

Covers the contracts the redesign hangs on: block-streaming must be
byte-identical to the whole clip (rain is the stateful one), waves/rain accept
an OPTIONAL video input they refract, a points card fans a card out to many
origins, same-kind cards merge into ONE shared field (and mixed kinds refuse
with a clear error), and fire rides the fluid solver — merging with fluids.
"""

from __future__ import annotations

import numpy as np
import pytest

from backend import graph as G
from backend.sources import SOURCE_PARAMS

from helpers import assert_moves

OUT = {"width": 120, "height": 64, "quality": "draft", "fps": 24}
SEG = {"start": 0.0, "end": 2.5, "signals": [], "lyric_lines": []}
NOAUDIO = lambda j, s: None  # noqa: E731


def _ports(card, **over):
    p = {
        k: {"binding": {"kind": "const", "value": d}}
        for k, (lo, hi, d) in SOURCE_PARAMS[card].items()
    }
    for k, v in over.items():
        p[k] = {"binding": {"kind": "const", "value": v}}
    return p


def _node(nid, t, data=None):
    return {"id": nid, "type": t, "data": data or {}}


def _edge(s, t, tp):
    return {"id": f"{s}-{t}-{tp}", "source": s, "sourcePort": "out", "target": t, "targetPort": tp}


def _dag(nodes, edges):
    return G.Dag("job", SEG, {"nodes": nodes, "edges": edges}, NOAUDIO, OUT)


def _card(nid, t, **over):
    return _node(nid, t, {"seed": 5, "ports": _ports(t, **over)})


@pytest.mark.parametrize("card", ["waves", "lightning", "aurora", "rain", "clouds"])
def test_block_stream_matches_whole_clip(card):
    # The lockstep invariant, per card — rain is the stateful one (its spectral
    # surface carries across blocks); the others must stay pure functions of the
    # absolute frame. (Lightning's strike-spanning-a-seam case is exercised by
    # the dedicated strike test below.)
    # Lightning only draws when its `strike` port RISES past the midpoint, so a card on
    # default constants renders 60 identical empty frames — and a lockstep check over
    # empty frames proves nothing. Give it an LFO to fire on. (Found by assert_moves.)
    nodes = [_card("n", card)]
    edges = []
    if card == "lightning":
        nodes = [
            _card("n", card, strike=0.0),
            _node("lfo", "lfo", {"shape": "square", "rateMode": "cycles", "rate": 3}),
        ]
        nodes[0]["data"]["ports"]["strike"] = {
            "binding": {"kind": "node", "nodeId": "lfo", "lo": 0, "hi": 1}
        }
        edges = [_edge("lfo", "n", "strike")]
    whole = _dag(nodes, edges).video("n")
    assert_moves(whole, card)  # a generative card that does not animate is broken
    dagb = _dag(nodes, edges)
    prod = dagb._block_producer("n")
    n = len(whole)
    cuts = [0, max(1, n // 3), max(2, 2 * n // 3), n]
    blocks = np.concatenate([prod(a, b) for a, b in zip(cuts, cuts[1:])])
    assert np.array_equal(whole, blocks), f"{card} streams != whole clip"


def test_waves_refracts_optional_input():
    plain = _dag([_card("w", "waves")], []).video("w")
    nodes = [
        _card("w", "waves"),
        _node("b", "backdrop", {"color": "#804020", "ports": _ports("backdrop")}),
    ]
    with_in = _dag(nodes, [_edge("b", "w", "video")]).video("w")
    assert plain.shape == with_in.shape and plain.shape[-1] == 4
    assert not np.array_equal(plain, with_in)  # the input actually shows through


def test_rain_refracts_optional_input_and_stays_streamable():
    nodes = [
        _card("r", "rain"),
        _node("b", "backdrop", {"color": "#208040", "ports": _ports("backdrop")}),
    ]
    edges = [_edge("b", "r", "video")]
    whole = _dag(nodes, edges).video("r")
    dagb = _dag(nodes, edges)
    prod = dagb._block_producer("r")
    n = len(whole)
    blocks = np.concatenate([prod(0, n // 2), prod(n // 2, n)])
    assert np.array_equal(whole, blocks)


def test_points_card_fans_out_positions():
    # Two drip points vs uniform rain: different frames, same contract.
    nodes = [_card("r", "rain"), _node("p", "points", {"points": [[0.25, 0.5], [0.75, 0.5]]})]
    pointed = _dag(nodes, [_edge("p", "r", "positions")]).video("r")
    uniform = _dag([_card("r", "rain")], []).video("r")
    assert not np.array_equal(pointed, uniform)


def test_same_kind_merge_shares_one_field():
    combine = _node(
        "c", "combine", {"mode": "merge", "inputs": [{"id": "i1"}, {"id": "i2"}], "medium": {}}
    )
    nodes = [
        _card("r1", "rain"),
        _node("r2", "rain", {"seed": 9, "ports": _ports("rain")}),
        combine,
    ]
    edges = [_edge("r1", "c", "i1"), _edge("r2", "c", "i2")]
    merged = _dag(nodes, edges).video("c")
    solo = _dag([_card("r1", "rain")], []).video("r1")
    assert merged.shape == solo.shape
    assert not np.array_equal(merged, solo)  # the second card's drops landed too


def test_mixed_kind_merge_raises_clear_error():
    combine = _node(
        "c", "combine", {"mode": "merge", "inputs": [{"id": "i1"}, {"id": "i2"}], "medium": {}}
    )
    nodes = [_card("w", "waves"), _card("a", "aurora"), combine]
    edges = [_edge("w", "c", "i1"), _edge("a", "c", "i2")]
    with pytest.raises(ValueError, match="stack"):
        _dag(nodes, edges).video("c")


def test_fire_rides_the_fluid_path_and_merges_with_fluid():
    fire = _dag([_card("f", "fire")], []).video("f")
    assert fire.shape[-1] == 3 and fire.max() > 40  # dye-on-black, actually burning
    fl_ports = {
        k: {"binding": {"kind": "const", "value": v}}
        for k, v in [
            ("r", 0.2),
            ("g", 0.5),
            ("b", 1.0),
            ("angle", 270),
            ("force", 30),
            ("emit", 0.4),
            ("radius", 0.07),
        ]
    }
    fluid_node = _node(
        "fl",
        "fluid",
        {
            "static": {
                "enabled": True,
                "wrap": True,
                "points": [[0.3, 0.4]],
                "path_speed": 1,
                "color": [0.2, 0.5, 1.0],
            },
            "ports": fl_ports,
        },
    )
    combine = _node(
        "c", "combine", {"mode": "merge", "inputs": [{"id": "i1"}, {"id": "i2"}], "medium": {}}
    )
    nodes = [_card("f", "fire"), fluid_node, combine]
    edges = [_edge("f", "c", "i1"), _edge("fl", "c", "i2")]
    both = _dag(nodes, edges).video("c")
    assert both.shape == fire.shape and not np.array_equal(both, fire)


def test_lightning_strike_flashes_then_decays():
    dag0 = _dag([_card("li", "lightning")], [])
    n = max(1, round(dag0.duration * dag0.fps))
    st = np.zeros(n, np.float32)
    st[8] = 1.0
    node = _node("li", "lightning", {"seed": 5, "ports": _ports("lightning")})
    dag = _dag([node], [])
    params = dag._fx_params(dag.nodes["li"])
    params["strike"] = st
    from backend import sources

    layer = dict(params, seed=5, stops=[(0.0, (0.3, 0.5, 1.0)), (1.0, (1, 1, 1))])
    frames = sources.lightning(n, 64, 120, dag.fps, [layer])
    lum = frames[..., :3].max(axis=(1, 2, 3)).astype(int)
    assert lum[7] == 0  # dark before the strike
    assert lum[8] > 200  # the return stroke flashes
    assert lum[min(n, 40) - 1] < lum[8]  # and it decays
