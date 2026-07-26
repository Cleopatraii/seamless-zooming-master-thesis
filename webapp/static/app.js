/*
SEAMLESS_ZOOM — A technique for seamless zooming between process models and process instances.
*/

import { exportData } from './utils/exportData.mjs';
import { TIMEORDERMAP, resetPersistedXZoom } from './views/timeOrderMap.js';
import { SPACEORDERMAP } from './views/spaceOrderMap.js';
import { createMultiEntityState } from './utils/multiEntityState.mjs';
import {
    VISIBLE_ENTITY_CATEGORIES,
    getEntityColor,
    getEntityCategoryDisplayLabel,
    getEntityDisplayLabel,
    isExpandableRelationEntityType,
    splitVisibleAndHiddenMemberships,
} from './utils/multiEntityConfig.mjs';

let currentGraphViewSelection = 0;
let currentRenderedData = null;
let currentMultiEntityController = null;
let availableMultiEntityInstances = [];
let selectedMultiEntityInstanceId = null;
let instanceOverviewState = {
    page: 1,
    pageSize: 10,
    total: 0,
    sort: "event_count",
    order: "desc",
    applicationSearch: "",
    minEvents: "",
    minOffers: "",
    onlyCancelled: false,
    warning: null,
};


function formatCount(value) {
    return Number.isFinite(Number(value)) ? String(value) : "-";
}


function formatDuration(value) {
    if (!Number.isFinite(Number(value))) return "-";
    const days = Number(value);
    if (days < 1) return `${Math.round(days * 24)}h`;
    return `${days.toFixed(days < 10 ? 1 : 0)}d`;
}


function describeInstance(instance) {
    if (!instance) return "No instance selected";
    const metrics = [];
    if (instance.eventCount != null) metrics.push(`${instance.eventCount} events`);
    if (instance.dfEdgeCount != null) metrics.push(`${instance.dfEdgeCount} DF edges`);
    if (instance.offerCount != null) metrics.push(`${instance.offerCount} offers`);
    if (instance.durationDays != null) metrics.push(`${formatDuration(instance.durationDays)} duration`);
    if (instance.description) metrics.push(instance.description);
    return `${instance.id}${metrics.length > 0 ? " · " + metrics.join(" · ") : ""}`;
}


function describeGraphFilters(filters = {}) {
    const activeFilters = [
        filters.activityPrefix ? `activity type ${filters.activityPrefix}` : null,
        filters.activityContains ? `activity contains "${filters.activityContains}"` : null,
        filters.timeStartDays ? `from D${filters.timeStartDays}` : null,
        filters.timeEndDays ? `to D${filters.timeEndDays}` : null,
    ].filter(Boolean);
    return activeFilters.length > 0 ? activeFilters.join(", ") : "";
}


function showMultiEntityError(message) {
    const panel = document.getElementById("multi-entity-panel");
    const status = document.getElementById("multi-entity-status");
    const details = document.getElementById("multi-entity-details");
    if (panel) panel.style.display = "block";
    if (status) status.textContent = "Scope: error";
    if (details) {
        details.innerHTML = `
            <div class="detail-card">
                <div class="detail-title">Multi-Entity initialization error</div>
                <div class="detail-meta">${message}</div>
            </div>
        `;
    }
}


function graphViewSwitcher(graphViewSelection, data) {
    if (graphViewSelection === 0) {
        d3.select("#chart").selectAll("*").remove();
        TIMEORDERMAP(data);
    } else if (graphViewSelection === 1) {
        d3.select("#chart").selectAll("*").remove();
        d3.select("h1").text("Space-Order Map (work-in-progress)");
        SPACEORDERMAP(data);
    } else {
        console.error("Unknown view:", graphViewSelection);
    }
}


function renderEmptyMultiEntityGraph() {
    d3.select("#chart").selectAll("*").remove();
    const emptyPanel = d3.select("#chart")
        .append("div")
        .attr("class", "multi-entity-empty-chart")
        .html(`
            <div class="detail-card">
                <div class="detail-title">No matching events</div>
                <div class="detail-meta">
                    The current graph filters hide all events in this scope. Clear the filters or widen the time range.
                </div>
                <div class="empty-chart-actions">
                    <button type="button" id="button-empty-show-all">Show All with same filters</button>
                    <button type="button" id="button-empty-clear-filters">Clear graph filters</button>
                </div>
            </div>
        `);

    emptyPanel.select("#button-empty-show-all").on("click", () => {
        if (!currentMultiEntityController) return;
        currentMultiEntityController.showAll();
        renderMultiEntityGraph();
    });

    emptyPanel.select("#button-empty-clear-filters").on("click", () => {
        clearGraphFilters();
    });
}


