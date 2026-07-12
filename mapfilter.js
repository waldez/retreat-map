// mapfilter.js — pure, DOM-free filter + URL-hash logic for the retreat map.
// Unit-tested with `node --test` (see mapfilter.test.mjs). No imports, no DOM,
// so index.html and the test runner share exactly one source of truth.

export const TIERS = ["primary_candidate", "secondary", "avoid", "unknown"];

export const TIER_COLOR = {
  primary_candidate: "#2e7d32", // green
  secondary: "#f9a825",         // amber
  avoid: "#c62828",             // red
  unknown: "#757575",           // grey
};

const STRUCTURE_SOURCES = new Set(["house", "chata"]);

export function defaultState() {
  return {
    tiers: new Set(["primary_candidate", "secondary"]), // avoid + unknown OFF
    maxPrice: null,        // null = no ceiling
    includeUnpriced: true,
    structuresOnly: false,
    excludeFlags: new Set(),
    focusGuid: null,
  };
}

export function tierOf(props) {
  return props.suitability_tier || props.verdict || "unknown";
}

export function passesFilters(props, state) {
  if (!state.tiers.has(tierOf(props))) return false;

  const price = props.price;
  if (price == null) {
    if (!state.includeUnpriced) return false;
  } else if (state.maxPrice != null && price > state.maxPrice) {
    return false;
  }

  if (state.structuresOnly && !STRUCTURE_SOURCES.has(props.source)) return false;

  if (state.excludeFlags.size && Array.isArray(props.flags)) {
    for (const f of props.flags) if (state.excludeFlags.has(f)) return false;
  }
  return true;
}

export function serializeHash(state) {
  const p = new URLSearchParams();
  if (state.tiers.size) p.set("tier", [...state.tiers].join(","));
  if (state.maxPrice != null) p.set("max", String(state.maxPrice));
  if (!state.includeUnpriced) p.set("unpriced", "0");
  if (state.structuresOnly) p.set("struct", "1");
  if (state.excludeFlags.size) p.set("xflag", [...state.excludeFlags].join(","));
  if (state.focusGuid) p.set("guid", state.focusGuid);
  return p.toString();
}

export function parseHash(hash, base = defaultState()) {
  const s = {
    ...base,
    tiers: new Set(base.tiers),
    excludeFlags: new Set(base.excludeFlags),
  };
  const p = new URLSearchParams((hash || "").replace(/^#/, ""));
  if (p.has("tier")) s.tiers = new Set(p.get("tier").split(",").filter(Boolean));
  if (p.has("max")) {
    const n = parseInt(p.get("max"), 10);
    s.maxPrice = Number.isFinite(n) ? n : null;
  }
  if (p.has("unpriced")) s.includeUnpriced = p.get("unpriced") !== "0";
  if (p.has("struct")) s.structuresOnly = p.get("struct") === "1";
  if (p.has("xflag")) s.excludeFlags = new Set(p.get("xflag").split(",").filter(Boolean));
  if (p.has("guid")) s.focusGuid = p.get("guid");
  return s;
}
