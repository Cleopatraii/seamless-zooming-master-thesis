/*
SEAMLESS_ZOOM — A technique for seamless zooming between process models and process instances.
*/

import { exportData } from './utils/exportData.mjs';
import { TIMEORDERMAP, resetPersistedXZoom } from './views/timeOrderMap.js';
import { SPACEORDERMAP } from './views/spaceOrderMap.js';
import { bindAggregateEdgePopupInteractions, hideAggregateEdgePopup } from './components/aggregateEdgePopup.mjs';
import { createMultiEntityState } from './utils/multiEntityState.mjs';
import {
    buildAggregateComparisonPayload,
    buildAggregateGroupPayload,
    buildAggregateGroupComparisonPayload,
    buildSelectedInstanceOverlay,
    buildSelectedInstanceOverlayPayload,
    createAggregateGroupFromOverlay,
    summarizeAggregateInstances,
} from './utils/multiEntityAggregation.mjs';
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
let currentAnalysisMode = "instance";
let abstractionPerspective = "Application";
let availableMultiEntityInstances = [];
let knownMultiEntityInstancesById = new Map();
let selectedMultiEntityInstanceId = null;
let selectedAggregateInstanceIds = new Set();
let currentSelectedInstanceOverlay = null;
let currentAggregateDraft = null;
let aggregateGroups = [];
let activeAggregateGroupId = null;
const MAX_AGGREGATE_GROUPS = 3;
const ABSTRACTION_PERSPECTIVES = ["Application", "Offer", "Workflow"];
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


function getBrowserEntityType() {
    return currentAnalysisMode === "abstraction" ? abstractionPerspective : "Application";
}


function getEntityTypeLabel(entityType = getBrowserEntityType()) {
    return entityType === "Application" ? "Application case" : `${entityType} instance`;
}


function getEntityTypePluralLabel(entityType = getBrowserEntityType()) {
    return entityType === "Application" ? "Application cases" : `${entityType} instances`;
}


function getRelatedCountLabel(entityType = getBrowserEntityType()) {
    return entityType === "Application" ? "Offers" : "Related cases";
}


function getInstanceDisplayLabel(instance, fallbackEntityType = getBrowserEntityType()) {
    const entityType = instance?.entityType ?? fallbackEntityType;
    const id = instance?.id ?? "";
    if (entityType === "Workflow") {
        return id.replace(/^Application_/, "Workflow_");
    }
    return id;
}


function describeInstance(instance) {
    if (!instance) return "No instance selected";
    const metrics = [];
    if (instance.entityType && instance.entityType !== "Application") metrics.push(instance.entityType);
    if (instance.eventCount != null) metrics.push(`${instance.eventCount} events`);
    if (instance.dfEdgeCount != null) metrics.push(`${instance.dfEdgeCount} DF edges`);
    if (instance.entityType === "Application" && instance.offerCount != null) {
        metrics.push(`${instance.offerCount} offers`);
    } else if (instance.relatedCaseCount != null) {
        metrics.push(`${instance.relatedCaseCount} related cases`);
    }
    if (instance.durationDays != null) metrics.push(`${formatDuration(instance.durationDays)} duration`);
    if (instance.description) metrics.push(instance.description);
    return `${getInstanceDisplayLabel(instance)}${metrics.length > 0 ? " · " + metrics.join(" · ") : ""}`;
}


function getKnownInstance(instanceId) {
    return knownMultiEntityInstancesById.get(instanceId) ?? {
        id: instanceId,
        label: instanceId,
        entityType: getBrowserEntityType(),
    };
}


function getSelectedAggregateInstances() {
    return Array.from(selectedAggregateInstanceIds, getKnownInstance);
}


function getActiveAggregateGroup() {
    return aggregateGroups.find((group) => group.id === activeAggregateGroupId) ?? null;
}


function getAggregateGroupById(groupId) {
    return aggregateGroups.find((group) => group.id === groupId) ?? null;
}


function getAggregateGroupNumber(group) {
    const groupNumber = Number.parseInt(String(group?.id ?? "").replace("group-", ""), 10);
    return Number.isFinite(groupNumber) ? groupNumber : null;
}


function getNextAggregateGroupNumber() {
    const usedNumbers = new Set(aggregateGroups.map(getAggregateGroupNumber).filter(Boolean));
    for (let groupNumber = 1; groupNumber <= MAX_AGGREGATE_GROUPS; groupNumber += 1) {
        if (!usedNumbers.has(groupNumber)) return groupNumber;
    }
    return null;
}


function getAggregateGroupForInstance(instanceId) {
    return aggregateGroups.find((group) => group.instanceIds.includes(instanceId)) ?? null;
}


function getSelectedInstancesOutsideActiveGroup() {
    const activeGroup = getActiveAggregateGroup();
    const activeGroupIds = new Set(activeGroup?.instanceIds ?? []);
    return getSelectedAggregateInstances().filter((instance) => (
        !activeGroupIds.has(instance.id) && !getAggregateGroupForInstance(instance.id)
    ));
}

function haveSameInstanceIds(leftIds = [], rightIds = []) {
    if (leftIds.length !== rightIds.length) return false;
    const rightIdSet = new Set(rightIds);
    return leftIds.every((instanceId) => rightIdSet.has(instanceId));
}


function clearAbstractionState() {
    selectedAggregateInstanceIds.clear();
    currentSelectedInstanceOverlay = null;
    currentAggregateDraft = null;
    aggregateGroups = [];
    activeAggregateGroupId = null;
}


async function setAbstractionPerspective(perspective) {
    if (!ABSTRACTION_PERSPECTIVES.includes(perspective) || perspective === abstractionPerspective) return;

    abstractionPerspective = perspective;
    clearAbstractionState();
    knownMultiEntityInstancesById = new Map();
    availableMultiEntityInstances = [];
    instanceOverviewState = {
        ...instanceOverviewState,
        page: 1,
        total: 0,
        applicationSearch: "",
        minEvents: "",
        minOffers: "",
        onlyCancelled: false,
        warning: null,
    };

    currentMultiEntityController = null;
    currentRenderedData = null;
    updatePerspectiveControlFromState();
    await loadAvailableMultiEntityInstances();
    renderAbstractionEmptyState();
    renderInstanceBrowser();
}


function describeAggregateSummary(summary = {}) {
    const parts = [`${summary.caseCount ?? 0} ${getEntityTypePluralLabel()}`];
    if (summary.totalEvents != null) parts.push(`${summary.totalEvents} events`);
    if (summary.totalDfEdges != null) parts.push(`${summary.totalDfEdges} DF edges`);
    if (summary.totalOffers != null) parts.push(`${summary.totalOffers} ${getRelatedCountLabel().toLowerCase()}`);
    if (summary.cancelledCount != null) parts.push(`${summary.cancelledCount} cancelled`);
    if (summary.averageDuration != null) parts.push(`${formatDuration(summary.averageDuration)} avg duration`);
    return parts.join(" · ");
}


function describeSelectedInstanceOverlay(overlay) {
    if (!overlay) return "";
    return `Overlay ready: ${overlay.instanceIds.length}`;
}