function setMultiEntityPanelVisibility(isVisible) {
    const panel = document.getElementById("multi-entity-panel");
    if (panel) panel.style.display = isVisible ? "block" : "none";
    const topKPanel = document.getElementById("topk-panel");
    if (topKPanel) topKPanel.style.display = isVisible ? "none" : "block";
}


function markActiveEventInChart() {
    const activeEventId = currentMultiEntityController?.getActiveEventId?.();
    d3.selectAll(".instance-node")
        .classed("event-selected", false)
        .classed("event-shared", function () {
            return this.dataset.shared === "true";
        });

    if (!activeEventId) return;
    d3.select(`#node-${CSS.escape(activeEventId)}`)
        .classed("event-selected", true);
}


function updateEntityExpansionList() {
    const list = document.getElementById("multi-entity-selected");
    if (!list || !currentMultiEntityController) return;

    const entries = currentMultiEntityController.getExpandedEntityEntries();
    if (entries.length === 0) {
        list.innerHTML = '<p class="multi-entity-muted">No related entities expanded yet.</p>';
        return;
    }

    list.innerHTML = entries.map((entry) => `
        <div class="entity-pill">
            <span>${getEntityDisplayLabel(entry.entityType)}: ${entry.entityId}</span>
            <span class="entity-pill-meta">${entry.eventIds?.size ?? 0} events</span>
        </div>
    `).join("");
}


function renderMultiEntityLegend() {
    const legend = document.getElementById("multi-entity-legend");
    if (!legend) return;

    legend.innerHTML = VISIBLE_ENTITY_CATEGORIES
        .map((entityCategory) => `
            <div class="legend-row">
                <span class="legend-swatch" style="background:${getEntityColor(entityCategory)}"></span>
                <span>${getEntityCategoryDisplayLabel(entityCategory)}</span>
            </div>
        `)
        .join("");
}


function getSelectedInstanceSummary() {
    const selectedInstance = availableMultiEntityInstances.find(
        (instance) => instance.id === selectedMultiEntityInstanceId
    );
    return selectedInstance ?? {
        id: selectedMultiEntityInstanceId,
        label: selectedMultiEntityInstanceId,
    };
}


function renderCurrentInstanceNavigator() {
    const summary = document.getElementById("current-instance-summary");
    if (summary) summary.textContent = describeInstance(getSelectedInstanceSummary());
}


