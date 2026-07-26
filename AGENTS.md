## Thesis Context and Design Intent

This project is part of a master thesis titled:

**Visualizing Multi-Perspective Event Networks in Time-Order Maps**

The thesis does not propose a new event data model. It uses graph-derived multi-entity event data as input and focuses on how such data can be visualized in a time-oriented and abstraction-aware layout.

The central goal is to extend the existing Time-Order Map so that it can show several entity perspectives, such as Application, Offer, and Resource, within one shared layout. The visualization should help analysts inspect how events and directly-follows relations differ across entity perspectives without duplicating shared events.

## Core Conceptual Terms

### Multi-Entity Event Data

Event data in which one event may be related to more than one process-relevant entity. For example, in BPIC17, an event may be related to an Application, an Offer, and a Resource.

### Entity Perspective

An entity perspective is the view induced by one entity type. Examples:

* Application perspective
* Offer perspective
* Resource perspective, stored as `Case_R` in the current Neo4j data

Each perspective has its own lifecycle semantics and its own directly-follows relations.

### Entity Lifecycle

The timestamp-ordered sequence of events related to one entity instance. For example, the lifecycle of one specific Offer consists of all events correlated to that Offer, ordered by timestamp.

### Shared Event

A shared event is an event related to entities from more than one entity type. Shared events must be displayed only once in the visual layout. They should not be duplicated for each perspective.

### Perspective-Specific Directly-Follows Relation

A directly-follows relation that is valid within a specific entity perspective. For example:

* `DF_Application` connects events that directly follow each other in an Application lifecycle.
* `DF_Offer` connects events that directly follow each other in an Offer lifecycle.
* `DF_Case_R` connects events that directly follow each other in a Resource lifecycle.

The same pair of activities may have different meanings depending on the perspective.

### Perspective-Specific Aggregated Directly-Follows Relation

An activity-level relation derived from event-level directly-follows relations for one entity perspective. It summarizes event pairs where events of activity `a1` are directly followed by events of activity `a2` in the lifecycle of entities of one type.

Aggregated relations may later store measures such as:

* frequency
* average duration
* number of involved entity instances

## Design Objectives

The implementation should support three main design objectives.

### DO1: Layout Mapping for Graph-Derived Multi-Entity Event Data

The system should map events from Neo4j into the existing two-dimensional Time-Order Map layout.

Layout assumptions:

* X-axis: relative time.
* Y-axis: activity rank.
* Shared events are positioned once.
* Multiple selected entity perspectives are shown in the same coordinate system.
* The number of selected perspectives is expected to be small, usually between two and five.

The current default anchor is an Application instance. Relative time is measured from the first event of the anchor Application lifecycle unless another anchor strategy is explicitly implemented.

### DO2: Visual Encoding of Entity Membership and Perspective-Specific Relations

The visualization should make it clear:

* which entity perspectives an event belongs to;
* which directly-follows edge belongs to which perspective;
* when an event is shared across multiple perspectives.

Suggested visual encodings:

* color by entity perspective for directly-follows edges;
* marker, border, halo, or tooltip information for shared events;
* legend explaining active perspectives and edge colors.

Do not duplicate event nodes to represent different perspectives. Use one event node with multiple memberships where applicable.

### DO3: Multi-Entity Semantic Zooming and Interaction

The extension should preserve the original Time-Order Map idea of moving between event-level behavior and aggregated process relations.

At lower abstraction levels:

* individual events are visible;
* entity lifecycles and event-level directly-follows edges can be inspected.

At higher abstraction levels:

* event-level directly-follows relations are summarized into aggregated activity-level relations;
* aggregation should remain perspective-specific;
* analysts should be able to distinguish Application-level, Offer-level, and Resource-level aggregated relations.

Interaction should support:

* selecting entity perspectives;
* filtering by anchor Application or selected entity instance;
* controlling which directly-follows relation types are visible;
* inspecting details on demand through tooltips or selection panels.

## Analytical Tasks to Support

The prototype should support the following thesis tasks.

