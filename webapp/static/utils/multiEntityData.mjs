/*
SEAMLESS_ZOOM - A technique for seamless zooming between process models and process instances.
*/

import { getEntityDisplayCategory, splitVisibleAndHiddenMemberships } from "./multiEntityConfig.mjs";
import { buildActivityRanking } from "./multiEntityActivityRanking.mjs";

const secondsToDays = (seconds) => seconds / 86400;
const EXPANDABLE_ENTITY_TYPES = new Set(["Case_AO", "Case_AW", "Case_WO", "Offer", "Workflow"]);

function getSampleContext(sample) {
    return {
        memberships: sample.memberships ?? [],
        dfEdges: sample.dfEdges ?? [],
        anchorEntityId: sample.anchor?.entityId ?? null,
        anchorEntityType: sample.anchor?.entityType ?? null,
    };
}

function findBaseTimestamp(memberships) {
    let baseTimestampMs = null;

    memberships.forEach((membership) => {
        const timestampMs = Date.parse(membership.timestamp);
        if (!Number.isFinite(timestampMs)) return;

        baseTimestampMs = baseTimestampMs == null
            ? timestampMs
            : Math.min(baseTimestampMs, timestampMs);
    });

    return baseTimestampMs;
}

function getRelativeSeconds(timestamp, baseTimestampMs) {
    const timestampMs = Date.parse(timestamp);
    if (!Number.isFinite(timestampMs) || baseTimestampMs == null) return 0;
    return (timestampMs - baseTimestampMs) / 1000;
}

function makeEntityKey(entityType, entityId) {
    return `${entityType}::${entityId}`;
}

// One raw Neo4j membership row describes one Event -> Entity correlation.
// The event object is created once, then more memberships are appended to it.
function createEventFromMembership(membership, relativeSeconds) {
    return {
        id: membership.event_id,
        event_id: membership.event_id,
        activity: membership.activity,
        "concept:name": membership.activity,
        timestamp: membership.timestamp,
        timestamps: membership.timestamp,
        case: membership.case_id,
        resources: "",
        timestamp_relative_seconds: relativeSeconds,
        is_anchor_event: Boolean(membership.is_anchor_event),
        entityMemberships: [],
        entityMembershipKeys: [],
        entityTypes: [],
        isShared: false,
    };
}

function addMembershipToEvent(event, membership, entityKey) {
    // Resource is kept in the legacy TOM-compatible `resources` field.
    if (membership.entity_type === "Case_R" && !event.resources) {
        event.resources = membership.entity_id;
    }
    if (membership.is_anchor_event) {
        event.is_anchor_event = true;
    }
    if (event.entityMembershipKeys.includes(entityKey)) return;

    event.entityMembershipKeys.push(entityKey); //entityKey是那个:: 复合的id
    event.entityMemberships.push({
        entityType: membership.entity_type,
        displayCategory: getEntityDisplayCategory(membership.entity_type),
        entityId: membership.entity_id,
        entityKey,
    });
    event.entityTypes.push(membership.entity_type);
}

function addEventToEntityIndex(entityIndex, membership, entityKey) {
    // entityIndex answers: "given this entity instance, which events belong to it?"
    const indexEntry = entityIndex.get(entityKey) ?? {
        entityType: membership.entity_type,
        entityId: membership.entity_id,
        entityKey,
        eventIds: new Set(),
        edgeIds: new Set(),
    };

    //外层循环membership来给 每个entity加满event lifecycle
    indexEntry.eventIds.add(membership.event_id);
    //entityIndex是个map
    entityIndex.set(entityKey, indexEntry);
}