function renderInstanceBrowser() {
    renderCurrentInstanceNavigator();

    const table = document.getElementById("instance-browser-table");
    const status = document.getElementById("instance-browser-status");
    const pageStatus = document.getElementById("instance-page-status");
    const sortSelect = document.getElementById("instance-sort-select");
    const orderSelect = document.getElementById("instance-order-select");
    const applicationSearchInput = document.getElementById("instance-application-search");
    const minEventsInput = document.getElementById("instance-min-events");
    const minOffersInput = document.getElementById("instance-min-offers");
    const onlyCancelledInput = document.getElementById("instance-only-cancelled");

    if (sortSelect) sortSelect.value = instanceOverviewState.sort;
    if (orderSelect) orderSelect.value = instanceOverviewState.order;
    if (applicationSearchInput) applicationSearchInput.value = instanceOverviewState.applicationSearch;
    if (minEventsInput) minEventsInput.value = instanceOverviewState.minEvents;
    if (minOffersInput) minOffersInput.value = instanceOverviewState.minOffers;
    if (onlyCancelledInput) onlyCancelledInput.checked = instanceOverviewState.onlyCancelled;

    if (status) {
        const start = instanceOverviewState.total === 0
            ? 0
            : ((instanceOverviewState.page - 1) * instanceOverviewState.pageSize) + 1;
        const end = Math.min(instanceOverviewState.page * instanceOverviewState.pageSize, instanceOverviewState.total);
        const warning = instanceOverviewState.warning ? ` · fallback: ${instanceOverviewState.warning}` : "";
        const activeFilters = [
            instanceOverviewState.applicationSearch ? `ID contains "${instanceOverviewState.applicationSearch}"` : null,
            instanceOverviewState.minEvents ? `min events ${instanceOverviewState.minEvents}` : null,
            instanceOverviewState.minOffers ? `min offers ${instanceOverviewState.minOffers}` : null,
            instanceOverviewState.onlyCancelled ? "only cancelled" : null,
        ].filter(Boolean);
        const filterText = activeFilters.length > 0 ? ` · filters: ${activeFilters.join(", ")}` : "";
        status.textContent = `Showing ${start}-${end} of ${instanceOverviewState.total} instances${filterText}${warning}`;
    }
    if (pageStatus) {
        const totalPages = Math.max(Math.ceil(instanceOverviewState.total / instanceOverviewState.pageSize), 1);
        pageStatus.textContent = `Page ${instanceOverviewState.page} / ${totalPages}`;
    }

    if (!table) return;
    if (availableMultiEntityInstances.length === 0) {
        table.innerHTML = '<div class="multi-entity-muted">No instances available.</div>';
        return;
    }

    table.innerHTML = `
        <table>
            <thead>
                <tr>
                    <th>Instance</th>
                    <th>Events</th>
                    <th>DF edges</th>
                    <th>Offers</th>
                    <th>Duration</th>
                    <th>Cancelled</th>
                </tr>
            </thead>
            <tbody>
                ${availableMultiEntityInstances.map((instance) => `
                    <tr class="instance-browser-row ${instance.id === selectedMultiEntityInstanceId ? "active" : ""}"
                        data-instance-id="${instance.id}">
                        <td>${instance.id}</td>
                        <td>${formatCount(instance.eventCount)}</td>
                        <td>${formatCount(instance.dfEdgeCount)}</td>
                        <td>${formatCount(instance.offerCount)}</td>
                        <td>${formatDuration(instance.durationDays)}</td>
                        <td>${instance.hasCancellation ? "yes" : "no"}</td>
                    </tr>
                `).join("")}
            </tbody>
        </table>
    `;

    table.querySelectorAll(".instance-browser-row").forEach((row) => {
        row.addEventListener("click", async () => {
            const instanceId = row.dataset.instanceId;
            if (!instanceId) return;
            await switchMultiEntityInstance(instanceId);
            setInstanceBrowserOpen(false);
        });
    });
}


function updateGraphFilterControlsFromState() {
    const filters = currentMultiEntityController?.getGraphFilters?.() ?? {};
    const activityPrefixInput = document.getElementById("graph-filter-activity-prefix");
    const activityInput = document.getElementById("graph-filter-activity");
    const timeStartInput = document.getElementById("graph-filter-time-start");
    const timeEndInput = document.getElementById("graph-filter-time-end");

    if (activityPrefixInput) activityPrefixInput.value = filters.activityPrefix ?? "";
    if (activityInput) activityInput.value = filters.activityContains ?? "";
    if (timeStartInput) timeStartInput.value = filters.timeStartDays ?? "";
    if (timeEndInput) timeEndInput.value = filters.timeEndDays ?? "";
}


function setInstanceBrowserOpen(isOpen) {
    const panel = document.getElementById("instance-browser-panel");
    if (!panel) return;
    panel.classList.toggle("hidden", !isOpen);
    if (isOpen) renderInstanceBrowser();
}


