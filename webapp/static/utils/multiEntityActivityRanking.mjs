/*
SEAMLESS_ZOOM - A technique for seamless zooming between process models and process instances.
*/

function addUniqueActivity(target, seenActivities, activity) {
    if (!activity || seenActivities.has(activity)) return;
    target.push(activity);
    seenActivities.add(activity);
}

function getEventRelativeTime(eventMap, eventId) {
    return eventMap.get(eventId)?.timestamp_relative_seconds ?? 0;
}

function buildActivityTimeStats(eventMap) {
    const activityTimes = new Map();

    eventMap.forEach((event) => {
        const times = activityTimes.get(event.activity) ?? [];
        times.push(event.timestamp_relative_seconds);
        activityTimes.set(event.activity, times);
    });

    const firstTimeByActivity = new Map();
    const meanTimeByActivity = new Map();

    activityTimes.forEach((times, activity) => {
        const sortedTimes = times.slice().sort((a, b) => a - b);
        const total = sortedTimes.reduce((sum, value) => sum + value, 0);
        firstTimeByActivity.set(activity, sortedTimes[0]);
        meanTimeByActivity.set(activity, total / sortedTimes.length);
    });

    return { firstTimeByActivity, meanTimeByActivity };
}

function sortDfEdgesByTime(dfEdges, eventMap) {
    return dfEdges.slice().sort((edgeA, edgeB) => {
        const sourceDelta = getEventRelativeTime(eventMap, edgeA.source_event_id)
            - getEventRelativeTime(eventMap, edgeB.source_event_id);
        if (sourceDelta !== 0) return sourceDelta;

        const targetDelta = getEventRelativeTime(eventMap, edgeA.target_event_id)
            - getEventRelativeTime(eventMap, edgeB.target_event_id);
        if (targetDelta !== 0) return targetDelta;

        return `${edgeA.source_event_id}${edgeA.target_event_id}`
            .localeCompare(`${edgeB.source_event_id}${edgeB.target_event_id}`);
    });
}

function buildPerspectiveActivityOrder(dfEdges, eventMap, perspective) {
    const orderedActivities = [];
    const seenActivities = new Set();

    sortDfEdgesByTime(
        dfEdges.filter((edge) => edge.perspective === perspective),
        eventMap
    ).forEach((edge) => {
        addUniqueActivity(orderedActivities, seenActivities, edge.source_activity);
        addUniqueActivity(orderedActivities, seenActivities, edge.target_activity);
    });

    return orderedActivities;
}

function buildApplicationBackbone(eventMap, dfEdges, meanTimeByActivity) {
    const applicationEventIds = new Set();
    const orderedActivities = [];
    const seenActivities = new Set();

    sortDfEdgesByTime(
        dfEdges.filter((edge) => edge.perspective === "Application"),
        eventMap
    ).forEach((edge) => {
        applicationEventIds.add(edge.source_event_id);
        applicationEventIds.add(edge.target_event_id);
        addUniqueActivity(orderedActivities, seenActivities, edge.source_activity);
        addUniqueActivity(orderedActivities, seenActivities, edge.target_activity);
    });

    // Fallback for incomplete samples without Application DF edges.
    if (orderedActivities.length === 0) {
        Array.from(eventMap.values())
            .filter((event) => event.activity?.startsWith("A_"))
            .sort((eventA, eventB) => {
                const delta = (meanTimeByActivity.get(eventA.activity) ?? 0)
                    - (meanTimeByActivity.get(eventB.activity) ?? 0);
                return delta !== 0 ? delta : eventA.activity.localeCompare(eventB.activity);
            })
            .forEach((event) => {
                applicationEventIds.add(event.id);
                addUniqueActivity(orderedActivities, seenActivities, event.activity);
            });
    }

    const orderedEvents = Array.from(applicationEventIds)
        .map((eventId) => eventMap.get(eventId))
        .filter(Boolean)
        .sort((eventA, eventB) => {
            const delta = eventA.timestamp_relative_seconds - eventB.timestamp_relative_seconds;
            return delta !== 0 ? delta : eventA.id.localeCompare(eventB.id);
        });

    return { orderedActivities, orderedEvents };
}

