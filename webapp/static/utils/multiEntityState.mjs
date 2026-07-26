/*
SEAMLESS_ZOOM — A technique for seamless zooming between process models and process instances.
*/

import { buildGraphPayload, buildMultiEntityGraph } from "./multiEntityData.mjs";
import {
    OFFER_EDGE_COLORS,
    filterMembershipsForScope,
    getEntityDisplayCategory,
    isExpandableRelationEntityType,
    isRingEntityType,
    splitVisibleAndHiddenMemberships,
} from "./multiEntityConfig.mjs";

const secondsToDays = (seconds) => seconds / 86400;
const EXPANSION_RELATION_TYPE_BY_PERSPECTIVE = {
    Offer: "Case_AO",
    Workflow: "Case_AW",
};
const EXPANSION_TARGET_BY_RELATION_TYPE = {
    Case_AO: "Offer",
    Case_AW: "Workflow",
};
const PERSPECTIVE_EDGE_COLORS = {
    Application: "#1f9d55",
    Workflow: "#e85d04",
};
const PERSPECTIVE_PATH_OFFSETS = {
    Application: 0,
    Offer: 6,
    Workflow: -6,
};
const OVERLAP_THRESHOLD_SECONDS = 1;


function createMultiEntityState(localSample, expandedSample) {
    const localData = buildMultiEntityGraph(localSample);
    const expandedData = buildMultiEntityGraph(expandedSample);
    //"A_Create Application" => "1_A_Create Application"
    const sharedRankedActivityByActivity = new Map(
        expandedData.graphData.nodes.map((node) => [node.activity, node.ranked_activity])
    );
    //生成完整 y 轴的 activity 列表 Set 不能直接 .sort()，数组可以
    const sharedActivityDomain = Array.from(
        new Set(expandedData.graphData.nodes.map((node) => node.ranked_activity))
    ).sort((a, b) => {
        const aRank = Number.parseInt(String(a).split("_", 1)[0], 10);//得到第一个数字，10进制
        const bRank = Number.parseInt(String(b).split("_", 1)[0], 10);
        if (Number.isFinite(aRank) && Number.isFinite(bRank) && aRank !== bRank) {
            return aRank - bRank;
        }
        return String(a).localeCompare(String(b));
    });

    const localEventIds = new Set(localData.graphData.nodes.map((node) => node.id));

    const state = {
        anchor: expandedSample.anchor,
        localSample,
        expandedSample,
        localData,
        expandedData,
        mode: "local",
        expandedEntityKeys: new Set(),  //"Case_AO::Offer_716078829_Application_681547497"
        selectedEventId: null,
        hoveredEventId: null,
        graphFilters: {
            activityPrefix: "",
            activityContains: "",
            timeStartDays: "",
            timeEndDays: "",
        },
    };

    function getActiveEventId() {
        return state.selectedEventId ?? state.hoveredEventId;
    }

    //如果你展开了 Offer1 或 Workflow，事件详情里可能会显示相关的 Case_WO 信息
    function shouldIncludeWorkflowOfferRelations() {
        if (state.mode === "expanded") return true;
        return getExpandedEntityEntries().some((entry) => {
            const category = entry.displayCategory ?? getEntityDisplayCategory(entry.entityType);
            return category === "Offer" || category === "Workflow";
        });
    }

    function getExpansionAnchorPair(entry, targetEntityType) {
        const entryEvents = Array.from(entry.eventIds)
            .map((eventId) => expandedData.eventMap.get(eventId))
            .filter(Boolean)
            .sort((a, b) => {
                const delta = a.timestamp_relative_seconds - b.timestamp_relative_seconds;
                return delta !== 0 ? delta : a.id.localeCompare(b.id);
            });

        const firstLifecycleEvent = entryEvents.find((event) => (
            event.entityMemberships?.some((membership) => membership.entityType === targetEntityType)
        ));
        if (!firstLifecycleEvent) return null;

        const anchorEvent = entryEvents
            .filter((event) => (
                event.timestamp_relative_seconds <= firstLifecycleEvent.timestamp_relative_seconds &&
                !event.entityMemberships?.some((membership) => membership.entityType === targetEntityType) &&
                event.entityMemberships?.some((membership) => membership.entityType === "Application")
            ))
            .at(-1);
        if (!anchorEvent) return null;

        return { anchorEvent, firstLifecycleEvent };
    }

    function isExpansionAnchorMembership(event, membership) {
        const targetEntityType = EXPANSION_TARGET_BY_RELATION_TYPE[membership.entityType];
        if (!targetEntityType) return false;

        const entry = expandedData.entityIndex.get(membership.entityKey);
        if (!entry?.canExpand) return false;

        const expansionAnchor = getExpansionAnchorPair(entry, targetEntityType);
        return expansionAnchor?.anchorEvent.id === event.id;
    }

    /*
    * 1. 哪些可以显示
      2. 哪些画进 ring
      3. 哪些作为可展开 badge / sidebar relation
      4. ring 里每个 category 只画一次
      * 真正根据当前 Local / Selective / Expanded scope 决定 ring/badge */
    function decorateEventForCurrentScope(event) {
        if (!event) return null;

        //Application,Case_AO,Case_AW,Case_R ----Case_WO,Offer,Workflow
        const scopedMemberships = filterMembershipsForScope(event.entityMemberships, {
            anchorEntityType: state.anchor?.entityType ?? null,
            allowWorkflowOfferRelations: shouldIncludeWorkflowOfferRelations(),//是否允许 Case_WO / true Offer / true Workflow membership 出现
        });

        //把已经过滤过的 memberships 再分成两组
        //已经允许参与显示的 membership，放在主区域还是 Other relations（Case_WO，Case_AW）
        const membershipGroups = splitVisibleAndHiddenMemberships(scopedMemberships);
        const ringMemberships = scopedMemberships.filter((membership) => (
            isRingEntityType(membership.entityType)
        ));
        // Relation entities are not ring segments; they drive badges and Expand buttons.
        const relationMemberships = scopedMemberships.filter((membership) => (
            isExpandableRelationEntityType(membership.entityType)
        ));
        const anchorRelationMemberships = relationMemberships.filter((membership) => (
            isExpansionAnchorMembership(event, membership)
        ));
        //ring 里按 category 去重
        const visibleMembershipsByCategory = Array.from(
            ringMemberships.reduce((acc, membership) => {
                const category = membership.displayCategory ?? getEntityDisplayCategory(membership.entityType);
                if (!category || acc.has(category)) return acc;
                acc.set(category, {
                    ...membership,
                    displayCategory: category,
                });
                return acc;
            }, new Map()).values()
        );

        return {
            ...event,
            ranked_activity: sharedRankedActivityByActivity.get(event.activity) ?? event.ranked_activity ?? event.activity,
            scopedEntityMemberships: scopedMemberships,
            visibleEntityMemberships: visibleMembershipsByCategory,
            ringEntityMemberships: visibleMembershipsByCategory,
            expandableRelationMemberships: anchorRelationMemberships,
            expandableRelationCount: anchorRelationMemberships.length,
            hiddenEntityMemberships: membershipGroups.hidden,
            visibleEntityTypes: visibleMembershipsByCategory.map((membership) => membership.displayCategory),
            isShared: visibleMembershipsByCategory.length > 1,
        };
    }

    function getEventDetails(eventId) {
        if (!eventId) return null;
        return decorateEventForCurrentScope(expandedData.eventMap.get(eventId) ?? null);
    }

    function getEntityDetails(entityKey) {
        return expandedData.entityIndex.get(entityKey) ?? null;
    }

    function getExpandedEntityEntries() {
        return Array.from(state.expandedEntityKeys)
            .map((entityKey) => expandedData.entityIndex.get(entityKey))
            .filter(Boolean);
    }

    function isGraphFilterActive() {
        return Boolean(
            state.graphFilters.activityContains ||
            state.graphFilters.activityPrefix ||
            state.graphFilters.timeStartDays ||
            state.graphFilters.timeEndDays
        );
    }

    function parseOptionalNumber(value) {
        if (value === "" || value == null) return null;
        const parsedValue = Number(value);
        return Number.isFinite(parsedValue) ? parsedValue : null;
    }

    function matchesGraphFilters(event) {
        if (!event) return false;

        const activity = String(event.activity ?? "");
        const activityPrefix = state.graphFilters.activityPrefix;
        if (activityPrefix && !activity.startsWith(activityPrefix)) {
            return false;
        }

        const activityNeedle = state.graphFilters.activityContains.trim().toLowerCase();
        if (activityNeedle && !activity.toLowerCase().includes(activityNeedle)) {
            return false;
        }

        const eventDays = secondsToDays(event.timestamp_relative_seconds ?? 0);
        const startDays = parseOptionalNumber(state.graphFilters.timeStartDays);
        const endDays = parseOptionalNumber(state.graphFilters.timeEndDays);

        if (startDays != null && eventDays < startDays) return false;
        if (endDays != null && eventDays > endDays) return false;
        return true;
    }

    function applyGraphFiltersToEventIds(eventIds) {
        if (!isGraphFilterActive()) return eventIds;

        const filteredEventIds = new Set();
        eventIds.forEach((eventId) => {
            const event = expandedData.eventMap.get(eventId) ?? localData.eventMap.get(eventId);
            if (matchesGraphFilters(event)) {
                filteredEventIds.add(eventId);
            }
        });
        return filteredEventIds;
    }

    function getModeEventIds() {
        if (state.mode === "expanded") {
            return new Set(expandedData.graphData.nodes.map((node) => node.id));
        }
        if (state.mode === "selective") {
            const visibleEventIds = new Set(localEventIds);
            getExpandedEntityEntries().forEach((entry) => {
                entry.eventIds.forEach((eventId) => visibleEventIds.add(eventId));
            });
            return visibleEventIds;
        }
        return new Set(localEventIds);
    }

    //selective模式的时候 做到用户点击展开
    function getVisibleEventIds() {
        return applyGraphFiltersToEventIds(getModeEventIds());
    }

    function isEntityEffectivelyExpanded(entityKey) {
        const entry = expandedData.entityIndex.get(entityKey);
        if (!entry || entry.eventIds.size === 0) return false;

        const visibleEventIds = getModeEventIds();
        return Array.from(entry.eventIds).every((eventId) => visibleEventIds.has(eventId));
    }

    function setMode(mode) {
        state.mode = mode;
    }

    //变成函数回调 js里 selection。on
    function toggleEntityExpansion(entityKey) {
        if (state.expandedEntityKeys.has(entityKey)) {
            state.expandedEntityKeys.delete(entityKey);
        } else {
            state.expandedEntityKeys.add(entityKey);
        }
        state.mode = state.expandedEntityKeys.size > 0 ? "selective" : "local";
    }

    function showAll() {
        state.mode = "expanded";
    }

    function resetSelections() {
        state.mode = "local";
        state.expandedEntityKeys.clear();
    }

    function clearSelectionIfFilteredOut() {
        if (!isGraphFilterActive()) return;
        const visibleEventIds = getVisibleEventIds();
        if (state.selectedEventId && !visibleEventIds.has(state.selectedEventId)) {
            state.selectedEventId = null;
        }
        if (state.hoveredEventId && !visibleEventIds.has(state.hoveredEventId)) {
            state.hoveredEventId = null;
        }
    }

    function setGraphFilters(filters = {}) {
        state.graphFilters = {
            activityPrefix: String(filters.activityPrefix ?? "").trim(),
            activityContains: String(filters.activityContains ?? "").trim(),
            timeStartDays: String(filters.timeStartDays ?? "").trim(),
            timeEndDays: String(filters.timeEndDays ?? "").trim(),
        };
        clearSelectionIfFilteredOut();
    }

    function resetGraphFilters() {
        state.graphFilters = {
            activityPrefix: "",
            activityContains: "",
            timeStartDays: "",
            timeEndDays: "",
        };
    }

    function getGraphFilters() {
        return { ...state.graphFilters };
    }

    function setSelectedEvent(eventId) {
        if (state.selectedEventId === eventId) {
            state.selectedEventId = null;
            state.hoveredEventId = null;
            return;
        }
        state.selectedEventId = eventId;
    }

    function setHoveredEvent(eventId) {
        state.hoveredEventId = eventId;
    }

    function clearHoveredEvent() {
        state.hoveredEventId = null;
    }

    function buildSelectiveGraph() {
        const visibleEventIds = getVisibleEventIds();

        const nodes = expandedData.graphData.nodes.filter((node) => visibleEventIds.has(node.id));
        const edges = expandedData.graphData.edges.filter(
            (edge) => visibleEventIds.has(edge.source) && visibleEventIds.has(edge.target)
        );

        return { graph: [{ type: "directed" }], nodes, edges };
    }

    function buildFilteredGraph(graphData) {
        const visibleEventIds = getVisibleEventIds();
        const nodes = graphData.nodes.filter((node) => visibleEventIds.has(node.id));
        const edges = graphData.edges.filter(
            (edge) => visibleEventIds.has(edge.source) && visibleEventIds.has(edge.target)
        );
        return { ...graphData, nodes, edges };
    }

    function getOfferExpansionEntries() {
        return getExpansionEntries("Offer");
    }

    function getExpansionEntries(perspective) {
        const relationType = EXPANSION_RELATION_TYPE_BY_PERSPECTIVE[perspective];
        return getExpandedEntityEntries().filter((entry) => {
            const category = entry.displayCategory ?? getEntityDisplayCategory(entry.entityType);
            return category === perspective && entry.entityType === relationType;
        });
    }

    function getEntriesForMode(perspective) {
        const relationType = EXPANSION_RELATION_TYPE_BY_PERSPECTIVE[perspective];
        if (state.mode === "expanded") {
            return Array.from(expandedData.entityIndex.values()).filter((entry) => {
                const category = entry.displayCategory ?? getEntityDisplayCategory(entry.entityType);
                return category === perspective && entry.entityType === relationType;
            });
        }
        return getExpansionEntries(perspective);
    }

    /*决定当前画哪些df边，颜色是否虚线*/
    function decorateVisibleEdges(edges) {
        const offerEntries = getEntriesForMode("Offer");
        const workflowEntries = getEntriesForMode("Workflow");
        const visibleEventIds = getVisibleEventIds();

        const visibleDfEdges = edges.flatMap((edge) => {
            if (edge.perspective === "Application") {
                return [{
                    ...edge,
                    edgeColor: PERSPECTIVE_EDGE_COLORS.Application,
                    edgePerspectiveLabel: "Application",
                    edgePathOffset: PERSPECTIVE_PATH_OFFSETS.Application,
                }];
            }

            if (edge.perspective === "Workflow") {
                const matchingWorkflowIndex = workflowEntries.findIndex((entry) => (
                    entry.eventIds.has(edge.source) && entry.eventIds.has(edge.target)
                ));

                if (matchingWorkflowIndex === -1) return [];

                const matchingWorkflow = workflowEntries[matchingWorkflowIndex];
                return [{
                    ...edge,
                    edgeColor: PERSPECTIVE_EDGE_COLORS.Workflow,
                    edgePerspectiveLabel: "Workflow",
                    edgeEntityKey: matchingWorkflow.entityKey,
                    edgeEntityId: matchingWorkflow.entityId,
                    edgePathOffset: PERSPECTIVE_PATH_OFFSETS.Workflow,
                }];
            }

            if (edge.perspective !== "Offer") {
                return [];
            }

            const matchingOfferIndex = offerEntries.findIndex((entry) => (
                entry.eventIds.has(edge.source) && entry.eventIds.has(edge.target)
            ));

            if (matchingOfferIndex === -1) {
                return [];
            }

            const matchingOffer = offerEntries[matchingOfferIndex];
            return [{
                ...edge,
                edgeColor: OFFER_EDGE_COLORS[matchingOfferIndex % OFFER_EDGE_COLORS.length],
                edgePerspectiveLabel: "Offer",
                edgeEntityKey: matchingOffer.entityKey,
                edgeEntityId: matchingOffer.entityId,
                edgePathOffset: PERSPECTIVE_PATH_OFFSETS.Offer,
            }];
        });

        const expansionEntries = [
            ...offerEntries.map((entry) => ({ entry, targetEntityType: "Offer" })),
            ...workflowEntries.map((entry) => ({ entry, targetEntityType: "Workflow" })),
        ];

        const expansionAnchorEdges = expansionEntries.flatMap(({ entry, targetEntityType }) => {
            const expansionAnchor = getExpansionAnchorPair(entry, targetEntityType);
            if (!expansionAnchor) return [];

            const { anchorEvent, firstLifecycleEvent } = expansionAnchor;
            if (!visibleEventIds.has(anchorEvent.id) || !visibleEventIds.has(firstLifecycleEvent.id)) return [];

            return [{
                id: `expansion-anchor-${entry.entityKey}`,
                source: anchorEvent.id,
                target: firstLifecycleEvent.id,
                source_activity: anchorEvent.activity,
                target_activity: firstLifecycleEvent.activity,
                source_coordinates: [
                    secondsToDays(anchorEvent.timestamp_relative_seconds ?? 0),
                    sharedRankedActivityByActivity.get(anchorEvent.activity) ?? anchorEvent.ranked_activity ?? anchorEvent.activity,
                ],
                target_coordinates: [
                    secondsToDays(firstLifecycleEvent.timestamp_relative_seconds ?? 0),
                    sharedRankedActivityByActivity.get(firstLifecycleEvent.activity) ?? firstLifecycleEvent.ranked_activity ?? firstLifecycleEvent.activity,
                ],
                entity: "ExpansionAnchor",
                perspective: "ExpansionAnchor",
                relationKind: "expansion-anchor",
                edgeColor: "#9bb8d3",
                edgePerspectiveLabel: "Expansion anchor",
                edgeEntityKey: entry.entityKey,
                edgeEntityId: entry.entityId,
                edgeDasharray: "4 4",
                edgeOpacity: 0.85,
                edgePathOffset: PERSPECTIVE_PATH_OFFSETS[targetEntityType] ?? 0,
            }];
        });

        return [...expansionAnchorEdges, ...visibleDfEdges];
    }

    function decorateOverlappingNodes(nodes) {
        const nodesByActivity = new Map();
        nodes.forEach((node) => {
            const activityKey = node.ranked_activity ?? node.activity;
            const activityNodes = nodesByActivity.get(activityKey) ?? [];
            activityNodes.push(node);
            nodesByActivity.set(activityKey, activityNodes);
        });

        const overlapEventIdsByNodeId = new Map();
        nodesByActivity.forEach((activityNodes) => {
            const sortedNodes = activityNodes.slice().sort((a, b) => {
                const delta = a.timestamp_relative_seconds - b.timestamp_relative_seconds;
                return delta !== 0 ? delta : a.id.localeCompare(b.id);
            });
            let currentGroup = [];

            const flushGroup = () => {
                if (currentGroup.length <= 1) {
                    currentGroup = [];
                    return;
                }
                const eventIds = currentGroup.map((node) => node.id);
                currentGroup.forEach((node) => {
                    overlapEventIdsByNodeId.set(node.id, eventIds);
                });
                currentGroup = [];
            };

            sortedNodes.forEach((node) => {
                const previousNode = currentGroup.at(-1);
                const isSameOverlapGroup = previousNode && (
                    Math.abs(node.timestamp_relative_seconds - previousNode.timestamp_relative_seconds) <= OVERLAP_THRESHOLD_SECONDS
                );

                if (!previousNode || isSameOverlapGroup) {
                    currentGroup.push(node);
                    return;
                }

                flushGroup();
                currentGroup.push(node);
            });
            flushGroup();
        });

        return nodes.map((node) => {
            const overlapEventIds = overlapEventIdsByNodeId.get(node.id) ?? [node.id];
            return {
                ...node,
                overlapEventIds,
                overlapCount: overlapEventIds.length,
            };
        });
    }

    //把当前要显示的 nodes 按当前 scope 重新整理一遍，
    // 然后建一个 nodeId -> node 的查找表。
    function buildScopedGraph(graphData) {
        const scopedNodes = decorateOverlappingNodes(
            graphData.nodes.map((node) => decorateEventForCurrentScope(node))
        );
        //Map {
        //   "e1" => { id: "e1", activity: "A_Create Application" },{}
        //   }
        const scopedNodeMap = new Map(scopedNodes.map((node) => [node.id, node]));

        return {
            ...graphData,
            nodes: scopedNodes,
            edges: decorateVisibleEdges(graphData.edges).map((edge) => {
                const sourceNode = scopedNodeMap.get(edge.source);
                const targetNode = scopedNodeMap.get(edge.target);
                return {
                    ...edge,
                    source_coordinates: [
                        edge.source_coordinates?.[0] ?? secondsToDays(sourceNode?.timestamp_relative_seconds ?? 0),
                        sourceNode?.ranked_activity ?? sharedRankedActivityByActivity.get(edge.source_activity) ?? edge.source_coordinates?.[1],
                    ],
                    target_coordinates: [
                        edge.target_coordinates?.[0] ?? secondsToDays(targetNode?.timestamp_relative_seconds ?? 0),
                        targetNode?.ranked_activity ?? sharedRankedActivityByActivity.get(edge.target_activity) ?? edge.target_coordinates?.[1],
                    ],
                };
            }),
        };
    }

    function getVisibleGraphPayload() {
        if (state.mode === "expanded") {
            return buildGraphPayload(buildScopedGraph(buildFilteredGraph(expandedData.graphData)), {
                multiEntity: true,
                mode: "expanded",
                activityDomain: sharedActivityDomain,
                graphFilters: getGraphFilters(),
            });
        }
        if (state.mode === "selective") {
            return buildGraphPayload(buildScopedGraph(buildSelectiveGraph()), {
                multiEntity: true,
                mode: "selective",
                activityDomain: sharedActivityDomain,
                graphFilters: getGraphFilters(),
            });
        }
        return buildGraphPayload(buildScopedGraph(buildFilteredGraph(localData.graphData)), {
            multiEntity: true,
            mode: "local",
            activityDomain: sharedActivityDomain,
            graphFilters: getGraphFilters(),
        });
    }

    return {
        state,
        getActiveEventId,
        getEventDetails,
        getEntityDetails,
        getExpandedEntityEntries,
        getVisibleEventIds,
        isEntityEffectivelyExpanded,
        getVisibleGraphPayload,
        getGraphFilters,
        isGraphFilterActive,
        setMode,
        toggleEntityExpansion,
        showAll,
        resetSelections,
        setGraphFilters,
        resetGraphFilters,
        setSelectedEvent,
        setHoveredEvent,
        clearHoveredEvent,
    };
}


export { createMultiEntityState };