function updateMultiEntityDetailsPanel() {
    const panel = document.getElementById("multi-entity-details");
    const status = document.getElementById("multi-entity-status");
    if (!panel || !status || !currentMultiEntityController) return;

    const { state } = currentMultiEntityController;
    const filterDescription = describeGraphFilters(currentMultiEntityController.getGraphFilters?.());
    status.textContent = `Scope: ${state.mode}${filterDescription ? ` · filters: ${filterDescription}` : ""}`;
    updateEntityExpansionList();

    const event = currentMultiEntityController.getEventDetails(
        currentMultiEntityController.getActiveEventId()
    );

    if (!event) {
        panel.innerHTML = `
            <p class="multi-entity-muted">
                Hover or click an event to inspect memberships and expand a related lifecycle.
            </p>
        `;
        markActiveEventInChart();
        return;
    }

    const membershipGroups = splitVisibleAndHiddenMemberships(
        event.scopedEntityMemberships ?? event.entityMemberships
    );
    const anchorExpandableRelationKeys = new Set(
        (event.expandableRelationMemberships ?? []).map((membership) => membership.entityKey)
    );

    const membershipMarkup = membershipGroups.visible.map((membership) => {
        const entry = currentMultiEntityController.getEntityDetails(membership.entityKey);
        const isAnchorApplication = (
            membership.entityType === "Application" &&
            membership.entityId === currentMultiEntityController.state.anchor.entityId
        );
        const isRelationMembership = isExpandableRelationEntityType(membership.entityType);
        const isAnchorExpansionPoint = (
            !isRelationMembership || anchorExpandableRelationKeys.has(membership.entityKey)
        );
        const isDirectlyExpanded = currentMultiEntityController.state.expandedEntityKeys.has(membership.entityKey);
        const isEffectivelyExpanded = currentMultiEntityController.isEntityEffectivelyExpanded(membership.entityKey);
        const canExpand = !isAnchorApplication && Boolean(entry?.canExpand) && isAnchorExpansionPoint;
        const buttonLabel = !canExpand && isRelationMembership && entry?.canExpand
            ? "Info only"
            : (isDirectlyExpanded ? "Collapse" : (isEffectivelyExpanded ? "Shown" : "Expand"));
        const buttonDisabled = canExpand && (isDirectlyExpanded || !isEffectivelyExpanded) ? "" : "disabled";

        return `
            <div class="membership-row">
                <div>
                    <strong>${getEntityDisplayLabel(membership.entityType)}</strong>
                    <div class="membership-id">Category: ${membership.displayCategory ? getEntityCategoryDisplayLabel(membership.displayCategory) : "Other relation"}</div>
                    <div class="membership-id">Raw type: ${membership.entityType}</div>
                    <div class="membership-id">${membership.entityId}</div>
                </div>
                <button
                    class="membership-action"
                    data-entity-key="${membership.entityKey}"
                    ${buttonDisabled}
                >${buttonLabel}</button>
            </div>
        `;
    }).join("") || `
        <p class="multi-entity-muted">
            No basic entity memberships are shown for this event.
        </p>
    `;

    const otherRelationsMarkup = membershipGroups.hidden.length > 0
        ? `
            <div class="detail-section-title">Other relations</div>
            <div class="membership-other-group">
                ${membershipGroups.hidden.map((membership) => `
                    <div class="membership-row membership-row-muted">
                        <div>
                            <strong>${getEntityDisplayLabel(membership.entityType)}</strong>
                            <div class="membership-id">Raw type: ${membership.entityType}</div>
                            <div class="membership-id">${membership.entityId}</div>
                        </div>
                    </div>
                `).join("")}
            </div>
        `
        : "";

    panel.innerHTML = `
        <div class="detail-card">
            <div class="detail-title">${event.activity}</div>
            <div class="detail-meta">Case: ${event.case}</div>
            <div class="detail-meta">Timestamp: ${event.timestamp}</div>
            <div class="detail-meta detail-meta-secondary">Event ID: ${event.id}</div>
            <div class="detail-section-title">Entity memberships</div>
            ${membershipMarkup}
            ${otherRelationsMarkup}
        </div>
    `;

    panel.querySelectorAll(".membership-action").forEach((button) => {
        button.addEventListener("click", () => {
            const entityKey = button.dataset.entityKey;
            currentMultiEntityController.toggleEntityExpansion(entityKey);
            renderMultiEntityGraph();
        });
    });

    markActiveEventInChart();
}


function bindMultiEntityChartInteractions() {
    if (!currentMultiEntityController) return;

    d3.selectAll(".instance-node, .instance-node-hit-area")
        .on("mouseenter.multi-entity", function () {
            if (currentMultiEntityController.state.selectedEventId) return;
            currentMultiEntityController.setHoveredEvent(this.dataset.eventId);
            updateMultiEntityDetailsPanel();
        })
        .on("mouseleave.multi-entity", function () {
            if (currentMultiEntityController.state.selectedEventId) return;
            currentMultiEntityController.clearHoveredEvent();
            updateMultiEntityDetailsPanel();
        })
        .on("click.multi-entity", function (event, d) {
            const clickedEventId = this.dataset.eventId;
            const overlapEventIds = d?.overlapEventIds ?? [];
            if (overlapEventIds.length > 1) {
                const activeEventId = currentMultiEntityController.getActiveEventId();
                const activeIndex = overlapEventIds.indexOf(activeEventId);
                const clickedIndex = overlapEventIds.indexOf(clickedEventId);
                const nextEventId = activeIndex === -1
                    ? overlapEventIds[(clickedIndex + 1) % overlapEventIds.length]
                    : overlapEventIds[(activeIndex + 1) % overlapEventIds.length];
                currentMultiEntityController.setSelectedEvent(nextEventId);
                updateMultiEntityDetailsPanel();
                return;
            }

            currentMultiEntityController.setSelectedEvent(clickedEventId);
            updateMultiEntityDetailsPanel();
        });

    markActiveEventInChart();
}