function buildEventAndEntityIndexes(memberships, baseTimestampMs) {
    const eventMap = new Map();
    const entityIndex = new Map();

    // Multiple rows can point to the same event_id. Map keeps one event node,
    // while arrays on that node keep all entity memberships.
    memberships.forEach((membership) => {
        const eventId = membership.event_id;
        const entityKey = makeEntityKey(membership.entity_type, membership.entity_id);
        const relativeSeconds = getRelativeSeconds(membership.timestamp, baseTimestampMs);
        const event = eventMap.get(eventId) ?? createEventFromMembership(membership, relativeSeconds);

        addMembershipToEvent(event, membership, entityKey);
        eventMap.set(eventId, event);

        addEventToEntityIndex(entityIndex, membership, entityKey);
    });

    return { eventMap, entityIndex };
}

function ensureAnchorApplicationMembership(eventMap, entityIndex, anchorEntityType, anchorEntityId) {
    if (anchorEntityType !== "Application" || !anchorEntityId) return;

    // In expanded case-based exports, some events may belong to the same case
    // without an explicit Application CORR row. Add the anchor membership so
    // the shared layout can still treat them as part of the anchor case.
    const entityKey = makeEntityKey("Application", anchorEntityId);
    eventMap.forEach((event) => {
        if (event.case !== anchorEntityId) return;

        if (!event.entityMembershipKeys.includes(entityKey)) {
            event.entityMembershipKeys.unshift(entityKey);
            event.entityMemberships.unshift({
                entityType: "Application",
                displayCategory: "Application",
                entityId: anchorEntityId,
                entityKey,
            });
            event.entityTypes.unshift("Application");
        }

        // entity entry 就是 entityIndex 里的“一条记录”。
        // 它表示：
        // 某一个 entity instance 对应哪些 events、哪些 edges、能不能展开。
        const indexEntry = entityIndex.get(entityKey) ?? {
            entityType: "Application",
            entityId: anchorEntityId,
            entityKey,
            eventIds: new Set(),
            edgeIds: new Set(),
        };
        indexEntry.eventIds.add(event.id);
        entityIndex.set(entityKey, indexEntry);
    });
}

//按 display category 去重 membership 负责“同类只保留一个
function uniqueVisibleMembershipsByCategory(memberships) {
    const categoryMap = new Map();

    // The ring shows categories, not every raw entity row. For example,
    // multiple Offer-related rows should still produce one Offer category.
    memberships.forEach((membership) => {
        const category = membership.displayCategory ?? getEntityDisplayCategory(membership.entityType);
        if (!category || categoryMap.has(category)) return;

        categoryMap.set(category, {
            ...membership,
            displayCategory: category,
        });
    });

    return Array.from(categoryMap.values());
}

function decorateNodeForGraph(event, activityRanking) {
    const membershipGroups = splitVisibleAndHiddenMemberships(event.entityMemberships);
    const visibleMembershipsByCategory = uniqueVisibleMembershipsByCategory(membershipGroups.visible);

    // Add display-oriented fields used by the D3 renderer and side panel.
    return {
        ...event,
        visibleEntityMemberships: visibleMembershipsByCategory,
        hiddenEntityMemberships: membershipGroups.hidden,
        visibleEntityTypes: visibleMembershipsByCategory.map((membership) => membership.displayCategory),
        ranked_activity: activityRanking.get(event.activity) ?? event.activity,
        isShared: visibleMembershipsByCategory.length > 1,
    };
}

/*给每个 node 加上 ranked_activity，"A_Accepted"—>6_A_Accepted */
function buildGraphNodes(eventMap, activityRanking) {
    return Array.from(eventMap.values())
        .map((event) => decorateNodeForGraph(event, activityRanking))
        .sort((eventA, eventB) => {
            const delta = eventA.timestamp_relative_seconds - eventB.timestamp_relative_seconds;
            return delta !== 0 ? delta : eventA.id.localeCompare(eventB.id);
        });
}

