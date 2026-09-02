/*
SEAMLESS_ZOOM — Perspective-specific relation rules for multi-entity TOM.
*/

const RELATION_RULES_BY_PERSPECTIVE = {
    Application: {
        visibleRelationTypes: ["Case_AO", "Case_AW"],
        expansionTargets: {
            Case_AO: "Offer",
            Case_AW: "Workflow",
        },
    },
    Offer: {
        visibleRelationTypes: ["Case_AO", "Case_WO"],
        expansionTargets: {
            Case_AO: "Application",
            Case_WO: "Workflow",
        },
    },
    Workflow: {
        visibleRelationTypes: ["Case_AW", "Case_WO"],
        expansionTargets: {
            Case_AW: "Application",
            Case_WO: "Offer",
        },
    },
};

function getPerspectiveRule(perspective) {
    return RELATION_RULES_BY_PERSPECTIVE[perspective] ?? RELATION_RULES_BY_PERSPECTIVE.Application;
}

function getVisibleRelationTypesForPerspective(perspective) {
    return getPerspectiveRule(perspective).visibleRelationTypes;
}

function getExpansionTargetForRelation(perspective, relationType) {
    return getPerspectiveRule(perspective).expansionTargets[relationType] ?? null;
}

function isRelationVisibleForPerspective(perspective, relationType) {
    return getVisibleRelationTypesForPerspective(perspective).includes(relationType);
}

export {
    RELATION_RULES_BY_PERSPECTIVE,
    getExpansionTargetForRelation,
    getPerspectiveRule,
    getVisibleRelationTypesForPerspective,
    isRelationVisibleForPerspective,
};
