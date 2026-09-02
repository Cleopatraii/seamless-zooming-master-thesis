"""Query helpers for extracting graph-shaped data from Neo4j."""

import json
from pathlib import Path

from src.integrations.neo4j_client import get_neo4j_database, get_neo4j_driver

# local mode:
# 1. fetch the anchor application's own events
# 2. inspect which entities those events are correlated with
#
# expanded mode:
# 1. use the shared BPIC17 case field
# 2. fetch every event whose case equals the anchor application ID
# 3. fetch every DF edge whose source and target stay inside that case
#
# entity-instance mode (optional fallback):
# 1. fetch the full lifecycle of one selected entity instance
# 2. fetch only the DF edges of the matching perspective for that instance

LOCAL_APPLICATION_MEMBERSHIP_QUERY = """
MATCH (:Entity {EntityType: 'Application', ID: $application_id})<-[:CORR]-(e:Event)-[:CORR]->(n:Entity)
RETURN e.EventID AS event_id,
       e.Activity AS activity,
       e.timestamp AS timestamp,
       e.case AS case_id,
       n.EntityType AS entity_type,
       n.ID AS entity_id,
       true AS is_anchor_event
ORDER BY e.timestamp, event_id, entity_type, entity_id
"""


LOCAL_APPLICATION_DF_QUERY = """
MATCH (:Entity {EntityType: 'Application', ID: $application_id})<-[:CORR]-(e1:Event)
MATCH (:Entity {EntityType: 'Application', ID: $application_id})<-[:CORR]-(e2:Event)
MATCH (e1)-[df:DF]->(e2)
RETURN e1.EventID AS source_event_id,
       e1.Activity AS source_activity,
       e1.timestamp AS source_timestamp,
       e2.EventID AS target_event_id,
       e2.Activity AS target_activity,
       e2.timestamp AS target_timestamp,
       df.EntityType AS perspective,
       true AS source_is_anchor_event,
       e2.case = $application_id AS target_is_anchor_event
ORDER BY source_timestamp, source_event_id, target_event_id, perspective
"""


EXPANDED_APPLICATION_MEMBERSHIP_QUERY = """
MATCH (event_node:Event {case: $application_id})-[:CORR]->(member_entity:Entity)
RETURN event_node.EventID AS event_id,
       event_node.Activity AS activity,
       event_node.timestamp AS timestamp,
       event_node.case AS case_id,
       member_entity.EntityType AS entity_type,
       member_entity.ID AS entity_id,
       true AS is_anchor_event
ORDER BY timestamp, event_id, entity_type, entity_id
"""


EXPANDED_APPLICATION_DF_QUERY = """
MATCH (e1:Event {case: $application_id})-[df:DF]->(e2:Event {case: $application_id})
RETURN e1.EventID AS source_event_id,
       e1.Activity AS source_activity,
       e1.timestamp AS source_timestamp,
       e2.EventID AS target_event_id,
       e2.Activity AS target_activity,
       e2.timestamp AS target_timestamp,
       df.EntityType AS perspective,
       true AS source_is_anchor_event,
       true AS target_is_anchor_event
ORDER BY source_timestamp, source_event_id, target_event_id, perspective
"""


ENTITY_INSTANCE_MEMBERSHIP_QUERY = """
MATCH (:Entity {EntityType: $entity_type, ID: $entity_id})<-[:CORR]-(e:Event)-[:CORR]->(n:Entity)
RETURN e.EventID AS event_id,
       e.Activity AS activity,
       e.timestamp AS timestamp,
       e.case AS case_id,
       n.EntityType AS entity_type,
       n.ID AS entity_id,
       false AS is_anchor_event
ORDER BY e.timestamp, event_id, entity_type, entity_id
"""


ENTITY_INSTANCE_DF_QUERY = """
MATCH (:Entity {EntityType: $entity_type, ID: $entity_id})<-[:CORR]-(e1:Event)-[df:DF]->(e2:Event)-[:CORR]->(:Entity {EntityType: $entity_type, ID: $entity_id})
WHERE df.EntityType = $entity_type
RETURN e1.EventID AS source_event_id,
       e1.Activity AS source_activity,
       e1.timestamp AS source_timestamp,
       e2.EventID AS target_event_id,
       e2.Activity AS target_activity,
       e2.timestamp AS target_timestamp,
       df.EntityType AS perspective,
       false AS source_is_anchor_event,
       false AS target_is_anchor_event
ORDER BY source_timestamp, source_event_id, target_event_id, perspective
"""


