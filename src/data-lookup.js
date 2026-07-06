const { buildDataSections, getDataSearchScope, selectDataSources } = require("./workspace-context");

function formatDataLookupReply({ dataSources, sections, searchScope }) {
  const lines = ["### Data Lookup"];
  if (Array.isArray(dataSources) && dataSources.length > 0) {
    lines.push(`Sources: ${dataSources.join(", ")}`);
  }
  if (searchScope) {
    lines.push(`Scope: ${searchScope}`);
  }
  if (sections.length === 0) {
    lines.push("No matching data found in the scoped sources.");
    return lines.join("\n");
  }

  lines.push("");
  lines.push(...sections);
  return lines.join("\n");
}

async function runDataLookup(request = {}) {
  const startedAt = Date.now();
  const dispatchPlan = request.dispatchPlan || {};
  const dataSources = Array.isArray(dispatchPlan.dataSources) && dispatchPlan.dataSources.length > 0
    ? dispatchPlan.dataSources
    : selectDataSources(request.text || "");
  const sections = buildDataSections(request.text || "", {
    dataSources,
    projectMatches: dispatchPlan.projectMatches || [],
  });
  const searchScope = dispatchPlan.searchScope || getDataSearchScope(dataSources);
  const canary = dispatchPlan.dataLookupCanary || null;
  const latencyMs = Date.now() - startedAt;

  return {
    status: "ok",
    reply: formatDataLookupReply({ dataSources, sections, searchScope }),
    artifacts: [],
    recipeId: "data/lookup",
    metadata: {
      route: {
        recipeId: "data/lookup",
        lane: "data_lookup",
        layer: "deterministic",
        owner: "data",
        searchScope,
        dataSources,
        dataSectionCount: sections.length,
        latencyMs,
      },
      dataLookup: {
        dataSources,
        searchScope,
        dataSectionCount: sections.length,
        empty: sections.length === 0,
        emptyReason: sections.length === 0 ? "no_matching_data_sections" : null,
        fallbackReason: null,
        latencyMs,
        canary,
      },
    },
    usage: null,
    sessionId: null,
  };
}

module.exports = {
  formatDataLookupReply,
  runDataLookup,
};
