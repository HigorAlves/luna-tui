#!/usr/bin/env python3
"""A headless, code-only Graphify build: detect the corpus, extract the AST, build and cluster the
graph, export graph.json and a report, and stamp the commit it was built from. No LLM, no key.
Reads the checkout at --input (read-only), writes only under --out."""
import argparse, json, sys, time
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path


def graphify_version() -> str:
    try:
        return version("graphifyy")
    except PackageNotFoundError:
        return "unknown"


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--input", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--commit", required=True)
    a = p.parse_args()
    root, out = Path(a.input), Path(a.out) / "graphify-out"
    out.mkdir(parents=True, exist_ok=True)
    from graphify.detect import detect
    from graphify.extract import collect_files, extract
    from graphify.build import build_from_json
    from graphify.cluster import cluster, score_all
    from graphify.analyze import god_nodes, surprising_connections, suggest_questions
    from graphify.report import generate
    from graphify.export import to_json

    detection = detect(root)
    code = []
    for f in detection.get("files", {}).get("code", []):
        code.extend(collect_files(Path(f)) if Path(f).is_dir() else [Path(f)])
    if not code:
        print("graph: no code files", file=sys.stderr)
        return 2
    ast = extract(code, cache_root=root)
    extraction = {"nodes": ast["nodes"], "edges": ast["edges"], "hyperedges": [], "input_tokens": 0, "output_tokens": 0}
    G = build_from_json(extraction, root=str(root), directed=False)
    if G.number_of_nodes() == 0:
        print("graph: empty extraction", file=sys.stderr)
        return 2
    communities = cluster(G)
    cohesion = score_all(G, communities)
    labels = {cid: f"Community {cid}" for cid in communities}
    gods = god_nodes(G)
    surprises = surprising_connections(G, communities)
    questions = suggest_questions(G, communities, labels)
    # A fresh output dir: never refuse to write.
    if not to_json(G, communities, str(out / "graph.json"), force=True, built_at_commit=a.commit):
        print("graph: export refused", file=sys.stderr)
        return 1
    report = generate(
        G, communities, cohesion, labels, gods, surprises, detection, {"input": 0, "output": 0}, str(root),
        suggested_questions=questions, built_at_commit=a.commit,
    )
    (out / "GRAPH_REPORT.md").write_text(report, encoding="utf-8")
    stamp = {
        "schema": 1,
        "commit": a.commit,
        "builtAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "nodes": G.number_of_nodes(),
        "edges": G.number_of_edges(),
        "communities": len(communities),
        "graphify": graphify_version(),
    }
    (Path(a.out) / "stamp.json").write_text(json.dumps(stamp, indent=2), encoding="utf-8")
    print(json.dumps(stamp))
    return 0


if __name__ == "__main__":
    sys.exit(main())
