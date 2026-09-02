import { buildGraphPayload } from "./multiEntityData.mjs";

const AGGREGATE_GROUP_COLORS = ["#16a34a", "#ea580c", "#2563eb"];

function getAggregateGroupColor(groupNumberOrIndex) {
    const numericIndex = Number(groupNumberOrIndex) - 1;
    const index = Number.isFinite(numericIndex) ? numericIndex : 0;
    return AGGREGATE_GROUP_COLORS[Math.max(index, 0) % AGGREGATE_GROUP_COLORS.length];
}

function summarizeAggregateInstances(instances) {
    const totalEvents = instances.reduce((sum, instance) => sum + Number(instance.eventCount ?? 0), 0);
    const totalDfEdges = instances.reduce((sum, instance) => sum + Number(instance.dfEdgeCount ?? 0), 0);
    const totalOffers = instances.reduce((sum, instance) => sum + Number(instance.offerCount ?? 0), 0);
    const cancelledCount = instances.filter((instance) => instance.hasCancellation).length;
    const durations = instances
        .map((instance) => Number(instance.durationDays))
        .filter((duration) => Number.isFinite(duration));
    const averageDuration = durations.length === 0
        ? null
        : durations.reduce((sum, duration) => sum + duration, 0) / durations.length;

    return {
        caseCount: instances.length,
        totalEvents,
        totalDfEdges,
        totalOffers,
        cancelledCount,
        averageDuration,
    };
}

function buildSelectedInstanceOverlay(instances) {
    return {
        instanceIds: instances.map((instance) => instance.id),
        summary: summarizeAggregateInstances(instances),
    };
}

function stripActivityRankPrefix(rankedActivity) {
    return String(rankedActivity ?? "").replace(/^\d+_/, "");
}

function getRawActivity(node) {
    return node?.activity ?? node?.["concept:name"] ?? stripActivityRankPrefix(node?.ranked_activity);
}

function getRankNumber(rankedActivity) {
    const rank = Number.parseInt(String(rankedActivity ?? "").split("_", 1)[0], 10);
    return Number.isFinite(rank) ? rank : Number.POSITIVE_INFINITY;
}

function getGraphTimeDomainDays(graphData) {
    const dayValues = (graphData?.nodes ?? [])
        .map((node) => Number(node.timestamp_relative_seconds) / 86400)
        .filter((day) => Number.isFinite(day));
    if (dayValues.length === 0) return [0, 1];
    return [Math.min(...dayValues), Math.max(...dayValues)];
}

function average(values) {
    const finiteValues = values.filter((value) => Number.isFinite(value));
    if (finiteValues.length === 0) return 0;
    return finiteValues.reduce((sum, value) => sum + value, 0) / finiteValues.length;
}

function makeAggregateIdPrefix(groupId) {
    return `aggregate-${groupId}`;
}

function makeActivityNodeId(groupId, activity) {
    return `${makeAggregateIdPrefix(groupId)}::activity::${encodeURIComponent(activity)}`;
}

function getNodeTimeSeconds(node) {
    const seconds = Number(node?.timestamp_relative_seconds);
    return Number.isFinite(seconds) ? seconds : 0;
}

function getNodeTimestampMs(node) {
    const timestampMs = Date.parse(node?.timestamp ?? node?.timestamps ?? "");
    return Number.isFinite(timestampMs) ? timestampMs : null;
}

function getActivitySpanInterval(graphData, sourceActivity, targetActivity, fallbackInterval) {
    const matchingNodes = (graphData?.nodes ?? []).filter((node) => {
        const activity = getRawActivity(node);
        return activity === sourceActivity || activity === targetActivity;
    });
    const timestampValues = matchingNodes
        .map(getNodeTimestampMs)
        .filter((timestampMs) => Number.isFinite(timestampMs));
    const secondValues = matchingNodes
        .map(getNodeTimeSeconds)
        .filter((seconds) => Number.isFinite(seconds));

    if (timestampValues.length >= 2) {
        return {
            sourceSeconds: secondValues.length > 0 ? Math.min(...secondValues) : fallbackInterval.sourceSeconds,
            targetSeconds: secondValues.length > 0 ? Math.max(...secondValues) : fallbackInterval.targetSeconds,
            sourceTimestampMs: Math.min(...timestampValues),
            targetTimestampMs: Math.max(...timestampValues),
        };
    }

    return fallbackInterval;
}

