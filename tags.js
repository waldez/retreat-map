// Pure op model for tags.json. Kept identical to land_pipeline/tag_ops.py by the
// shared fixture fixtures/tag_ops_cases.json.
export const TAGS = {
  dead: { emoji: "💀", reactions: ["skull", "skull_and_crossbones"] },
  fav: { emoji: "⭐", reactions: ["star", "star2"] },
  nope: { emoji: "👎", reactions: ["thumbsdown", "-1"] },
  visit: { emoji: "🚗", reactions: ["car", "red_car"] },
};

export function emptyDoc() {
  return { version: 1, items: {}, derived: { hidden: [] } };
}

function item(doc, guid) {
  return (doc.items[guid] ??= { tags: {}, notes: [] });
}

function prune(doc, guid) {
  const it = doc.items[guid];
  if (it && !Object.keys(it.tags).length && !it.notes.length && !it.dead) delete doc.items[guid];
}

export function applyOp(doc, op) {
  const out = structuredClone(doc);
  const kind = op.op;
  if (kind === "set_hidden") {
    out.derived.hidden = [...op.guids];
    return out;
  }
  const guid = op.guid;
  if ((kind === "add_tag" || kind === "remove_tag") && !Object.hasOwn(TAGS, op.tag)) {
    throw new Error(`unknown tag ${op.tag}`);
  }
  if (kind === "add_tag") {
    const it = item(out, guid);
    const entry = { at: op.at, via: op.via };
    if ("price" in op) entry.price = op.price;
    it.tags[op.tag] = entry;
    if (op.tag === "dead") {
      const prev = it.dead?.state;
      it.dead = prev === "disputed" || prev === "withdrawn"
        ? { state: "pending", force: true } : { state: "pending" };
    }
  } else if (kind === "remove_tag") {
    const it = out.items[guid];
    if (!it || !(op.tag in it.tags)) return out;
    delete it.tags[op.tag];
    if (op.tag === "dead" && it.dead) {
      if (it.dead.state === "disputed") it.dead.state = "withdrawn";
      else delete it.dead;
    }
    prune(out, guid);
  } else if (kind === "add_note") {
    const it = out.items[guid];
    if (it && it.notes.some((n) => n.id === op.id)) return out;
    item(out, guid).notes.push({ id: op.id, at: op.at, via: op.via, text: op.text });
  } else if (kind === "remove_note") {
    const it = out.items[guid];
    if (!it) return out;
    it.notes = it.notes.filter((n) => n.id !== op.id);
    prune(out, guid);
  } else if (kind === "set_nope_ref") {
    // Pipeline-only: the nope'd plot's parcel ref, recorded once known. No-op
    // without a nope tag or when the ref is already equal.
    const nope = out.items[guid]?.tags?.nope;
    if (!nope || typeof nope !== "object" || nope.national_reference === op.national_reference) {
      return out;
    }
    nope.national_reference = op.national_reference;
  } else if (kind === "set_dead") {
    item(out, guid).dead = { state: op.state, checked_at: op.checked_at, detail: op.detail };
  } else {
    throw new Error(`unknown op ${kind}`);
  }
  return out;
}

// ---- filter helpers (shared by mapfilter.js and listfilter.js) ----

// Tags an item CARRIES. A withdrawn `dead` record is not a tag (counts as untagged).
export function carriedTags(doc, guid) {
  const it = doc && doc.items && doc.items[guid];
  return it && it.tags ? Object.keys(it.tags) : [];
}

// Confirmed-dead is always hidden; no toggle reveals it.
export function isConfirmedDead(doc, guid) {
  const it = doc && doc.items && doc.items[guid];
  return !!(it && it.dead && it.dead.state === "confirmed");
}

// Hidden by the nope rule: carries `nope` or is in derived.hidden (a sibling's nope).
export function isNopeHidden(doc, guid) {
  if (!doc) return false;
  const hidden = doc.derived && doc.derived.hidden;
  if (Array.isArray(hidden) && hidden.includes(guid)) return true;
  return carriedTags(doc, guid).includes("nope");
}

// Does the item carry ANY of `only` (array/Set)? Empty/absent `only` = no constraint.
export function carriesAny(doc, guid, only) {
  const want = only ? [...only] : [];
  if (!want.length) return true;
  const have = carriedTags(doc, guid);
  return want.some((t) => have.includes(t));
}

