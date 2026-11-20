// In-memory per-context model/effort selection state for the panel.
//
// This module holds no DOM, settings, network or persistence concerns: the
// caller feeds the server-normalized `/api/codex/models` catalog in via
// `setModels` and reads back the request fragment to send via `payload`.
//
// Contract: a selection is only ever reported for values the catalog still
// authorizes. Unknown, hidden and malformed entries are dropped on intake,
// an effort is only forwarded when the entry that owns it lists it as one of
// its supported reasoning efforts, and an unknown native thread id gets no
// state at all (the draft selection lives in a separate slot).

const DRAFT = null;
const MAX_EFFORT_LENGTH = 40;

function normalizeEfforts(entry) {
  const source = Array.isArray(entry.supportedReasoningEfforts) ? entry.supportedReasoningEfforts : [];
  const efforts = [];
  for (const item of source) {
    const value = typeof item === 'string' ? item : item && item.reasoningEffort;
    if (typeof value !== 'string') continue;
    const effort = value.trim();
    if (!effort || effort.length > MAX_EFFORT_LENGTH || efforts.includes(effort)) continue;
    efforts.push(effort);
  }
  return efforts;
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.hidden || entry.isHidden) return null;
  const id = typeof entry.id === 'string' ? entry.id.trim() : '';
  if (!id) return null;
  const supportedReasoningEfforts = normalizeEfforts(entry);
  const candidate = typeof entry.defaultReasoningEffort === 'string' ? entry.defaultReasoningEffort.trim() : '';
  return {
    id,
    displayName: typeof entry.displayName === 'string' && entry.displayName.trim() ? entry.displayName.trim() : id,
    supportedReasoningEfforts,
    defaultReasoningEffort: candidate && supportedReasoningEfforts.includes(candidate) ? candidate : null,
    isDefault: Boolean(entry.isDefault),
  };
}

function normalizeCatalog(catalog) {
  const source = Array.isArray(catalog) ? catalog : Array.isArray(catalog && catalog.models) ? catalog.models : [];
  const models = [];
  const seen = new Set();
  for (const raw of source) {
    const entry = normalizeEntry(raw);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    models.push(entry);
  }
  return models;
}

function threadKey(threadId) {
  if (typeof threadId === 'string') {
    const id = threadId.trim();
    return id ? id : DRAFT;
  }
  return DRAFT;
}

export function createModelChoices() {
  let catalog = [];
  let byId = new Map();
  const selections = new Map();
  let draft = {};

  function readSlot(threadId) {
    const key = threadKey(threadId);
    if (key === DRAFT) return draft;
    const stored = selections.get(key);
    return stored ? { ...stored } : {};
  }

  function writeSlot(threadId, value) {
    const key = threadKey(threadId);
    if (key === DRAFT) {
      draft = value;
      return;
    }
    if (value.model || value.effort) selections.set(key, value);
    else selections.delete(key);
  }

  function setModels(next) {
    catalog = normalizeCatalog(next);
    byId = new Map(catalog.map((entry) => [entry.id, entry]));
    return models();
  }

  function models() {
    return catalog.map((entry) => ({ ...entry, supportedReasoningEfforts: [...entry.supportedReasoningEfforts] }));
  }

  function get(threadId) {
    return readSlot(threadId);
  }

  function choose(threadId, model, effort) {
    const wanted = typeof model === 'string' ? model.trim() : '';
    const entry = wanted ? byId.get(wanted) : null;
    const next = {};
    if (entry) {
      next.model = entry.id;
      const wantedEffort = typeof effort === 'string' ? effort.trim() : '';
      if (wantedEffort && entry.supportedReasoningEfforts.includes(wantedEffort)) next.effort = wantedEffort;
    }
    writeSlot(threadId, next);
    return { ...next };
  }

  function payload(threadId) {
    const stored = readSlot(threadId);
    const entry = stored.model ? byId.get(stored.model) : null;
    if (!entry) return {};
    const fragment = { model: entry.id };
    if (stored.effort && entry.supportedReasoningEfforts.includes(stored.effort)) fragment.effort = stored.effort;
    return fragment;
  }

  function resetDraft() {
    draft = {};
  }

  function reset() {
    selections.clear();
    draft = {};
  }

  return { setModels, models, get, choose, payload, resetDraft, reset };
}