function getIntervalDurationSeconds(interval) {
    if (
        Number.isFinite(interval?.sourceTimestampMs) &&
        Number.isFinite(interval?.targetTimestampMs)
    ) {
        return Math.abs(interval.targetTimestampMs - interval.sourceTimestampMs) / 1000;
    }
    if (
        Number.isFinite(interval?.sourceSeconds) &&
        Number.isFinite(interval?.targetSeconds)
    ) {
        return Math.abs(interval.targetSeconds - interval.sourceSeconds);
    }
    return null;
}

function getNodeMembershipCategories(node) {
    const memberships = [
        ...(node?.ringEntityMemberships ?? []),
        ...(node?.visibleEntityMemberships ?? []),
        ...(node?.entityMemberships ?? []),
    ];
    const categories = new Set();

    memberships.forEach((membership) => {
        const rawType = membership.entityType;
        if (["Application", "Offer", "Workflow"].includes(rawType)) {
            categories.add(rawType);
        }
    });

    return categories;
}

function getNodeResourceId(node) {
    if (node?.resources) return node.resources;
    return (node?.entityMemberships ?? [])
        .find((membership) => membership.entityType === "Case_R")
        ?.entityId ?? null;
}

function incrementMap(map, key, amount = 1) {
    map.set(key, (map.get(key) ?? 0) + amount);
}

function addCrossPerspectiveContext(context, instanceId, interval, graphData, primaryPerspective) {
    const nodes = graphData?.nodes ?? [];
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const useAbsoluteTime = (
        Number.isFinite(interval.sourceTimestampMs) &&
        Number.isFinite(interval.targetTimestampMs)
    );
    const intervalStart = useAbsoluteTime
        ? Math.min(interval.sourceTimestampMs, interval.targetTimestampMs)
        : Math.min(interval.sourceSeconds, interval.targetSeconds);
    const intervalEnd = useAbsoluteTime
        ? Math.max(interval.sourceTimestampMs, interval.targetTimestampMs)
        : Math.max(interval.sourceSeconds, interval.targetSeconds);

    nodes.forEach((node) => {
        const timestamp = useAbsoluteTime
            ? getNodeTimestampMs(node)
            : getNodeTimeSeconds(node);
        if (!Number.isFinite(timestamp)) return;
        if (timestamp < intervalStart || timestamp > intervalEnd) return;

        getNodeMembershipCategories(node).forEach((category) => {
            if (category === primaryPerspective) return;
            incrementMap(context.eventCountsByPerspective, category);
            const entityIds = (node.entityMemberships ?? [])
                .filter((membership) => (
                    membership.entityType === category
                ))
                .map((membership) => membership.entityId)
                .filter(Boolean);
            entityIds.forEach((entityId) => {
                context.relatedLifecyclesByPerspective[category].add(entityId);
            });
        });
    });

    (graphData?.edges ?? []).forEach((edge) => {
        const perspective = edge.perspective ?? edge.entity;
        if (!["Application", "Offer", "Workflow"].includes(perspective)) return;
        if (perspective === primaryPerspective) return;

        const sourceNode = nodeById.get(edge.source);
        const targetNode = nodeById.get(edge.target);
        if (!sourceNode || !targetNode) return;

        const sourceTime = useAbsoluteTime
            ? getNodeTimestampMs(sourceNode)
            : getNodeTimeSeconds(sourceNode);
        if (!Number.isFinite(sourceTime)) return;
        if (sourceTime < intervalStart || sourceTime > intervalEnd) return;

        const sourceActivity = getRawActivity(sourceNode);
        const targetActivity = getRawActivity(targetNode);
        if (!sourceActivity || !targetActivity) return;

        const transitionKey = `${sourceActivity}=>${targetActivity}`;
        const perspectiveTransitions = context.transitionsByPerspective.get(perspective) ?? new Map();
        const transition = perspectiveTransitions.get(transitionKey) ?? {
            sourceActivity,
            targetActivity,
            count: 0,
            instanceIds: new Set(),
        };
        transition.count += 1;
        transition.instanceIds.add(instanceId);
        perspectiveTransitions.set(transitionKey, transition);
        context.transitionsByPerspective.set(perspective, perspectiveTransitions);
    });
}