function buildGraphEdges(dfEdges, eventMap, activityRanking) {
    return dfEdges.map((edge, index) => {
        const sourceNode = eventMap.get(edge.source_event_id);
        const targetNode = eventMap.get(edge.target_event_id);

        // Keep the original DF perspective. Later state code decides which
        // perspectives are visible in Local, Selective, or Show All mode.
        return {
            id: `df-${index}`,//这个边的index就是query查出来的顺序
            source: edge.source_event_id,
            target: edge.target_event_id,
            source_coordinates: [
                secondsToDays(sourceNode?.timestamp_relative_seconds ?? 0),
                activityRanking.get(edge.source_activity) ?? edge.source_activity,
            ],
            target_coordinates: [
                secondsToDays(targetNode?.timestamp_relative_seconds ?? 0),
                activityRanking.get(edge.target_activity) ?? edge.target_activity,
            ],
            entity: edge.perspective,
            perspective: edge.perspective,
            case: sourceNode?.case ?? targetNode?.case ?? "",
            source_is_anchor_event: Boolean(edge.source_is_anchor_event),
            target_is_anchor_event: Boolean(edge.target_is_anchor_event),
        };
    });
}

function getPerspectiveCategory(perspective) {
    return getEntityDisplayCategory(perspective) ?? perspective;
}

//这份数据里有哪些 perspective 可用 case_R->Resource
function getAvailablePerspectives(edges) {
    return new Set(
        edges
            .map((edge) => getPerspectiveCategory(edge.perspective))
            .filter(Boolean)
    );
}

function edgeBelongsToEntity(edge, entityEntry) {
    // A perspective edge belongs to an entity lifecycle only when both endpoint
    // events are members of that entity instance.
    return (
        getPerspectiveCategory(edge.perspective) === entityEntry.displayCategory &&
        entityEntry.eventIds.has(edge.source) &&
        entityEntry.eventIds.has(edge.target)
    );
}

function enrichEntityIndexWithEdges(entityIndex, edges, availablePerspectives) {
    entityIndex.forEach((entry) => {
        entry.displayCategory = getEntityDisplayCategory(entry.entityType);

        edges.forEach((edge) => {
            if (edgeBelongsToEntity(edge, entry)) {
                entry.edgeIds.add(edge.id);
            }
        });

        entry.canExpand = (
            EXPANDABLE_ENTITY_TYPES.has(entry.entityType) &&
            Boolean(entry.displayCategory) &&
            availablePerspectives.has(entry.displayCategory) &&
            entry.eventIds.size > 0
        );
    });
}

function buildMultiEntityGraph(sample) {
    // Main conversion pipeline:
    // Neo4j JSON sample -> TOM-compatible nodes/edges + multi-entity indexes.
    const { memberships, dfEdges, anchorEntityId, anchorEntityType } = getSampleContext(sample);
    const baseTimestampMs = findBaseTimestamp(memberships);
    const { eventMap, entityIndex } = buildEventAndEntityIndexes(memberships, baseTimestampMs);

    ensureAnchorApplicationMembership(eventMap, entityIndex, anchorEntityType, anchorEntityId);

    const activityRanking = buildActivityRanking(eventMap, dfEdges);
    const nodes = buildGraphNodes(eventMap, activityRanking);
    const edges = buildGraphEdges(dfEdges, eventMap, activityRanking);
    const availablePerspectives = getAvailablePerspectives(edges);

    enrichEntityIndexWithEdges(entityIndex, edges, availablePerspectives);

    return {
        //nodes 给d3画图的event数组 eventMap 按eventid查event的字典
        graphData: { graph: [{ type: "directed" }], nodes, edges },
        eventMap,
        entityIndex,
        availablePerspectives: Array.from(availablePerspectives).sort(),
    };
}

function buildRowsFromGraph(graphData) {
    return graphData.nodes.map((node) => ({
        id: node.id,
        case: node.case,
        activity: node.activity,
        ranked_activity: node.ranked_activity,
        "concept:name": node.activity,
        timestamps: node.timestamp,
        timestamp_relative_seconds: node.timestamp_relative_seconds,
        resources: node.resources,
        is_anchor_event: node.is_anchor_event,
    }));
}

function buildGraphPayload(graphData, meta = {}) {
    return {
        graphData,
        rawRows: buildRowsFromGraph(graphData),
        meta,
    };
}

export { buildMultiEntityGraph, buildGraphPayload, makeEntityKey };