function findPrecedingApplicationActivity(applicationEvents, activityTime, fallbackActivity) {
    let selectedActivity = fallbackActivity;

    applicationEvents.forEach((event) => {
        if (event.timestamp_relative_seconds <= activityTime) {
            selectedActivity = event.activity;
        }
    });

    return selectedActivity;
}

function addInsertedActivity(insertedByApplicationActivity, applicationActivity, activityInfo) {
    if (!applicationActivity) return;

    const insertedActivities = insertedByApplicationActivity.get(applicationActivity) ?? [];
    if (!insertedActivities.some((item) => item.activity === activityInfo.activity)) {
        insertedActivities.push(activityInfo);
    }
    insertedByApplicationActivity.set(applicationActivity, insertedActivities);
}

function addPerspectiveActivitiesNearApplicationBackbone({
    insertedByApplicationActivity,
    applicationBackbone,
    perspectiveActivities,
    perspective,
    firstTimeByActivity,
    alreadyHandledActivities,
}) {
    const fallbackActivity = applicationBackbone.orderedActivities[0] ?? null;

    perspectiveActivities.forEach((activity, perspectiveRank) => {
        if (alreadyHandledActivities.has(activity)) return;

        const firstTime = firstTimeByActivity.get(activity) ?? 0;
        const applicationActivity = findPrecedingApplicationActivity(
            applicationBackbone.orderedEvents,
            firstTime,
            fallbackActivity
        );

        addInsertedActivity(insertedByApplicationActivity, applicationActivity, {
            activity,
            perspective,
            perspectiveRank,
            firstTime,
        });
        alreadyHandledActivities.add(activity);
    });
}

function rankRemainingActivities(eventMap, meanTimeByActivity, rankedActivities, rankedActivitySet) {
    Array.from(new Set(Array.from(eventMap.values()).map((event) => event.activity)))
        .filter((activity) => !rankedActivitySet.has(activity))
        .sort((activityA, activityB) => {
            const delta = (meanTimeByActivity.get(activityA) ?? 0)
                - (meanTimeByActivity.get(activityB) ?? 0);
            return delta !== 0 ? delta : activityA.localeCompare(activityB);
        })
        .forEach((activity) => addUniqueActivity(rankedActivities, rankedActivitySet, activity));
}

// Version A ranking:
// Application is the primary backbone. Related Offer/Workflow activities keep
// their own DF order and are inserted near the preceding Application phase.
function buildActivityRanking(eventMap, dfEdges) {
    const { firstTimeByActivity, meanTimeByActivity } = buildActivityTimeStats(eventMap);
    const applicationBackbone = buildApplicationBackbone(eventMap, dfEdges, meanTimeByActivity);
    const applicationActivitySet = new Set(applicationBackbone.orderedActivities);
    const insertedByApplicationActivity = new Map();
    const handledInsertedActivities = new Set(applicationActivitySet);

    ["Offer", "Workflow"].forEach((perspective) => {
        addPerspectiveActivitiesNearApplicationBackbone({
            insertedByApplicationActivity,
            applicationBackbone,
            perspectiveActivities: buildPerspectiveActivityOrder(dfEdges, eventMap, perspective),
            perspective,
            firstTimeByActivity,
            alreadyHandledActivities: handledInsertedActivities,
        });
    });

    const rankedActivities = [];
    const rankedActivitySet = new Set();

    applicationBackbone.orderedActivities.forEach((applicationActivity) => {
        addUniqueActivity(rankedActivities, rankedActivitySet, applicationActivity);

        const insertedActivities = insertedByApplicationActivity.get(applicationActivity) ?? [];
        insertedActivities
            .slice()
            .sort((activityA, activityB) => {
                const timeDelta = activityA.firstTime - activityB.firstTime;
                if (timeDelta !== 0) return timeDelta;

                const perspectiveDelta = activityA.perspective.localeCompare(activityB.perspective);
                if (perspectiveDelta !== 0) return perspectiveDelta;

                return activityA.perspectiveRank - activityB.perspectiveRank;
            })
            .forEach((activityInfo) => {
                addUniqueActivity(rankedActivities, rankedActivitySet, activityInfo.activity);
            });
    });

    rankRemainingActivities(eventMap, meanTimeByActivity, rankedActivities, rankedActivitySet);

    const ranking = new Map();
    rankedActivities.forEach((activity, index) => {
        ranking.set(activity, `${index + 1}_${activity}`);
    });
    return ranking;
}

export { buildActivityRanking };