### T1: Trace Entity Lifecycles Over Time

Given an entity instance, such as one Offer, the analyst should be able to follow its lifecycle over time and see how Application-level or Resource-level events occur relative to it.

### T2: Identify Waiting Times and Temporal Dependencies Across Entity Boundaries

The analyst should be able to inspect time gaps between events from different perspectives, such as an Application-level event followed by an Offer-level event.

The visualization should make temporal ordering and distances easier to compare by placing selected perspectives in a shared temporal context.

### T3: Relate Aggregated Process Relations to Event-Level Patterns

The analyst should be able to move from aggregated directly-follows relations back to underlying event-level sequences. The same activity pair may behave differently across perspectives, so aggregation must preserve the perspective from which it was derived.

## Implementation Principles

When modifying the existing codebase, preserve the original Time-Order Map behavior unless the change is explicitly required for multi-entity support.

Prefer incremental changes:

1. inspect the existing data loading and layout pipeline;
2. add Neo4j-based data extraction separately;
3. transform Neo4j results into the existing frontend data format where possible;
4. extend the frontend only where the old data model is insufficient.

Do not rewrite the whole visualization from scratch.

Do not hard-code secrets. Read Neo4j credentials from `.env` or local configuration files that are excluded from Git.

Do not commit:

* `.env`
* local database dumps
* large temporary files
* generated cache files
* personal notes not needed for the project

## Development Workflow for Codex

Before making changes:

* inspect the existing file structure;
* identify the current data format expected by the frontend;
* locate where events, links, activity ranks, time scales, and abstraction levels are computed;
* explain which files will be changed and why.

When adding Neo4j support:

* keep database query code separate from visualization logic;
* use small sample cases first;
* avoid unbounded queries over the full BPIC17 graph;
* return only the fields required by the visualization;
* sort events by timestamp before computing relative time;
* keep perspective information attached to both events and edges.

When adding frontend support:

* maintain compatibility with the original single-case TOM data if possible;
* add perspective-aware fields rather than replacing the old structure entirely;
* ensure shared events are represented once;
* ensure edges carry a `perspective` or `entityType` field;
* keep color mapping centralized and documented.

When implementing aggregation:

* aggregate directly-follows relations per perspective;
* do not merge relations from different perspectives unless the UI explicitly asks for a combined view;
* preserve links from aggregated relations back to event-level pairs where possible.

## Expected Output Data Shape

A useful intermediate data structure for the frontend may contain:

```js
{
  events: [
    {
      id: "event id",
      activity: "activity name",
      timestamp: "ISO timestamp",
      relativeTime: 0.0,
      activityRank: 1,
      entityMemberships: [
        { entityType: "Application", entityId: "Application_..." },
        { entityType: "Offer", entityId: "Offer_..." }
      ],
      isShared: true
    }
  ],
  edges: [
    {
      source: "event id",
      target: "event id",
      perspective: "Application",
      relationType: "DF_Application",
      duration: 123.4
    }
  ],
  aggregatedEdges: [
    {
      sourceActivity: "A_Create Application",
      targetActivity: "O_Create Offer",
      perspective: "Offer",
      frequency: 10,
      averageDuration: 123.4,
      eventPairs: [
        ["event id 1", "event id 2"]
      ]
    }
  ],
  perspectives: ["Application", "Offer", "Case_R"],
  anchor: {
    entityType: "Application",
    entityId: "Application_..."
  }
}
```

This shape is a guideline, not a fixed requirement. If the existing frontend already uses another structure, adapt the multi-entity fields to fit the existing pipeline.

## Important Constraints

The thesis contribution is not simply to show more edges. The goal is to preserve the Time-Order Map idea while adding multi-entity semantics.

Therefore:

* keep one shared layout;
* keep relative time meaningful;
* keep activity rank shared across perspectives;
* avoid duplicating shared events;
* keep perspective-specific directly-follows relations distinguishable;
* support movement between event-level and aggregated views;
* document limitations when visual density becomes too high.