function renderSelectedInstanceOverlayDetails(overlay) {
    const status = document.getElementById("multi-entity-status");
    const details = document.getElementById("multi-entity-details");
    const selectedList = document.getElementById("multi-entity-selected");
    const summary = document.getElementById("current-instance-summary");

    if (status) {
        status.textContent = `Scope: selected instance overlay · ${describeAggregateSummary(overlay.summary)}`;
    }
    if (summary) {
        summary.textContent = `Overlay: ${describeAggregateSummary(overlay.summary)}`;
    }
    if (selectedList) {
        selectedList.innerHTML = overlay.instanceIds
            .map((instanceId) => `<div class="entity-pill"><span>${instanceId}</span></div>`)
            .join("");
    }
    if (details) {
        details.innerHTML = `
            <div class="detail-card">
                <div class="detail-title">Selected instance overlay</div>
                <div class="detail-meta">${describeAggregateSummary(overlay.summary)}</div>
                <div class="detail-section-title">Included ${getEntityTypePluralLabel()}</div>
                ${overlay.instanceIds.map((instanceId) => `
                    <div class="membership-row membership-row-muted">
                        <div class="membership-id">${instanceId}</div>
                    </div>
                `).join("")}
                <p class="multi-entity-muted">
                    This first overlay view is for visual comparison before aggregation; event-level expand actions remain available in the single-instance view.
                </p>
            </div>
        `;
    }
}


function renderAggregateGroupsList() {
    const selectedList = document.getElementById("multi-entity-selected");
    if (!selectedList) return;
    if (aggregateGroups.length === 0) {
        selectedList.innerHTML = '<p class="multi-entity-muted">No aggregate groups created yet.</p>';
        return;
    }

    const activeGroup = getActiveAggregateGroup();
    selectedList.innerHTML = aggregateGroups.map((group) => {
        const isActive = group.id === activeAggregateGroupId;
        const canCompareWithActive = Boolean(activeGroup) && !isActive;
        return `
        <div class="aggregate-group-card ${isActive ? "active" : ""}">
            <div>
                <div class="aggregate-group-title-row">
                    <span class="aggregate-comparison-swatch" style="background:${group.color}"></span>
                    <strong>${group.name}</strong>
                </div>
                <div class="membership-id">${describeAggregateSummary(group.summary)}</div>
            </div>
            <div class="aggregate-group-actions">
                <button type="button" class="aggregate-group-show" data-group-id="${group.id}">
                    Show aggregate
                </button>
                ${canCompareWithActive ? `
                    <button type="button" class="aggregate-group-compare" data-group-id="${group.id}">
                        Compare with active
                    </button>
                    <button type="button" class="aggregate-group-merge" data-group-id="${group.id}">
                        Merge into active
                    </button>
                ` : ""}
                <button type="button" class="aggregate-group-dissolve" data-group-id="${group.id}">
                    Dissolve group
                </button>
            </div>
        </div>
    `}).join("");

    selectedList.querySelectorAll(".aggregate-group-show").forEach((button) => {
        button.addEventListener("click", () => {
            const group = getAggregateGroupById(button.dataset.groupId);
            if (!group) return;
            showAggregateGroup(group);
        });
    });

    selectedList.querySelectorAll(".aggregate-group-compare").forEach((button) => {
        button.addEventListener("click", () => {
            const group = getAggregateGroupById(button.dataset.groupId);
            const active = getActiveAggregateGroup();
            if (!group || !active || group.id === active.id) return;
            showAggregateGroupComparison(group, active);
        });
    });

    selectedList.querySelectorAll(".aggregate-group-merge").forEach((button) => {
        button.addEventListener("click", () => {
            mergeGroupIntoActiveGroup(button.dataset.groupId).catch((err) => {
                console.error("Failed to merge aggregate group:", err);
                showMultiEntityError(String(err?.message ?? err));
            });
        });
    });

    selectedList.querySelectorAll(".aggregate-group-dissolve").forEach((button) => {
        button.addEventListener("click", () => {
            dissolveAggregateGroup(button.dataset.groupId);
        });
    });
}


function renderAggregateGroupDetails(group) {
    const status = document.getElementById("multi-entity-status");
    const details = document.getElementById("multi-entity-details");
    const summary = document.getElementById("current-instance-summary");

    if (status) {
        status.textContent = `Scope: aggregate group · ${group.name} · ${describeAggregateSummary(group.summary)}`;
    }
    if (summary) {
        summary.textContent = `${group.name}: ${describeAggregateSummary(group.summary)}`;
    }
    renderAggregateGroupsList();
    if (details) {
        details.innerHTML = `
            <div class="detail-card">
                <div class="detail-title">${group.name}</div>
                <div class="detail-meta">${describeAggregateSummary(group.summary)}</div>
                <div class="detail-section-title">Aggregation semantics</div>
                <p class="multi-entity-muted">
                    Nodes summarize activities across the selected ${getEntityTypePluralLabel()}. Edges summarize ${abstractionPerspective} directly-follows transitions; thicker edges occur in more selected instances.
                </p>
                <div class="detail-section-title">Included ${getEntityTypePluralLabel()}</div>
                ${group.instanceIds.map((instanceId) => `
                    <div class="membership-row membership-row-muted">
                        <div class="membership-id">${instanceId}</div>
                    </div>
                `).join("")}
            </div>
        `;
    }
}


function renderAggregateComparisonDetails(group, candidateInstances) {
    const status = document.getElementById("multi-entity-status");
    const details = document.getElementById("multi-entity-details");
    const selectedList = document.getElementById("multi-entity-selected");
    const summary = document.getElementById("current-instance-summary");
    const candidateSummary = summarizeAggregateInstances(candidateInstances);

    if (status) {
        status.textContent = `Scope: aggregate comparison · ${group.name} vs ${candidateInstances.length} selected ${getEntityTypePluralLabel()}`;
    }
    if (summary) {
        summary.textContent = `${group.name} compared with selected ${getEntityTypePluralLabel()}`;
    }
    if (selectedList) {
        selectedList.innerHTML = `
            <div class="aggregate-group-card active">
                <div class="aggregate-group-title-row">
                    <span class="aggregate-comparison-swatch" style="background:${group.color}"></span>
                    <strong>${group.name}</strong>
                </div>
                <div class="membership-id">${describeAggregateSummary(group.summary)}</div>
            </div>
            <div class="aggregate-group-card aggregate-candidate-card">
                <strong>Selected candidate ${getEntityTypePluralLabel()}</strong>
                <div class="membership-id">${describeAggregateSummary(candidateSummary)}</div>
            </div>
        `;
    }
    if (details) {
        details.innerHTML = `
            <div class="detail-card">
                <div class="detail-title">Aggregate comparison</div>
                <div class="detail-meta">${group.name} is shown together with the selected candidate ${getEntityTypePluralLabel()}.</div>
                <div class="detail-section-title">Current aggregate group</div>
                <div class="membership-row membership-row-muted">
                    <div class="membership-id">${describeAggregateSummary(group.summary)}</div>
                </div>
                <div class="detail-section-title">Candidate ${getEntityTypePluralLabel()}</div>
                ${candidateInstances.map((instance) => `
                    <div class="membership-row membership-row-muted">
                        <div class="membership-id">${instance.id}</div>
                    </div>
                `).join("")}
                <p class="multi-entity-muted">
                    If the candidate behavior looks compatible with the aggregate pattern, use "Add selected to active group".
                </p>
                <button type="button" id="button-show-comparison-full-range" class="detail-action-button">
                    Show full range
                </button>
                <button type="button" id="button-restore-comparison-range" class="detail-action-button detail-action-button-secondary">
                    Restore comparison range
                </button>
            </div>
        `;
        details.querySelector("#button-show-comparison-full-range")?.addEventListener("click", () => {
            showAggregateComparisonFullRange();
        });
        details.querySelector("#button-restore-comparison-range")?.addEventListener("click", () => {
            restoreAggregateComparisonRange();
        });
    }
}


