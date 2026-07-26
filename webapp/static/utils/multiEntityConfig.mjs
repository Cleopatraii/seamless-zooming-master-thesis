/*
SEAMLESS_ZOOM — A technique for seamless zooming between process models and process instances.
*/

/*raw entity type 在 UI 上显示成什么名字*/
const ENTITY_TYPE_DISPLAY_LABELS = {
    Application: "Application",
    Offer: "Offer",
    Workflow: "Workflow",
    Case_R: "Resource",
    Case_AO: "Offer-related entity",
    Case_AW: "Workflow-related entity",
    Case_WO: "Workflow-offer relation",
};

const ENTITY_CATEGORY_DISPLAY_LABELS = {
    Application: "Application",
    Offer: "Offer",
    Workflow: "Workflow",
    Resource: "Resource",
};

const ENTITY_CATEGORY_COLORS = {
    Application: "#1f9d55",
    Offer: "#2563eb",
    Workflow: "#e85d04",
    Resource: "#8b5cf6",
};

const OFFER_EDGE_COLORS = ["#2563eb", "#1d4ed8", "#60a5fa", "#0f766e"];

const ENTITY_TYPE_TO_CATEGORY = {
    Application: "Application",
    Offer: "Offer",
    Case_AO: "Offer",
    Workflow: "Workflow",
    Case_AW: "Workflow",
    Case_WO: "Workflow",
    Case_R: "Resource",
};

const VISIBLE_ENTITY_CATEGORIES = ["Application", "Offer", "Workflow", "Resource"];
const HIDDEN_RAW_ENTITY_TYPES = [];
const APPLICATION_SCOPE_BASE_RAW_ENTITY_TYPES = ["Application", "Case_AO", "Case_AW", "Case_R"];//允许的entity
const RING_RAW_ENTITY_TYPES = ["Application", "Offer", "Workflow", "Case_R"];
const EXPANDABLE_RELATION_RAW_ENTITY_TYPES = ["Case_AO", "Case_AW", "Case_WO"];

/**
 * getEntityDisplayLabel("Case_AO")
 * "Offer-related entity"
 */
function getEntityDisplayLabel(entityType) {
    return ENTITY_TYPE_DISPLAY_LABELS[entityType] ?? entityType;
}

//负责“raw type -> display category
function getEntityDisplayCategory(entityType) {
    return ENTITY_TYPE_TO_CATEGORY[entityType] ?? null;
}

function getEntityCategoryDisplayLabel(entityCategory) {
    return ENTITY_CATEGORY_DISPLAY_LABELS[entityCategory] ?? entityCategory;
}

function getEntityColor(entityTypeOrCategory) {
    const category = ENTITY_CATEGORY_COLORS[entityTypeOrCategory]
        ? entityTypeOrCategory
        : getEntityDisplayCategory(entityTypeOrCategory);
    return ENTITY_CATEGORY_COLORS[category] ?? "#6b7280";
}

function isVisibleEntityType(entityType) {
    return Boolean(getEntityDisplayCategory(entityType));
}

function isRingEntityType(entityType) {
    return RING_RAW_ENTITY_TYPES.includes(entityType);
}

function isExpandableRelationEntityType(entityType) {
    return EXPANDABLE_RELATION_RAW_ENTITY_TYPES.includes(entityType);
}

/*来决定哪些 membership 正常显示，哪些放到 Other relations*/
function splitVisibleAndHiddenMemberships(memberships = []) {
    return memberships.reduce((acc, membership) => {
        if (isVisibleEntityType(membership.entityType)) {
            acc.visible.push(membership);
        } else {
            acc.hidden.push(membership);
        }
        return acc;
    }, { visible: [], hidden: [] });
}

/*当前 scope 下，一个 event 的哪些 memberships 应该拿出来给 UI 看*/
function filterMembershipsForScope(memberships = [], scope = {}) {
    const {
        anchorEntityType = null,
        allowWorkflowOfferRelations = false,
    } = scope;

    //如果当前 anchor 不是 Application，那暂时不做 Application-specific 过滤，直接返回 memberships 的浅拷贝。
    if (anchorEntityType !== "Application") {
        return memberships.slice();
    }

    //创建一个允许名单
    const allowedRawTypes = new Set(APPLICATION_SCOPE_BASE_RAW_ENTITY_TYPES);
    //如果当前已经展开了 Offer/Workflow，或者 Show All，那允许名单增加
    if (allowWorkflowOfferRelations) {
        allowedRawTypes.add("Case_WO");
        allowedRawTypes.add("Offer");
        allowedRawTypes.add("Workflow");
    }

    return memberships.filter((membership) => allowedRawTypes.has(membership.entityType));
}

export {
    APPLICATION_SCOPE_BASE_RAW_ENTITY_TYPES,
    ENTITY_CATEGORY_COLORS,
    HIDDEN_RAW_ENTITY_TYPES,
    OFFER_EDGE_COLORS,
    EXPANDABLE_RELATION_RAW_ENTITY_TYPES,
    RING_RAW_ENTITY_TYPES,
    VISIBLE_ENTITY_CATEGORIES,
    filterMembershipsForScope,
    getEntityColor,
    getEntityCategoryDisplayLabel,
    getEntityDisplayCategory,
    getEntityDisplayLabel,
    isExpandableRelationEntityType,
    isRingEntityType,
    isVisibleEntityType,
    splitVisibleAndHiddenMemberships,
};
