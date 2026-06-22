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

// -----------------------------
// MAIN DRAWING FUNCTION for TIME ORDER MAP
// -----------------------------
// == IMPORT ==
import { convertLogtoGraph, getUniqueValues, sortStringArrayByStartNumber } from '../utils/processData.mjs';
import { idAccessor, timeAccessor, actAccessor, caseAccessor, resAccessor, nodes, edges } from '../utils/parsers.mjs';
import { dimensions } from '../layout/chartDimensions.mjs';
import { SCALE } from '../layout/scales.mjs';
import { drawAxis } from '../components/axes.mjs';
import { CONTOURGRAPH } from '../charts/contourGraph.mjs';
import { assignGraphByContours } from '../vizmodules/graphContoursMapping.mjs';
import { multiLevelGraphBuilder } from '../vizmodules/multiLevelGraphBuilder.mjs';
import { renderInstanceGraph } from '../charts/instanceGraph.mjs';
import { renderAbstractionLevelGraph } from '../charts/modelabstractionlevelGraph.mjs';
import { defineArrowHeads } from '../components/arrowheads.mjs';
import { defineLinkVertical, defineLinkBezier } from '../vizmodules/linkCalculator.mjs';
import { buildCases, discoverContextCandidates, topKMetrics, jaccardOverlap } from '../utils/contextFeatures.mjs';
import { initTimeLens } from "../utils/timeLens.mjs";