function renderAggregateGroupComparisonDetails(groupA, groupB) {
    const status = document.getElementById("multi-entity-status");
    const details = document.getElementById("multi-entity-details");
    const summary = document.getElementById("current-instance-summary");

    if (status) {
        status.textContent = `Scope: group comparison · ${groupA.name} vs ${groupB.name}`;
    }
    if (summary) {
        summary.textContent = `${groupA.name} compared with ${groupB.name}`;
    }
    renderAggregateGroupsList();
    if (details) {
        details.innerHTML = `
            <div class="detail-card">
                <div class="detail-title">Aggregate group comparison</div>
                <div class="detail-meta">
                    Two user-defined aggregate groups are shown in the same Time-Order Map layout.
                </div>
                <div class="detail-section-title">Compared groups</div>
                <div class="aggregate-comparison-legend-row">
                    <span class="aggregate-comparison-swatch" style="background:${groupA.color}"></span>
                    <div>
                        <strong>${groupA.name}</strong>
                        <div class="membership-id">${describeAggregateSummary(groupA.summary)}</div>
                    </div>
                </div>
                <div class="aggregate-comparison-legend-row">
                    <span class="aggregate-comparison-swatch" style="background:${groupB.color}"></span>
                    <div>
                        <strong>${groupB.name}</strong>
                        <div class="membership-id">${describeAggregateSummary(groupB.summary)}</div>
                    </div>
                </div>
                <p class="multi-entity-muted">
                    Click an aggregated edge to inspect its frequency, duration, and involved instances for the group it belongs to.
                </p>
                <button type="button" id="button-show-comparison-full-range" class="detail-action-button">
                    Show full range
                </button>
                <button type="button" id="button-restore-comparison-range" class="detail-action-button detail-action-button-secondary">
                    Restore comparison range
                </button>
            </div>
        `;
        details.querySelector("#button-show-comparison-full-range")?.addEventListener("click", () => {
            showAggregateComparisonFullRange();
        });
        details.querySelector("#button-restore-comparison-range")?.addEventListener("click", () => {
            restoreAggregateComparisonRange();
        });
    }
}


function isAggregateComparisonMode(mode) {
    return mode === "aggregate-comparison" || mode === "aggregate-group-comparison";
}


function renderCurrentAggregateComparisonDetails() {
    const mode = currentRenderedData?.meta?.mode;
    if (mode === "aggregate-comparison") {
        const activeGroup = getActiveAggregateGroup();
        const candidateInstances = (currentSelectedInstanceOverlay?.instanceIds ?? []).map(getKnownInstance);
        if (activeGroup) renderAggregateComparisonDetails(activeGroup, candidateInstances);
        return;
    }

    if (mode === "aggregate-group-comparison") {
        const groupA = aggregateGroups.find((group) => group.id === currentRenderedData?.meta?.aggregateGroupId);
        const groupB = aggregateGroups.find((group) => group.id === currentRenderedData?.meta?.comparisonGroupId);
        if (groupA && groupB) renderAggregateGroupComparisonDetails(groupA, groupB);
    }
}


function showAggregateComparisonFullRange() {
    const fullRange = currentRenderedData?.meta?.comparisonFullXDomainDays;
    if (
        !isAggregateComparisonMode(currentRenderedData?.meta?.mode) ||
        !Array.isArray(fullRange) ||
        fullRange.length !== 2
    ) {
        return;
    }

    const xDomainDays = fullRange.map(Number);
    if (!xDomainDays.every(Number.isFinite)) return;
    currentRenderedData.meta.comparisonFocusedXDomainDays = currentRenderedData.meta.comparisonFocusedXDomainDays
        ?? currentRenderedData.meta.xDomainDays?.slice();
    currentRenderedData.meta.isShowingComparisonFullRange = true;
    currentRenderedData.meta.xDomainDays = xDomainDays;
    resetPersistedXZoom();
    renderCurrentGraph();
    renderCurrentAggregateComparisonDetails();
}


function restoreAggregateComparisonRange() {
    const focusedRange = currentRenderedData?.meta?.comparisonFocusedXDomainDays;
    if (
        !isAggregateComparisonMode(currentRenderedData?.meta?.mode) ||
        !Array.isArray(focusedRange) ||
        focusedRange.length !== 2
    ) {
        return;
    }

    const xDomainDays = focusedRange.map(Number);
    if (!xDomainDays.every(Number.isFinite)) return;
    currentRenderedData.meta.xDomainDays = xDomainDays;
    currentRenderedData.meta.isShowingComparisonFullRange = false;
    resetPersistedXZoom();
    renderCurrentGraph();
    renderCurrentAggregateComparisonDetails();
}


function renderAggregateSelectionControls() {
    const status = document.getElementById("instance-aggregate-status");
    const showButton = document.getElementById("button-show-selected-instances");
    const aggregateButton = document.getElementById("button-aggregate-selected-instances");
    const addToActiveButton = document.getElementById("button-add-selected-to-active-group");
    const clearButton = document.getElementById("button-clear-aggregate-selection");
    const selectedInstances = getSelectedAggregateInstances();
    const selectedSummary = summarizeAggregateInstances(selectedInstances);
    const activeGroup = getActiveAggregateGroup();
    const candidatesOutsideActiveGroup = getSelectedInstancesOutsideActiveGroup();
    const hasReachedGroupLimit = getNextAggregateGroupNumber() == null;

    if (status) {
        const selectionText = selectedInstances.length === 0
            ? `Select ${getEntityTypePluralLabel()}, show them together, then decide whether to aggregate.`
            : `Selected: ${describeAggregateSummary(selectedSummary)}`;
        const overlayText = currentSelectedInstanceOverlay
            ? ` ${describeSelectedInstanceOverlay(currentSelectedInstanceOverlay)}`
            : "";
        const draftText = currentAggregateDraft
            ? ` Current aggregate draft: ${describeAggregateSummary(currentAggregateDraft)}`
            : "";
        const activeGroupText = activeGroup
            ? ` Active group: ${activeGroup.name}.`
            : "";
        const groupLimitText = hasReachedGroupLimit
            ? ` Prototype limit: up to ${MAX_AGGREGATE_GROUPS} aggregate groups.`
            : "";
        status.textContent = `${selectionText}${overlayText}${draftText}${activeGroupText}${groupLimitText}`;
    }
    if (showButton) {
        showButton.disabled = selectedInstances.length === 0;
    }
    if (aggregateButton) {
        const selectedInstancesOutsideGroups = selectedInstances.filter((instance) => (
            !getAggregateGroupForInstance(instance.id)
        ));
        aggregateButton.disabled = hasReachedGroupLimit
            || selectedInstancesOutsideGroups.length < 2;
    }
    if (addToActiveButton) {
        addToActiveButton.disabled = !activeGroup || candidatesOutsideActiveGroup.length === 0;
    }
    if (clearButton) {
        clearButton.disabled = selectedInstances.length === 0
            && !currentSelectedInstanceOverlay
            && !currentAggregateDraft;
    }
}


