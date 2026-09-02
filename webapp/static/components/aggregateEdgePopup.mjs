function hideAggregateEdgePopup() {
    d3.select("#aggregate-edge-popup").remove();
}

function formatDurationFromDays(days) {
    const numericDays = Number(days);
    if (!Number.isFinite(numericDays)) return "-";
    const absoluteDays = Math.abs(numericDays);
    const seconds = numericDays * 24 * 60 * 60;
    if (absoluteDays < 1 / (24 * 60)) return `${seconds.toFixed(Math.abs(seconds) < 10 ? 2 : 0)} s`;
    if (absoluteDays < 1 / 24) return `${(seconds / 60).toFixed(Math.abs(seconds) < 10 * 60 ? 1 : 0)} min`;
    if (absoluteDays < 1) return `${(numericDays * 24).toFixed(1)} h`;
    return `${numericDays.toFixed(numericDays < 10 ? 1 : 0)} d`;
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function getPerspectiveLabel(perspective) {
    const labels = {
        Application: "Application",
        Offer: "Offer",
        Workflow: "Workflow",
    };
    return labels[perspective] ?? perspective;
}

function formatResourceLabel(resourceId) {
    return String(resourceId ?? "").replace(/^User_/, "U");
}

function getResourceDistributionEntries(context = {}) {
    const resourceCounts = new Map();
    (context.transitions ?? []).forEach((transition) => {
        const sourceResource = transition.sourceResource;
        if (!sourceResource) return;
        resourceCounts.set(
            sourceResource,
            (resourceCounts.get(sourceResource) ?? 0) + (Number(transition.count) || 0)
        );
    });
    return Array.from(resourceCounts.entries())
        .map(([resourceId, count]) => ({ resourceId, count }))
        .sort((entryA, entryB) => {
            const delta = entryB.count - entryA.count;
            if (delta !== 0) return delta;
            return entryA.resourceId.localeCompare(entryB.resourceId);
        });
}

function renderResourceDistributionChart(context = {}) {
    const entries = getResourceDistributionEntries(context).slice(0, 8);
    if (entries.length === 0) return "";
    const maxCount = Math.max(...entries.map((entry) => entry.count), 1);

    return `
        <div class="resource-handover-graph resource-distribution-chart hidden">
            ${entries.map((entry) => `
                <div class="resource-distribution-row">
                    <span class="resource-distribution-label">${escapeHtml(formatResourceLabel(entry.resourceId))}</span>
                    <span class="resource-distribution-track">
                        <span class="resource-distribution-bar"
                            style="width: ${Math.max(8, (entry.count / maxCount) * 100).toFixed(1)}%"></span>
                    </span>
                    <strong>${escapeHtml(entry.count)}</strong>
                </div>
            `).join("")}
            <div class="aggregate-edge-popup-muted">
                No resource handover occurs in this transition. The chart shows how many
                underlying event pairs were handled by each resource.
            </div>
        </div>
    `;
}

function renderResourceHandoverGraph(context = {}) {
    const transitions = (context.transitions ?? [])
        .filter((transition) => transition.sourceResource !== transition.targetResource);
    if (transitions.length === 0) return "";

    const sourceIds = Array.from(new Set(transitions.map((transition) => transition.sourceResource)))
        .sort();
    const targetIds = Array.from(new Set(transitions.map((transition) => transition.targetResource)))
        .sort();
    const maxCount = Math.max(...transitions.map((transition) => Number(transition.count) || 1), 1);
    const viewWidth = 300;
    const rowCount = Math.max(sourceIds.length, targetIds.length, 3);
    const rowGap = 24;
    const topPadding = 28;
    const viewHeight = topPadding * 2 + ((rowCount - 1) * rowGap);
    const nodeRadius = rowCount > 10 ? 9 : 11;
    const sourceX = 54;
    const targetX = 246;

    const makeColumnPositions = (resourceIds, x) => new Map(
        resourceIds.map((resourceId, index) => {
            const columnHeight = (resourceIds.length - 1) * rowGap;
            const startY = (viewHeight - columnHeight) / 2;
            return [resourceId, { x, y: startY + index * rowGap }];
        })
    );
    const sourcePositions = makeColumnPositions(sourceIds, sourceX);
    const targetPositions = makeColumnPositions(targetIds, targetX);

    const edgeElements = transitions.map((transition, index) => {
        const source = sourcePositions.get(transition.sourceResource);
        const target = targetPositions.get(transition.targetResource);
        if (!source || !target) return "";
        const strokeWidth = 1.1 + ((Number(transition.count) || 1) / maxCount) * 2.8;
        const isDominant = index === 0;
        const startX = source.x + nodeRadius + 3;
        const startY = source.y;
        const endX = target.x - nodeRadius - 6;
        const endY = target.y;
        const midX = (startX + endX) / 2;
        const midY = (startY + endY) / 2;
        const curveOffset = (index % 2 === 0 ? -1 : 1) * Math.min(16, Math.abs(target.y - source.y) * 0.22 + 8);
        const controlX = midX;
        const controlY = midY + curveOffset;

        return `
            <path class="resource-handover-edge ${isDominant ? "dominant" : ""}"
                d="M ${startX} ${startY} Q ${controlX} ${controlY} ${endX} ${endY}"
                stroke-width="${strokeWidth.toFixed(1)}"
                marker-end="url(#resource-handover-arrow)" />
            <text class="resource-handover-edge-label"
                x="${controlX}" y="${controlY - 4}">${escapeHtml(transition.count)}</text>
        `;
    }).join("");

    const nodeElements = [
        ...sourceIds.map((resourceId) => ({
            resourceId,
            position: sourcePositions.get(resourceId),
            className: "source",
        })),
        ...targetIds.map((resourceId) => ({
            resourceId,
            position: targetPositions.get(resourceId),
            className: "target",
        })),
    ].map(({ resourceId, position, className }) => `
        <g class="resource-handover-node ${className}" transform="translate(${position.x},${position.y})">
            <circle r="${nodeRadius}"></circle>
            <text y="4">${escapeHtml(formatResourceLabel(resourceId))}</text>
        </g>
    `).join("");

    return `
        <div class="resource-handover-graph hidden">
            <svg viewBox="0 0 ${viewWidth} ${viewHeight}" role="img" aria-label="Resource handover graph">
                <defs>
                    <marker id="resource-handover-arrow" markerWidth="6" markerHeight="6"
                        refX="5.5" refY="3" orient="auto" markerUnits="userSpaceOnUse">
                        <path d="M 0 0 L 6 3 L 0 6 z"></path>
                    </marker>
                </defs>
                <text class="resource-handover-column-label" x="${sourceX}" y="14">source</text>
                <text class="resource-handover-column-label" x="${targetX}" y="14">target</text>
                <g class="resource-handover-edges">${edgeElements}</g>
                <g class="resource-handover-nodes">${nodeElements}</g>
            </svg>
            <div class="aggregate-edge-popup-muted">
                The graph shows ${escapeHtml(context.changedResourceCount ?? transitions.length)}
                changed-resource handovers. Same-resource pairs are counted above but are not drawn as handover edges.
            </div>
        </div>
    `;
}

function renderResourceHandoverContext(context = {}) {
    const transitions = context.transitions ?? [];
    if (transitions.length === 0) {
        return `
            <div class="aggregate-edge-popup-section">Resource handover</div>
            <div class="aggregate-edge-popup-muted">
                No source and target resources are available for the underlying event pairs.
            </div>
        `;
    }

    const hasResourceChange = Number(context.changedResourceCount ?? 0) > 0;
    const changedTransitions = transitions.filter((transition) => (
        transition.sourceResource !== transition.targetResource
    ));
    const dominant = changedTransitions[0] ?? null;
    const hasTiedChangedHandovers = changedTransitions.length > 1
        && dominant
        && changedTransitions.every((transition) => transition.count === dominant.count);
    const distributionEntries = getResourceDistributionEntries(context);
    const dominantResource = distributionEntries[0] ?? null;
    const hasTiedResourceDistribution = distributionEntries.length > 1
        && dominantResource
        && distributionEntries.filter((entry) => entry.count === dominantResource.count).length > 1;
    const dominantHandoverText = dominant
        ? `${formatResourceLabel(dominant.sourceResource)} → ${formatResourceLabel(dominant.targetResource)} (${dominant.count})`
        : "-";
    const dominantResourceText = dominantResource
        ? `${formatResourceLabel(dominantResource.resourceId)} (${dominantResource.count})`
        : "-";
    const summaryLabel = hasResourceChange
        ? (hasTiedChangedHandovers ? "Dominant handover" : "Most common handover")
        : (hasTiedResourceDistribution ? "Dominant resource" : "Most frequent resource");
    const summaryValue = hasResourceChange
        ? (hasTiedChangedHandovers ? `No dominant handover, all occur ${dominant.count}x` : dominantHandoverText)
        : (hasTiedResourceDistribution ? `Several resources tie at ${dominantResource.count}x` : dominantResourceText);

    return `
        <div class="aggregate-edge-popup-section">
            ${hasResourceChange ? "Resource handover" : "Resource distribution"}
        </div>
        <div class="aggregate-edge-popup-row compact">
            <span>Distinct resources involved</span>
            <strong>${escapeHtml(context.distinctResources?.length ?? 0)}</strong>
        </div>
        <div class="aggregate-edge-popup-row compact">
            <span>Same resource</span>
            <strong>${escapeHtml(context.sameResourceCount ?? 0)}</strong>
        </div>
        <div class="aggregate-edge-popup-row compact">
            <span>Resource changed</span>
            <strong>${escapeHtml(context.changedResourceCount ?? 0)}</strong>
        </div>
        <div class="aggregate-edge-popup-row compact">
            <span>${summaryLabel}</span>
            <strong>${escapeHtml(summaryValue)}</strong>
        </div>
        <button type="button" class="resource-handover-toggle">
            ${hasResourceChange ? "View resource handover graph" : "View resource distribution"}
        </button>
        ${hasResourceChange ? renderResourceHandoverGraph(context) : renderResourceDistributionChart(context)}
    `;
}

function renderFoldout(title, content, isOpen = false) {
    if (!content) return "";
    return `
        <details class="aggregate-edge-popup-foldout" ${isOpen ? "open" : ""}>
            <summary>${escapeHtml(title)}</summary>
            <div class="aggregate-edge-popup-foldout-content">
                ${content}
            </div>
        </details>
    `;
}

function renderInvolvedInstances(instanceIds = []) {
    const shownInstanceIds = instanceIds.slice(0, 5);
    const hiddenInstanceCount = Math.max(instanceIds.length - shownInstanceIds.length, 0);
    return `
        <div class="aggregate-edge-popup-instances">
            ${shownInstanceIds.map((instanceId) => `<div>${escapeHtml(instanceId)}</div>`).join("")}
            ${hiddenInstanceCount > 0 ? `<div>+ ${hiddenInstanceCount} more</div>` : ""}
        </div>
    `;
}

function renderResourceSummaryRow(context = {}) {
    const transitions = context.transitions ?? [];
    if (transitions.length === 0) return "";
    const changedCount = Number(context.changedResourceCount ?? 0);
    const label = changedCount > 0 ? "Resource changed" : "Same-resource pairs";
    const value = changedCount > 0 ? changedCount : Number(context.sameResourceCount ?? 0);
    return `
        <div class="aggregate-edge-popup-row compact">
            <span>${label}</span>
            <strong>${escapeHtml(value)}</strong>
        </div>
    `;
}

function renderCrossPerspectiveContext(context = {}) {
    const eventCounts = Object.entries(context.eventCounts ?? {})
        .filter(([, count]) => Number(count) > 0);
    const relatedLifecycles = Object.entries(context.relatedLifecycles ?? {})
        .filter(([, ids]) => (ids ?? []).length > 0);
    const transitions = Object.entries(context.transitions ?? {})
        .map(([perspective, entries]) => [perspective, (entries ?? []).filter((entry) => Number(entry.count) > 0)])
        .filter(([, entries]) => entries.length > 0);

    const emptyMessage = `
        <div class="aggregate-edge-popup-muted">
            No related cross-perspective events or transitions fall inside this edge interval.
        </div>
    `;

    if (eventCounts.length === 0 && relatedLifecycles.length === 0 && transitions.length === 0) {
        return `
            <div class="aggregate-edge-popup-section">Cross-perspective context</div>
            <div class="aggregate-edge-popup-muted">
                Activity-span rule: related transitions are assigned to the underlying
                ${escapeHtml(getPerspectiveLabel(context.primaryPerspective))} activity span that contains their source event.
            </div>
            ${emptyMessage}
        `;
    }

    const eventRows = eventCounts.map(([perspective, count]) => `
        <div class="aggregate-edge-popup-row compact">
            <span>${escapeHtml(getPerspectiveLabel(perspective))} events in underlying intervals</span>
            <strong>${escapeHtml(count)}</strong>
        </div>
    `).join("");

    const lifecycleRows = relatedLifecycles.map(([perspective, ids]) => `
        <div class="aggregate-edge-popup-row compact">
            <span>Related ${escapeHtml(getPerspectiveLabel(perspective))} lifecycles</span>
            <strong>${escapeHtml(ids.length)}</strong>
        </div>
    `).join("");

    const transitionRows = transitions.map(([perspective, entries]) => `
        <div class="aggregate-edge-popup-subsection">
            Common ${escapeHtml(getPerspectiveLabel(perspective))} transitions
        </div>
        ${(entries ?? []).slice(0, 4).map((entry) => `
            <div class="aggregate-edge-popup-transition">
                <span>${escapeHtml(entry.sourceActivity)} → ${escapeHtml(entry.targetActivity)}</span>
                <strong>${escapeHtml(entry.count)}</strong>
            </div>
        `).join("")}
        ${(entries ?? []).length > 4 ? `<div class="aggregate-edge-popup-muted">+ ${(entries ?? []).length - 4} more transitions</div>` : ""}
    `).join("");

    return `
        <div class="aggregate-edge-popup-section">Cross-perspective context</div>
        <div class="aggregate-edge-popup-muted">
            Activity-span rule: related transitions are assigned to the underlying
            ${escapeHtml(getPerspectiveLabel(context.primaryPerspective))} activity span that contains their source event.
        </div>
        ${eventRows}
        ${lifecycleRows}
        ${transitionRows}
    `;
}

function showAggregateEdgePopup(edge, clickEvent, groupInstanceCount) {
    hideAggregateEdgePopup();

    const chart = document.getElementById("chart");
    if (!chart || !edge) return;

    const chartBounds = chart.getBoundingClientRect();
    const popupWidth = 360;
    const left = Math.min(
        Math.max(clickEvent.clientX - chartBounds.left + 14, 8),
        Math.max(chartBounds.width - popupWidth - 8, 8)
    );
    const top = Math.max(clickEvent.clientY - chartBounds.top + 14, 8);
    const instanceIds = edge.aggregateInstanceIds ?? [];
    const denominator = edge.aggregateGroupInstanceCount ?? groupInstanceCount;
    const hasResourceChange = Number(edge.resourceHandoverContext?.changedResourceCount ?? 0) > 0;

    d3.select(chart)
        .append("div")
        .attr("id", "aggregate-edge-popup")
        .attr("class", "aggregate-edge-popup")
        .style("left", `${left}px`)
        .style("top", `${top}px`)
        .html(`
            <button type="button" class="aggregate-edge-popup-close" aria-label="Close aggregate edge popup">×</button>
            <div class="aggregate-edge-popup-title">
                ${edge.sourceActivity ?? edge.source} → ${edge.targetActivity ?? edge.target}
            </div>
            <div class="aggregate-edge-popup-row">
                <span>Transition frequency</span>
                <strong>${edge.aggregateCount ?? "-"}/${denominator ?? "-"}</strong>
            </div>
            <div class="aggregate-edge-popup-row">
                <span>Event pairs</span>
                <strong>${edge.aggregateEventPairCount ?? "-"}</strong>
            </div>
            <div class="aggregate-edge-popup-row">
                <span>Mean activity distance</span>
                <strong>${formatDurationFromDays(edge.averageDurationDays)}</strong>
            </div>
            ${edge.averagePairDurationDays != null ? `
                <div class="aggregate-edge-popup-row compact">
                    <span>Direct DF-pair duration</span>
                    <strong>${formatDurationFromDays(edge.averagePairDurationDays)}</strong>
                </div>
            ` : ""}
            ${renderResourceSummaryRow(edge.resourceHandoverContext)}
            ${renderFoldout("Cross-perspective context", renderCrossPerspectiveContext(edge.crossPerspectiveContext))}
            ${renderFoldout(
                hasResourceChange ? "Resource handover" : "Resource distribution",
                renderResourceHandoverContext(edge.resourceHandoverContext)
            )}
            ${renderFoldout("Involved instances", renderInvolvedInstances(instanceIds))}
        `);

    document.querySelector("#aggregate-edge-popup .aggregate-edge-popup-close")
        ?.addEventListener("click", hideAggregateEdgePopup);
    document.querySelector("#aggregate-edge-popup .resource-handover-toggle")
        ?.addEventListener("click", (event) => {
            event.stopPropagation();
            const graph = document.querySelector("#aggregate-edge-popup .resource-handover-graph");
            if (!graph) return;
            const isHidden = graph.classList.toggle("hidden");
            const hasHandoverGraph = !graph.classList.contains("resource-distribution-chart");
            event.currentTarget.textContent = isHidden
                ? (hasHandoverGraph ? "View resource handover graph" : "View resource distribution")
                : (hasHandoverGraph ? "Hide resource handover graph" : "Hide resource distribution");
        });
}

function bindAggregateEdgePopupInteractions(graphData, groupInstanceCount) {
    const aggregateEdges = graphData?.edges ?? [];
    const edgeById = new Map(aggregateEdges.map((edge) => [String(edge.id), edge]));

    d3.selectAll(".instance-edge, .aggregate-edge-hit-area")
        .filter(function () {
            const edgeId = this.dataset.edgeId ?? this.id?.replace(/^edge-/, "");
            return Boolean(edgeById.get(edgeId)?.isAggregateEdge);
        })
        .style("cursor", "pointer")
        .on("click.aggregate-edge", function (event) {
            event.stopPropagation();
            const edgeId = this.dataset.edgeId ?? this.id?.replace(/^edge-/, "");
            showAggregateEdgePopup(edgeById.get(edgeId), event, groupInstanceCount);
        });

    d3.select("#chart svg").on("click.aggregate-edge-popup", () => {
        hideAggregateEdgePopup();
    });
}

export { bindAggregateEdgePopupInteractions, hideAggregateEdgePopup };