function makeEmptyCrossPerspectiveContext() {
    return {
        eventCountsByPerspective: new Map(),
        relatedLifecyclesByPerspective: {
            Application: new Set(),
            Offer: new Set(),
            Workflow: new Set(),
        },
        transitionsByPerspective: new Map(),
    };
}

function makeEmptyResourceHandoverContext() {
    return {
        sameResourceCount: 0,
        changedResourceCount: 0,
        resources: new Set(),
        transitionsByPair: new Map(),
    };
}

function addResourceHandover(context, sourceNode, targetNode, instanceId) {
    const sourceResource = getNodeResourceId(sourceNode);
    const targetResource = getNodeResourceId(targetNode);
    if (!sourceResource || !targetResource) return;

    context.resources.add(sourceResource);
    context.resources.add(targetResource);
    if (sourceResource === targetResource) {
        context.sameResourceCount += 1;
    } else {
        context.changedResourceCount += 1;
    }

    const transitionKey = `${sourceResource}=>${targetResource}`;
    const transition = context.transitionsByPair.get(transitionKey) ?? {
        sourceResource,
        targetResource,
        count: 0,
        instanceIds: new Set(),
    };
    transition.count += 1;
    transition.instanceIds.add(instanceId);
    context.transitionsByPair.set(transitionKey, transition);
}

function serializeResourceHandoverContext(context) {
    const transitions = Array.from(context.transitionsByPair.values())
        .sort((transitionA, transitionB) => {
            const delta = transitionB.count - transitionA.count;
            if (delta !== 0) return delta;
            return `${transitionA.sourceResource}->${transitionA.targetResource}`
                .localeCompare(`${transitionB.sourceResource}->${transitionB.targetResource}`);
        })
        .map((transition) => ({
            sourceResource: transition.sourceResource,
            targetResource: transition.targetResource,
            count: transition.count,
            instanceIds: Array.from(transition.instanceIds).sort(),
        }));

    return {
        sameResourceCount: context.sameResourceCount,
        changedResourceCount: context.changedResourceCount,
        distinctResources: Array.from(context.resources).sort(),
        transitions,
        dominantTransition: transitions[0] ?? null,
    };
}

function serializeCrossPerspectiveContext(context, primaryPerspective) {
    const eventCounts = Object.fromEntries(
        Array.from(context.eventCountsByPerspective.entries())
            .sort(([perspectiveA], [perspectiveB]) => perspectiveA.localeCompare(perspectiveB))
    );
    const relatedLifecycles = Object.fromEntries(
        Object.entries(context.relatedLifecyclesByPerspective)
            .map(([perspective, ids]) => [perspective, Array.from(ids).sort()])
            .filter(([, ids]) => ids.length > 0)
    );
    const transitions = Object.fromEntries(
        Array.from(context.transitionsByPerspective.entries())
            .sort(([perspectiveA], [perspectiveB]) => perspectiveA.localeCompare(perspectiveB))
            .map(([perspective, transitionMap]) => [
                perspective,
                Array.from(transitionMap.values())
                    .sort((a, b) => {
                        const delta = b.count - a.count;
                        if (delta !== 0) return delta;
                        return `${a.sourceActivity}->${a.targetActivity}`
                            .localeCompare(`${b.sourceActivity}->${b.targetActivity}`);
                    })
                    .map((transition) => ({
                        sourceActivity: transition.sourceActivity,
                        targetActivity: transition.targetActivity,
                        count: transition.count,
                        instanceIds: Array.from(transition.instanceIds).sort(),
                    })),
            ])
    );

    return {
        assignmentRule: "activity-span interval",
        primaryPerspective,
        eventCounts,
        relatedLifecycles,
        transitions,
    };
}