function rebuildAggregateGroup(group) {
    group.summary = summarizeAggregateInstances(group.instanceIds.map(getKnownInstance));
    group.aggregatePayload = buildAggregateGroupPayload(group);
    currentAggregateDraft = group.summary;
}


async function mergeGroupIntoActiveGroup(sourceGroupId) {
    if (currentAnalysisMode !== "abstraction") return;
    const activeGroup = getActiveAggregateGroup();
    const sourceGroup = getAggregateGroupById(sourceGroupId);
    if (!activeGroup || !sourceGroup || activeGroup.id === sourceGroup.id) return;
    if ((activeGroup.perspective ?? "Application") !== (sourceGroup.perspective ?? "Application")) return;

    const mergedInstanceIds = Array.from(new Set([
        ...activeGroup.instanceIds,
        ...sourceGroup.instanceIds,
    ]));
    const payloadByInstanceId = new Map();
    [...activeGroup.instancePayloads, ...sourceGroup.instancePayloads].forEach((entry) => {
        const instanceId = entry?.instance?.id;
        if (instanceId && !payloadByInstanceId.has(instanceId)) {
            payloadByInstanceId.set(instanceId, entry);
        }
    });

    const missingPayloads = await Promise.all(
        mergedInstanceIds
            .filter((instanceId) => !payloadByInstanceId.has(instanceId))
            .map((instanceId) => loadLocalInstancePayload(getKnownInstance(instanceId)))
    );
    missingPayloads.forEach((entry) => {
        payloadByInstanceId.set(entry.instance.id, entry);
    });

    activeGroup.instanceIds = mergedInstanceIds;
    activeGroup.instancePayloads = mergedInstanceIds
        .map((instanceId) => payloadByInstanceId.get(instanceId))
        .filter(Boolean);
    rebuildAggregateGroup(activeGroup);
    removeGroupFromList(sourceGroup.id);
    currentSelectedInstanceOverlay = null;
    activeAggregateGroupId = activeGroup.id;
    showAggregateGroup(activeGroup);
}


function dissolveAggregateGroup(groupId) {
    if (currentAnalysisMode !== "abstraction") return;
    const group = getAggregateGroupById(groupId);
    if (!group) return;

    const wasActive = group.id === activeAggregateGroupId;
    const wasShownInCurrentComparison = [
        currentRenderedData?.meta?.aggregateGroupId,
        currentRenderedData?.meta?.comparisonGroupId,
    ].includes(group.id);
    removeGroupFromList(group.id);
    currentSelectedInstanceOverlay = null;
    currentAggregateDraft = null;

    if (wasActive || wasShownInCurrentComparison) {
        activeAggregateGroupId = aggregateGroups[0]?.id ?? null;
        const nextActiveGroup = getActiveAggregateGroup();
        if (nextActiveGroup) {
            showAggregateGroup(nextActiveGroup);
            return;
        }
        currentRenderedData = null;
        d3.select("#chart").selectAll("*").remove();
        const status = document.getElementById("multi-entity-status");
        const summary = document.getElementById("current-instance-summary");
        const details = document.getElementById("multi-entity-details");
        if (status) {
            status.textContent = "Scope: abstraction · no aggregate group selected";
        }
        if (summary) {
            summary.textContent = "No aggregate group selected";
        }
        if (details) {
            details.innerHTML = `
                <div class="detail-card">
                    <div class="detail-title">No aggregate group</div>
                    <div class="detail-meta">
                        Select ${getEntityTypePluralLabel()}, show them together, then aggregate them into a new group.
                    </div>
                </div>
            `;
        }
        renderAggregateGroupsList();
        renderAggregateSelectionControls();
        renderInstanceBrowser();
        return;
    }

    renderAggregateGroupsList();
    renderAggregateSelectionControls();
    renderInstanceBrowser();
}


