"""Validate and summarize an exported Neo4j JSON sample."""

import argparse
import json
from collections import defaultdict
from pathlib import Path


def build_parser():
    parser = argparse.ArgumentParser(
        description="Verify an exported Neo4j JSON sample."
    )
    parser.add_argument(
        "--input",
        default="data/neo4j_samples/sample_structure.json",
        help="Path to the exported JSON sample.",
    )
    return parser


def load_export(path):
    input_path = Path(path)
    return json.loads(input_path.read_text(encoding="utf-8"))


def collect_unique_events(memberships):
    events = {}
    entity_type_to_events = defaultdict(set)

    for membership in memberships:
        event_id = membership["event_id"]
        entity_type = membership["entity_type"]
        event_record = events.setdefault(
            event_id,
            {
                "event_id": event_id,
                "activity": membership["activity"],
                "timestamp": membership["timestamp"],
                "case_id": membership["case_id"],
                "is_anchor_event": membership["is_anchor_event"],
            },
        )
        if membership["is_anchor_event"]:
            event_record["is_anchor_event"] = True
        entity_type_to_events[entity_type].add(event_id)

    return events, entity_type_to_events


def count_df_edges_by_perspective(df_edges):
    counts = defaultdict(int)
    for edge in df_edges:
        counts[edge["perspective"]] += 1
    return counts


def find_unexpected_case_ids(events, anchor_application_id):
    unexpected = sorted(
        {
            event["case_id"]
            for event in events.values()
            if event["case_id"] != anchor_application_id
        }
    )
    return unexpected


def count_anchor_events(events):
    return sum(1 for event in events.values() if event["is_anchor_event"])


def sort_events_by_time(events):
    return sorted(
        events.values(),
        key=lambda event: (
            event["timestamp"],
            event["event_id"],
        ),
    )


def print_report(data):
    anchor_application_id = data["anchor"]["entityId"]
    memberships = data.get("memberships", [])
    df_edges = data.get("dfEdges", [])

    events, entity_type_to_events = collect_unique_events(memberships)
    df_edges_by_perspective = count_df_edges_by_perspective(df_edges)
    unexpected_case_ids = find_unexpected_case_ids(events, anchor_application_id)
    anchor_event_count = count_anchor_events(events)
    sorted_events = sort_events_by_time(events)

    print(f"anchor application ID: {anchor_application_id}")
    print(f"total unique events: {len(events)}")
    print(f"total DF edges: {len(df_edges)}")
    print("unique events by entity type:")
    for entity_type in sorted(entity_type_to_events):
        print(f"  {entity_type}: {len(entity_type_to_events[entity_type])}")
    print("DF edges by perspective:")
    for perspective in sorted(df_edges_by_perspective):
        print(f"  {perspective}: {df_edges_by_perspective[perspective]}")

    if unexpected_case_ids:
        print("unexpected case_id values:")
        for case_id in unexpected_case_ids:
            print(f"  {case_id}")
    else:
        print("all event case_id values match the anchor application ID")

    print(f"is_anchor_event=true unique events: {anchor_event_count}")
    print("events sorted by time:")
    for event in sorted_events:
        print(
            f"{event['event_id']} | "
            f"{event['activity']} | "
            f"{event['timestamp']}"
        )


def main():
    args = build_parser().parse_args()
    data = load_export(args.input)
    print_report(data)


if __name__ == "__main__":
    main()