EXPANDED_ENTITY_CONTEXT_MEMBERSHIP_QUERY = """
MATCH (:Entity {EntityType: $entity_type, ID: $entity_id})<-[:CORR]-(anchor_event:Event)
WITH collect(DISTINCT anchor_event.case) AS related_cases
UNWIND related_cases AS related_case
MATCH (event_node:Event {case: related_case})-[:CORR]->(member_entity:Entity)
RETURN event_node.EventID AS event_id,
       event_node.Activity AS activity,
       event_node.timestamp AS timestamp,
       event_node.case AS case_id,
       member_entity.EntityType AS entity_type,
       member_entity.ID AS entity_id,
       false AS is_anchor_event
ORDER BY timestamp, event_id, entity_type, entity_id
"""


EXPANDED_ENTITY_CONTEXT_DF_QUERY = """
MATCH (:Entity {EntityType: $entity_type, ID: $entity_id})<-[:CORR]-(anchor_event:Event)
WITH collect(DISTINCT anchor_event.case) AS related_cases
UNWIND related_cases AS related_case
MATCH (e1:Event {case: related_case})-[df:DF]->(e2:Event {case: related_case})
RETURN e1.EventID AS source_event_id,
       e1.Activity AS source_activity,
       e1.timestamp AS source_timestamp,
       e2.EventID AS target_event_id,
       e2.Activity AS target_activity,
       e2.timestamp AS target_timestamp,
       df.EntityType AS perspective,
       false AS source_is_anchor_event,
       false AS target_is_anchor_event
ORDER BY source_timestamp, source_event_id, target_event_id, perspective
"""


INSTANCE_SUMMARY_BASE_QUERY_TEMPLATE = """
MATCH (application_entity:Entity {{EntityType: 'Application'}})
WITH DISTINCT application_entity.ID AS application_id
WHERE $application_search = '' OR toLower(application_id) CONTAINS toLower($application_search)
MATCH (event_node:Event {{case: application_id}})
WITH application_id,
     count(DISTINCT event_node.EventID) AS event_count,
     min(event_node.timestamp) AS start_time,
     max(event_node.timestamp) AS end_time,
     sum(CASE WHEN event_node.Activity CONTAINS 'Cancel' THEN 1 ELSE 0 END) > 0 AS has_cancellation
CALL (application_id) {{
    MATCH (offer_event:Event {{case: application_id}})-[:CORR]->(offer_entity:Entity {{EntityType: 'Offer'}})
    RETURN count(DISTINCT offer_entity.ID) AS offer_count
}}
CALL (application_id) {{
    MATCH (source_event:Event {{case: application_id}})-[df:DF]->(target_event:Event {{case: application_id}})
    RETURN count(df) AS df_edge_count
}}
WITH application_id,
     event_count,
     df_edge_count,
     offer_count,
     start_time,
     end_time,
     has_cancellation
WHERE event_count >= $min_events
  AND offer_count >= $min_offers
  AND ($only_cancelled = false OR has_cancellation)
"""


INSTANCE_SUMMARY_QUERY_TEMPLATE = INSTANCE_SUMMARY_BASE_QUERY_TEMPLATE + """
RETURN application_id,
       event_count,
       df_edge_count,
       offer_count,
       start_time,
       end_time,
       has_cancellation
ORDER BY {order_field} {order_direction}, application_id ASC
SKIP $skip
LIMIT $limit
"""


INSTANCE_SUMMARY_COUNT_QUERY_TEMPLATE = INSTANCE_SUMMARY_BASE_QUERY_TEMPLATE + """
RETURN count(*) AS total
"""


INSTANCE_SUMMARY_SORT_FIELDS = {
    "event_count": "event_count",
    "df_edge_count": "df_edge_count",
    "offer_count": "offer_count",
    "start_time": "start_time",
    "application_id": "application_id",
}


ENTITY_INSTANCE_SUMMARY_BASE_QUERY_TEMPLATE = """
MATCH (entity:Entity {{EntityType: $entity_type}})
WITH DISTINCT entity.ID AS entity_id
WHERE $application_search = '' OR toLower(entity_id) CONTAINS toLower($application_search)
MATCH (:Entity {{EntityType: $entity_type, ID: entity_id}})<-[:CORR]-(event_node:Event)
WITH entity_id,
     count(DISTINCT event_node.EventID) AS event_count,
     min(event_node.timestamp) AS start_time,
     max(event_node.timestamp) AS end_time,
     sum(CASE WHEN event_node.Activity CONTAINS 'Cancel' THEN 1 ELSE 0 END) > 0 AS has_cancellation,
     count(DISTINCT event_node.case) AS related_case_count
CALL (entity_id) {{
    MATCH (:Entity {{EntityType: $entity_type, ID: entity_id}})<-[:CORR]-(source_event:Event)-[df:DF]->(target_event:Event)
    WHERE df.EntityType = $entity_type
    RETURN count(df) AS df_edge_count
}}
WITH entity_id,
     event_count,
     df_edge_count,
     related_case_count,
     start_time,
     end_time,
     has_cancellation
WHERE event_count >= $min_events
  AND related_case_count >= $min_offers
  AND ($only_cancelled = false OR has_cancellation)
"""


