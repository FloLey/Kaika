"""The backend node-handler registry stays consistent (Phase 3).

Guards that the video/emitter dispatch is driven by the registries and that
`_VIDEO_PRODUCERS` is derived from them — so adding a producing node type is one
handler + one registration, with nothing left to hand-sync.
"""
from backend import graph


def test_video_producers_derive_from_handlers():
    assert graph._VIDEO_PRODUCERS == tuple(graph._VIDEO_HANDLERS)


def test_core_node_types_are_registered():
    for t in ("fluid", "combine", "output"):
        assert t in graph._VIDEO_HANDLERS
        assert t in graph._EMITTER_HANDLERS
        assert callable(graph._VIDEO_HANDLERS[t])
        assert callable(graph._EMITTER_HANDLERS[t])


def test_unknown_node_type_has_no_handler():
    assert graph._VIDEO_HANDLERS.get("totally-new") is None
    assert graph._EMITTER_HANDLERS.get("totally-new") is None
