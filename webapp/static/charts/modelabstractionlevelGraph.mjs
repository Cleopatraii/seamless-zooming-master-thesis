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

function renderAbstractionLevelGraph(
    multilevelGraphData, currentLevelIndex, previousLevelIndex, 
    link, container, xScale, yScale, options = {}) {
    // Graph initialization
    const {
        // Names for instance graph
        classNameInstanceGraph = "instance-graph",
        classNameHiddenInstanceNodes = "hidden-instance-nodes",
        classNameHiddenInstanceEdges = "hidden-instance-edges",
        // Names for abstraction layer graph
        classNameAbstractionLevelGraph = "abstraction-layer",
        classNameAbstractionLevelNodes = "supernodes",
        classNameAbstractionLevelEdges = "superedges",
        // Edge drawing options
        strokeWidth = 1.2,
        classNameAbstractLevelEdgeUp = "link-abstract-up",
        classNameAbstractLevelEdgeDown = "link-abstract-down",
        classNameArrowHeadUp = "arrowhead-up",
        classNameArrowHeadDown = "arrowhead-down",
        // Node drawing options
        classNameRectNode = "activity-range",
        classNameCircleNode = "event-circle-mean",
        classRectNodeHeight = 10,
        // Node drawing for classic activity boxes
        classNameClassicActivityGroup = "classic-activity-group",
        classNameClassicRectNodeName = "activity-classic",
        classNameClassicActivityLabel = "activity-label",
        classClassicRectNodeHeight = 14,
        classClassicRectNodeWidth = 120,
        classClassicRectNodeTextAlignment = "middle",
        // Opacity levels
        opacityLevelDFG = 0,
        opacityLevelActRange = .8,
        toggleHideInstanceElements = false,

    } = options;
    
    const __t0 = performance.now();
    // Hide previous layer
    container.select(`#${classNameAbstractionLevelGraph}`).remove();
    console.log(currentLevelIndex)

    // Initialize data for the abstraction layer
    const levelGraph = multilevelGraphData[currentLevelIndex];
    let nodes = [];
    let edges = [];
    let instanceNodeIds = [];
    let instanceEdgeIds = [];
    if (levelGraph) {
        nodes = levelGraph.nodes;
        edges = levelGraph.edges;
        instanceNodeIds = nodes.flatMap(d => d.has.map(id => `#node-${id}`));
        instanceEdgeIds = edges.flatMap(d => d.has.map(id => `#edge-${id}`));
    }
    console.log(`Prev: ${previousLevelIndex}, Curr: ${currentLevelIndex}`)

    // == LAYERS CHECK ==
    // Show/Hide instance nodes and edges (go up in the slider)
    if (toggleHideInstanceElements) {
        if (previousLevelIndex <= currentLevelIndex) {
            d3.selectAll(instanceNodeIds.join(",")).classed(classNameHiddenInstanceNodes, true);
            d3.selectAll(instanceEdgeIds.join(",")).classed(classNameHiddenInstanceEdges, true);
        } else if (previousLevelIndex > currentLevelIndex) {
            // Unhide the previously hidden nodes and edges (go down in the slider)
            d3.selectAll(`.${classNameInstanceGraph} .${classNameHiddenInstanceNodes}`).classed(classNameHiddenInstanceNodes, false);
            d3.selectAll(`.${classNameInstanceGraph} .${classNameHiddenInstanceEdges}`).classed(classNameHiddenInstanceEdges, false);
            d3.selectAll(instanceNodeIds.join(",")).classed(classNameHiddenInstanceNodes, true);
            d3.selectAll(instanceEdgeIds.join(",")).classed(classNameHiddenInstanceEdges, true);
        }
    }

    if (!levelGraph) return;
    // console.log("=== Debug superedges @ level", currentLevelIndex, "===");
    // console.table(edges.slice(0, 20).map(e => ({
    //   source: e.source,
    //   target: e.target,
    //   frequency: e.frequency,
    //   hasLen: e.has?.length
    // })));

    // Remove previous abstraction layer
    const layer = container.append("g").attr("id", classNameAbstractionLevelGraph);
    

    // // == SUPER EDGES ==
    // // Create a super edges group
    // const superEdgesGroup = layer.append("g").attr("class", classNameAbstractionLevelEdges);
    //
    // superEdgesGroup.selectAll("path")
    //     .data(edges)
    //     .join("path")
    //     .attr("d", link)
    //     .attr("fill", "none")
    //     .attr("stroke-width", strokeWidth)
    //     .attr('class', d =>
    //         yScale(d.source_coordinates[1]) > yScale(d.target_coordinates[1])
    //             ? classNameAbstractLevelEdgeUp
    //             : classNameAbstractLevelEdgeDown
    //         )
    //     .attr("marker-end", d =>
    //         yScale(d.source_coordinates[1]) > yScale(d.target_coordinates[1])
    //             ? `url(#${classNameArrowHeadUp})`
    //             : `url(#${classNameArrowHeadDown})`
    //         );
    
    // == SUPER EDGES (frequency-aware) ==
    const {
      // Inherit origin Option, add more..
      freqWidthMin = 0.8,          // Minimum line width
      freqWidthMax = 6,            // Maximum line width
      freqThresholdAbs = null,     // Absolute threshold, priority over quantile thresholds
      freqThresholdQuantile = 0.0, // quantile thresholds
      freqThresholdStepPerLevel = 0.0 // quantile threshold increment per level
    } = options;

    const superEdgesGroup = layer.append("g").attr("class", classNameAbstractionLevelEdges);

    // line width scale
    const freqs = edges.map(e => e.frequency ?? 1).filter(Number.isFinite);
    const sortedFreqs = [...freqs].sort(d3.ascending);

    const lo = d3.quantileSorted(sortedFreqs, 0.10) ?? sortedFreqs[0] ?? 1;
    const hi = d3.quantileSorted(sortedFreqs, 0.90) ?? sortedFreqs[sortedFreqs.length - 1] ?? lo;

    const widthScale = d3.scaleSqrt()
      .domain(lo === hi ? [0, hi || 1] : [lo, hi])
      .range([freqWidthMin, freqWidthMax])
      .clamp(true);

    const opacityScale = d3.scaleLinear()
      .domain([lo, hi])
      .range([0.10, 0.95])
      .clamp(true);

    // threshold
   const minSupport = 2;
    let kept = edges.filter(e => (e.frequency ?? 1) >= minSupport);

    if (kept.length) {
      if (Number.isFinite(freqThresholdAbs)) {
        kept = kept.filter(e => (e.frequency ?? 1) >= freqThresholdAbs);
      } else {
        const q = Math.min(
          0.999,
          Math.max(0, freqThresholdQuantile + currentLevelIndex * freqThresholdStepPerLevel)
        );

        const freqsKept = kept.map(e => e.frequency ?? 1);
        const sortedFreqs = [...freqsKept].sort(d3.ascending);

        const cut = d3.quantileSorted(sortedFreqs, q) ?? 0;
        kept = kept.filter(e => (e.frequency ?? 1) >= cut);
      }
    }

    // IMPORTANT: draw order (thin first, thick last)
    kept = kept.slice().sort((a, b) => (a.frequency ?? 1) - (b.frequency ?? 1));

    //Evaluation Metric
    // ---- Strategy 1 metrics (console) ----
    const E_all = edges.length;
    const E_kept = kept.length;
    const V = nodes.length;
    const suppression = E_all ? (1 - (E_kept / E_all)) : 0;

    const msg = {
      level: currentLevelIndex,
      V_super: V,
      E_all,
      E_kept,
      suppression: +suppression.toFixed(4),
      mode: Number.isFinite(freqThresholdAbs) ? "abs" : "quantile",
      abs: freqThresholdAbs,
      q0: freqThresholdQuantile,
      step: freqThresholdStepPerLevel
    };
    console.table([msg]);

    superEdgesGroup.selectAll("path")
      .data(kept, d => `${d.source}→${d.target}`)
      .join(
        enter => enter.append("path")
          .attr("fill", "none")
          .attr("marker-end", d =>
            yScale(d.source_coordinates[1]) > yScale(d.target_coordinates[1])
              ? `url(#${classNameArrowHeadUp})`
              : `url(#${classNameArrowHeadDown})`
          )
          .attr("class", d =>
            yScale(d.source_coordinates[1]) > yScale(d.target_coordinates[1])
              ? classNameAbstractLevelEdgeUp
              : classNameAbstractLevelEdgeDown
          ),
        update => update,
        exit => exit.remove()
      )
      .attr("d", link)
        .attr("stroke", "#111")
      .attr("stroke-width", d => widthScale(d.frequency ?? 1))
      .attr("stroke-opacity", d => opacityScale(d.frequency ?? 1))
      .attr("stroke-linecap", "round")
      .attr("stroke-linejoin", "round");


    // === SUPER NODES ===
    // Create a super nodes group
    const superNodesGroup = layer.append("g").attr("class", classNameAbstractionLevelNodes);

    // Draw super nodes as boxes (range)
    const superNodeRects = superNodesGroup.selectAll("rect")
        .data(nodes)
        .join("rect")
        .attr("x", d => xScale(d.x.min) - 7)
        .attr("y", d => yScale(d.y) - 5)
        .attr("width", d => xScale(d.x.max) - xScale(d.x.min) + 14)
        .attr("height", classRectNodeHeight)
        .attr("rx", 5)
        .attr("ry", 5)
        .attr("class", classNameRectNode)
        .attr("opacity", opacityLevelActRange)

    // Draw super nodes as circles (mean)
    const superNodeCircles = superNodesGroup.selectAll("circle")
        .data(nodes)
        .join("circle")
        .attr("cx", d => xScale(d.x.mean))
        .attr("cy", d => yScale(d.y))
        .attr("r", 5)
        .attr("class", classNameCircleNode)

    // Draw classic activity boxes 
    const classicActivityGroup = layer.append("g").attr("class", classNameClassicActivityGroup);
    classicActivityGroup.selectAll("rect")
        .data(nodes)
        .join("rect")
        .attr("x", d => xScale(d.x.mean) - 60)
        .attr("y", d => yScale(d.y) - 7)
        .attr("width", classClassicRectNodeWidth)
        .attr("height", classClassicRectNodeHeight)
        .attr("rx", 5)
        .attr("ry", 5)
        .attr("class", classNameClassicRectNodeName)
        .style("opacity", opacityLevelDFG)

        console.log("Classic activity group:", nodes)

    classicActivityGroup.selectAll("text")
        .data(nodes)
        .join("text")
        .attr("x", d => xScale(d.x.mean))  // center of the box
        .attr("y", d => yScale(d.y))   // vertically centered, adjust as needed
        .attr("text-anchor", classClassicRectNodeTextAlignment)     // center align
        .attr("alignment-baseline", classClassicRectNodeTextAlignment)
        .attr("class", classNameClassicActivityLabel)
        .text(d => {
            const label = d.y;
            const maxLength = 20;
            return label.length > maxLength 
                ? label.slice(0, maxLength - 1) + "…" 
                : label;
            })
        .style("opacity", opacityLevelDFG);

    const __ms = performance.now() - __t0;
    console.log(`[S1] render level=${currentLevelIndex} time=${__ms.toFixed(1)}ms (~${(1000/__ms).toFixed(1)} FPS)`);

}

export { renderAbstractionLevelGraph };