function removeGroupFromList(groupId) {
    aggregateGroups = aggregateGroups.filter((group) => group.id !== groupId);
    selectedAggregateInstanceIds = new Set(
        Array.from(selectedAggregateInstanceIds).filter((instanceId) => (
            !getAggregateGroupForInstance(instanceId)
        ))
    );
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


function renderAbstractionEmptyState() {
    currentMultiEntityController = null;
    currentRenderedData = null;
    d3.select("#chart").selectAll("*").remove();
    setMultiEntityPanelVisibility(true);
    renderMultiEntityLegend();
    renderAggregateGroupsList();
    renderAggregateSelectionControls();

    const status = document.getElementById("multi-entity-status");
    const summary = document.getElementById("current-instance-summary");
    const details = document.getElementById("multi-entity-details");

    if (status) {
        status.textContent = `Scope: abstraction · ${abstractionPerspective} perspective · no selected ${getEntityTypePluralLabel()}`;
    }
    if (summary) {
        summary.textContent = `${abstractionPerspective} abstraction · select ${getEntityTypePluralLabel()} to compare or aggregate.`;
    }
    if (details) {
        details.innerHTML = `
            <div class="detail-card">
                <div class="detail-title">${abstractionPerspective} abstraction</div>
                <div class="detail-meta">
                    Select ${getEntityTypePluralLabel()} in the browser, then use "Show selected instances" or "Aggregate selected".
                </div>
                <p class="multi-entity-muted">
                    Workflow IDs may look like Application IDs in BPIC17 because the Workflow entity reuses the Application identifier in the source graph.
                </p>
            </div>
        `;
    }
}


function updateAnalysisModeButtons() {
    document.getElementById("button-mode-instance")
        ?.classList.toggle("active", currentAnalysisMode === "instance");
    document.getElementById("button-mode-abstraction")
        ?.classList.toggle("active", currentAnalysisMode === "abstraction");
    document.body.classList.toggle("analysis-mode-instance", currentAnalysisMode === "instance");
    document.body.classList.toggle("analysis-mode-abstraction", currentAnalysisMode === "abstraction");
    const scopeControls = document.getElementById("multi-entity-scope-controls");
    if (scopeControls) {
        scopeControls.style.display = currentAnalysisMode === "instance" ? "" : "none";
    }
}


function setAnalysisMode(mode) {
    currentAnalysisMode = mode;
    updateAnalysisModeButtons();
    updatePerspectiveControlFromState();
}


async function enterInstanceMode() {
    setAnalysisMode("instance");
    setInstanceBrowserOpen(false);
    if (!currentMultiEntityController && selectedMultiEntityInstanceId) {
        await switchMultiEntityInstance(selectedMultiEntityInstanceId);
        return;
    }
    renderCurrentInstanceNavigator();
}


function restoreSelectedInstanceOverlay() {
    if (!currentSelectedInstanceOverlay?.payload) return false;

    const activeGroup = getActiveAggregateGroup();
    const candidateInstances = currentSelectedInstanceOverlay.instanceIds.map(getKnownInstance);
    currentMultiEntityController = null;
    currentRenderedData = currentSelectedInstanceOverlay.payload;
    setMultiEntityPanelVisibility(true);
    renderMultiEntityLegend();
    renderCurrentGraph();

    if (activeGroup) {
        renderAggregateComparisonDetails(activeGroup, candidateInstances);
    } else {
        renderSelectedInstanceOverlayDetails(currentSelectedInstanceOverlay);
    }
    renderAggregateSelectionControls();
    return true;
}


async function enterAbstractionMode() {
    setAnalysisMode("abstraction");
    await loadAvailableMultiEntityInstances();
    setInstanceBrowserOpen(true);

    if (restoreSelectedInstanceOverlay()) return;

    const activeGroup = getActiveAggregateGroup();
    if (activeGroup) {
        showAggregateGroup(activeGroup);
        return;
    }

    renderAggregateGroupsList();
    renderAggregateSelectionControls();
    renderAbstractionEmptyState();
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


function getPerspectiveEntityOptions() {
    if (!currentMultiEntityController) return [];

    const { state } = currentMultiEntityController;
    const entries = Array.from(state.expandedData.entityIndex.values());
    const optionMap = new Map();
    const addOption = ({ perspective, entityType, entityId, entityKey }) => {
        if (!entityType || !entityId || !entityKey || optionMap.has(entityKey)) return;
        optionMap.set(entityKey, {
            perspective: perspective ?? entityType,
            entityType,
            entityId,
            entityKey,
        });
    };

    addOption({
        perspective: "Application",
        entityType: state.anchor?.entityType ?? "Application",
        entityId: state.anchor?.entityId,
        entityKey: `${state.anchor?.entityType ?? "Application"}::${state.anchor?.entityId}`,
    });

    entries
        .filter((entry) => ["Offer", "Workflow"].includes(entry.entityType))
        .sort((entryA, entryB) => {
            const typeDelta = entryA.entityType.localeCompare(entryB.entityType);
            return typeDelta !== 0 ? typeDelta : entryA.entityId.localeCompare(entryB.entityId);
        })
        .forEach((entry) => {
            addOption({
                perspective: entry.entityType,
                entityType: entry.entityType,
                entityId: entry.entityId,
                entityKey: entry.entityKey,
            });
        });

    return Array.from(optionMap.values());
}


function formatPerspectiveOption(option) {
    if (!option) return "";
    if (option.entityType === "Application") {
        return `Application perspective: ${option.entityId}`;
    }
    return `${option.entityType} perspective: ${option.entityId}`;
}


function updatePerspectiveControlFromState() {
    const select = document.getElementById("multi-entity-perspective-select");
    const label = document.getElementById("multi-entity-perspective-label");
    const description = document.getElementById("multi-entity-perspective-description");
    if (!select) return;

    if (currentAnalysisMode === "abstraction") {
        if (label) label.textContent = "Abstraction-level perspective";
        if (description) {
            description.textContent = `Aggregate selected ${getEntityTypePluralLabel()} by ${abstractionPerspective} lifecycle relations.`;
        }
        select.innerHTML = ABSTRACTION_PERSPECTIVES.map((perspective) => `
            <option value="${perspective}" ${perspective === abstractionPerspective ? "selected" : ""}>
                ${perspective} lifecycle aggregation
            </option>
        `).join("");
        select.disabled = false;
        return;
    }

    if (label) label.textContent = "Instance-level perspective";
    if (description) {
        description.textContent = "Anchor stays fixed; Local shows the selected lifecycle.";
    }
    if (!currentMultiEntityController) {
        select.innerHTML = "";
        select.disabled = true;
        return;
    }

    const options = getPerspectiveEntityOptions();
    const activeEntityKey = currentMultiEntityController.state.perspective?.entityKey ?? "";
    select.innerHTML = options.map((option) => `
        <option value="${option.entityKey}" ${option.entityKey === activeEntityKey ? "selected" : ""}>
            ${formatPerspectiveOption(option)}
        </option>
    `).join("");
    select.disabled = options.length <= 1;
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
    if (!summary) return;
    if (currentAnalysisMode === "abstraction") {
        summary.textContent = `${abstractionPerspective} abstraction · select ${getEntityTypePluralLabel()} to compare or aggregate.`;
        return;
    }
    summary.textContent = describeInstance(getSelectedInstanceSummary());
}


function updateAggregateSelectionFromCheckbox(checkbox) {
    const instanceId = checkbox?.dataset?.instanceId;
    if (!instanceId || checkbox.disabled) return;
    if (checkbox.checked) {
        selectedAggregateInstanceIds.add(instanceId);
    } else {
        selectedAggregateInstanceIds.delete(instanceId);
    }
    currentSelectedInstanceOverlay = null;
    currentAggregateDraft = null;
    renderAggregateSelectionControls();
}


function renderInstanceBrowser() {
    renderCurrentInstanceNavigator();

    const table = document.getElementById("instance-browser-table");
    const browserTitle = document.getElementById("instance-browser-title");
    const browserDescription = document.getElementById("instance-browser-description");
    const status = document.getElementById("instance-browser-status");
    const pageStatus = document.getElementById("instance-page-status");
    const aggregateControls = document.getElementById("instance-aggregate-controls");
    const sortSelect = document.getElementById("instance-sort-select");
    const orderSelect = document.getElementById("instance-order-select");
    const applicationSearchInput = document.getElementById("instance-application-search");
    const idFilterLabel = document.getElementById("instance-id-filter-label");
    const minEventsInput = document.getElementById("instance-min-events");
    const minOffersInput = document.getElementById("instance-min-offers");
    const relatedCountFilterLabel = document.getElementById("instance-related-count-filter-label");
    const onlyCancelledInput = document.getElementById("instance-only-cancelled");
    const isAbstractionMode = currentAnalysisMode === "abstraction";
    const browserEntityType = getBrowserEntityType();
    const relatedCountLabel = getRelatedCountLabel(browserEntityType);

    if (browserTitle) {
        browserTitle.textContent = isAbstractionMode
            ? `${browserEntityType} Instance Overview`
            : "Application Instance Overview";
    }
    if (browserDescription) {
        browserDescription.textContent = isAbstractionMode
            ? `Browse ${getEntityTypePluralLabel(browserEntityType)} for ${browserEntityType} abstraction and grouping.`
            : "Browse application-centered process instances before loading one into the Time-Order Map.";
    }

    if (aggregateControls) {
        aggregateControls.style.display = isAbstractionMode ? "" : "none";
    }
    if (isAbstractionMode) {
        renderAggregateSelectionControls();
    }

    if (sortSelect) {
        const relatedCountOption = sortSelect.querySelector('option[value="offer_count"]');
        if (relatedCountOption) relatedCountOption.textContent = `${relatedCountLabel} count`;
        sortSelect.value = instanceOverviewState.sort;
    }
    if (orderSelect) orderSelect.value = instanceOverviewState.order;
    if (idFilterLabel) idFilterLabel.textContent = `${browserEntityType} ID contains`;
    if (applicationSearchInput) {
        applicationSearchInput.placeholder = browserEntityType === "Application" ? "Application_..." : `${browserEntityType}_...`;
    }
    if (relatedCountFilterLabel) relatedCountFilterLabel.textContent = `Min ${relatedCountLabel.toLowerCase()}`;
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
        //去掉null，false，和undefined
        const activeFilters = [
            instanceOverviewState.applicationSearch ? `ID contains "${instanceOverviewState.applicationSearch}"` : null,
            instanceOverviewState.minEvents ? `min events ${instanceOverviewState.minEvents}` : null,
            instanceOverviewState.minOffers ? `min ${relatedCountLabel.toLowerCase()} ${instanceOverviewState.minOffers}` : null,
            instanceOverviewState.onlyCancelled ? "only cancelled" : null,
        ].filter(Boolean);
        const filterText = activeFilters.length > 0 ? ` · filters: ${activeFilters.join(", ")}` : "";
        status.textContent = `Showing ${start}-${end} of ${instanceOverviewState.total} ${getEntityTypePluralLabel(browserEntityType)}${filterText}${warning}`;
    }
    if (pageStatus) {
        //end = Math.min(20, 17) // 17
        const totalPages = Math.max(Math.ceil(instanceOverviewState.total / instanceOverviewState.pageSize), 1);
        pageStatus.textContent = `Page ${instanceOverviewState.page} / ${totalPages}`;
    }

    if (!table) return;
    if (availableMultiEntityInstances.length === 0) {
        table.innerHTML = `<div class="multi-entity-muted">No ${getEntityTypePluralLabel(browserEntityType)} available.</div>`;
        return;
    }

    const selectablePageInstances = availableMultiEntityInstances.filter((instance) => (
        !getAggregateGroupForInstance(instance.id)
    ));
    const selectedPageCount = selectablePageInstances.filter((instance) => (
        selectedAggregateInstanceIds.has(instance.id)
    )).length;
    const isCurrentPageFullySelected = selectablePageInstances.length > 0
        && selectedPageCount === selectablePageInstances.length;
    const isCurrentPagePartlySelected = selectedPageCount > 0
        && selectedPageCount < selectablePageInstances.length;

    table.innerHTML = `
        <table>
            <thead>
                <tr>
                    ${isAbstractionMode ? `
                        <th>
                            <label class="instance-page-select">
                                <input
                                    type="checkbox"
                                    id="instance-page-select-checkbox"
                                    ${isCurrentPageFullySelected ? "checked" : ""}
                                    ${selectablePageInstances.length === 0 ? "disabled" : ""}
                                    aria-label="Select all instances on this page"
                                >
                                <span>Select</span>
                            </label>
                        </th>
                    ` : ""}
                    <th>${getEntityTypeLabel(browserEntityType)}</th>
                    <th>Events</th>
                    <th>DF edges</th>
                    <th>${relatedCountLabel}</th>
                    <th>Duration</th>
                    <th>Cancelled</th>
                </tr>
            </thead>
            <tbody>
                ${availableMultiEntityInstances.map((instance) => {
                    const containingGroup = isAbstractionMode ? getAggregateGroupForInstance(instance.id) : null;
                    const isInAnyGroup = Boolean(containingGroup);
                    const isSelected = selectedAggregateInstanceIds.has(instance.id);
                    const isCurrentSingleInstance = !isAbstractionMode && instance.id === selectedMultiEntityInstanceId;
                    return `
                    <tr class="instance-browser-row ${isCurrentSingleInstance ? "active" : ""} ${isInAnyGroup ? "in-active-aggregate-group" : ""}"
                        data-instance-id="${instance.id}">
                        ${isAbstractionMode ? `
                        <td>
                            <input
                                type="checkbox"
                                class="instance-aggregate-checkbox"
                                data-instance-id="${instance.id}"
                                ${isSelected || isInAnyGroup ? "checked" : ""}
                                ${isInAnyGroup ? "disabled" : ""}
                                aria-label="${isInAnyGroup ? `${instance.id} is already in ${containingGroup.name}` : `Select ${instance.id} for aggregation`}"
                            >
                        </td>
                        ` : ""}
                        <td>
                            <span>${getInstanceDisplayLabel(instance, browserEntityType)}</span>
                            ${isAbstractionMode ? `<span class="instance-entity-type-badge">${instance.entityType ?? browserEntityType}</span>` : ""}
                            ${isAbstractionMode && isInAnyGroup ? `<span class="instance-active-group-badge">In ${containingGroup.name}</span>` : ""}
                        </td>
                        <td>${formatCount(instance.eventCount)}</td>
                        <td>${formatCount(instance.dfEdgeCount)}</td>
                        <td>${formatCount(instance.entityType === "Application" ? instance.offerCount : (instance.relatedCaseCount ?? instance.offerCount))}</td>
                        <td>${formatDuration(instance.durationDays)}</td>
                        <td>${instance.hasCancellation ? "yes" : "no"}</td>
                    </tr>
                `}).join("")}
            </tbody>
        </table>
    `;

    const pageSelectCheckbox = table.querySelector("#instance-page-select-checkbox");
    if (pageSelectCheckbox) {
        pageSelectCheckbox.indeterminate = isCurrentPagePartlySelected;
        pageSelectCheckbox.addEventListener("click", (event) => {
            event.stopPropagation();
        });
        pageSelectCheckbox.addEventListener("change", (event) => {
            const shouldSelect = event.target.checked;
            selectablePageInstances.forEach((instance) => {
                if (shouldSelect) {
                    selectedAggregateInstanceIds.add(instance.id);
                } else {
                    selectedAggregateInstanceIds.delete(instance.id);
                }
            });
            currentSelectedInstanceOverlay = null;
            currentAggregateDraft = null;
            renderAggregateSelectionControls();
            renderInstanceBrowser();
        });
    }

    table.querySelectorAll(".instance-browser-row").forEach((row) => {
        row.addEventListener("click", async () => {
            const instanceId = row.dataset.instanceId;
            if (!instanceId) return;
            if (currentAnalysisMode === "abstraction") {
                const checkbox = row.querySelector(".instance-aggregate-checkbox");
                if (!checkbox || checkbox.disabled) return;
                checkbox.checked = !checkbox.checked;
                updateAggregateSelectionFromCheckbox(checkbox);
                return;
            }
            await switchMultiEntityInstance(instanceId);
            setInstanceBrowserOpen(false);
        });
    });

    table.querySelectorAll(".instance-aggregate-checkbox").forEach((checkbox) => {
        checkbox.addEventListener("click", (event) => {
            event.stopPropagation();
        });
        checkbox.addEventListener("change", (event) => {
            updateAggregateSelectionFromCheckbox(event.target);
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
    const perspectiveDescription = state.perspective
        ? ` · perspective: ${state.perspective.perspective}`
        : "";
    status.textContent = `Scope: ${state.mode}${perspectiveDescription}${filterDescription ? ` · filters: ${filterDescription}` : ""}`;
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
        const isCurrentPerspectiveEntity = (
            membership.entityKey === currentMultiEntityController.state.perspective?.entityKey
        );
        const canToggleExpansion = (
            isRelationMembership &&
            !isAnchorApplication &&
            Boolean(entry?.canExpand) &&
            (isAnchorExpansionPoint || isDirectlyExpanded)
        );
        const buttonLabel = !isRelationMembership
            ? (isCurrentPerspectiveEntity ? "Current" : "Membership")
            : isDirectlyExpanded
            ? "Collapse"
            : (!canToggleExpansion && isRelationMembership && entry?.canExpand
                ? "Info only"
                : (isEffectivelyExpanded ? "Shown" : "Expand"));
        const buttonDisabled = canToggleExpansion && (isDirectlyExpanded || !isEffectivelyExpanded)
            ? ""
            : "disabled";

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
    hideAggregateEdgePopup();
    graphViewSwitcher(currentGraphViewSelection, currentRenderedData);
    if (["aggregate-group", "aggregate-comparison", "aggregate-group-comparison"].includes(currentRenderedData?.meta?.mode)) {
        const groupInstanceCount = currentRenderedData?.meta?.aggregateGroupInstanceCount
            ?? getActiveAggregateGroup()?.instanceIds.length;
        bindAggregateEdgePopupInteractions(currentRenderedData.graphData, groupInstanceCount);
    }
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
    const entityType = getBrowserEntityType();
    const query = new URLSearchParams({
        entity_type: entityType,
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
    const payloadEntityType = payload.entityType ?? entityType;
    if (currentAnalysisMode === "abstraction") {
        knownMultiEntityInstancesById = new Map();
    }
    availableMultiEntityInstances = (payload.instances ?? payload).map((instance) => ({
        ...instance,
        entityType: instance.entityType ?? payloadEntityType,
    }));
    availableMultiEntityInstances.forEach((instance) => {
        knownMultiEntityInstancesById.set(instance.id, instance);
    });
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


function showAggregateGroup(group) {
    abstractionPerspective = group.perspective ?? abstractionPerspective;
    if (!group.aggregatePayload) {
        group.aggregatePayload = buildAggregateGroupPayload(group);
    }
    resetPersistedXZoom();
    setAnalysisMode("abstraction");
    activeAggregateGroupId = group.id;
    currentMultiEntityController = null;
    currentRenderedData = group.aggregatePayload;
    setMultiEntityPanelVisibility(true);
    renderMultiEntityLegend();
    renderCurrentGraph();
    renderAggregateGroupDetails(group);
    renderAggregateSelectionControls();
    renderInstanceBrowser();
}


function showAggregateGroupComparison(groupA, groupB) {
    if (!groupA || !groupB || groupA.id === groupB.id) return;

    resetPersistedXZoom();
    setAnalysisMode("abstraction");
    currentMultiEntityController = null;
    currentSelectedInstanceOverlay = null;
    currentAggregateDraft = null;
    currentRenderedData = buildAggregateGroupComparisonPayload(groupA, groupB);
    setMultiEntityPanelVisibility(true);
    renderMultiEntityLegend();
    renderCurrentGraph();
    renderAggregateGroupComparisonDetails(groupA, groupB);
    renderAggregateSelectionControls();
    renderInstanceBrowser();
}


async function aggregateSelectedInstances() {
    if (currentAnalysisMode !== "abstraction") return;
    const groupNumber = getNextAggregateGroupNumber();
    if (groupNumber == null) {
        renderAggregateSelectionControls();
        return;
    }
    const selectedInstances = getSelectedAggregateInstances().filter((instance) => (
        !getAggregateGroupForInstance(instance.id)
    ));
    if (selectedInstances.length < 2) return;

    const selectedInstanceIds = selectedInstances.map((instance) => instance.id);
    let overlay = currentSelectedInstanceOverlay;
    if (
        !overlay
        || !haveSameInstanceIds(overlay.instanceIds ?? [], selectedInstanceIds)
        || !Array.isArray(overlay.instancePayloads)
    ) {
        const instancePayloads = await Promise.all(selectedInstances.map(loadLocalInstancePayload));
        overlay = buildSelectedInstanceOverlay(selectedInstances);
        overlay.instancePayloads = instancePayloads;
    }

    const group = createAggregateGroupFromOverlay(
        overlay,
        groupNumber,
        abstractionPerspective
    );
    aggregateGroups.push(group);
    activeAggregateGroupId = group.id;
    currentAggregateDraft = group.summary;
    currentSelectedInstanceOverlay = null;
    selectedAggregateInstanceIds.clear();
    showAggregateGroup(group);
    renderAggregateSelectionControls();
}


async function addSelectedInstancesToActiveGroup() {
    if (currentAnalysisMode !== "abstraction") return;
    const activeGroup = getActiveAggregateGroup();
    const candidates = getSelectedInstancesOutsideActiveGroup();
    if (!activeGroup || candidates.length === 0) return;
    if ((activeGroup.perspective ?? "Application") !== abstractionPerspective) return;

    const candidatePayloads = await Promise.all(candidates.map(loadLocalInstancePayload));
    candidates.forEach((instance) => {
        selectedAggregateInstanceIds.delete(instance.id);
    });
    activeGroup.instanceIds.push(...candidates.map((instance) => instance.id));
    activeGroup.instancePayloads.push(...candidatePayloads);
    activeGroup.summary = summarizeAggregateInstances(
        activeGroup.instanceIds.map(getKnownInstance)
    );
    activeGroup.aggregatePayload = buildAggregateGroupPayload(activeGroup);
    currentAggregateDraft = activeGroup.summary;
    currentSelectedInstanceOverlay = null;
    showAggregateGroup(activeGroup);
    renderAggregateSelectionControls();
}


async function showSelectedInstances() {
    if (currentAnalysisMode !== "abstraction") return;
    const selectedInstances = getSelectedAggregateInstances();
    if (selectedInstances.length === 0) return;

    const activeGroup = getActiveAggregateGroup();
    const candidateInstances = activeGroup
        ? getSelectedInstancesOutsideActiveGroup()
        : selectedInstances;
    if (candidateInstances.length === 0) {
        if (activeGroup) showAggregateGroup(activeGroup);
        return;
    }

    const instancePayloads = await Promise.all(candidateInstances.map(loadLocalInstancePayload));

    if (!activeGroup) {
        resetPersistedXZoom();
    }
    const overlay = buildSelectedInstanceOverlay(candidateInstances);
    overlay.payload = activeGroup
        ? buildAggregateComparisonPayload(activeGroup, instancePayloads)
        : buildSelectedInstanceOverlayPayload(instancePayloads, overlay);
    overlay.instancePayloads = instancePayloads;

    currentSelectedInstanceOverlay = overlay;
    currentAggregateDraft = null;
    currentMultiEntityController = null;
    currentRenderedData = overlay.payload;
    setAnalysisMode("abstraction");
    setMultiEntityPanelVisibility(true);
    renderMultiEntityLegend();
    renderCurrentGraph();
    if (activeGroup) {
        renderAggregateComparisonDetails(activeGroup, candidateInstances);
    } else {
        renderSelectedInstanceOverlayDetails(overlay);
    }
    renderAggregateSelectionControls();
}


function clearAggregateSelection() {
    if (currentAnalysisMode !== "abstraction") return;
    selectedAggregateInstanceIds.clear();
    currentSelectedInstanceOverlay = null;
    currentAggregateDraft = null;
    renderInstanceBrowser();
}


async function loadMultiEntityPrototype(instanceId = selectedMultiEntityInstanceId) {
    const encodedInstanceId = encodeURIComponent(instanceId);
    let localResponse;
    let expandedResponse;

    //先请求 Neo4j live API
    try {
        [localResponse, expandedResponse] = await Promise.all([
            fetch(`/api/multi_entity_live/${encodedInstanceId}/local`),
            fetch(`/api/multi_entity_live/${encodedInstanceId}/expanded`),
        ]);
    } catch (err) {
        console.warn("Live Neo4j instance loading failed, trying exported samples:", err);
    }

    //如果失败，再请求 sample JSON：
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


async function loadEntityLifecyclePrototype(entityType, entityId) {
    if (entityType === "Application") {
        return loadMultiEntityPrototype(entityId);
    }

    const encodedEntityType = encodeURIComponent(entityType);
    const encodedEntityId = encodeURIComponent(entityId);
    const [localResponse, expandedResponse] = await Promise.all([
        fetch(`/api/multi_entity_entity_live/${encodedEntityType}/local/${encodedEntityId}`),
        fetch(`/api/multi_entity_entity_live/${encodedEntityType}/expanded/${encodedEntityId}`),
    ]);

    if (!localResponse.ok || !expandedResponse.ok) {
        throw new Error(`${entityType} lifecycle data is not available for ${entityId}.`);
    }

    const [localSample, expandedSample] = await Promise.all([
        localResponse.json(),
        expandedResponse.json(),
    ]);

    return createMultiEntityState(localSample, expandedSample);
}


async function loadLocalInstancePayload(instance) {
    const entityType = instance.entityType ?? getBrowserEntityType();
    const controller = await loadEntityLifecyclePrototype(entityType, instance.id);
    controller.setMode("local");
    const payload = controller.getVisibleGraphPayload();
    controller.setMode("expanded");
    const expandedPayload = controller.getVisibleGraphPayload();
    return {
        instance,
        payload,
        expandedPayload,
    };
}


async function switchMultiEntityInstance(instanceId) {
    selectedMultiEntityInstanceId = instanceId;
    setAnalysisMode("instance");
    d3.select("#chart").selectAll("*").remove();
    currentMultiEntityController = await loadMultiEntityPrototype(selectedMultiEntityInstanceId);
    currentRenderedData = currentMultiEntityController.getVisibleGraphPayload();
    renderCurrentInstanceNavigator();
    renderMultiEntityLegend();
    updatePerspectiveControlFromState();
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
    } catch (err) {
        console.warn("Falling back to default CSV data:", err);
        try {
            currentRenderedData = await d3.json('/api/get_data');
            currentMultiEntityController = null;
            setMultiEntityPanelVisibility(false);
            renderCurrentGraph();
        } catch (fallbackErr) {
            console.error("Failed to load default data:", fallbackErr);
        }
        return;
    }

    try {
        renderCurrentInstanceNavigator();
        currentMultiEntityController = await loadMultiEntityPrototype(selectedMultiEntityInstanceId);
        currentRenderedData = currentMultiEntityController.getVisibleGraphPayload();
        setAnalysisMode("instance");
        setMultiEntityPanelVisibility(true);
        renderMultiEntityLegend();
        updatePerspectiveControlFromState();
        updateGraphFilterControlsFromState();
        renderCurrentGraph();
    } catch (err) {
        console.error("Multi-entity loading/rendering failed:", err);
        showMultiEntityError(String(err?.message ?? err));
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


async function applyPerspectiveSelection() {
    const select = document.getElementById("multi-entity-perspective-select");
    if (currentAnalysisMode === "abstraction") {
        await setAbstractionPerspective(select?.value);
        return;
    }

    if (!currentMultiEntityController) return;

    const selectedEntityKey = select?.value;
    const selectedOption = getPerspectiveEntityOptions().find((option) => (
        option.entityKey === selectedEntityKey
    ));
    if (!selectedOption) return;

    resetPersistedXZoom();
    currentMultiEntityController.resetGraphFilters();
    currentMultiEntityController.setPerspectiveEntity(selectedOption);
    updatePerspectiveControlFromState();
    updateGraphFilterControlsFromState();
    renderMultiEntityGraph();
}


function setupUiHandlers() {
    d3.selectAll('input[name="option-switcher-graph-view"]').on("change", function () {
        currentGraphViewSelection = +this.value;
        renderCurrentGraph();
    });

    document.getElementById("button-mode-instance")?.addEventListener("click", async () => {
        try {
            await enterInstanceMode();
        } catch (err) {
            console.error("Failed to enter instance mode:", err);
            showMultiEntityError(String(err?.message ?? err));
        }
    });

    document.getElementById("button-mode-abstraction")?.addEventListener("click", async () => {
        try {
            await enterAbstractionMode();
        } catch (err) {
            console.error("Failed to enter abstraction mode:", err);
            showMultiEntityError(String(err?.message ?? err));
        }
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

    document.getElementById("multi-entity-perspective-select")?.addEventListener("change", async () => {
        try {
            await applyPerspectiveSelection();
        } catch (err) {
            console.error("Failed to apply perspective selection:", err);
            showMultiEntityError(String(err?.message ?? err));
        }
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

    document.getElementById("button-show-selected-instances")?.addEventListener("click", async () => {
        try {
            await showSelectedInstances();
        } catch (err) {
            console.error("Failed to show selected instance overlay:", err);
            showMultiEntityError(String(err?.message ?? err));
        }
    });

    document.getElementById("button-aggregate-selected-instances")?.addEventListener("click", async () => {
        try {
            await aggregateSelectedInstances();
        } catch (err) {
            console.error("Failed to aggregate selected instances:", err);
            showMultiEntityError(String(err?.message ?? err));
        }
    });

    document.getElementById("button-add-selected-to-active-group")?.addEventListener("click", async () => {
        try {
            await addSelectedInstancesToActiveGroup();
        } catch (err) {
            console.error("Failed to add selected instances to active aggregate group:", err);
            showMultiEntityError(String(err?.message ?? err));
        }
    });

    document.getElementById("button-clear-aggregate-selection")?.addEventListener("click", () => {
        clearAggregateSelection();
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
