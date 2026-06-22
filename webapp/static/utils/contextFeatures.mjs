
function buildCases(rows) {
  // 1) Group by case and sort by time
  const byCase = d3.group(rows, d => d.case);
  const cases = [];
  const act = (e) => e?.["concept:name"]

  for (const [caseId, evts] of byCase.entries()) {
    // Ensure sorting by time
    evts.sort((a,b) => new Date(a.timestamps) - new Date(b.timestamps));

    //+Convert to number
    const durationSec = +evts[evts.length - 1].timestamp_relative_seconds;


    const activities = evts
      .map(act)
      .filter(v => v != null && v !== "");
    const startActivity = activities[0] ?? null;
    const endActivity = activities[activities.length - 1];

    // Dominent resources: The most frequently occurring resources
    const res = (e) => e?.resources;
    const resCount = d3.rollup(evts, v => v.length, e => res(e));
    let mainResource = null, bestN = -1;
    for (const [r, n] of resCount.entries()) {
      if (r == null || r === "") continue;
      if (n > bestN) { bestN = n; mainResource = r; }
    }

    //Resource diversity
    const resourceSet = new Set(
      evts.map(res).filter(v => v != null && v !== "")
    );
    const resourceDiversity = resourceSet.size;

    // Variant: Encoding the activity sequence as a string
    const variant = activities.join("→");

    cases.push({
      caseId,
      events: evts,
      durationSec,
      activities,
      startActivity,
      endActivity,
      mainResource,
      resourceDiversity,
      variant
    });
  }

  // 2) Calculate variant frequency & binning (low/medium/high)
  // "A→B→C" => 10
  // "A→D"   => 2
  const varFreq = d3.rollup(cases, v => v.length, c => c.variant);
  const freqs = [...varFreq.values()];
  const q33 = d3.quantileSorted([...freqs].sort(d3.ascending), 0.33) || 1;
  const q66 = d3.quantileSorted([...freqs].sort(d3.ascending), 0.66) || 2;

  for (const c of cases) {
    const f = varFreq.get(c.variant) || 1;
    c.variantFreq = f;
    c.variantFreqBucket = (f <= q33) ? "low" : (f <= q66 ? "mid" : "high");
  }

  // 3) Duration buckets (short/medium/long)
  const durs = cases.map(c => c.durationSec).sort(d3.ascending);
  const d33 = d3.quantileSorted(durs, 0.33) || 0;
  const d66 = d3.quantileSorted(durs, 0.66) || d33;

  for (const c of cases) {
    c.durationBucket = (c.durationSec <= d33) ? "short" :
                       (c.durationSec <= d66) ? "medium" : "long";
  }

  // 4) Resource Diversity Segmentation (Low/Medium/High)
  const resDivs = cases.map(c => c.resourceDiversity).sort(d3.ascending);
  const r33 = d3.quantileSorted(resDivs, 0.33) || 1;
  const r66 = d3.quantileSorted(resDivs, 0.66) || r33;

  for (const c of cases) {
    const r = c.resourceDiversity;
    c.resourceDiversityBucket = (r <= r33) ? "low" : (r <= r66 ? "mid" : "high" );
  }

  console.info("cases:")
  console.log(cases)

  return cases;
}

//Remove context candidates with excessively low coverage
function discoverContextCandidates(cases) {
  //label for ui
  const candidates = [
    //{ key: "durationBucket", label: "Duration bucket", type: "categorical" },
    { key: "startActivity",  label: "Start activity",  type: "categorical" },
    { key: "endActivity",    label: "End activity",    type: "categorical" },
    { key: "mainResource",   label: "Dominant resource",   type: "categorical" },
    { key: "resourceDiversityBucket", label: "Resource diversity bucket", type: "categorical" },

    //{ key: "variantFreqBucket", label: "Variant frequency bucket", type: "categorical" },
  ];


  // Assign each candidate a cardinality and a missing rate to facilitate heuristic sorting/filtering.
  for (const c of candidates) {
    const vals = cases.map(x => x[c.key]).filter(v => v != null && v !== "");
    const distinct = new Set(vals);
    c.cardinality = distinct.size;
    c.coverage = vals.length / cases.length;
  }

  //Simple Rules ：coverage >= 0.7 and 2 <= cardinality <= 100
  return candidates.filter(c => c.coverage >= 0.7 && c.cardinality >= 2 && c.cardinality <= 100);
}

//Score the selected context
function pickTopKByContext(cases, contextKey, K, levelK, densityScoreFn) {
  const byContext = d3.group(cases, c => c[contextKey]);
  const picked = [];

  for (const [ctxValue, groupCases] of byContext.entries()) {
    // calculate score
    for (const c of groupCases) {
      c._score_k = densityScoreFn(c, levelK); //
      console.info("context score :")
      console.log(c._score_k)
    }
    groupCases.sort((a,b) => b._score_k - a._score_k);
    picked.push(...groupCases.slice(0, K));
  }
  return picked;
}

  export function topKMetrics(topKCases) {
    const caseIds = topKCases.map(d => d.caseId);

    const uniqueVariants = new Set(topKCases.map(d => d.variant)).size;
    const uniqueEndActs  = new Set(topKCases.map(d => d.endActivity)).size;
    const uniqueStartActs = new Set(topKCases.map(d => d.startActivity)).size;

    return {
      K: topKCases.length,
      caseIds,
      variantDiversity: uniqueVariants,
      endActivityDiversity: uniqueEndActs,
      startActivityDiversity: uniqueStartActs,
    };
  }

  export function jaccardOverlap(topK_A, topK_B) {
    const A = new Set(topK_A.map(d => d.caseId));
    const B = new Set(topK_B.map(d => d.caseId));
    const inter = [...A].filter(x => B.has(x)).length;
    const union = new Set([...A, ...B]).size;
    return union ? inter / union : 0;
  }


export { buildCases, discoverContextCandidates, pickTopKByContext };