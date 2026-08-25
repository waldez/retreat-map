// listfilter.js — pure, DOM-free filter + sort logic for the retreat listings
// page. No imports, no DOM, so list.html and node --test share exactly one
// source of truth. Same split as mapfilter.js.

// Noise (co-ownership shares, ZPF farmland, speculative lots) is HIDDEN by
// default but never dropped from the feed: `hiddenNoise` is rendered next to
// the toggle so suppression is always visible and always one click reversible.
export function applyFilters(feed, opts = {}) {
  const showNoise = opts.showNoise === true;
  const maxPrice = typeof opts.maxPrice === 'number' ? opts.maxPrice : null;
  const sources = Array.isArray(opts.sources) && opts.sources.length ? opts.sources : null;
  const all = (feed && feed.listings) || [];

  let hiddenNoise = 0;
  const listings = all.filter((l) => {
    if (sources && !sources.includes(l.source)) return false;
    // An unpriced listing is KEPT under a ceiling: "price on request" is common
    // here and is not evidence the plot is expensive.
    if (maxPrice !== null && typeof l.price_czk === 'number' && l.price_czk > maxPrice) {
      return false;
    }
    // Noise is checked LAST, and the order is the point: `hiddenNoise` must
    // count only what toggling would actually REVEAL. Counting rows the source
    // or price filter already excluded makes the button offer something it
    // cannot deliver — a true number about the feed, a false one about itself.
    const isNoise = (l.noise_reasons || []).length > 0;
    if (isNoise && !showNoise) { hiddenNoise += 1; return false; }
    return true;
  });

  return { listings, hiddenNoise, total: all.length };
}

// Unknown values sort LAST under every key. An unpriced plot is not the
// cheapest, and an undated one is not the newest.
export function sortListings(listings, key) {
  const out = listings.slice();
  const missingLast = (v) => v === null || v === undefined || v === '';
  const cmp = {
    price: (a, b) => a.price_czk - b.price_czk,
    area: (a, b) => b.area_m2 - a.area_m2,
    per_m2: (a, b) => a.price_per_m2 - b.price_per_m2,
    newest: (a, b) => (a.first_seen < b.first_seen ? 1 : a.first_seen > b.first_seen ? -1 : 0),
  }[key];
  if (!cmp) return out;
  const field = { price: 'price_czk', area: 'area_m2', per_m2: 'price_per_m2', newest: 'first_seen' }[key];
  return out.sort((a, b) => {
    const am = missingLast(a[field]);
    const bm = missingLast(b[field]);
    if (am && bm) return 0;
    if (am) return 1;
    if (bm) return -1;
    return cmp(a, b);
  });
}