function buildSharedOverlayActivityRanking(instancePayloads) {
    const rankByActivity = new Map();

    instancePayloads.forEach(({ payload }) => {
        (payload?.meta?.activityDomain ?? []).forEach((rankedActivity) => {
            const activity = stripActivityRankPrefix(rankedActivity);
            if (!activity) return;
            const rank = getRankNumber(rankedActivity);
            const previousRank = rankByActivity.get(activity) ?? Number.POSITIVE_INFINITY;
            rankByActivity.set(activity, Math.min(previousRank, rank));
        });

        (payload?.graphData?.nodes ?? []).forEach((node) => {
            const activity = getRawActivity(node);
            if (!activity || rankByActivity.has(activity)) return;
            rankByActivity.set(activity, getRankNumber(node.ranked_activity));
        });
    });

    const orderedActivities = Array.from(rankByActivity.entries())
        .sort(([activityA, rankA], [activityB, rankB]) => {
            const delta = rankA - rankB;
            return delta !== 0 ? delta : activityA.localeCompare(activityB);
        })
        .map(([activity]) => activity);

    const rankedActivityByActivity = new Map(
        orderedActivities.map((activity, index) => [activity, `${index + 1}_${activity}`])
    );
    const activityDomain = orderedActivities.map((activity) => rankedActivityByActivity.get(activity));

    return { rankedActivityByActivity, activityDomain };
}