If a design choice is ambiguous, prefer the option that best supports the thesis tasks T1, T2, and T3.

## Verified Neo4j Schema

The current local Neo4j instance was inspected on 2026-06-23 using:

- `NEO4J_URI=bolt://localhost:7687`
- `NEO4J_USER=neo4j`
- `NEO4J_DATABASE=neo4j`
- `NEO4J_PASSWORD` loaded locally from `.env`

### Labels

- `Event`
- `Entity`
- `Class`
- `Log`

### Relationship Types

- `CORR`
- `DF`
- `HAS`
- `OBSERVED`
- `REL`

### Relationship Semantics Verified in the Current Database

- `CORR`: `Event -> Entity`
- `DF`: `Event -> Event`
- `HAS`, `OBSERVED`, `REL`: present in the database, but not yet used by the current visualization pipeline

### Key Observation

The current Neo4j database does not use relationship names such as `E_EN`, `DF_Application`, or `DF_Offer`.

Instead:

- event-to-entity correlation is represented by `CORR`
- directly-follows is represented by `DF`
- the perspective is encoded as the `EntityType` property on the `DF` edge

Example:

- `(:Event)-[:CORR]->(:Entity)`
- `(:Event)-[:DF {EntityType: "Application"}]->(:Event)`
- `(:Event)-[:DF {EntityType: "Case_R"}]->(:Event)`

### Event Node Properties

Observed event properties include:

- `EventID`
- `EventIDraw`
- `Activity`
- `timestamp`
- `case`
- `resource`
- `lifecycle`
- `EventOrigin`
- `Log`
- `idx`
- `OfferID`
- `ApplicationType`
- `LoanGoal`
- `RequestedAmount`
- `OfferedAmount`
- `NumberOfTerms`
- `MonthlyCost`
- `FirstWithdrawalAmount`
- `CreditScore`
- `Selected`
- `Accepted`
- `Action`

### Entity Node Properties

- `EntityType`
- `ID`
- `uID`

### EntityType Distribution in the Current Sample Database

- `Case_R`: 67
- `Case_AO`: 25
- `Case_WO`: 25
- `Offer`: 25
- `Application`: 20
- `Case_AW`: 20
- `Workflow`: 20

### Relationship Counts in the Current Sample Database

- `CORR`: 3318
- `OBSERVED`: 1558
- `DF`: 1426
- `HAS`: 779
- `REL`: 210

### Important Modeling Detail

The same `ID` string can appear in more than one entity type. For example, `Application_681547497` exists as:

- `EntityType = "Application"`
- `EntityType = "Workflow"`

Therefore, queries should not filter entities only by `ID`. They should usually filter by both:

- `EntityType`
- `ID`

### Verified Anchor Query Pattern

To get the event set of one anchor application, use the application entity node and traverse incoming `CORR` edges:

```cypher
MATCH (:Entity {EntityType: "Application", ID: "Application_681547497"})<-[:CORR]-(e:Event)
RETURN e
ORDER BY e.timestamp
```

To get perspective-specific directly-follows edges for that anchor application:

```cypher
MATCH (:Entity {EntityType: "Application", ID: "Application_681547497"})<-[:CORR]-(e1:Event)-[df:DF]->(e2:Event)
RETURN e1, df, e2
ORDER BY e1.timestamp
```

The `df.EntityType` property indicates the perspective, for example:

- `Application`
- `Case_R`

### Verified Correlation Pattern for Shared Events

Shared events can be detected through multiple `CORR` edges from one event to entities of different `EntityType` values.

For `Application_681547497`, events were observed to correlate with:

- `Application`
- `Case_R`
- `Case_AO`
- `Case_AW`

This confirms that multi-entity membership is represented by repeated `CORR` edges, not by repeated event nodes.

## Subgraph Modes

The project should support two subgraph construction modes for an anchor application.

### Mode 1: Anchor-Local Subgraph

Purpose:

- show only the anchor application's own events;
- keep the graph compact for first-look inspection;
- reveal which additional entities those anchor events are correlated with.

