"""CLI for exporting a small Neo4j sample as JSON."""

import argparse

from src.integrations.neo4j_queries import export_anchor_application_sample


def build_parser():
    parser = argparse.ArgumentParser(
        description="Export a Neo4j case sample to JSON."
    )
    parser.add_argument(
        "--application-id",
        default="Application_681547497",
        help="Anchor application identifier used in the Neo4j query.",
    )
    parser.add_argument(
        "--output",
        default="data/neo4j_samples/sample_structure.json",
        help="Output path for the exported JSON file.",
    )
    parser.add_argument(
        "--mode",
        default="expanded",
        choices=["local", "expanded"],
        help="Subgraph expansion mode used for the export.",
    )
    parser.add_argument(
        "--selected-perspectives",
        nargs="+",
        default=["Offer", "Workflow"],
        help="Entity types used for expanded-mode traversal.",
    )
    return parser


def main():
    args = build_parser().parse_args()
    output_file = export_anchor_application_sample(
        args.application_id,
        args.output,
        mode=args.mode,
        selected_perspectives=args.selected_perspectives,
    )
    print(f"Exported Neo4j sample to {output_file}")


if __name__ == "__main__":
    main()