function buildAggregateGroupPayload(group) {
    const instancePayloads = group.instancePayloads ?? [];
    const groupPerspective = group.perspective ?? "Application";
    const { rankedActivityByActivity, activityDomain } = buildSharedOverlayActivityRanking(instancePayloads);
    const activityStats = new Map();
    const edgeStats = new Map();

    instancePayloads.forEach(({ instance, payload, expandedPayload }) => {
        const originalNodeById = new Map(
            (payload?.graphData?.nodes ?? []).map((node) => [node.id, node])
        );
        const contextGraphData = expandedPayload?.graphData
            ?? payload?.graphData;

        (payload?.graphData?.nodes ?? []).forEach((node) => {
            const activity = getRawActivity(node);
            if (!activity) return;
            const entry = activityStats.get(activity) ?? {
                activity,
                timestamps: [],
                instanceIds: new Set(),
                eventCount: 0,
            };
            entry.timestamps.push(getNodeTimeSeconds(node));
            entry.instanceIds.add(instance.id);
            entry.eventCount += 1;
            activityStats.set(activity, entry);
        });

        (payload?.graphData?.edges ?? [])
            .filter((edge) => (edge.perspective ?? edge.entity) === groupPerspective)
            .forEach((edge) => {
                const sourceNode = originalNodeById.get(edge.source);
                const targetNode = originalNodeById.get(edge.target);
                const sourceActivity = getRawActivity(sourceNode);
                const targetActivity = getRawActivity(targetNode);
                if (!sourceActivity || !targetActivity) return;

                const edgeKey = `${sourceActivity}=>${targetActivity}`;
                const sourceSeconds = getNodeTimeSeconds(sourceNode);
                const targetSeconds = getNodeTimeSeconds(targetNode);
                const entry = edgeStats.get(edgeKey) ?? {
                    sourceActivity,
                    targetActivity,
                    instanceIds: new Set(),
                    pairDurations: [],
                    spanDurations: [],
                    eventPairCount: 0,
                    intervals: [],
                    contextIntervalKeys: new Set(),
                    crossPerspectiveContext: makeEmptyCrossPerspectiveContext(),
                    resourceHandoverContext: makeEmptyResourceHandoverContext(),
                };
                entry.instanceIds.add(instance.id);
                entry.pairDurations.push(targetSeconds - sourceSeconds);
                entry.eventPairCount += 1;
                addResourceHandover(
                    entry.resourceHandoverContext,
                    sourceNode,
                    targetNode,
                    instance.id
                );
                entry.intervals.push({
                    instanceId: instance.id,
                    sourceEventId: edge.source,
                    targetEventId: edge.target,
                    sourceSeconds,
                    targetSeconds,
                });
                if (!entry.contextIntervalKeys.has(instance.id)) {
                    const fallbackInterval = {
                        sourceSeconds,
                        targetSeconds,
                        sourceTimestampMs: getNodeTimestampMs(sourceNode),
                        targetTimestampMs: getNodeTimestampMs(targetNode),
                    };
                    const contextInterval = getActivitySpanInterval(
                        payload?.graphData,
                        sourceActivity,
                        targetActivity,
                        fallbackInterval
                    );
                    const spanDuration = getIntervalDurationSeconds(contextInterval);
                    if (Number.isFinite(spanDuration)) {
                        entry.spanDurations.push(spanDuration);
                    }
                    addCrossPerspectiveContext(
                        entry.crossPerspectiveContext,
                        instance.id,
                        contextInterval,
                        contextGraphData,
                        groupPerspective
                    );
                    entry.contextIntervalKeys.add(instance.id);
                }
                edgeStats.set(edgeKey, entry);
            });
    });

    const nodes = Array.from(activityStats.values()).map((entry) => {
        const rankedActivity = rankedActivityByActivity.get(entry.activity) ?? entry.activity;
        return {
            id: makeActivityNodeId(group.id, entry.activity),
            event_id: makeActivityNodeId(group.id, entry.activity),
            activity: entry.activity,
            "concept:name": entry.activity,
            ranked_activity: rankedActivity,
            timestamp: "",
            timestamps: "",
            timestamp_relative_seconds: average(entry.timestamps),
            case: group.id,
            resources: "",
            is_anchor_event: false,
            isAggregateNode: true,
            aggregateGroupColor: group.color,
            aggregateCount: entry.instanceIds.size,
            aggregateEventCount: entry.eventCount,
            aggregateInstanceIds: Array.from(entry.instanceIds).sort(),
            entityMemberships: [],
            visibleEntityMemberships: [{
                entityType: groupPerspective,
                displayCategory: groupPerspective,
                entityId: group.id,
                entityKey: `${groupPerspective}::${group.id}`,
            }],
            ringEntityMemberships: [{
                entityType: groupPerspective,
                displayCategory: groupPerspective,
                entityId: group.id,
                entityKey: `${groupPerspective}::${group.id}`,
            }],
            visibleEntityTypes: [groupPerspective],
        };
    });
    const nodeByActivity = new Map(nodes.map((node) => [node.activity, node]));
    const maxEdgeCount = Math.max(
        ...Array.from(edgeStats.values()).map((entry) => entry.instanceIds.size),
        1
    );

    const edges = Array.from(edgeStats.values()).map((entry, index) => {
        const sourceNode = nodeByActivity.get(entry.sourceActivity);
        const targetNode = nodeByActivity.get(entry.targetActivity);
        const count = entry.instanceIds.size;
        const activityDistanceDays = Math.abs(
            (targetNode.timestamp_relative_seconds - sourceNode.timestamp_relative_seconds) / 86400
        );
        return {
            id: `${makeAggregateIdPrefix(group.id)}::edge::${index}`,
            source: sourceNode.id,
            target: targetNode.id,
            sourceActivity: entry.sourceActivity,
            targetActivity: entry.targetActivity,
            source_coordinates: [
                sourceNode.timestamp_relative_seconds / 86400,
                sourceNode.ranked_activity,
            ],
            target_coordinates: [
                targetNode.timestamp_relative_seconds / 86400,
                targetNode.ranked_activity,
            ],
            entity: groupPerspective,
            perspective: groupPerspective,
            case: group.id,
            isAggregateEdge: true,
            aggregateCount: count,
            aggregateEventPairCount: entry.eventPairCount,
            aggregateInstanceIds: Array.from(entry.instanceIds).sort(),
            aggregateGroupInstanceCount: group.instanceIds.length,
            averageDurationDays: activityDistanceDays,
            averagePairDurationDays: average(entry.pairDurations) / 86400,
            crossPerspectiveContext: serializeCrossPerspectiveContext(
                entry.crossPerspectiveContext,
                groupPerspective
            ),
            resourceHandoverContext: serializeResourceHandoverContext(entry.resourceHandoverContext),
            edgeColor: group.color,
            edgeStrokeWidth: 1.2 + (count / maxEdgeCount) * 4,
            edgeOpacity: 0.35 + (count / maxEdgeCount) * 0.55,
        };
    });

    const graphData = {
        graph: [{ type: "directed" }],
        nodes: nodes.sort((nodeA, nodeB) => {
            const delta = getRankNumber(nodeA.ranked_activity) - getRankNumber(nodeB.ranked_activity);
            return delta !== 0 ? delta : nodeA.activity.localeCompare(nodeB.activity);
        }),
        edges,
    };

    return buildGraphPayload(graphData, {
        multiEntity: true,
        mode: "aggregate-group",
        aggregateGroupId: group.id,
        aggregatePerspective: groupPerspective,
        activityDomain,
        xDomainDays: getGraphTimeDomainDays(graphData),
        graphFilters: {},
    });
}