ENTITY_INSTANCE_SUMMARY_QUERY_TEMPLATE = ENTITY_INSTANCE_SUMMARY_BASE_QUERY_TEMPLATE + """
RETURN entity_id,
       event_count,
       df_edge_count,
       related_case_count,
       start_time,
       end_time,
       has_cancellation
ORDER BY {order_field} {order_direction}, entity_id ASC
SKIP $skip
LIMIT $limit
"""


ENTITY_INSTANCE_SUMMARY_COUNT_QUERY_TEMPLATE = ENTITY_INSTANCE_SUMMARY_BASE_QUERY_TEMPLATE + """
RETURN count(*) AS total
"""


ENTITY_INSTANCE_SUMMARY_SORT_FIELDS = {
    "event_count": "event_count",
    "df_edge_count": "df_edge_count",
    "offer_count": "related_case_count",
    "start_time": "start_time",
    "application_id": "entity_id",
}


ABSTRACTION_ENTITY_TYPES = {"Application", "Offer", "Workflow"}


def _run_query(query, **parameters):
    """Run one Neo4j query and return records as dictionaries."""
    database = get_neo4j_database()

    with get_neo4j_driver() as driver:
        with driver.session(database=database) as session:
            result = session.run(query, **parameters)
            return [dict(record) for record in result]


def _parse_page_parameters(page=1, page_size=20):
    """Normalize pagination parameters for bounded overview queries."""
    normalized_page = max(int(page or 1), 1)
    normalized_page_size = min(max(int(page_size or 20), 1), 100)
    return normalized_page, normalized_page_size


def _normalize_sort_parameters(sort="event_count", order="desc"):
    """Return safe Cypher order tokens from user-provided values."""
    order_field = INSTANCE_SUMMARY_SORT_FIELDS.get(sort, "event_count")
    order_direction = "ASC" if str(order).lower() == "asc" else "DESC"
    return order_field, order_direction


def _normalize_entity_sort_parameters(sort="event_count", order="desc"):
    """Return safe Cypher order tokens for entity instance overview queries."""
    order_field = ENTITY_INSTANCE_SUMMARY_SORT_FIELDS.get(sort, "event_count")
    order_direction = "ASC" if str(order).lower() == "asc" else "DESC"
    return order_field, order_direction


def _normalize_instance_filters(
    application_search="",
    min_events=0,
    min_offers=0,
    only_cancelled=False,
):
    """Normalize instance overview filters before passing them to Cypher."""
    return {
        "application_search": str(application_search or "").strip().lower(),
        "min_events": max(int(min_events or 0), 0),
        "min_offers": max(int(min_offers or 0), 0),
        "only_cancelled": bool(only_cancelled),
    }


def _duration_days(start_time, end_time):
    """Compute a coarse duration in days from ISO-like timestamp strings."""
    from datetime import datetime

    def parse_timestamp(value):
        if not value:
            return None
        text = str(value)
        if "." in text:
            prefix, suffix = text.split(".", 1)
            timezone_part = ""
            fraction_part = suffix
            for marker in ["+", "-", "Z"]:
                marker_index = suffix.find(marker)
                if marker_index > 0:
                    fraction_part = suffix[:marker_index]
                    timezone_part = suffix[marker_index:]
                    break
            text = f"{prefix}.{fraction_part[:6]}{timezone_part}"
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        try:
            return datetime.fromisoformat(text)
        except ValueError:
            return None

    start = parse_timestamp(start_time)
    end = parse_timestamp(end_time)
    if start is None or end is None:
        return None
    return round((end - start).total_seconds() / 86400, 3)


