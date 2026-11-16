"""Focused tests for the Grid Intelligence Nexus semantic layer (api/grid_nexus.py).

Pure-logic coverage only: edge-kind classification, schema path finding, and the honesty contract of the
curated semantic layer (every target type has an interpretation, interpretations never claim to be verified,
and properties without a curated meaning stay unverified). Live ontology contents are verified separately
against the running API.
"""

import grid_nexus as gn


def test_every_target_has_semantic_and_category():
    for name in gn.TARGETS:
        assert name in gn.SEMANTIC, name
        assert name in gn.CATEGORY, name
        assert gn.CATEGORY[name] in gn.CATEGORY_COLOR


def test_edge_kind_classification():
    assert gn._edge_kind("Feeder energy balance (grid demo)") == "data_lineage"
    assert gn._edge_kind("Feeder SCADA measurement point (grid demo)") == "data_lineage"
    assert gn._edge_kind("Feeder from primary substation (grid demo)") == "electrical_topology"
    assert gn._edge_kind("Customer on distribution substation (grid demo)") == "electrical_topology"
    assert gn._edge_kind("Loss finding at substation (grid demo)") == "logical"
    assert gn._edge_kind("Loss finding on feeder (grid demo)") == "logical"
    assert gn._edge_kind("Work order from loss finding (grid demo)") == "operational_dependency"
    assert gn._edge_kind("Field visit by crew (grid demo)") == "operational_dependency"
    assert gn._edge_kind("P2TL meter inspection of customer (grid demo)") == "operational_dependency"
    assert gn._edge_kind("Something unlisted (grid demo)") == "logical"


def test_edge_terms_are_human_verbs_in_link_direction():
    assert gn._edge_term("Feeder from primary substation (grid demo)") == "powered by"
    assert gn._edge_term("Customer on distribution substation (grid demo)") == "belongs to"
    assert gn._edge_term("Feeder SCADA measurement point (grid demo)") == "measures"
    assert gn._edge_term("P2TL meter inspection of customer (grid demo)") == "inspects"
    assert gn._edge_term("Unlisted link") == "related to"
    for name in gn.EDGE_TERMS:
        assert gn._edge_term(name) != "related to"


def test_paths_follow_real_edges_and_stop_when_unconnected():
    edges = [
        {"id": "e1", "source": "a", "target": "b"},
        {"id": "e2", "source": "b", "target": "c"},
        {"id": "e3", "source": "x", "target": "y"},
    ]
    assert gn._paths(edges, "a", "c") == ["e1", "e2"]
    assert gn._paths(edges, "c", "a") == ["e2", "e1"]
    assert gn._paths(edges, "a", "y") == []


def test_semantic_layer_marks_interpretation_and_unverified_properties():
    fake = {
        "description": "Verified ontology description.",
        "properties": [
            {"api_name": "kode_dt", "display_name": "DT code", "type": "string", "description": ""},
            {"api_name": "mystery_field", "display_name": "Mystery", "type": "string", "description": ""},
            {"api_name": "documented", "display_name": "Doc", "type": "string", "description": "From the ontology."},
        ],
    }
    sem = gn._node_semantic(fake, "Grid Distribution Substation")
    assert sem["verified_definition"] == "Verified ontology description."
    assert sem["verified_source"] == "ontology"
    assert sem["interpretation"]["source"] == "interpretation"
    by_name = {p["api_name"]: p for p in sem["properties"]}
    assert by_name["kode_dt"]["meaning"] and by_name["kode_dt"]["meaning_source"] == "interpretation"
    assert by_name["mystery_field"]["meaning"] is None and "mystery_field" in sem["unverified_properties"]
    assert by_name["documented"]["verified"] is True


def test_grid_type_inclusion_excludes_logs_and_tests():
    assert gn._is_grid_type("Grid Feeder (demo)")
    assert gn._is_grid_type("Titik Ukur SCADA Grid (demo)")
    assert gn._is_grid_type("Transmission Line Java-Bali Combined (OSM)")
    assert gn._is_grid_type("Substation Java-Bali Combined (OSM)")
    assert gn._is_grid_type("Power Plant West Java (OSM)")
    assert not gn._is_grid_type("Grid Loss Finding status log (demo)")
    assert not gn._is_grid_type("Grid Feeder — manual (0536, test)")
    assert not gn._is_grid_type("Klaim JKN (demo)")


def test_function_and_model_node_builders():
    type_node = {"id": "ot-x", "name": "Grid Distribution Substation", "api_name": "GarduDistribusiGridDemo",
                 "functions": [{"id": "fn-1", "name": "alasan_susut_gardu", "doc": "Why.", "output": "string", "version": "1.0.0"}]}
    fn_nodes, fn_edges = gn._function_nodes([type_node])
    assert fn_nodes[0]["node_kind"] == "function" and fn_nodes[0]["on_type_id"] == "ot-x"
    assert fn_edges[0]["term"] == "runs on" and fn_edges[0]["verified"] is True
    m_nodes, m_edges = gn._model_nodes({})
    assert isinstance(m_nodes, list) and isinstance(m_edges, list)  # registry may be unavailable in tests


def test_search_intents_only_reference_target_types():
    for intent in gn.INTENTS:
        for name in intent["types"]:
            assert name in gn.TARGETS, (intent["q"], name)