function createAggregateGroupFromOverlay(overlay, groupNumber, perspective = "Application") {
    const group = {
        id: `group-${groupNumber}`,
        name: `Group ${String.fromCharCode(64 + groupNumber)}`,
        perspective,
        color: getAggregateGroupColor(groupNumber),
        instanceIds: overlay.instanceIds.slice(),
        summary: overlay.summary,
        instancePayloads: overlay.instancePayloads ?? [],
    };
    group.aggregatePayload = buildAggregateGroupPayload(group);
    return group;
}

function prefixOverlayNode(node, instanceId, rankedActivityByActivity) {
    const originalId = node.id;
    const activity = getRawActivity(node);
    const rankedActivity = rankedActivityByActivity.get(activity) ?? node.ranked_activity ?? activity;
    const prefixedOverlapIds = (node.overlapEventIds ?? [originalId]).map((eventId) => `${instanceId}::${eventId}`);

    return {
        ...node,
        id: `${instanceId}::${originalId}`,
        event_id: `${instanceId}::${node.event_id ?? originalId}`,
        overlayInstanceId: instanceId,
        originalEventId: originalId,
        ranked_activity: rankedActivity,
        overlapEventIds: prefixedOverlapIds,
        overlapCount: node.overlapCount ?? prefixedOverlapIds.length,
    };
}

function prefixOverlayEdge(edge, instanceId, nodeByOriginalId) {
    const sourceNode = nodeByOriginalId.get(edge.source);
    const targetNode = nodeByOriginalId.get(edge.target);

    return {
        ...edge,
        id: `${instanceId}::${edge.id}`,
        source: `${instanceId}::${edge.source}`,
        target: `${instanceId}::${edge.target}`,
        overlayInstanceId: instanceId,
        originalEdgeId: edge.id,
        source_coordinates: [
            edge.source_coordinates?.[0] ?? (Number(sourceNode?.timestamp_relative_seconds) / 86400),
            sourceNode?.ranked_activity ?? edge.source_coordinates?.[1],
        ],
        target_coordinates: [
            edge.target_coordinates?.[0] ?? (Number(targetNode?.timestamp_relative_seconds) / 86400),
            targetNode?.ranked_activity ?? edge.target_coordinates?.[1],
        ],
    };
}

function buildSelectedInstanceOverlayPayload(instancePayloads, overlay) {
    const { rankedActivityByActivity, activityDomain } = buildSharedOverlayActivityRanking(instancePayloads);
    const nodes = [];
    const edges = [];
    const xDomainBounds = [];

    instancePayloads.forEach(({ instance, payload }) => {
        const prefixedNodes = (payload?.graphData?.nodes ?? []).map((node) => (
            prefixOverlayNode(node, instance.id, rankedActivityByActivity)
        ));
        const nodeByOriginalId = new Map(
            prefixedNodes.map((node) => [node.originalEventId, node])
        );
        const prefixedEdges = (payload?.graphData?.edges ?? []).map((edge) => (
            prefixOverlayEdge(edge, instance.id, nodeByOriginalId)
        ));
        const [xStart, xEnd] = payload?.meta?.xDomainDays ?? getGraphTimeDomainDays(payload?.graphData);

        nodes.push(...prefixedNodes);
        edges.push(...prefixedEdges);
        if (Number.isFinite(Number(xStart)) && Number.isFinite(Number(xEnd))) {
            xDomainBounds.push(Number(xStart), Number(xEnd));
        }
    });

    const graphData = {
        graph: [{ type: "directed" }],
        nodes: nodes.sort((nodeA, nodeB) => {
            const delta = Number(nodeA.timestamp_relative_seconds) - Number(nodeB.timestamp_relative_seconds);
            return delta !== 0 ? delta : nodeA.id.localeCompare(nodeB.id);
        }),
        edges,
    };

    return buildGraphPayload(graphData, {
        multiEntity: true,
        mode: "instance-overlay",
        activityDomain,
        xDomainDays: xDomainBounds.length > 0
            ? [Math.min(...xDomainBounds), Math.max(...xDomainBounds)]
            : getGraphTimeDomainDays(graphData),
        overlayInstances: overlay.instanceIds,
        graphFilters: {},
    });
}