def fetch_application_instance_summaries(
    page=1,
    page_size=20,
    sort="event_count",
    order="desc",
    application_search="",
    min_events=0,
    min_offers=0,
    only_cancelled=False,
):
    """Fetch one page of lightweight Application instance summaries."""
    normalized_page, normalized_page_size = _parse_page_parameters(page, page_size)
    order_field, order_direction = _normalize_sort_parameters(sort, order)
    filters = _normalize_instance_filters(
        application_search=application_search,
        min_events=min_events,
        min_offers=min_offers,
        only_cancelled=only_cancelled,
    )
    query = INSTANCE_SUMMARY_QUERY_TEMPLATE.format(
        order_field=order_field,
        order_direction=order_direction,
    )
    query_parameters = {
        **filters,
        "skip": (normalized_page - 1) * normalized_page_size,
        "limit": normalized_page_size,
    }
    rows = _run_query(
        query,
        **query_parameters,
    )
    total_rows = _run_query(
        INSTANCE_SUMMARY_COUNT_QUERY_TEMPLATE.format(),
        **filters,
    )
    total = int(total_rows[0]["total"]) if total_rows else 0

    instances = []
    for row in rows:
        start_time = row.get("start_time")
        end_time = row.get("end_time")
        instances.append({
            "id": row["application_id"],
            "label": row["application_id"],
            "entityType": "Application",
            "eventCount": row["event_count"],
            "dfEdgeCount": row["df_edge_count"],
            "offerCount": row["offer_count"],
            "startTime": str(start_time) if start_time is not None else None,
            "endTime": str(end_time) if end_time is not None else None,
            "durationDays": _duration_days(start_time, end_time),
            "hasCancellation": bool(row.get("has_cancellation")),
        })

    return {
        "page": normalized_page,
        "pageSize": normalized_page_size,
        "total": total,
        "sort": sort,
        "order": order_direction.lower(),
        "entityType": "Application",
        "filters": filters,
        "instances": instances,
    }


def fetch_entity_instance_summaries(
    entity_type,
    page=1,
    page_size=20,
    sort="event_count",
    order="desc",
    application_search="",
    min_events=0,
    min_offers=0,
    only_cancelled=False,
):
    """Fetch one page of lightweight Offer or Workflow instance summaries."""
    if entity_type == "Application":
        return fetch_application_instance_summaries(
            page=page,
            page_size=page_size,
            sort=sort,
            order=order,
            application_search=application_search,
            min_events=min_events,
            min_offers=min_offers,
            only_cancelled=only_cancelled,
        )
    if entity_type not in ABSTRACTION_ENTITY_TYPES:
        raise ValueError(f"Unsupported abstraction entity type: {entity_type}")

    normalized_page, normalized_page_size = _parse_page_parameters(page, page_size)
    order_field, order_direction = _normalize_entity_sort_parameters(sort, order)
    filters = _normalize_instance_filters(
        application_search=application_search,
        min_events=min_events,
        min_offers=min_offers,
        only_cancelled=only_cancelled,
    )
    query_parameters = {
        **filters,
        "entity_type": entity_type,
        "skip": (normalized_page - 1) * normalized_page_size,
        "limit": normalized_page_size,
    }
    rows = _run_query(
        ENTITY_INSTANCE_SUMMARY_QUERY_TEMPLATE.format(
            order_field=order_field,
            order_direction=order_direction,
        ),
        **query_parameters,
    )
    total_rows = _run_query(
        ENTITY_INSTANCE_SUMMARY_COUNT_QUERY_TEMPLATE.format(),
        **query_parameters,
    )
    total = int(total_rows[0]["total"]) if total_rows else 0

    instances = []
    for row in rows:
        start_time = row.get("start_time")
        end_time = row.get("end_time")
        instances.append({
            "id": row["entity_id"],
            "label": row["entity_id"],
            "entityType": entity_type,
            "eventCount": row["event_count"],
            "dfEdgeCount": row["df_edge_count"],
            "offerCount": row["related_case_count"],
            "relatedCaseCount": row["related_case_count"],
            "startTime": str(start_time) if start_time is not None else None,
            "endTime": str(end_time) if end_time is not None else None,
            "durationDays": _duration_days(start_time, end_time),
            "hasCancellation": bool(row.get("has_cancellation")),
        })

    return {
        "page": normalized_page,
        "pageSize": normalized_page_size,
        "total": total,
        "sort": sort,
        "order": order_direction.lower(),
        "entityType": entity_type,
        "filters": filters,
        "instances": instances,
    }


def fetch_local_application_memberships(application_id):
    """Fetch event-entity memberships for the anchor application's own events."""
    return _run_query(
        LOCAL_APPLICATION_MEMBERSHIP_QUERY,
        application_id=application_id,
    )