function renderCurrentGraph() {
    graphViewSwitcher(currentGraphViewSelection, currentRenderedData);
    if (currentMultiEntityController) {
        try {
            bindMultiEntityChartInteractions();
            updateMultiEntityDetailsPanel();
        } catch (err) {
            console.error("Multi-entity panel binding failed:", err);
            showMultiEntityError(String(err?.message ?? err));
        }
    }
}


function renderMultiEntityGraph() {
    currentRenderedData = currentMultiEntityController.getVisibleGraphPayload();
    if ((currentRenderedData?.graphData?.nodes?.length ?? 0) === 0) {
        renderEmptyMultiEntityGraph();
        updateMultiEntityDetailsPanel();
        return;
    }
    renderCurrentGraph();
}


async function loadAvailableMultiEntityInstances() {
    const query = new URLSearchParams({
        page: String(instanceOverviewState.page),
        page_size: String(instanceOverviewState.pageSize),
        sort: instanceOverviewState.sort,
        order: instanceOverviewState.order,
        application_search: instanceOverviewState.applicationSearch,
        min_events: instanceOverviewState.minEvents || "0",
        min_offers: instanceOverviewState.minOffers || "0",
        only_cancelled: String(Boolean(instanceOverviewState.onlyCancelled)),
    });
    const response = await fetch(`/api/multi_entity_instances?${query.toString()}`);
    if (!response.ok) {
        throw new Error("Multi-entity instance list is not available.");
    }
    const payload = await response.json();
    availableMultiEntityInstances = payload.instances ?? payload;
    instanceOverviewState = {
        ...instanceOverviewState,
        page: payload.page ?? instanceOverviewState.page,
        pageSize: payload.pageSize ?? instanceOverviewState.pageSize,
        total: payload.total ?? availableMultiEntityInstances.length,
        sort: payload.sort ?? instanceOverviewState.sort,
        order: payload.order ?? instanceOverviewState.order,
        applicationSearch: payload.filters?.application_search ?? instanceOverviewState.applicationSearch,
        minEvents: payload.filters?.min_events ? String(payload.filters.min_events) : instanceOverviewState.minEvents,
        minOffers: payload.filters?.min_offers ? String(payload.filters.min_offers) : instanceOverviewState.minOffers,
        onlyCancelled: payload.filters?.only_cancelled ?? instanceOverviewState.onlyCancelled,
        warning: payload.warning ?? null,
    };
    if (!selectedMultiEntityInstanceId && availableMultiEntityInstances.length > 0) {
        selectedMultiEntityInstanceId = availableMultiEntityInstances[0].id;
    }
    renderInstanceBrowser();
    return availableMultiEntityInstances;
}


async function loadMultiEntityPrototype(instanceId = selectedMultiEntityInstanceId) {
    const encodedInstanceId = encodeURIComponent(instanceId);
    let localResponse;
    let expandedResponse;

    try {
        [localResponse, expandedResponse] = await Promise.all([
            fetch(`/api/multi_entity_live/${encodedInstanceId}/local`),
            fetch(`/api/multi_entity_live/${encodedInstanceId}/expanded`),
        ]);
    } catch (err) {
        console.warn("Live Neo4j instance loading failed, trying exported samples:", err);
    }

    if (!localResponse?.ok || !expandedResponse?.ok) {
        [localResponse, expandedResponse] = await Promise.all([
            fetch(`/api/multi_entity_sample/${encodedInstanceId}/local`),
            fetch(`/api/multi_entity_sample/${encodedInstanceId}/expanded`),
        ]);
    }

    if (!localResponse.ok || !expandedResponse.ok) {
        throw new Error(`Multi-entity samples are not available for ${instanceId}.`);
    }

    const [localSample, expandedSample] = await Promise.all([
        localResponse.json(),
        expandedResponse.json(),
    ]);

    return createMultiEntityState(localSample, expandedSample);
}