function applySharedRanking(graphData, rankedActivityByActivity) {
    const nodes = (graphData?.nodes ?? []).map((node) => {
        const activity = getRawActivity(node);
        return {
            ...node,
            ranked_activity: rankedActivityByActivity.get(activity) ?? node.ranked_activity ?? activity,
        };
    });
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const edges = (graphData?.edges ?? []).map((edge) => {
        const sourceNode = nodeById.get(edge.source);
        const targetNode = nodeById.get(edge.target);
        return {
            ...edge,
            source_coordinates: [
                sourceNode?.timestamp_relative_seconds / 86400,
                sourceNode?.ranked_activity ?? edge.source_coordinates?.[1],
            ],
            target_coordinates: [
                targetNode?.timestamp_relative_seconds / 86400,
                targetNode?.ranked_activity ?? edge.target_coordinates?.[1],
            ],
        };
    });

    return {
        graph: graphData?.graph ?? [{ type: "directed" }],
        nodes,
        edges,
    };
}

function markComparisonLayer(graphData, layer, label) {
    const edgeOffsetsByLayer = {
        aggregate: {
            edgePathOffset: -5,
        },
        candidate: {
            edgePathOffset: 5,
        },
    };
    const edgeStyle = edgeOffsetsByLayer[layer] ?? {};

    return {
        graph: graphData?.graph ?? [{ type: "directed" }],
        nodes: (graphData?.nodes ?? []).map((node) => ({
            ...node,
            comparisonLayer: layer,
            comparisonLabel: label,
        })),
        edges: (graphData?.edges ?? []).map((edge) => ({
            ...edge,
            comparisonLayer: layer,
            comparisonLabel: label,
            ...edgeStyle,
            edgeOpacity: layer === "candidate"
                ? Math.min(Number(edge.edgeOpacity ?? 0.65), 0.55)
                : edge.edgeOpacity,
        })),
    };
}

function buildAggregateGroupComparisonPayload(groupA, groupB) {
    const rankingSourcePayloads = [
        ...(groupA.instancePayloads ?? []),
        ...(groupB.instancePayloads ?? []),
    ];
    const { rankedActivityByActivity, activityDomain } = buildSharedOverlayActivityRanking(rankingSourcePayloads);

    const groupAPayload = groupA.aggregatePayload ?? buildAggregateGroupPayload(groupA);
    const groupBPayload = groupB.aggregatePayload ?? buildAggregateGroupPayload(groupB);
    const groupAGraph = markComparisonLayer(
        applySharedRanking(groupAPayload.graphData, rankedActivityByActivity),
        "aggregate",
        groupA.name
    );
    const groupBGraph = markComparisonLayer(
        applySharedRanking(groupBPayload.graphData, rankedActivityByActivity),
        "candidate",
        groupB.name
    );
    const graphData = {
        graph: [{ type: "directed" }],
        nodes: [...groupAGraph.nodes, ...groupBGraph.nodes].sort((nodeA, nodeB) => {
            const delta = Number(nodeA.timestamp_relative_seconds) - Number(nodeB.timestamp_relative_seconds);
            return delta !== 0 ? delta : nodeA.id.localeCompare(nodeB.id);
        }),
        edges: [...groupAGraph.edges, ...groupBGraph.edges],
    };
    const groupAXDomainDays = (
        groupAPayload.meta?.xDomainDays ?? getGraphTimeDomainDays(groupAPayload.graphData)
    ).map(Number).filter((value) => Number.isFinite(value));
    const groupBXDomainDays = (
        groupBPayload.meta?.xDomainDays ?? getGraphTimeDomainDays(groupBPayload.graphData)
    ).map(Number).filter((value) => Number.isFinite(value));
    const fullXDomainDays = [...groupAXDomainDays, ...groupBXDomainDays];

    return buildGraphPayload(graphData, {
        multiEntity: true,
        mode: "aggregate-group-comparison",
        aggregateGroupId: groupA.id,
        aggregateGroupName: groupA.name,
        aggregatePerspective: groupA.perspective ?? "Application",
        aggregateGroupInstanceCount: groupA.instanceIds.length,
        comparisonGroupId: groupB.id,
        comparisonGroupName: groupB.name,
        comparisonGroupInstanceCount: groupB.instanceIds.length,
        comparisonFullXDomainDays: fullXDomainDays.length > 0
            ? [Math.min(...fullXDomainDays), Math.max(...fullXDomainDays)]
            : getGraphTimeDomainDays(graphData),
        activityDomain,
        xDomainDays: fullXDomainDays.length > 0
            ? [Math.min(...fullXDomainDays), Math.max(...fullXDomainDays)]
            : getGraphTimeDomainDays(graphData),
        graphFilters: {},
    });
}