def fetch_local_application_df_edges(application_id):
    """Fetch DF edges visible in the anchor application's local subgraph."""
    return _run_query(
        LOCAL_APPLICATION_DF_QUERY,
        application_id=application_id,
    )


def fetch_expanded_application_memberships(
    application_id,
    selected_perspectives=None,
):
    """Fetch memberships for the full case-level subgraph."""
    return _run_query(
        EXPANDED_APPLICATION_MEMBERSHIP_QUERY,
        application_id=application_id,
    )


def fetch_expanded_application_df_edges(
    application_id,
    selected_perspectives=None,
):
    """Fetch DF edges for the full case-level subgraph."""
    return _run_query(
        EXPANDED_APPLICATION_DF_QUERY,
        application_id=application_id,
    )


def fetch_entity_instance_memberships(entity_type, entity_id):
    """Fetch the full lifecycle memberships for one selected entity instance."""
    return _run_query(
        ENTITY_INSTANCE_MEMBERSHIP_QUERY,
        entity_type=entity_type,
        entity_id=entity_id,
    )


def fetch_entity_instance_df_edges(entity_type, entity_id):
    """Fetch perspective-specific DF edges for one selected entity instance."""
    return _run_query(
        ENTITY_INSTANCE_DF_QUERY,
        entity_type=entity_type,
        entity_id=entity_id,
    )


def fetch_expanded_entity_context_memberships(entity_type, entity_id):
    """Fetch the full case context around one selected Offer or Workflow instance."""
    return _run_query(
        EXPANDED_ENTITY_CONTEXT_MEMBERSHIP_QUERY,
        entity_type=entity_type,
        entity_id=entity_id,
    )


def fetch_expanded_entity_context_df_edges(entity_type, entity_id):
    """Fetch all same-case DF edges around one selected Offer or Workflow instance."""
    return _run_query(
        EXPANDED_ENTITY_CONTEXT_DF_QUERY,
        entity_type=entity_type,
        entity_id=entity_id,
    )


def _get_mode_payload(
    mode,
    application_id,
    selected_perspectives=None,
):
    """Build the export payload for one subgraph mode."""
    if mode == "local":
        memberships = fetch_local_application_memberships(application_id)
        df_edges = fetch_local_application_df_edges(application_id)
    elif mode == "expanded":
        memberships = fetch_expanded_application_memberships(
            application_id,
            selected_perspectives=selected_perspectives,
        )
        df_edges = fetch_expanded_application_df_edges(
            application_id,
            selected_perspectives=selected_perspectives,
        )
    else:
        raise ValueError(f"Unsupported mode: {mode}")

    return {
        "mode": mode,
        "anchor": {
            "entityType": "Application",
            "entityId": application_id,
        },
        "selectedPerspectives": selected_perspectives,
        "memberships": memberships,
        "dfEdges": df_edges,
    }


def build_anchor_application_sample_payload(
    application_id,
    mode="expanded",
    selected_perspectives=None,
):
    """Build a local or expanded payload without writing it to disk."""
    return _get_mode_payload(
        mode,
        application_id,
        selected_perspectives=selected_perspectives,
    )


def build_entity_instance_sample_payload(entity_type, entity_id, mode="local"):
    """Build a payload for one selected entity lifecycle."""
    if entity_type not in ABSTRACTION_ENTITY_TYPES:
        raise ValueError(f"Unsupported entity type: {entity_type}")
    if mode not in {"local", "expanded"}:
        raise ValueError(f"Unsupported mode: {mode}")

    if mode == "expanded":
        memberships = fetch_expanded_entity_context_memberships(entity_type, entity_id)
        df_edges = fetch_expanded_entity_context_df_edges(entity_type, entity_id)
    else:
        memberships = fetch_entity_instance_memberships(entity_type, entity_id)
        df_edges = fetch_entity_instance_df_edges(entity_type, entity_id)
    return {
        "mode": mode,
        "anchor": {
            "entityType": entity_type,
            "entityId": entity_id,
        },
        "selectedPerspectives": [entity_type],
        "memberships": memberships,
        "dfEdges": df_edges,
    }


def export_anchor_application_sample(
    application_id,
    output_path,
    mode="expanded",
    selected_perspectives=None,
):
    """Export a JSON sample for frontend prototyping from the real Neo4j schema."""
    payload = _get_mode_payload(
        mode,
        application_id,
        selected_perspectives=selected_perspectives,
    )
    output_file = Path(output_path)
    output_file.parent.mkdir(parents=True, exist_ok=True)
    output_file.write_text(
        json.dumps(payload, indent=2, default=str),
        encoding="utf-8",
    )
    return output_file
