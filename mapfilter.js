// mapfilter.js — pure, DOM-free filter + URL-hash logic for the retreat map.
// Unit-tested with `node --test` (see mapfilter.test.mjs). No imports, no DOM,
// so index.html and the test runner share exactly one source of truth.

// Must stay in step with land-pipeline's emitted tiers AND results_map/geojson.py's
// _TIER_COLORS — a tier missing here has NO checkbox, so passesFilters() rejects it
// and those pins are unreachable (that is exactly how primary_conditional hid 42% of
// the map between 2026-07-12 and 2026-07-27).
export const TIERS = [
  "primary_candidate", "primary_conditional", "secondary", "avoid", "unknown",
];

export const TIER_COLOR = {
  primary_candidate: "#2e7d32",   // green
  primary_conditional: "#1565c0", // blue — deliberately off the green→red ramp:
                                  // a light green reads as noise on the OSM basemap
  secondary: "#f9a825",           // amber
  avoid: "#c62828",               // red
  unknown: "#757575",             // grey
};

const STRUCTURE_SOURCES = new Set(["house", "chata"]);

export function defaultState() {
  return {
    // the three positive verdicts ON; avoid + unknown OFF
    tiers: new Set(["primary_candidate", "primary_conditional", "secondary"]),
    maxPrice: null,        // null = no ceiling
    includeUnpriced: true,
    structuresOnly: false,
    excludeFlags: new Set(),
    // Parcel types (ČÚZK druh pozemku) to HIDE. Exclude-semantics on purpose,
    // mirroring excludeFlags rather than tiers: druh values are open-ended, and
    // a value missing from an include-list would be invisible — exactly how
    // `primary_conditional` hid 42% of the map (see the TIERS note above).
    // Fail open: unknown, new, and not-yet-vetted parcels stay shown.
    hiddenDruhs: new Set(),
    focusGuid: null,
  };
}

export function druhOf(props) {
  return props.druh_pozemku || "";
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

  // An absent druh (not vetted yet) is never hidden — those are the freshest
  // listings and dropping them would hide exactly what is worth looking at.
  const druh = druhOf(props);
  if (druh && state.hiddenDruhs.has(druh)) return false;
  return true;
}

export function serializeHash(state) {
  const p = new URLSearchParams();
  if (state.tiers.size) p.set("tier", [...state.tiers].join(","));
  if (state.maxPrice != null) p.set("max", String(state.maxPrice));
  if (!state.includeUnpriced) p.set("unpriced", "0");
  if (state.structuresOnly) p.set("struct", "1");
  if (state.excludeFlags.size) p.set("xflag", [...state.excludeFlags].join(","));
  // Repeated params, not a joined list: a druh may legitimately contain a comma
  // ("ostatní plocha, jiná plocha") and joining would split it into two bogus
  // filters that match nothing.
  for (const d of state.hiddenDruhs) p.append("xdruh", d);
  if (state.focusGuid) p.set("guid", state.focusGuid);
  return p.toString();
}

export function parseHash(hash, base = defaultState()) {
  const s = {
    ...base,
    tiers: new Set(base.tiers),
    excludeFlags: new Set(base.excludeFlags),
    hiddenDruhs: new Set(base.hiddenDruhs),
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
  if (p.has("xdruh")) s.hiddenDruhs = new Set(p.getAll("xdruh").filter(Boolean));
  if (p.has("guid")) s.focusGuid = p.get("guid");
  return s;
}