// =====================================================================
// Page I/O + html helpers (map + list). Everything below is DOM-free and
// unit-tested; the pages only wire events to it.
//
// SECURITY: the page can hold a GitHub token that can rewrite the page itself.
// - Every value from listings / tags.json / notes goes through esc(), including
//   attributes (always double-quoted).
// - The token is sent ONLY to API_BASE (a constant), only in the Authorization
//   header, and is never logged, rendered or put in a URL or error message.
// =====================================================================

export const TOKEN_KEY = "retreat.tags.pat";
export const API_BASE = "https://api.github.com";
export const REPO_PLACEHOLDER = "__TAGS_REPO__";
const TAGS_PATH = "tags.json";
const MAX_ATTEMPTS = 3;
const API_VERSION = "2022-11-28";

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// "<owner>/<repo>@<branch>" from <meta name="tags-repo">, or null when the meta is
// still the unsubstituted placeholder (page opened locally) or malformed.
export function parseRepoMeta(content) {
  const m = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)@([A-Za-z0-9._\/-]+)$/.exec(content || "");
  if (!m || m[2].startsWith(".") || m[3].includes("..")) return null;
  return { repo: `${m[1]}/${m[2]}`, branch: m[3] };
}

const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

function apiUrl(repo) {
  if (!REPO_RE.test(repo || "")) throw new Error("tags: no valid repo configured");
  return `${API_BASE}/repos/${repo}/contents/${TAGS_PATH}`;
}

function apiHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": API_VERSION,
  };
}

// Same key order as the Python writer (json.dumps(sort_keys=True, indent=2)), so
// a phone write and a pipeline write of the same doc are the same bytes.
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