function buildAggregateComparisonPayload(group, candidatePayloads) {
    const candidateInstances = candidatePayloads.map(({ instance }) => instance);
    const candidateOverlay = buildSelectedInstanceOverlay(candidateInstances);
    const rankingSourcePayloads = [
        ...(group.instancePayloads ?? []),
        ...candidatePayloads,
    ];
    const { rankedActivityByActivity, activityDomain } = buildSharedOverlayActivityRanking(rankingSourcePayloads);

    const aggregatePayload = group.aggregatePayload ?? buildAggregateGroupPayload(group);
    const candidatePayload = buildSelectedInstanceOverlayPayload(candidatePayloads, candidateOverlay);
    const aggregateGraph = markComparisonLayer(
        applySharedRanking(aggregatePayload.graphData, rankedActivityByActivity),
        "aggregate",
        group.name
    );
    const candidateGraph = markComparisonLayer(
        applySharedRanking(candidatePayload.graphData, rankedActivityByActivity),
        "candidate",
        "Selected instances"
    );
    const graphData = {
        graph: [{ type: "directed" }],
        nodes: [...aggregateGraph.nodes, ...candidateGraph.nodes].sort((nodeA, nodeB) => {
            const delta = Number(nodeA.timestamp_relative_seconds) - Number(nodeB.timestamp_relative_seconds);
            return delta !== 0 ? delta : nodeA.id.localeCompare(nodeB.id);
        }),
        edges: [...aggregateGraph.edges, ...candidateGraph.edges],
    };
    const aggregateXDomainDays = (
        aggregatePayload.meta?.xDomainDays ?? getGraphTimeDomainDays(aggregatePayload.graphData)
    ).map(Number).filter((value) => Number.isFinite(value));
    const candidateXDomainDays = (
        candidatePayload.meta?.xDomainDays ?? getGraphTimeDomainDays(candidatePayload.graphData)
    ).map(Number).filter((value) => Number.isFinite(value));
    const fullXDomainDays = [...aggregateXDomainDays, ...candidateXDomainDays];

    return buildGraphPayload(graphData, {
        multiEntity: true,
        mode: "aggregate-comparison",
        aggregateGroupId: group.id,
        aggregateGroupName: group.name,
        aggregatePerspective: group.perspective ?? "Application",
        aggregateGroupInstanceCount: group.instanceIds.length,
        candidateInstances: candidateOverlay.instanceIds,
        candidateXDomainDays,
        comparisonFullXDomainDays: fullXDomainDays.length > 0
            ? [Math.min(...fullXDomainDays), Math.max(...fullXDomainDays)]
            : getGraphTimeDomainDays(graphData),
        activityDomain,
        xDomainDays: aggregateXDomainDays.length > 0
            ? [Math.min(...aggregateXDomainDays), Math.max(...aggregateXDomainDays)]
            : getGraphTimeDomainDays(graphData),
        graphFilters: {},
    });
}

export {
    buildAggregateComparisonPayload,
    buildAggregateGroupPayload,
    buildAggregateGroupComparisonPayload,
    buildSelectedInstanceOverlay,
    buildSelectedInstanceOverlayPayload,
    createAggregateGroupFromOverlay,
    getAggregateGroupColor,
    summarizeAggregateInstances,
};