// == MAIN GRAPH DRAWING FUNCTION ==
function TIMEORDERMAP(csvdata) {
    // Contour plot values
    let currentContourBandwidth = 60;
    let currentContourThreshold = 3;

    // LevelIndex tracker and transitions
    let levelIndex = -1;
    let previousLevelIndex = -1;
    let currentLevelIndex = -1;
    let toggleHideInstanceElements = false;
    let toggleContours = false;
    let switcherGradualElementRendering = 0;
    let opacityLevel = 1;
    let opacityLevelDFG = 0;
    let opacityLevelActRange = .8;
    let opacityLevelYAxis = 1;
    let toggleDFG = false;

    let selectedLevel = -1;
    let activeTopKCaseSet = null; // Set(caseId) or null

    let topKState = {
      caseSet: null,        // Set(caseId)
      colorMap: new Map()   // Map(caseId -> color string)
    }; // used by TimeLens to reuse Top-K colors

    let freqOpts = {
        freqThresholdAbs: null,      // Absolute threshold
        freqThresholdQuantile: 0.4,  // Quantile threshold starting point
        freqThresholdStepPerLevel: .1,
        freqWidthMin: 0.4,
        freqWidthMax: 6
    };


    console.info("csvdata :")
    console.log(csvdata)
    // Create graph data set
    const data = convertLogtoGraph(csvdata, caseAccessor, timeAccessor, actAccessor, idAccessor);

    const fullGraph = data;
    const fullNodes = nodes(fullGraph);
    const fullEdges = edges(fullGraph);

    // Data processing
    let activities = getUniqueValues(nodes(data), actAccessor);
    const xScale = SCALE.linear(d3.extent(nodes(data), timeAccessor), dimensions, { vertical: false });
    const yScale = SCALE.categories(activities, dimensions);

    console.log(nodes(data))

    // == CANVAS ==
    // Draw SVG
    const svg = d3.select('#chart')
        .append("svg")
        .attr("width", dimensions.width)
        .attr("height", dimensions.height)

    // Create marker points for arrowheads
    defineArrowHeads(svg);

    // Draw container
    const ctr = svg.append("g")
        .attr(
            "transform",
            `translate(${dimensions.margin.left}, ${dimensions.margin.top})`
        )

    // Draw edges for instance graph
    const linkInstance = defineLinkVertical(xScale, yScale);
    const linkBundled = defineLinkBezier(xScale, yScale);

    // == AXES ==
    // Draw x-axis
    drawAxis(ctr, xScale, 'bottom', dimensions, {
        className: 'x-axis',
        axisLabel: 'Relative time (in days)',
        labelDistance: -10,
        });

    // Draw y-axis
    drawAxis(ctr, yScale, 'left', dimensions, {
        className: 'y-axis',
        axisLabel: 'Activities',
        ticks: d3.max(nodes(data), caseAccessor),
        tickPadding: 15,
        removeDomain: true,      // remove the y-axis line domain
        opacity: opacityLevelYAxis
    });

    // == CONTOUR GRAPH ==
    let contours = CONTOURGRAPH.generateContours(nodes(data), currentContourBandwidth, currentContourThreshold, dimensions, timeAccessor, xScale, actAccessor, yScale);
    // Draw contour graph
    CONTOURGRAPH.drawContourGraph(contours, ctr);

    console.info("Instance graph data:")
    console.log(data)
    console.info("Contours data:")
    console.log(contours)

    // Creating multilevelgraph data
    let levelData = assignGraphByContours(data, contours, timeAccessor, xScale, actAccessor, yScale)
    console.info("Level data (nodes and edges for each level):")
    console.log(levelData)
    console.log(data)

    let multiLevelGraph = multiLevelGraphBuilder(data, levelData, timeAccessor, actAccessor);
    console.info("Multi level graph:")
    console.log(multiLevelGraph)

    // ============= topK: base on context ==============

    // prepare cases
    const cases = buildCases(csvdata);

    //============================ADVANCED===============================
    // Strategy2 Score3 (Not used)： Contour line coverage
    function contourCoverage(events, k, outLevel) {
      if (!events.length) return 0;
      let covered = 0;

      for (let i = 0; i < events.length; i++){
          const ev = events[i];
        const lvl = (ev.level ?? 0);
        if (lvl <= k) covered++;
      }
      return covered / events.length;
    }

    function buildActivityStatsAtLevel(multiLevelGraph, k) {
      const stats = new Map();
      //The x/y coordinates of the supernode at layer k
      const superNodes = multiLevelGraph[k]?.nodes || [];
      for (const sn of superNodes)
          stats.set(sn.y, { min: sn.x.min, mean: sn.x.mean, max: sn.x.max });
      return stats;
    }

    // Strategy2 Score4 (Not used): Supernode Alignment
    function supernodeFit(events, k, multiLevelGraph, timeAccessor, actAccessor) {
        if (!events.length) return 0;
      const stats = buildActivityStatsAtLevel(multiLevelGraph, k);
      let sum = 0, cnt = 0;

      for (let i = 0; i < events.length; i++){
        const ev = events[i];
        //get activity
        const st = stats.get(actAccessor(ev));
        if (!st) continue;

        const x = timeAccessor(ev);
        const {min, mean, max} = st;

        if (x < min || x > max) {
            sum += 0; cnt++; }
        else {
            const half = Math.max(1e-9, (max-min)/2);
            const score = Math.max(0, 1 - Math.abs(x-mean)/half);
            sum += score; cnt++;
        }
      }
      //The scoring result for the entire current path
      return cnt ? sum/cnt : 0;
    }

    function advancedDensityScoreFn(c, k) {
      const outLevel = contours.length;
      //w1 Weighting for contour lines w2 Weighting for time
      const w1 = 0.6, w2 = 0.4;
      const cov = contourCoverage(c.events, k, outLevel);
      const fit = supernodeFit(c.events, k, multiLevelGraph, timeAccessor, actAccessor);
      return w1*cov + w2*fit; // 0~1
    }


    //=============================BASIC=================================
    // prepare cases
    const casesSimple = buildCases(nodes(data));

    // function simpleCaseScore(c) {
    //   // Map the bucket to score
    //   const freqScoreMap = { low: 0.3, mid: 0.6, high: 1.0 };
    //   const durScoreMap  = { short: 0.5, medium: 1.0, long: 0.7 };
    //
    //   const fScore = freqScoreMap[c.variantFreqBucket] ?? 0.0;
    //   const dScore = durScoreMap[c.durationBucket] ?? 0.0;
    //
    //   // Simple linear combination, frequency is considered slightly more important.
    //   return 0.25 * fScore + 0.75 * dScore;
    // }

    //To test the effects of different alpha values
    function simpleCaseScore(c, alpha = 0.6) {
      const freqScoreMap = { low: 0.3, mid: 0.6, high: 1.0 };
      const durScoreMap  = { short: 0.5, medium: 1.0, long: 0.7 };

      const fScore = freqScoreMap[c.variantFreqBucket] ?? 0.0;
      const dScore = durScoreMap[c.durationBucket] ?? 0.0;

      // s_bucket = alpha * freq + (1-alpha) * dur
      return alpha * fScore + (1 - alpha) * dScore;
    }

    function makeDensityScoreFn(alpha) {
        console.log("using alpha =", alpha);
      return function (c, k) {
        return simpleCaseScore(c, alpha);
      };
    }


    function densityScoreFn(c, k) {
    // baseline (no level dependence)
      return simpleCaseScore(c);
    }

    //-- helpers --
    //group median value： for Top-K tie break
    function median(arr) {
      const xs = arr.filter(Number.isFinite).slice().sort((a, b) => a - b);
      if (!xs.length) return NaN;
      const mid = Math.floor(xs.length / 2);
      return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
    }

    function pickTopKInOneGroup(groupCases, K, levelK, densityScoreFn) {
      for (const c of groupCases) {
        c._score_bucket = densityScoreFn(c, levelK);
      }
      // The median of dur and freq within the group
      const medDur  = median(groupCases.map(c => +c.durationSec));
      const medFreq = median(groupCases.map(c => +c.variantFreq));

      // tiebreak Indicator，The closer to the median, the more representative
      for (const c of groupCases) {
        const dur  = +c.durationSec;
        const freq = +c.variantFreq;

        c._tb_durDist  = Number.isFinite(dur)  && Number.isFinite(medDur)  ? Math.abs(dur  - medDur)  : Number.POSITIVE_INFINITY;
        c._tb_freqDist = Number.isFinite(freq) && Number.isFinite(medFreq) ? Math.abs(freq - medFreq) : Number.POSITIVE_INFINITY;
      }

      // sort by score, then closeness to group median (stable by caseId)
      return groupCases
        .slice()
        .sort((a, b) =>
          (b._score_bucket - a._score_bucket)  ||
          (a._tb_durDist - b._tb_durDist) ||
          (a._tb_freqDist - b._tb_freqDist) ||
          String(a.caseId).localeCompare(String(b.caseId))
        )
        .slice(0, K);
        }

    // ========Top-K rule based on one-hot encoding========
    // Scan all cases, any activity that has occurred
    // register:1  examine:2 decide:3 release:4 check:5 pay:6  => vocab.size = 6
    function buildActivityVocab(cases) {
      const vocab = new Map(); // activity -> index
      for (const c of cases) {
        for (const a of c.activities) {
          if (!vocab.has(a)) vocab.set(a, vocab.size);
        }
      }
      return vocab;
    }

    //register, examine =>  [1,1,0,0,0,0]
    function vectorizeCaseByActivities(c, vocab) {
      const v = Array(vocab.size).fill(0);
      for (const a of c.activities) {
        const idx = vocab.get(a);
        if (idx != null) v[idx] = 1; // If +1, greater emphasis is placed on the repetition type of variants.
      }
      return v;
    }

    function cosine(a, b) {
      let dot = 0, na = 0, nb = 0;
      for (let i = 0; i < a.length; i++) {
        dot += a[i]*b[i];
        na  += a[i]*a[i];
        nb  += b[i]*b[i];
      }
      if (na === 0 || nb === 0) return 0;
      return dot / (Math.sqrt(na) * Math.sqrt(nb));
    }

    function pickTopKByCentrality(groupCases, K) {
      const vocab = buildActivityVocab(groupCases);
      const vecs = groupCases.map(c => vectorizeCaseByActivities(c, vocab));

      for (let i = 0; i < groupCases.length; i++) {
        let sum = 0, cnt = 0;
        for (let j = 0; j < groupCases.length; j++) {
          if (i === j) continue;
          sum += cosine(vecs[i], vecs[j]);
          cnt++;
        }
        groupCases[i]._score_cent = cnt ? sum / cnt : 0; // The average similarity for each case
      }

      return groupCases.slice().sort((a,b) => b._score_cent - a._score_cent).slice(0, K);
    }

    // --- experiment metrics ---
    function durationDev(topKCases, groupCases) {
        const m = median(groupCases.map(c => +c.durationSec || 0));
        const devs = topKCases.map(c => Math.abs((+c.durationSec || 0) - m));
        return devs.reduce((s,x)=>s+x,0) / Math.max(1, devs.length);
        }
    function meanCentrality(topKCases) {
        const vals = topKCases.map(c => +c._score_cent || 0);
        return vals.reduce((s,x)=>s+x,0) / Math.max(1, vals.length);
        }

   function meanBucketScore(topKCases) {
        const vals = topKCases.map(c => +c._score_bucket || 0);
        return vals.reduce((s,x)=>s+x,0) / Math.max(1, vals.length);
        }

     // === Top-K Control: Read context + K from the UI, then select the top K ===

    // Highlight function: Highlight the corresponding instance nodes based on the top K cases.
    function highlightTopK(topKCases) {
      // 1) 清空之前的状态
      d3.selectAll(".instance-node, .instance-edge")
        .classed("topk-node", false)
        .classed("topk-edge", false)
        .classed("dimmed", false)
        .style("stroke", null)
        .style("fill", null);

      if (!topKCases || topKCases.length === 0) {
        d3.select("#topk-info").text("Top-K: 0 traces.");
        activeTopKCaseSet = null
        topKState.colorMap = new Map();
        return;
      }

      //  fade everything else
      d3.selectAll(".instance-node, .instance-edge")
        .classed("dimmed", true);

      //  assign a color to each Top-k path
      const caseIds = topKCases.map(c => c.caseId);
      const colorScale = d3.scaleOrdinal()
        .domain(caseIds)
        .range(d3.schemeTableau10);   // 最多 10 种清晰的颜色

       const colorMap = new Map(caseIds.map(cid => [cid, colorScale(cid)]));

        activeTopKCaseSet = new Set(caseIds);
        topKState.caseSet = new Set(caseIds);
        topKState.colorMap = colorMap;

    // 对每条 Top-K case：整条路径（点+边）上色 + 去掉 dimmed
      topKCases.forEach(c => {
        const cid = c.caseId;
        const color = colorMap.get(cid);

        d3.selectAll(`.instance-node[data-caseid="${cid}"]`)
          .classed("dimmed", false)
          .classed("topk-node", true)
          .style("stroke", color)
          .style("fill", color);

        d3.selectAll(`.instance-edge[data-caseid="${cid}"]`)
          .classed("dimmed", false)
          .classed("topk-edge", true)
          .style("stroke", color);
      });

      d3.select("#topk-info").text(`Top-K: ${topKCases.length} traces (colored per trace).`);


    }


    // == INTERFACE ==
    // TODO: MODULARIZE INTERFACE

    d3.select("#slider-abstraction-level")
      .attr("min", -1)
      .attr("max", multiLevelGraph.length - 1)
      .attr("value", -1)
      .on("input", function () {
        selectedLevel = +this.value;
        const totalLevels = multiLevelGraph.length - 1;

        // adjust instance layer transparency by level
        if (selectedLevel >= 0) {
          opacityLevel = 1 - (selectedLevel / totalLevels);
          updateInstanceGraphOpacityLevel(switcherGradualElementRendering, opacityLevel);
        }

        // repaint the abstract layer， #graph-container not exist。。
        ctr.select("#abstraction-layer").remove();
        if (selectedLevel !== -1) {
          renderAbstractionLevelGraph(
            multiLevelGraph, selectedLevel, previousLevelIndex,
            linkBundled, ctr, xScale, yScale,
            { opacityLevelDFG, opacityLevelActRange, toggleHideInstanceElements, ...freqOpts }
          );
        }

        previousLevelIndex = selectedLevel;
        d3.select("#slider-abstraction-level-value").text(selectedLevel + 1);
      });

    // === Simple Topk UI ===
    const contextCandidates = discoverContextCandidates(casesSimple);
    // fill the UI dropdown menu
    const contextSelect = d3.select("#context-select");

    contextSelect.selectAll("option")
      .data(contextCandidates)
      .join("option")
      .attr("value", d => d.key)
      .text(d => d.label);

    // add context value dropdown menu
    const contextValueSelect = d3.select("#context-value-select");

    // List the top N most common values based on the current contextKey (avoiding hundreds of resources)
    function rebuildContextValueSelect(contextKey, maxGroups = 10) {
        // Map {
        //   "short" => 3,
        //   "long"  => 1
        // }
        const counts = d3.rollup(
            casesSimple,
            v => v.length,
            c => c[contextKey]
        );

        //map -> array
        const items = Array.from(counts, ([value, count]) => ({value, count}))
            .filter(d => d.value != null && d.value !== "")
            .sort((a, b) => b.count - a.count)  // 频率从高到低
            .slice(0, maxGroups);

        contextValueSelect
            .selectAll("option")
            .data(items, d => d.value)
            .join("option")
            .attr("value", d => d.value)
            .text(d => `${d.value} (${d.count})`);
    }

    const initialKey = contextCandidates.length ? contextCandidates[0].key : "durationBucket";
    rebuildContextValueSelect(initialKey);

    // rebuild dropdown menu
    contextSelect.on("change", function () {
      const contextKey = this.value;
      rebuildContextValueSelect(contextKey);
    });


    // Bind button event
    d3.select("#btn-topk-apply").on("click", function () {
      const contextKey   = d3.select("#context-select").property("value") || "durationBucket";
      const contextValue = d3.select("#context-value-select").property("value");
      const K = +d3.select("#topk-input").property("value") || 3;
      const k = selectedLevel;   // Should it be replaced with an advanced score in future, k will be used.

      // 1) Filter all cases within this group according to the selected context value.
      let groupCases = casesSimple.filter(c => c[contextKey] === contextValue);
      console.log("Bucket distribution (freqBucket × durationBucket):");
        console.table(
          d3.rollups(
            groupCases,
            v => v.length,
            d => d.variantFreqBucket,
            d => d.durationBucket
          )
        );

      console.info(`Selected group: ${contextKey} = ${contextValue}, size = ${groupCases.length}`);

      if (groupCases.length === 0) {
        d3.select("#topk-info").text("No cases for this group.");
        highlightTopK([]);
        return;
      }

      // 2) Within this group, performing Top-K can be done either by bucket or by one-hot encoding.
        const method = d3.select("#topk-method").property("value") || "bucket";

        let topK;
        if (method === "onehot") {
          topK = pickTopKByCentrality(groupCases, K);
        } else {
          topK = pickTopKInOneGroup(groupCases, K, k, densityScoreFn);
        }

        //========= test Alpha (0.25, 0.5, 0.75）============
        // alpha sweep
        const alphas = [0.25, 0.5, 0.6, 0.75];
        const topK_by_alpha = new Map();

        for (const a of alphas) {
          const scoreFn = makeDensityScoreFn(a);
          const topK_a = pickTopKInOneGroup(groupCases, K, k, scoreFn);
          topK_by_alpha.set(a, topK_a);
        }

        // reference alpha = 0.6
        const topK_ref = topK_by_alpha.get(0.6);

        // print Jaccard vs reference
        const sweepRows = alphas
          .filter(a => a !== 0.6)
          .map(a => ({
            alpha: a,
            jaccard_vs_06: +jaccardOverlap(topK_by_alpha.get(a), topK_ref).toFixed(3),
            topK_caseIds: topK_by_alpha.get(a).map(d => d.caseId).join(", ")
          }));

        console.table(sweepRows);

        const j025 = jaccardOverlap(topK_by_alpha.get(0.25), topK_ref);
        const j05  = jaccardOverlap(topK_by_alpha.get(0.5),  topK_ref);
        const j075 = jaccardOverlap(topK_by_alpha.get(0.75), topK_ref);

        console.log(
          `[LaTeX row]  & ${j025.toFixed(3)} & ${j05.toFixed(3)} & ${j075.toFixed(3)} \\\\`
        );

        const topK_bucket = topK_ref;
        // ===== end alpha sweep =====

        const topK_cent   = pickTopKByCentrality(groupCases, K);
        const overlap = jaccardOverlap(topK_bucket, topK_cent);

        console.table([
          {
            method: "Bucket ",
            K,
            meanScore: +meanBucketScore(topK_bucket).toFixed(3),
            uniqueVariants: topKMetrics(topK_bucket).variantDiversity,
            jaccardOverlap: +overlap.toFixed(3),
            durationDev: +durationDev(topK_bucket, groupCases).toFixed(1)
          },
          {
            method: "Centrality (multi-hot)",
            K,
            meanScore: +meanCentrality(topK_cent).toFixed(3),
            uniqueVariants: topKMetrics(topK_cent).variantDiversity,
            jaccardOverlap: +overlap.toFixed(3),
            durationDev: +durationDev(topK_cent, groupCases).toFixed(1)
          }
        ]);

        const topK_final = (method === "onehot") ? topK_cent : topK_bucket;

      // 4) highlight Top-K
      highlightTopK(topK_final);

      d3.select("#topk-info")
        .text(`Top-K = ${topK.length} traces for ${contextKey} = ${contextValue}.`);
      });

      d3.select("#btn-topk-clear").on("click", function () {
      highlightTopK([]);
      d3.select("#topk-info").text("Top-K: off.");
      });

      // Threshold UI

    // Absolute threshold: #abs-threshold (numeric input field; if empty, proceed to decimals)
    d3.select('#abs-threshold').on('input', function () {
      const raw = this.value.trim();// because google allow input like ".2"
      const v = parseFloat(raw);
      freqOpts.freqThresholdAbs = (raw === '' || !Number.isFinite(v)) ? null : v

      if (selectedLevel === -1) return;
       renderAbstractionLevelGraph(multiLevelGraph, selectedLevel, previousLevelIndex, linkBundled, ctr, xScale, yScale, {opacityLevelDFG, opacityLevelActRange, toggleHideInstanceElements, ...freqOpts});
    });

    // Quantile threshold starting point：#quantile（0~0.999）
    d3.select('#quantile').on('input', function () {
        const v = Math.max(0, Math.min(0.999, parseFloat(this.value) || 0));
        freqOpts.freqThresholdQuantile = v;
        d3.select('#quantile-value').text(v.toFixed(1));

      if (selectedLevel === -1) return;
     renderAbstractionLevelGraph(multiLevelGraph, selectedLevel, previousLevelIndex, linkBundled, ctr, xScale, yScale, {opacityLevelDFG, opacityLevelActRange, toggleHideInstanceElements, ...freqOpts});
    });

    // Incremental step size per layer：#quantile-step（0~0.5）
    d3.select('#quantile-step').on('input', function () {
        const v = Math.max(0, Math.min(0.5, parseFloat(this.value) || 0));
        freqOpts.freqThresholdStepPerLevel = v;
        d3.select('#quantile-step-value').text(v.toFixed(1));
      if (selectedLevel === -1) return;
      renderAbstractionLevelGraph(multiLevelGraph, selectedLevel, previousLevelIndex, linkBundled, ctr, xScale, yScale, {opacityLevelDFG, opacityLevelActRange, toggleHideInstanceElements, ...freqOpts});
    });

    // Contour bandwidth slider
    d3.select("#contour-bandwidth-slider").on("input", function() {
        currentContourBandwidth = +this.value;
        d3.select("#contour-bandwidth-value").text(currentContourBandwidth);
        //updateContours();
        console.log("Contour graph with new values:")
        // Generate new contours with current values of bandwidth and thresholds
        contours = CONTOURGRAPH.generateContours(nodes(data), currentContourBandwidth, currentContourThreshold, dimensions, timeAccessor, xScale, actAccessor, yScale);

        console.log("Contours data:", contours.length)
        // Re-render the contour graph with the new contours
        CONTOURGRAPH.drawContourGraph(contours, ctr);

        d3.select(".contour-graph")
            .style("display", toggleContours ? "block" : "none");
    });

    d3.select("#contour-threshold-slider").on("input", function() {
        currentContourThreshold = +this.value;
        d3.select("#contour-threshold-value").text(currentContourThreshold);
        //updateContours();
        console.log("Contour graph with new values:")
        // Generate new contours with current values of bandwidth and thresholds
        contours = CONTOURGRAPH.generateContours(nodes(data), currentContourBandwidth, currentContourThreshold, dimensions, timeAccessor, xScale, actAccessor, yScale);

        console.log("Contours data:", contours.length)
        // Re-render the contour graph with the new contours
        CONTOURGRAPH.drawContourGraph(contours, ctr);

        d3.select(".contour-graph")
            .style("display", toggleContours ? "block" : "none");
    });

    // Update multilevel graph
    d3.select("#button-update-abstraction-graph").on("click", function() {
        //updateMultiLevelGraph();  // Call the function that updates the abstraction graph
        // Return updating message
        d3.select("#graph-update-status").text("Updating graph...");

        // Reset the level indices
        levelIndex = -1;
        previousLevelIndex = -1;

        // Regenerate the multi-level graph
        levelData = assignGraphByContours(data, contours, timeAccessor, xScale, actAccessor, yScale);
        multiLevelGraph = multiLevelGraphBuilder(data, levelData, timeAccessor, actAccessor);

        // Reset the abstraction level slider
        d3.select("#slider-abstraction-level")
            .attr("max", multiLevelGraph.length - 1)
            .property("value", -1)  // Reset to default level (e.g., -1 means "off")
            .dispatch("input");

        //Reset the abstraction level
        renderAbstractionLevelGraph(multiLevelGraph, levelIndex, previousLevelIndex, linkBundled, ctr, xScale, yScale, {opacityLevelDFG: opacityLevelDFG, opacityLevelActRange: opacityLevelActRange, toggleHideInstanceElements: toggleHideInstanceElements})
        previousLevelIndex = currentLevelIndex;

        // Show finished message
        d3.select("#graph-update-status").text("Successful graph update!");
        setTimeout(() => {d3.select("#graph-update-status").text("")}, 3000);
    });

    // Instance element rendering toggle
    d3.select("#toggle-instance-element-rendering").on("change", function () {
        toggleHideInstanceElements = this.checked;
    });

    // Contour lines rendering toggle

    d3.select("#toggle-contour-lines").on("change", function () {
        toggleContours = this.checked;
        // Show/Hide the contour lines
            d3.select(".contour-graph")
            .transition()
            .duration(100)
            .style("display", toggleContours ? "block" : "none");
            //.style("stroke-opacity", toggleContours ? .5 : 0);
    });

    // Instance element rendering toggle
    d3.select("#toggle-dfg-graph").on("change", function () {
        toggleDFG = this.checked;
        opacityLevelDFG = toggleDFG ? .95 : 0;
        opacityLevelYAxis = toggleDFG ? .1 : 1;
        opacityLevelActRange = toggleDFG ? .1 : .8;

        d3.selectAll(".activity-classic")
            .transition()
            .duration(100)
            .style("opacity", opacityLevelDFG);
        d3.selectAll(".activity-label")
            .transition()
            .duration(100)
            .style("opacity", opacityLevelDFG);
        d3.select(".y-axis")
            .transition()
            .duration(100)
            .style("opacity", opacityLevelYAxis);
        d3.select(".x-axis")
            .transition()
            .duration(100)
            .style("opacity", opacityLevelYAxis);
        d3.selectAll(".activity-range")
            .transition()
            .duration(100)
            .style("opacity", opacityLevelActRange);
        console.log("DFG hider toggle is now:", toggleDFG);
    });


    // Instance element rendering toggle
    d3.selectAll('input[name="option-switcher-value"]').on("change", function () {
        switcherGradualElementRendering = +this.value;
        updateInstanceGraphOpacityLevel(switcherGradualElementRendering, opacityLevel);
    });
    function updateInstanceGraphOpacityLevel(switcherGradualElementRendering, opacityLevel) {
        if (switcherGradualElementRendering === 1) {
            d3.select(".instance-edges")
                .transition()
                .duration(50)
                .style("opacity", opacityLevel)
            d3.select(".instance-graph")
                .style("opacity", 1)
        } else if (switcherGradualElementRendering === 2) {
            d3.select(".instance-graph")
                .transition()
                .duration(50)
                .style("opacity", opacityLevel)
            d3.selectAll(".instance-edges")
                .style("opacity", opacityLevel)
        } else {
            d3.selectAll(".instance-graph, .instance-edges")
                .style("opacity", 1)
        }
    }

    renderInstanceGraph(data, linkInstance, ctr, timeAccessor, xScale, actAccessor, yScale);

    const lens = initTimeLens({
      root: d3.select("#chart"),
      plotG: ctr,
      plotWidth: dimensions.ctrWidth,
      plotHeight: dimensions.ctrHeight,

      xScale,
      yScale,
      timeAccessor,
      actAccessor,

        data: fullNodes,

        toGraph: (winNodes) => {
        // If Top-K is enabled: Only retain nodes belonging to the Top-K
        const nodesFiltered = activeTopKCaseSet
          ? winNodes.filter(d => activeTopKCaseSet.has(caseAccessor(d)))
          : winNodes;

        const keep = new Set(nodesFiltered.map(idAccessor));// keep node ids

        //keep edges where both endpoints are visible (+ Top-K filter if enabled)
        const edgesFiltered = fullEdges.filter(e => {
          if (!keep.has(e.source) || !keep.has(e.target)) return false;
          if (activeTopKCaseSet) return activeTopKCaseSet.has(e.entity);
          return true;
        });

        return { graph: fullGraph.graph, nodes: nodesFiltered, edges: edgesFiltered };
      },

      renderInstance: (insetG, graphData, linkFn, insetX, insetY) => {
        renderInstanceGraph(graphData, linkFn, insetG, timeAccessor, insetX, actAccessor, insetY);
      },
        overlayPadLeft: dimensions.margin.left,
        getTopKState: () => topKState,
    });

    lens.setWindowHalf(2);

    //  User-input total width
    d3.select("#lens-window")
        .on("input.lens", null)
        .on("input.lens", function () {
          const full = +this.value;
          if (!Number.isFinite(full) || full <= 0) return;
          lens.setWindowHalf(full / 2);
    });

    console.log("end")
};

export { TIMEORDERMAP };