async function switchMultiEntityInstance(instanceId) {
    selectedMultiEntityInstanceId = instanceId;
    d3.select("#chart").selectAll("*").remove();
    currentMultiEntityController = await loadMultiEntityPrototype(selectedMultiEntityInstanceId);
    currentRenderedData = currentMultiEntityController.getVisibleGraphPayload();
    renderCurrentInstanceNavigator();
    renderMultiEntityLegend();
    updateGraphFilterControlsFromState();
    renderCurrentGraph();
    updateMultiEntityDetailsPanel();
}


async function draw(inputData = null) {
    d3.select("#chart").selectAll("*").remove();

    //user upload data
    if (inputData) {
        currentMultiEntityController = null;
        currentRenderedData = inputData;
        setMultiEntityPanelVisibility(false);
        renderCurrentGraph();
        return;
    }

    try {
        await loadAvailableMultiEntityInstances();
        renderCurrentInstanceNavigator();
        currentMultiEntityController = await loadMultiEntityPrototype(selectedMultiEntityInstanceId);
        currentRenderedData = currentMultiEntityController.getVisibleGraphPayload();
        setMultiEntityPanelVisibility(true);
        renderMultiEntityLegend();
        updateGraphFilterControlsFromState();
        try {
            renderCurrentGraph();
        } catch (err) {
            console.error("Multi-entity rendering failed:", err);
            showMultiEntityError(String(err?.message ?? err));
            return;
        }
        return;
    } catch (err) {
        console.warn("Falling back to default CSV data:", err);
    }

    try {
        currentRenderedData = await d3.json('/api/get_data');
        currentMultiEntityController = null;
        setMultiEntityPanelVisibility(false);
        renderCurrentGraph();
    } catch (err) {
        console.error("Failed to load default data:", err);
    }
}


function readInstanceFilterControls() {
    const applicationSearchInput = document.getElementById("instance-application-search");
    const minEventsInput = document.getElementById("instance-min-events");
    const minOffersInput = document.getElementById("instance-min-offers");
    const onlyCancelledInput = document.getElementById("instance-only-cancelled");

    return {
        applicationSearch: applicationSearchInput?.value.trim() ?? "",
        minEvents: minEventsInput?.value.trim() ?? "",
        minOffers: minOffersInput?.value.trim() ?? "",
        onlyCancelled: Boolean(onlyCancelledInput?.checked),
    };
}


function readGraphFilterControls() {
    const activityPrefixInput = document.getElementById("graph-filter-activity-prefix");
    const activityInput = document.getElementById("graph-filter-activity");
    const timeStartInput = document.getElementById("graph-filter-time-start");
    const timeEndInput = document.getElementById("graph-filter-time-end");

    return {
        activityPrefix: activityPrefixInput?.value ?? "",
        activityContains: activityInput?.value.trim() ?? "",
        timeStartDays: timeStartInput?.value.trim() ?? "",
        timeEndDays: timeEndInput?.value.trim() ?? "",
    };
}


async function applyInstanceFilters() {
    instanceOverviewState = {
        ...instanceOverviewState,
        ...readInstanceFilterControls(),
        page: 1,
    };
    await loadAvailableMultiEntityInstances();
}


async function clearInstanceFilters() {
    instanceOverviewState = {
        ...instanceOverviewState,
        applicationSearch: "",
        minEvents: "",
        minOffers: "",
        onlyCancelled: false,
        page: 1,
    };
    await loadAvailableMultiEntityInstances();
}


function applyGraphFilters() {
    if (!currentMultiEntityController) return;
    resetPersistedXZoom();
    currentMultiEntityController.setGraphFilters(readGraphFilterControls());
    renderMultiEntityGraph();
}


function clearGraphFilters() {
    if (!currentMultiEntityController) return;
    resetPersistedXZoom();
    currentMultiEntityController.resetGraphFilters();
    updateGraphFilterControlsFromState();
    renderMultiEntityGraph();
}


