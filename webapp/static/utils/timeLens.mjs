/*
SEAMLESS_ZOOM — A technique for seamless zooming between process models and process instances.
...
*/

// utils/timeLens.mjs
import { defineLinkBezier } from "../vizmodules/linkCalculator.mjs";

function initTimeLens(cfg) {
  const {
    root, //chart container
    plotG,
    plotWidth,
    plotHeight,
    xScale,
    yScale,
    timeAccessor,
    actAccessor,
    data,
    toGraph,
    renderInstance,
    overlayPadLeft = 0,
    insetWidth = 420,
    insetHeight = 260,
    onWindowChange = null,
    getTopKState = null,
    getWindowUnit = null,
  } = cfg;

  if (!root || !plotG) throw new Error("initTimeLens: root and plotG are required");
  if (!xScale || !yScale) throw new Error("initTimeLens: xScale/yScale required");
  if (!Array.isArray(data)) throw new Error("initTimeLens: data must be an array");
  if (typeof toGraph !== "function") throw new Error("initTimeLens: toGraph must be a function");
  if (typeof renderInstance !== "function") throw new Error("initTimeLens: renderInstance must be a function");


  // Lens state
  let pinned = false;
  let pinnedWindow = null; // {t0, t1}
  let hoverWindow = null;  // {t0, t1}
  let windowHalf = cfg.windowHalf ?? 2         // hover lens shows [t-windowDays, t+windowDays]

  // floating inset panel (root should be position: relative)
  const panelId = "time-lens-panel";
  root.select(`#${panelId}`).remove();
  let panelPos = { x: 12, y: 12 };

  const panel = root
    .append("div")
    .attr("id", panelId)
    .style("position", "absolute")
    .style("left", `${panelPos.x}px`)
    .style("top", `${panelPos.y}px`)
    .style("right", null)
    .style("width", `${insetWidth}px`)
    .style("height", `${insetHeight}px`)
    .style("border", "1px solid #ddd")
    .style("border-radius", "10px")
    .style("background", "white")
    .style("box-shadow", "0 4px 14px rgba(0,0,0,0.12)")// White background, obscuring the image beneath
    .style("display", "none")
    .style("overflow", "hidden")
    .style("z-index", 50);

  const header = panel
    .append("div")
    .style("display", "flex")
    .style("align-items", "center")
    .style("justify-content", "space-between")
    .style("padding", "8px 10px")
    .style("border-bottom", "1px solid #eee")
    .style("font", "12px/1.2 sans-serif");

  const title = header.append("div").text("Time Lens");

  const closeBtn = header
    .append("button")
    .attr("type", "button")
    .style("border", "none")
    .style("background", "transparent")
    .style("cursor", "pointer")
    .style("font", "16px/1 sans-serif")
    .text("×");

  // clamp v to [a, b]
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  let dragging = false;
  let dragDx = 0, dragDy = 0;

  // drag panel via header
  header
    .style("cursor", "move")
    .on("mousedown.timeLensDrag", (event) => {
      dragging = true;

      const rootRect  = root.node().getBoundingClientRect();
      const panelRect = panel.node().getBoundingClientRect();

      // Click the mouse on the offset in the top-left corner of the panel.
      dragDx = event.clientX - panelRect.left;
      dragDy = event.clientY - panelRect.top;

      event.preventDefault();
      event.stopPropagation();
    });

  d3.select(window).on("mousemove.timeLensDrag", (event) => {
    if (!dragging) return;

    const rootRect = root.node().getBoundingClientRect();

    // panel position in root coords (top-left)
    let x = (event.clientX - rootRect.left) - dragDx;//Current mouse position within the chart coordinate system - Offset of mouse relative to left edge of panel = Position 1 at top-left corner of current panel
    let y = (event.clientY - rootRect.top)  - dragDy;

    // Restricted to the root scope
    x = clamp(x, 0, rootRect.width  - insetWidth);
    y = clamp(y, 0, rootRect.height - insetHeight);

    panelPos = { x, y };
    panel
      .style("left", `${x}px`)
      .style("top", `${y}px`)
      .style("right", null);
  });

  d3.select(window).on("mouseup.timeLensDrag", () => {
    dragging = false;
  });


  const svg = panel
    .append("svg")
    .attr("width", insetWidth)
    .attr("height", insetHeight - 34);

  const insetMargin = { top: 12, right: 12, bottom: 28, left: 120 };

  const insetG = svg
    .append("g")
    .attr("transform", `translate(${insetMargin.left},${insetMargin.top})`);

  const insetInnerWidth = insetWidth - insetMargin.left - insetMargin.right;
  const insetInnerHeight = (insetHeight - 34) - insetMargin.top - insetMargin.bottom;

  // overlay captures mouse events in plot coordinates
  const overlay = plotG
    .insert("rect", ":first-child")
    .attr("class", "time-lens-overlay")
    .attr("x", -overlayPadLeft)
    .attr("y", 0)
    .attr("width", plotWidth + overlayPadLeft)
    .attr("height", plotHeight)
    .attr("fill", "transparent")

    .style("pointer-events", "all");


  //  support Shift-drag
  let brushing = false;
  let brushX0 = null;
  const brushRect = plotG
    .append("rect")
    .attr("class", "time-lens-brush-rect")
    .attr("y", 0)
    .attr("height", plotHeight)
    .attr("fill", "rgba(0,0,0,0.06)")
    .attr("stroke", "rgba(0,0,0,0.25)")
    .attr("display", "none");

  // panel helpers
  function showPanel() {
    panel.style("display", "block");
  }

  function hidePanel() {
    panel.style("display", "none");
  }

  const unitConfig = {
    days: { suffix: "d" },
    hours: { suffix: "h" },
    minutes: { suffix: "m" },
    seconds: { suffix: "s" },
  };

  function currentUnitConfig() {
    const unit = typeof getWindowUnit === "function" ? getWindowUnit() : "days";
    return unitConfig[unit] ?? unitConfig.days;
  }

  function formatTimeValue(days) {
    const unit = typeof getWindowUnit === "function" ? getWindowUnit() : "days";
    if (unit === "days") {
      return `${Number(days.toFixed(2))}d`;
    }

    const sign = days < 0 ? "-" : "";
    const absoluteSeconds = Math.round(Math.abs(days) * 24 * 60 * 60);
    const dayIndex = Math.floor(absoluteSeconds / 86400);
    const secondsInDay = absoluteSeconds % 86400;
    const hours = Math.floor(secondsInDay / 3600);
    const minutes = Math.floor((secondsInDay % 3600) / 60);
    const seconds = secondsInDay % 60;
    const hh = String(hours).padStart(2, "0");
    const mm = String(minutes).padStart(2, "0");
    const ss = String(seconds).padStart(2, "0");

    if (unit === "seconds") {
      return `${sign}D${dayIndex} ${hh}:${mm}:${ss}`;
    }
    return `${sign}D${dayIndex} ${hh}:${mm}`;
  }

  function setTitleText(t0, t1, isPinned) {

    const tag = isPinned ? "Pinned" : "Hover";
    title.text(`${tag} window: [${formatTimeValue(t0)}, ${formatTimeValue(t1)}]`);
  }

  // events within [t0, t1] (inclusive)
  function filterEventsByWindow(t0, t1) {
    // inclusive window
    return data.filter((d) => {
      const t = timeAccessor(d);
      return t >= t0 && t <= t1;
    });
  }

  function nearestEventTime(targetTime) {
    let bestTime = targetTime;
    let bestDistance = Infinity;

    data.forEach((event) => {
      const eventTime = timeAccessor(event);
      if (!Number.isFinite(eventTime)) return;
      const distance = Math.abs(eventTime - targetTime);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestTime = eventTime;
      }
    });

    return bestTime;
  }

  function renderWindow(t0, t1, isPinned) {
    const [d0, d1] = xScale.domain();
    t0 = Math.max(d0, t0);
    t1 = Math.min(d1, t1);

    //Avoid t0==t1
    if (t1 - t0 < 1e-9) t1 = t0 + 1e-9;
    // if window is empty, still show panel but indicate empty

    showPanel();
    setTitleText(t0, t1, isPinned);

    // inset x-scale: domain = [t0, t1]
    const insetXScale = d3
      .scaleLinear()
      .domain([t0, t1])
      .range([0, insetInnerWidth]);

    // inset y-scale uses same activity domain
    // range use insetInnerHeight
     const insetYScale = d3.scalePoint()
    .domain(yScale.domain())
    .range([insetInnerHeight, 0])
    .padding(1);

    // clear inset
    insetG.selectAll("*").remove();

    const events = filterEventsByWindow(t0, t1);
    if (!events.length) {
      insetG
        .append("text")
        .attr("x", 6)
        .attr("y", 18)
        .style("font", "12px sans-serif")
        .text("No events in this window.");
      if (typeof onWindowChange === "function") onWindowChange({ t0, t1, pinned: isPinned });
      return;
    }

    // --- inset axes (readable scales) ---
    const axesG = insetG.append("g").attr("class", "inset-axes");

    // x-axis at bottom
    axesG.append("g")
      .attr("transform", `translate(0,${insetInnerHeight})`)//Move the x-axis to the bottom
      .call(d3.axisBottom(insetXScale).ticks(5).tickFormat(formatTimeValue).tickSizeOuter(0));

    // y-axis: only activities that appear in this window
    const insetGraphData = toGraph(events);
    const actSet = new Set(insetGraphData.nodes.map(actAccessor));
    const shownActs = insetYScale.domain().filter(a => actSet.has(a));

    axesG.append("g")
      .call(d3.axisLeft(insetYScale).tickValues(shownActs).tickSizeOuter(0));

    // style a bit
    axesG.selectAll("text").style("font", "10px sans-serif");
    axesG.selectAll("path,line").style("stroke-opacity", 0.4);


    // link function for inset: use same bezier style but with inset scales
    const insetLink = defineLinkBezier(insetXScale, insetYScale, { curveStrength: 0.3 });

    // delegate actual drawing
    renderInstance(insetG, insetGraphData, insetLink, insetXScale, insetYScale);

    // apply Top-K colors in inset (if available)
    const st = (typeof getTopKState === "function") ? getTopKState() : null;
    const caseSet = st?.caseSet;
    const colorMap = st?.colorMap;

    if (caseSet && colorMap && colorMap.size) {
      // Overall dimmed
      insetG.selectAll(".instance-node, .instance-edge").classed("dimmed", true);

      for (const [cid, color] of colorMap.entries()) {
        insetG.selectAll(`.instance-node[data-caseid="${cid}"]`)
          .classed("dimmed", false)
          .style("stroke", color)
          .style("fill", color);

        insetG.selectAll(`.instance-edge[data-caseid="${cid}"]`)
          .classed("dimmed", false)
          .style("stroke", color);
      }
    }

    if (typeof onWindowChange === "function") onWindowChange({ t0, t1, pinned: isPinned });
  }

  function currentWindow() {
    return pinned && pinnedWindow ? pinnedWindow : hoverWindow;
  }

  function clearLens() {
    pinned = false;
    pinnedWindow = null;
    hoverWindow = null;
    hidePanel();
    if (typeof onWindowChange === "function") onWindowChange({ t0: null, t1: null, pinned: false });
  }

  // -----------------------
  // UI Events
  // -----------------------
  closeBtn.on("click", () => clearLens());

  // ESC to close
  d3.select(window).on("keydown.timeLens", (event) => {
    if (event.key === "Escape") clearLens();
  });

  // Hover lens (only when not pinned / not brushing)
  overlay.on("mousemove.timeLens", (event) => {
    if (pinned || brushing) return;

    //event is the position of the mouse
    let [mx, my] = d3.pointer(event, overlay.node()); //The mx coordinate represents the pixel position relative to the overlay.

    mx = Math.max(0, Math.min(plotWidth, mx));

    const rawTime = xScale.invert(mx); // Pixel to day-coordinate conversion
    const t = nearestEventTime(rawTime);
    const t0 = t - windowHalf;
    const t1 = t + windowHalf;

    hoverWindow = { t0, t1 };
    renderWindow(t0, t1, false);
  });

  overlay.on("mouseleave.timeLens", () => {
    // Hover disappears only if not pinned
    if (!pinned) {
      hoverWindow = null;
      hidePanel();
      if (typeof onWindowChange === "function") onWindowChange({ t0: null, t1: null, pinned: false });
    }
  });

  // Shift + drag -> pin brush window
  overlay.on("mousedown.timeLens", (event) => {
    if (!event.shiftKey) return;

    brushing = true;
    pinned = false; // entering brush mode
    pinnedWindow = null;

    let [mx] = d3.pointer(event, overlay.node());

    brushX0 = mx;
    brushRect
      .attr("x", mx)
      .attr("width", 0)
      .attr("display", null);
  });

  overlay.on("mousemove.brushTimeLens", (event) => {
    if (!brushing) return;

    let [mx] = d3.pointer(event, overlay.node());

    const x0 = Math.min(brushX0, mx);
    const x1 = Math.max(brushX0, mx);

    brushRect.attr("x", x0).attr("width", x1 - x0);
  });

  overlay.on("mouseup.timeLens", (event) => {
    if (!brushing) return;

    brushing = false;

    let [mx] = d3.pointer(event, overlay.node());
    const x0 = Math.min(brushX0, mx);
    const x1 = Math.max(brushX0, mx);

    brushRect.attr("display", "none");
    brushX0 = null;

    // Very small drag => treat as cancel
    if (Math.abs(x1 - x0) < 4) return;

    const t0 = xScale.invert(x0);
    const t1 = xScale.invert(x1);

    pinned = true;
    pinnedWindow = { t0, t1 };
    renderWindow(t0, t1, true);
  });

  // If mouseup happens outside overlay
  d3.select(window).on("mouseup.timeLensGlobal", () => {
    if (!brushing) return;
    brushing = false;
    brushRect.attr("display", "none");
    brushX0 = null;
  });


  return {
    clear: clearLens,
    isPinned: () => pinned,
    getWindow: () => currentWindow(),
    setPinnedWindow: (t0, t1) => {
      pinned = true;
      pinnedWindow = { t0, t1 };
      renderWindow(t0, t1, true);
    },

    setWindowHalf: (v) => {
      const num = +v;
      if (!Number.isFinite(num) || num <= 0) return;
      windowHalf = num;

      // If currently hovered (and not pinned), immediately redraw once.
      if (!pinned && hoverWindow) {
        const mid = (hoverWindow.t0 + hoverWindow.t1) / 2;
        hoverWindow = { t0: mid - windowHalf, t1: mid + windowHalf };
        renderWindow(hoverWindow.t0, hoverWindow.t1, false);
      }
    },

    getWindowHalf: () => windowHalf
  };
}

export { initTimeLens };
