/*
SEAMLESS_ZOOM — A technique for seamless zooming between process models and process instances.
Copyright (C) 2025  Christoffer Rubensson

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.

Website: https://hu-berlin.de/rubensson
E-Mail: {firstname.lastname}@hu-berlin.de
*/

// -----
// DRAW AN INSTANCE GRAPH
// -----

import { caseAccessor, actAccessor, timeAccessor, resAccessor, nodes, edges } from "../utils/parsers.mjs";
import { getEntityColor } from "../utils/multiEntityConfig.mjs";

function getPointOnPath(pathElement, distance) {
    const point = pathElement.getPointAtLength(distance);
    return [point.x, point.y];
}

function makeAggregateArrowGlyph(edgeDatum, link) {
    const pathElement = document.createElementNS("http://www.w3.org/2000/svg", "path");
    pathElement.setAttribute("d", link(edgeDatum));

    let pathLength = 0;
    try {
        pathLength = pathElement.getTotalLength();
    } catch {
        return null;
    }
    if (!Number.isFinite(pathLength) || pathLength <= 1) return null;

    const tipGap = Math.min(11, pathLength * 0.32);
    const tailGap = Math.min(22, pathLength * 0.68);
    const [tipX, tipY] = getPointOnPath(pathElement, Math.max(0, pathLength - tipGap));
    const [tailX, tailY] = getPointOnPath(pathElement, Math.max(0, pathLength - tailGap));
    const angle = Math.atan2(tipY - tailY, tipX - tailX);
    if (!Number.isFinite(angle)) return null;

    const arrowLength = 7;
    const arrowHalfWidth = 4;
    const baseX = tipX - Math.cos(angle) * arrowLength;
    const baseY = tipY - Math.sin(angle) * arrowLength;
    const normalX = -Math.sin(angle);
    const normalY = Math.cos(angle);
    const leftX = baseX + normalX * arrowHalfWidth;
    const leftY = baseY + normalY * arrowHalfWidth;
    const rightX = baseX - normalX * arrowHalfWidth;
    const rightY = baseY - normalY * arrowHalfWidth;

    return `M${tipX},${tipY} L${leftX},${leftY} L${rightX},${rightY} Z`;
}