export function encodeDoc(doc) {
  const bytes = new TextEncoder().encode(JSON.stringify(sortKeys(doc), null, 2) + "\n");
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// GitHub returns base64 with embedded newlines; atob alone yields Latin-1, so
// decode the bytes as UTF-8 explicitly (notes carry Czech + emoji).
export function decodeContent(b64) {
  const bin = atob(String(b64 || "").replace(/\s+/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

// One malformed note must not throw in notesHtml and blank the whole page: drop
// non-objects, coerce the fields the page reads to strings.
const str = (v) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));
function normaliseNotes(notes) {
  if (!Array.isArray(notes)) return [];
  return notes.filter((n) => n && typeof n === "object" && !Array.isArray(n)).map((n) => ({
    ...n, id: str(n.id), at: str(n.at), via: str(n.via), text: str(n.text),
  }));
}

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

function normalise(data) {
  if (!data || typeof data !== "object" || !data.items || typeof data.items !== "object"
      || Array.isArray(data.items)) {
    throw new Error("tags.json: not an object with an 'items' object");
  }
  const doc = { ...data, items: {} };
  for (const [guid, it] of Object.entries(data.items)) {
    if (!it || typeof it !== "object") throw new Error(`tags.json: item ${guid} is not an object`);
    const out = {
      ...it,
      tags: isObj(it.tags) ? it.tags : {},
      notes: normaliseNotes(it.notes),
    };
    if ("dead" in out && !isObj(out.dead)) delete out.dead; // parity: land-pipeline _normalise
    doc.items[guid] = out;
  }
  const derived = data.derived && typeof data.derived === "object" ? data.derived : {};
  doc.derived = { ...derived, hidden: Array.isArray(derived.hidden) ? derived.hidden : [] };
  doc.version ??= 1;
  return doc;
}

async function httpError(what, resp) {
  let msg = "";
  try { msg = (await resp.json()).message || ""; } catch { /* body not json */ }
  const err = new Error(`${what} failed: HTTP ${resp.status}${msg ? " " + msg : ""}`);
  err.status = resp.status;
  return err;
}

async function apiGet({ token, repo, branch, fetchFn }) {
  const url = `${apiUrl(repo)}?ref=${encodeURIComponent(branch || "main")}`;
  // no-store: the API answers with a cacheable response; a cached GET after a
  // 409 would hand back the same stale sha and burn every retry.
  const resp = await fetchFn(url, { headers: apiHeaders(token), cache: "no-store" });
  if (resp.status === 404) return { doc: emptyDoc(), sha: null };
  if (!resp.ok) throw await httpError("GET tags.json", resp);
  const body = await resp.json();
  return { doc: normalise(JSON.parse(decodeContent(body.content))), sha: body.sha || null };
}

// With a token: fresh read through the API. Without: the relative Pages copy
// (may lag a few minutes). 404 → emptyDoc(); anything else throws (the caller
// fails open by showing no tags). A token the API rejects (401/403: expired,
// revoked, wrong scope) falls back to the public copy with tokenRejected=true,
// so tags still show and the page goes read-only.
export async function loadTags({ token = "", repo = "", branch = "main", fetchFn = fetch } = {}) {
  if (token) {
    try {
      return { ...(await apiGet({ token, repo, branch, fetchFn })), tokenRejected: false };
    } catch (e) {
      if (e.status !== 401 && e.status !== 403) throw e;
      return { ...(await loadTags({ fetchFn })), tokenRejected: true };
    }
  }
  const resp = await fetchFn(TAGS_PATH, { cache: "no-cache" });
  if (resp.status === 404) return { doc: emptyDoc(), sha: null };
  if (!resp.ok) throw new Error(`tags.json: HTTP ${resp.status}`);
  return { doc: normalise(await resp.json()), sha: null };
}

// Read-modify-write with the blob sha. A 409/422 means someone else (the
// pipeline, another tab) wrote in between: re-read and re-apply THE SAME ops.
export async function commitOps(ops, { token, repo, branch = "main", fetchFn = fetch, message } = {}) {
  if (!token) throw new Error("tags: no token — read-only");
  const url = apiUrl(repo);
  let last = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { doc: loaded, sha } = await apiGet({ token, repo, branch, fetchFn });
    const doc = ops.reduce(applyOp, loaded);
    if (!ops.length || JSON.stringify(sortKeys(doc)) === JSON.stringify(sortKeys(loaded))) return doc;
    const body = {
      message: message || `tags: ${ops.map((o) => `${o.op} ${o.tag || ""}`.trim()).join(", ")} (map)`,
      content: encodeDoc(doc),
      branch,
    };
    if (sha) body.sha = sha;
    const resp = await fetchFn(url, {
      method: "PUT",
      headers: { ...apiHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    if (resp.ok) return doc;
    if (resp.status === 409 || resp.status === 422) {
      // keep GitHub's text: a 422 may be a real validation error, not a race
      last = (await httpError("PUT tags.json", resp)).message;
      continue;
    }
    throw await httpError("PUT tags.json", resp);
  }
  throw new Error(`tags.json still conflicting after ${MAX_ATTEMPTS} attempts (last: ${last})`);
}

// ---- ops the page emits ----

// ISO-8601 to the second, "Z" suffix — the format the pipeline writes.
export function nowIso(d = new Date()) {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// R6: "map:" + ISO timestamp + "-" + 4 random base36 chars.
export function newNoteId(d = new Date()) {
  const r = new Uint8Array(4);
  crypto.getRandomValues(r);
  return `map:${nowIso(d)}-${[...r].map((b) => (b % 36).toString(36)).join("")}`;
}

// Toggle = remove if carried, else add. Toggling 💀 off and on after a dispute
// needs nothing special: applyOp turns that add into a forced archive.
export function toggleOps(doc, guid, tag, { at = nowIso(), price = null } = {}) {
  if (carriedTags(doc, guid).includes(tag)) return [{ op: "remove_tag", guid, tag }];
  const op = { op: "add_tag", guid, tag, at, via: "map" };
  // nope records the price at rejection: the pipeline relists only if cheaper.
  if (tag === "nope" && typeof price === "number" && Number.isFinite(price)) op.price = price;
  return [op];
}

// ---- html (every interpolated value through esc) ----

function disputeHtml(it) {
  if (!it || !it.dead || it.dead.state !== "disputed") return "";
  const when = it.dead.checked_at ? ` (checked ${esc(it.dead.checked_at)})` : "";
  return `<div class="tag-dispute">🧟 still live${when} — to force: toggle 💀 off and on</div>`;
}

export function tagButtonsHtml(guid, doc, editable) {
  const it = doc && doc.items && doc.items[guid];
  const have = carriedTags(doc, guid);
  const dispute = disputeHtml(it);
  if (!editable) {
    const shown = Object.keys(TAGS).filter((t) => have.includes(t)).map((t) => TAGS[t].emoji).join(" ");
    return shown || dispute ? `<div class="tag-row">${esc(shown)}</div>${dispute}` : "";
  }
  const btns = Object.entries(TAGS).map(([tag, { emoji }]) => {
    const on = have.includes(tag);
    return `<button type="button" class="tag-btn${on ? " on" : ""}" data-act="tag" data-guid="${esc(guid)}" data-tag="${esc(tag)}" aria-pressed="${on}" title="${esc(tag)}">${emoji}</button>`;
  }).join("");
  return `<div class="tag-row">${btns}</div>${dispute}`;
}

// `draft` = the half-typed text for this guid's add-note box, restored on every
// re-render so a commit landing (or failing) never eats what the user typed.
export function notesHtml(guid, doc, editable = false, draft = "") {
  const it = doc && doc.items && doc.items[guid];
  const notes = (it && it.notes) || [];
  const lis = notes.map((n) => {
    const del = editable
      ? ` <button type="button" class="note-del" data-act="note-del" data-guid="${esc(guid)}" data-id="${esc(n.id)}" aria-label="delete note">🗑</button>`
      : "";
    return `<li><span class="note-text">${esc(n.text)}</span> <span class="note-meta">${esc((n.at || "").slice(0, 10))} · ${esc(n.via)}</span>${del}</li>`;
  }).join("");
  const list = lis ? `<ul class="notes">${lis}</ul>` : "";
  if (!editable) return list;
  return `${list}<div class="note-add"><textarea rows="2" maxlength="2000" placeholder="add note…" data-guid="${esc(guid)}">${esc(draft)}</textarea><button type="button" data-act="note-add" data-guid="${esc(guid)}">add note</button></div>`;
}

// Pin badges: ⭐ 🚗 and 🧟 (dead disputed). Emoji only — no untrusted text.
export function badgesHtml(guid, doc) {
  if (!doc) return "";
  const have = carriedTags(doc, guid);
  const it = doc.items && doc.items[guid];
  let out = "";
  if (have.includes("fav")) out += TAGS.fav.emoji;
  if (have.includes("visit")) out += TAGS.visit.emoji;
  if (it && it.dead && it.dead.state === "disputed") out += "🧟";
  return out;
}

// A draft is cleared only when ITS add_note commit succeeds, and only if the box
// still holds exactly the committed text (the user may have typed on since).
export function clearCommittedDrafts(drafts, ops) {
  for (const op of ops) {
    if (op.op === "add_note" && (drafts.get(op.guid) || "").trim() === op.text) drafts.delete(op.guid);
  }
}

// 🗑 asks first (R15). confirmFn is injectable; the pages pass window.confirm.
export function noteDeleteOps(guid, id, confirmFn) {
  return confirmFn("Smazat poznámku? / Delete this note?") ? [{ op: "remove_note", guid, id }] : [];
}

// ---- optimistic write queue ----
// doc = last server doc with every pending (not yet committed) op batch applied.
// A failed batch is dropped (= reverted) and reported; later batches still go.
export class TagSession {
  constructor({ commit, onChange = () => {}, onError = () => {}, onCommitted = () => {} }) {
    this.commit = commit;
    this.onCommitted = onCommitted;
    this.onChange = onChange;
    this.onError = onError;
    this.server = null;
    this.pending = [];
    this._running = null;
  }

  get doc() {
    if (!this.server) return null;
    return this.pending.reduce((d, ops) => ops.reduce(applyOp, d), this.server);
  }

  setServer(doc) { this.server = doc; this.onChange(); }

  submit(ops) {
    if (!this.server) throw new Error("tags not loaded");
    this.pending.push(ops);
    this.onChange();
    this._running ??= this._drain().finally(() => { this._running = null; });
    return this._running;
  }

  async _drain() {
    while (this.pending.length) {
      const ops = this.pending[0];
      try {
        this.server = await this.commit(ops);
        this.onCommitted(ops);
      } catch (err) {
        this.onError(err);
      }
      this.pending.shift();
      this.onChange();
    }
  }
}

// ---- URL hash: the `tag` and `nope` keys, shared by map and list ----
export function parseTagHash(hash) {
  const p = new URLSearchParams((hash || "").replace(/^#/, ""));
  return {
    onlyTags: new Set(p.has("tag") ? p.get("tag").split(",").filter(Boolean) : []),
    showNope: p.get("nope") === "1",
  };
}

export function writeTagHash(hash, { onlyTags, showNope }) {
  const p = new URLSearchParams((hash || "").replace(/^#/, ""));
  if (onlyTags && onlyTags.size) p.set("tag", [...onlyTags].join(",")); else p.delete("tag");
  if (showNope) p.set("nope", "1"); else p.delete("nope");
  return p.toString();
}