Construction:

1. find all events correlated with the anchor `Application` entity;
2. keep only those events as nodes;
3. attach every correlated entity membership of those events;
4. include `DF` edges between the retained events.

Consequence:

- other perspectives such as `Offer` or `Case_R` may appear only partially;
- this mode is intentionally local and should later be exposed as a frontend toggle.

### Mode 2: Expanded Multi-Entity Subgraph

Purpose:

- start from one anchor application;
- use the shared BPIC17 `case` field to retrieve the full case subgraph;
- include application, offer, and workflow events that belong to the same case.

Construction:

1. find all events where `Event.case = anchor application ID`;
2. include every `CORR` membership of those events;
3. include every `DF` edge whose source and target both have the same `case` value.

Consequence:

- perspectives such as `Application`, `Offer`, and `Workflow` can be retrieved in one pass;
- the result stays naturally bounded to one BPIC17 case;
- this is the default mode for backend export during the current prototyping phase.

### Current Implementation Decision

- backend export defaults to `expanded` mode;
- `local` mode is preserved in the query layer and should later be exposed as a frontend switch.

## Progressive Exploration Logic

The intended interaction follows Christoffer's idea of details on demand plus
progressive exploration.

### Mode 1: Local

- show the local query result only;
- the analyst initially sees the anchor application's own events;
- each event node shows colored rings or other membership markers for related entity memberships.

### Mode 2: Selective Entity Expansion

- when the analyst clicks a membership marker, such as an orange Offer ring,
  the system should reveal the full lifecycle of that selected entity instance;
- the default implementation path is frontend-side filtering from already
  preloaded `Expanded` data;
- this means the frontend should not require a new backend query for the
  common interaction path.

Example:

- start from 6 local anchor events;
- click the ring for `Offer_XXX`;
- show the full lifecycle of `Offer_XXX` in the main view;
- later click another ring, such as `Offer_YYY`;
- append that lifecycle as well.

### Mode 3: Show All

- when the analyst clicks `show all perspectives`, the system reveals the full
  case-level `Expanded` scope in one step.

### Query Strategy

The query strategy should match the interaction modes:

- `Local` query: fetch the anchor application's own events and their memberships;
- `Expanded` query: preload the full case-level event set and DF edges using the
  shared BPIC17 `case` field;
- Mode 2 default behavior: filter the already loaded `Expanded` data in the frontend
  to reveal one selected entity instance lifecycle.

### Optional Fallback Query

If the full expanded preload later becomes too large, the backend may use an
instance-specific fallback query:

```cypher
MATCH (:Entity {EntityType: $entity_type, ID: $entity_id})
  <-[:CORR]-(e:Event)-[:CORR]->(n:Entity)
RETURN e, n
```

and the corresponding DF query:

```cypher
MATCH (:Entity {EntityType: $entity_type, ID: $entity_id})
  <-[:CORR]-(e1:Event)-[df:DF]->(e2:Event)
WHERE df.EntityType = $entity_type
RETURN e1, df, e2
```

This fallback is not the first-choice interaction path for the current prototype.

## Feature Priority

The implementation order should follow the task and interaction priority from
`User Tasks and Interaction Requirements.pdf`.

### First Priority

Implement these first:

- Core User Tasks 1-3
- Scope Modes:
  - `Local`
  - `Expanded`
- Hover details on demand

Interpretation for the current prototype:

- first support tracing one selected entity lifecycle;
- then support expanding from an anchor entity to related entities;
- then support combining multiple entity perspectives in one shared layout;
- support progressive scope control through `Local` and `Expanded` modes;
- support hover-based details without changing layout state.

### Later Priority

Do not prioritize these before the first-priority features are working:

- Branching and convergence hotspots
- Auxiliary views for selected edges or aggregated flows

Reason:

- the requirements document states that the frontend *may provide an optional hotspot overlay*;
- auxiliary views are also described as optional additions;
- both should be treated as later enhancements, not as blockers for the first usable prototype.