function renderInstanceGraph(graphData, link, container, xAccessor, xScale, yAccessor, yScale, options = {}) {
    // Graph initialization
    const {
        classNameGraph = "instance-graph",
        classNameNodes = "instance-nodes",
        classNameNode = "event-circle",
        classNameEdges = "instance-edges",
        classNameEdgeUp = "link link-up",
        classNameEdgeDown = "link link-down",
        opacityGraph = 1,
        opacityStroke = 0.6,
        strokeWidth = 1.0,
    } = options;

    const ctrInstance = container.append('g')
        .attr('class', classNameGraph)
        .style('opacity', opacityGraph)
    
    const edge = ctrInstance.append('g')
        .attr('class', classNameEdges)
        .attr('fill', 'none')
        //.attr('stroke', '#feb24c')
        .attr('stroke-opacity', opacityStroke)
        .attr('stroke-width', strokeWidth)

    edge.selectAll('path')
        .data(edges(graphData))
        .join('path')
        .attr('id', d => `edge-${d.id}`)//edge-e0
        .attr('data-edge-id', d => d.id)
        .attr('d', link)
        .attr('data-caseid', d => d.entity)          // Use the entity as the case ID. Each edge belongs to a specific case.
        .attr('data-perspective', d => d.perspective ?? d.entity)
        .attr('data-edge-entity-id', d => d.edgeEntityId ?? "")
        .attr('data-relation-kind', d => d.relationKind ?? "df")
        .attr('class', d => {
            const base = yScale(d.source_coordinates[1]) > yScale(d.target_coordinates[1])
                ? classNameEdgeUp
                : classNameEdgeDown;
            const relationClass = d.relationKind === "expansion-anchor"
                ? " expansion-anchor-edge"
                : "";
            const aggregateClass = d.isAggregateEdge ? " aggregate-edge" : "";
            return base + " instance-edge" + relationClass + aggregateClass;            // ★ Add an instance-edge uniformly
        })
        .style('stroke', d => d.edgeColor ?? getEntityColor(d.perspective ?? d.entity))
        .style('stroke-dasharray', d => d.edgeDasharray ?? null)
        .style('stroke-opacity', d => d.edgeOpacity ?? null)
        .style('stroke-width', d => d.edgeStrokeWidth ?? strokeWidth)
        .style('stroke-linecap', d => d.isAggregateEdge ? 'butt' : null);

    const aggregateEdges = edges(graphData).filter(d => d.isAggregateEdge);
    if (aggregateEdges.length > 0) {
        // Aggregate edges can be very short. Keep the wide invisible click
        // target below nodes so it does not steal normal node interactions.
        ctrInstance.append('g')
            .attr('class', 'aggregate-edge-hit-areas')
            .attr('fill', 'none')
            .selectAll('path')
            .data(aggregateEdges)
            .join('path')
            .attr('class', 'aggregate-edge-hit-area')
            .attr('data-edge-id', d => d.id)
            .attr('d', link)
            .style('stroke', 'transparent')
            .style('stroke-width', d => Math.max((d.edgeStrokeWidth ?? strokeWidth) + 14, 18))
            .style('pointer-events', 'stroke')
            .style('cursor', 'pointer');
    }

    // Draw events
    const events = ctrInstance.append('g')
        .attr("class", classNameNodes)

    const eventGroups = events.selectAll('g')
        .data(nodes(graphData))
        .join('g')
        .attr('class', d => [
            'instance-node-group',
            d.isAggregateNode ? 'aggregate-node-group' : '',
            d.comparisonLayer ? `comparison-layer-${d.comparisonLayer}` : '',
        ].filter(Boolean).join(' '))
        .attr('data-event-id', d => d.id)
        .attr('data-shared', d => String(Boolean(d.isShared)))
        .attr('transform', d => `translate(${xScale(xAccessor(d))},${yScale(yAccessor(d))})`);

    eventGroups.append('circle')
        .attr('class', 'instance-node-hit-area')
        .attr('data-event-id', d => d.id)
        .attr('data-shared', d => String(Boolean(d.isShared)))
        .attr('r', 10)
        .style('fill', 'transparent')
        .style('stroke', 'none');

    eventGroups.each(function (d) {
        const group = d3.select(this);
        const visibleMemberships = (d.ringEntityMemberships ?? d.visibleEntityMemberships ?? d.entityMemberships ?? []).slice(0, 4);
        const segmentCount = visibleMemberships.length;

        const outerRadius = 8.5;
        const innerRadius = 5.2;
        if (segmentCount === 0) return;

        const totalAngle = Math.PI * 2;
        const anglePerSegment = totalAngle / segmentCount;
        const gapAngle = segmentCount === 1 ? 0 : Math.min(0.14, anglePerSegment * 0.22);
        const arcGenerator = d3.arc()
            .innerRadius(innerRadius)
            .outerRadius(outerRadius);

        group.append('circle')
            .attr('class', 'membership-ring-base')
            .attr('r', outerRadius)
            .style('fill', 'none')
            .style('stroke', '#ffffff')
            .style('stroke-width', 1.2)
            .style('opacity', 0.95)
            .style('pointer-events', 'none');

        visibleMemberships.forEach((membership, index) => {
            const rawStart = (-Math.PI / 2) + (index * anglePerSegment);
            const rawEnd = rawStart + anglePerSegment;
            const startAngle = rawStart + gapAngle / 2;
            const endAngle = rawEnd - gapAngle / 2;

            group.append('path')
                .attr('class', 'membership-segment')
                .attr('d', arcGenerator({
                    startAngle,
                    endAngle,
                }))
                .style('fill', d.aggregateGroupColor ?? getEntityColor(membership.entityType))
                .style('stroke', '#ffffff')
                .style('stroke-width', 0.9)
                .style('opacity', 0.98)
                .style('pointer-events', 'none');
        });

        const overlapCount = d.overlapCount ?? d.overlapEventIds?.length ?? 1;
        if (overlapCount > 1) {
            group.append('circle')
                .attr('class', 'event-overlap-outline')
                .attr('r', outerRadius + 1.2)
                .style('fill', 'none')
                .style('stroke', '#1f2937')
                .style('stroke-width', 1.8)
                .style('stroke-opacity', 0.75)
                .style('pointer-events', 'none');
        }
    });

    /*对每个 event node 执行一次。*/
    eventGroups.each(function (d) {
        /*判断要不要挂badge*/
        const relationCount = d.expandableRelationCount ?? d.expandableRelationMemberships?.length ?? 0;
        if (relationCount <= 0) return;

        const badge = d3.select(this)
            .append('g')
            .attr('class', 'relation-badge instance-node-hit-area')
            .attr('data-event-id', d.id)
            .attr('data-shared', String(Boolean(d.isShared)))
            .attr('transform', 'translate(10,-10)');

        badge.append('circle')
            .attr('r', 4.2)
            .style('fill', '#dbeafe')
            .style('stroke', '#2563eb')
            .style('stroke-width', 1.1)
            .style('stroke-dasharray', '2 1.5');

        badge.append('text')
            .attr('x', 4.4)
            .attr('y', -3.8)
            .attr('class', 'relation-badge-count')
            .text(relationCount);
    });

    eventGroups.each(function (d) {
        const overlapCount = d.overlapCount ?? d.overlapEventIds?.length ?? 1;
        if (overlapCount <= 1) return;

        const overlapMarker = d3.select(this)
            .append('g')
            .attr('class', 'event-overlap-marker instance-node-hit-area')
            .attr('data-event-id', d.id)
            .attr('data-shared', String(Boolean(d.isShared)))
            .attr('transform', 'translate(-11,13)');

        overlapMarker.append('rect')
            .attr('class', 'event-overlap-hit-area')
            .attr('x', -10)
            .attr('y', -10)
            .attr('width', 24)
            .attr('height', 16)
            .style('fill', 'transparent');

        overlapMarker.append('text')
            .attr('class', 'event-overlap-count')
            .text(`×${overlapCount}`);
    });

    eventGroups.append('circle')
        .attr('id', d => `node-${d.id}`) // keys to find these elements
        .attr('data-event-id', d => d.id)
        .attr('data-shared', d => String(Boolean(d.isShared)))
        .attr('r', 2)
        .attr('class', `${classNameNode} instance-node`)
        .attr('data-caseid', d => caseAccessor(d))        //  caseId
        .attr('case', caseAccessor)
        .attr('activity', actAccessor)
        .attr('timestamp', timeAccessor)
        .attr('resource', resAccessor);

    eventGroups
        .filter(d => d.isAggregateNode)
        .append('text')
        .attr('class', 'aggregate-node-count')
        .attr('x', 10)
        .attr('y', -7)
        .text(d => `×${d.aggregateCount ?? 1}`);

    const aggregateArrowheads = aggregateEdges
        .map(edgeDatum => ({
            ...edgeDatum,
            arrowGlyph: makeAggregateArrowGlyph(edgeDatum, link),
        }))
        .filter(edgeDatum => edgeDatum.arrowGlyph);

    if (aggregateArrowheads.length > 0) {
        ctrInstance.append('g')
            .attr('class', 'aggregate-edge-arrowheads')
            .style('pointer-events', 'none')
            .selectAll('path')
            .data(aggregateArrowheads)
            .join('path')
            .attr('class', 'aggregate-edge-arrowhead')
            .attr('d', d => d.arrowGlyph)
            .style('fill', d => d.edgeColor ?? getEntityColor(d.perspective ?? d.entity))
            .style('fill-opacity', 0.95)
            .style('stroke', '#ffffff')
            .style('stroke-width', 0.8)
            .style('stroke-linejoin', 'round');
    }
}

export { makeAggregateArrowGlyph, renderInstanceGraph };