function setupUiHandlers() {
    d3.selectAll('input[name="option-switcher-graph-view"]').on("change", function () {
        currentGraphViewSelection = +this.value;
        renderCurrentGraph();
    });

    document.getElementById("button-scope-local")?.addEventListener("click", () => {
        if (!currentMultiEntityController) return;
        currentMultiEntityController.setMode("local");
        renderMultiEntityGraph();
    });

    document.getElementById("button-show-all-perspectives")?.addEventListener("click", () => {
        if (!currentMultiEntityController) return;
        currentMultiEntityController.showAll();
        renderMultiEntityGraph();
    });

    document.getElementById("button-reset-expanded-entities")?.addEventListener("click", () => {
        if (!currentMultiEntityController) return;
        currentMultiEntityController.resetSelections();
        renderMultiEntityGraph();
    });

    document.getElementById("button-browse-instances")?.addEventListener("click", async () => {
        try {
            await loadAvailableMultiEntityInstances();
            setInstanceBrowserOpen(true);
        } catch (err) {
            console.error("Failed to open instance browser:", err);
            showMultiEntityError(String(err?.message ?? err));
        }
    });

    document.getElementById("button-close-instance-browser")?.addEventListener("click", () => {
        setInstanceBrowserOpen(false);
    });

    document.getElementById("button-next-instance")?.addEventListener("click", async () => {
        const currentIndex = availableMultiEntityInstances.findIndex(
            (instance) => instance.id === selectedMultiEntityInstanceId
        );
        const nextInstance = availableMultiEntityInstances[currentIndex + 1];
        if (nextInstance) {
            await switchMultiEntityInstance(nextInstance.id);
            renderInstanceBrowser();
        }
    });

    document.getElementById("button-previous-instance")?.addEventListener("click", async () => {
        const currentIndex = availableMultiEntityInstances.findIndex(
            (instance) => instance.id === selectedMultiEntityInstanceId
        );
        const previousInstance = availableMultiEntityInstances[currentIndex - 1];
        if (previousInstance) {
            await switchMultiEntityInstance(previousInstance.id);
            renderInstanceBrowser();
        }
    });

    document.getElementById("button-instance-page-next")?.addEventListener("click", async () => {
        const totalPages = Math.max(Math.ceil(instanceOverviewState.total / instanceOverviewState.pageSize), 1);
        if (instanceOverviewState.page >= totalPages) return;
        instanceOverviewState.page += 1;
        await loadAvailableMultiEntityInstances();
    });

    document.getElementById("button-instance-page-prev")?.addEventListener("click", async () => {
        if (instanceOverviewState.page <= 1) return;
        instanceOverviewState.page -= 1;
        await loadAvailableMultiEntityInstances();
    });

    document.getElementById("instance-sort-select")?.addEventListener("change", async (event) => {
        instanceOverviewState.sort = event.target.value;
        instanceOverviewState.page = 1;
        await loadAvailableMultiEntityInstances();
    });

    document.getElementById("instance-order-select")?.addEventListener("change", async (event) => {
        instanceOverviewState.order = event.target.value;
        instanceOverviewState.page = 1;
        await loadAvailableMultiEntityInstances();
    });

    document.getElementById("button-apply-instance-filters")?.addEventListener("click", async () => {
        await applyInstanceFilters();
    });

    document.getElementById("button-clear-instance-filters")?.addEventListener("click", async () => {
        await clearInstanceFilters();
    });

    document.getElementById("button-apply-graph-filters")?.addEventListener("click", () => {
        applyGraphFilters();
    });

    document.getElementById("button-clear-graph-filters")?.addEventListener("click", () => {
        clearGraphFilters();
    });

    [
        "instance-application-search",
        "instance-min-events",
        "instance-min-offers",
    ].forEach((inputId) => {
        document.getElementById(inputId)?.addEventListener("keydown", async (event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            await applyInstanceFilters();
        });
    });

    [
        "graph-filter-activity-prefix",
        "graph-filter-activity",
        "graph-filter-time-start",
        "graph-filter-time-end",
    ].forEach((inputId) => {
        const input = document.getElementById(inputId);
        input?.addEventListener("keydown", (event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            applyGraphFilters();
        });
        if (inputId === "graph-filter-activity-prefix") {
            input?.addEventListener("change", () => {
                applyGraphFilters();
            });
        }
    });
}


draw();
setupUiHandlers();


const exportButton = document.getElementById('button-export');
exportButton.addEventListener('click', () => {
    exportData();
});


document.getElementById('upload-form').addEventListener('submit', async function (e) {
    e.preventDefault();

    const fileInput = document.getElementById('file-input');
    if (!fileInput.files.length) return;

    const formData = new FormData();
    formData.append('file', fileInput.files[0]);

    const response = await fetch('/api/upload_data', {
        method: 'POST',
        body: formData
    });

    const uploadedData = await response.json();
    draw(uploadedData);
});


const resetButton = document.getElementById('button-reset');
resetButton.addEventListener('click', () => {
    draw(null);
});
