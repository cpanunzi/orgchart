import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { ArrowLeft, Plus, X, Search, RotateCcw, Crown, ChevronLeft, ChevronRight, ChevronUp, ChevronDown, Trash2, Edit2, UserPlus } from "lucide-react";
import { supabase } from "../lib/supabase.js";
import { sharedStyles } from "./styles.js";

// ---------------------------------------------------------------------------------------------
// Team matrix board — a free-form two-level grid.
//   across the top : teams, each split into subteams   (two header rows)
//   down the left  : teams, each split into subteams   (two header columns)
//   cells          : the people where a left lane meets a top lane
// Nothing is assumed about what either axis means — every label, person and split is hers to
// set. A team with no subteams is a single lane on its own.
// People are references (`ref`) into a functional chart (doc.sourceChartId), read live from it.
//   { id:"root", kind:"matrix", v:5, sourceChartId, leadRef,
//     top:[team], left:[team],   team = { id, label, headRef, subs:[{ id, label, headRef }] }
//     cells:{ "<leftLaneId>|<topLaneId>": [{ id, ref, name, role }] } }   lane id = sub id, or team id if no subs
// ---------------------------------------------------------------------------------------------

const rid = () => Math.random().toString(36).slice(2, 10);
const clone = (x) => JSON.parse(JSON.stringify(x));
const ck = (leftId, topId) => `${leftId}|${topId}`;
const TOP_COLORS = ["#3b6ea5", "#6d5aa8", "#2f7f86", "#5b7a3f", "#7a6a3b"];
const LEFT_COLORS = ["#b8442a", "#b07d2a", "#a0527a", "#4f6d7a", "#6b6252"];
const initials = (name) => (name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0] || "").join("").toUpperCase() || "?";
const lanesOf = (teams) => (teams || []).flatMap((t) => (t.subs && t.subs.length ? t.subs.map((sub) => ({ id: sub.id, team: t, sub })) : [{ id: t.id, team: t, sub: null }]));

// ---- upgrades from earlier board formats (each step only ever reads shapes it recognises) -----
const v1toV2 = (tree) => {
  const core = { id: rid(), label: "Core team", headRef: null };
  const subteams = [], cells = {};
  ((tree && tree.children) || []).forEach((sec) => {
    const sid = rid(); subteams.push({ id: sid, name: (sec.name || "").trim(), leadRef: null });
    const chips = [];
    const rec = (n) => (n.children || []).forEach((c) => { if (c.ref || (c.name && c.name !== "New Person")) chips.push({ id: rid(), ref: c.ref || null, name: c.name || "", role: "" }); rec(c); });
    rec(sec); if (chips.length) cells[`${sid}|${core.id}`] = chips;
  });
  return { v: 2, sourceChartId: tree?.sourceChartId || null, archived: tree?.archived, leadRef: null, functions: [core], subteams, cells };
};
const toV4 = (raw) => {
  if (raw && raw.v === 4) return raw;
  const pods = [], rows = [], cells = {};
  const put = (k, chips) => { if (chips && chips.length) cells[k] = [...(cells[k] || []), ...chips]; };
  let t = raw || {};
  if (t.v === 3) {
    (t.subteams || []).forEach((st) => pods.push({ id: st.id, name: st.name || "", leadRef: st.leadRef || null }));
    (t.groups || []).forEach((g) => rows.push({ id: g.id, label: g.label || "", headRef: g.headRef || null, core: true }));
    (t.partners || []).forEach((pt) => rows.push({ id: pt.id, label: pt.label || "", headRef: pt.headRef || null, core: false }));
    Object.entries(t.cells || {}).forEach(([k, chips]) => { const [rowId, stId] = k.split("|"); if (rowId === "_m") { const st = (t.subteams || []).find((x) => x.id === stId); if (st) put(`${st.groupId}|${stId}`, chips); } else put(k, chips); });
  } else {
    if (t.v !== 2) t = v1toV2(t);
    (t.subteams || []).forEach((st) => { if ((st.name || "").trim() || st.leadRef) pods.push({ id: st.id, name: st.name || "", leadRef: st.leadRef || null }); });
    (t.functions || []).forEach((f) => rows.push({ id: f.id, label: f.label || "", headRef: f.headRef || null, core: true }));
    Object.entries(t.cells || {}).forEach(([k, chips]) => { const [sid, fid] = k.split("|"); put(`${fid}|${sid}`, chips); });
  }
  return { v: 4, sourceChartId: t.sourceChartId || null, leadRef: t.leadRef || null, archived: t.archived, pods, rows, cells };
};
// v4 (subteam columns × function rows) → v5: the columns become subteams of one top team (hers to
// name or split up); each function row becomes a team down the left. Cell keys are unchanged.
const toV5 = (raw) => {
  if (raw && raw.v === 5) return { doc: raw, migrated: false };
  const t = toV4(raw);
  const top = (t.pods || []).length ? [{ id: rid(), label: "", headRef: null, subs: t.pods.map((pd) => ({ id: pd.id, label: pd.name || "", headRef: pd.leadRef || null })) }] : [];
  const left = (t.rows || []).map((r) => ({ id: r.id, label: r.label || "", headRef: r.headRef || null, subs: [] }));
  const doc = { id: "root", kind: "matrix", v: 5, sourceChartId: t.sourceChartId || null, leadRef: t.leadRef || null, top, left, cells: t.cells || {}, children: [] };
  if (t.archived) doc.archived = t.archived;
  return { doc, migrated: true };
};

// Index the functional org: everyone by id, their manager, their reports, and their whole org.
const buildSource = (tree) => {
  const list = [], byId = new Map(), kids = new Map();
  const rec = (n, parent) => {
    const title = (n.title || "").trim();
    const p = { id: n.id, name: (n.name || "").trim(), title: /^title$/i.test(title) ? "" : title, team: n.team || "",
      managerId: parent ? parent.id : null, managerName: parent ? (parent.name || "").trim() : "" };
    list.push(p); byId.set(p.id, p); kids.set(p.id, (n.children || []).map((c) => c.id));
    (n.children || []).forEach((c) => rec(c, n));
  };
  if (tree) rec(tree, null);
  const kidsOf = (id) => kids.get(id) || [];
  const orgOf = (id) => { const out = new Set(); const go = (x) => { if (out.has(x)) return; out.add(x); kidsOf(x).forEach(go); }; if (id) go(id); return out; };
  return { list, byId, orgOf, kidsOf };
};

// ---- safety net against out-of-date tabs ------------------------------------------------------
// A tab running an earlier build doesn't understand this format. So: keep a copy of every save
// in this browser; never load or overwrite a format NEWER than this build; if what's stored is
// emptier than our copy, offer it back instead of saving; and if an OLDER-format write lands on
// an open board, put the good version straight back.
const V = 5;
const weight = (d) => { if (!d) return 0; const ax = (teams) => (teams || []).reduce((n, t) => n + 1 + (t.subs || []).length, 0); return ax(d.top) + ax(d.left) + Object.values(d.cells || {}).reduce((n, a) => n + a.length, 0); };
const bkKey = (id) => `atelier-matrix-backup:${id}`;
const readBackup = (id) => { try { const bk = JSON.parse(localStorage.getItem(bkKey(id)) || "null"); return bk && bk.doc && bk.doc.v === V ? bk : null; } catch { return null; } };
const writeBackup = (id, doc) => { try { if (weight(doc) > 0) localStorage.setItem(bkKey(id), JSON.stringify({ at: Date.now(), doc })); } catch { /* storage full/blocked — not fatal */ } };

const EMPTY_SOURCE = { list: [], byId: new Map(), orgOf: () => new Set(), kidsOf: () => [], name: "", ready: false };

// small move/remove toolbar shown on hover (module-level so it isn't remounted every render)
const Tools = ({ onPrev, onNext, onRemove, prevIcon, nextIcon, canPrev, canNext, what }) => (
  <div className="mx-tools">
    <button className="mx-tool" disabled={!canPrev} onClick={onPrev} title="Move">{prevIcon}</button>
    <button className="mx-tool" disabled={!canNext} onClick={onNext} title="Move">{nextIcon}</button>
    <button className="mx-tool mx-tool-danger" onClick={onRemove} title={`Remove ${what}`}><Trash2 size={13} /></button>
  </div>
);

export default function MatrixBoard({ chartId, chartName, onBack, onRenamed }) {
  const [doc, setDocState] = useState(null);
  const [name, setName] = useState(chartName || "");
  const [editingName, setEditingName] = useState(false);
  const [history, setHistory] = useState([]);
  const [saveStatus, setSaveStatus] = useState("synced");
  const [loadError, setLoadError] = useState(null);
  const [tooNew, setTooNew] = useState(false);   // saved by a newer build than this tab — don't touch it
  const [rescue, setRescue] = useState(null);     // { at, doc } — a fuller copy from this browser, offered back
  const [source, setSource] = useState(EMPTY_SOURCE);
  const [picker, setPicker] = useState(null);     // { mode, leftId?, topId?, axis?, teamId?, subId?, rect }
  const [chipMenu, setChipMenu] = useState(null); // { key, chipId, rect }
  const [editing, setEditing] = useState(null);   // id of the team/subteam being renamed
  const [drag, setDrag] = useState(null);         // { key, chipId }
  const [overKey, setOverKey] = useState(null);
  const docRef = useRef(null);
  const saveTimer = useRef(null);
  const lastSavedAt = useRef(0);
  const lastRemoteAt = useRef(0);
  const dirty = useRef(false);

  // ---- persistence -------------------------------------------------------------------------
  const scheduleSave = useCallback((nextDoc, nextName) => {
    dirty.current = true; setSaveStatus("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const updates = { updated_at: new Date().toISOString() };
      if (nextDoc !== undefined) updates.tree = nextDoc;
      if (nextName !== undefined) updates.name = nextName;
      lastSavedAt.current = Date.now();
      const { data, error } = await supabase.from("charts").update(updates).eq("id", chartId).select("updated_at").single();
      saveTimer.current = null;
      if (error) { setSaveStatus("error"); return; }
      const ts = new Date(data.updated_at).getTime();
      lastSavedAt.current = ts; lastRemoteAt.current = Math.max(lastRemoteAt.current, ts);
      dirty.current = false; setSaveStatus("synced");
      if (nextDoc !== undefined) writeBackup(chartId, nextDoc);
    }, 600);
  }, [chartId]);

  const setDoc = (next, { save = true } = {}) => { docRef.current = next; setDocState(next); if (save) scheduleSave(next, undefined); };
  const apply = (fn) => { const prev = docRef.current; if (!prev) return; const next = fn(clone(prev)) || prev; setHistory((h) => [...h.slice(-49), prev]); setDoc(next); };
  const undo = () => setHistory((h) => { if (!h.length) return h; setDoc(h[h.length - 1]); return h.slice(0, -1); });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.from("charts").select("id, name, tree, updated_at").eq("id", chartId).single();
      if (cancelled) return;
      if (error) { setLoadError(error.message); return; }
      setName(data.name); lastRemoteAt.current = new Date(data.updated_at).getTime();
      if (data.tree && data.tree.v > V) { setTooNew(true); return; }
      const { doc: d, migrated } = toV5(data.tree);
      const bk = readBackup(chartId);
      if (bk && weight(bk.doc) > weight(d)) { setRescue(bk); setDoc(d, { save: false }); return; } // don't save over anything until she chooses
      setDoc(d, { save: migrated });
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartId]);

  useEffect(() => {
    const ch = supabase.channel(`matrix-${chartId}`).on("postgres_changes",
      { event: "UPDATE", schema: "public", table: "charts", filter: `id=eq.${chartId}` },
      (payload) => {
        const ts = new Date(payload.new.updated_at).getTime();
        if (Math.abs(ts - lastSavedAt.current) < 3000 || ts <= lastRemoteAt.current) return;
        if (dirty.current || saveTimer.current) return;
        lastRemoteAt.current = ts;
        const incoming = payload.new.tree;
        if (incoming && incoming.v > V) { setTooNew(true); return; }                       // a newer build is editing — step aside
        if (!incoming || incoming.v !== V) { if (docRef.current && weight(docRef.current) > 0) scheduleSave(docRef.current, undefined); return; } // an older tab overwrote it — put ours back
        setDoc(incoming, { save: false }); setName(payload.new.name);
      }).subscribe();
    return () => { supabase.removeChannel(ch); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartId]);

  // ---- the functional org these people come from -------------------------------------------
  const sourceChartId = doc?.sourceChartId || null;
  useEffect(() => {
    if (!sourceChartId) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.from("charts").select("name, tree").eq("id", sourceChartId).single();
      if (cancelled) return;
      if (error || !data) { setSource({ ...EMPTY_SOURCE, ready: true }); return; }
      setSource({ ...buildSource(data.tree), name: data.name, ready: true });
    })();
    return () => { cancelled = true; };
  }, [sourceChartId]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") { setPicker(null); setChipMenu(null); }
      const t = e.target; const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !typing) { e.preventDefault(); undo(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- helpers ------------------------------------------------------------------------------
  const person = (ref) => (ref ? source.byId.get(ref) : null) || null;
  const displayName = (ref, fallback) => person(ref)?.name || fallback || "Unknown";
  const saveName = (v) => { const nv = v.trim() || "Untitled team"; setName(nv); scheduleSave(undefined, nv); setEditingName(false); onRenamed && onRenamed(); };
  const openPicker = (e, p) => { const r = e.currentTarget.getBoundingClientRect(); setChipMenu(null); setPicker({ ...p, rect: { left: r.left, top: r.top, bottom: r.bottom } }); };

  // ---- actions (the two axes are symmetrical: axis = "top" | "left") ------------------------
  const side = (k, axis) => k.split("|")[axis === "left" ? 0 : 1];
  const dropCells = (d, pred) => Object.keys(d.cells).forEach((k) => { if (pred(k)) delete d.cells[k]; });
  const peopleIn = (pred) => Object.entries(doc.cells || {}).reduce((n, [k, v]) => n + (pred(k) ? v.length : 0), 0);
  const confirmLoss = (what, n) => !n || window.confirm(`Remove ${what} and the ${n} ${n === 1 ? "person" : "people"} placed in it?`);

  const addTeam = (axis) => { const id = rid(); apply((d) => { d[axis].push({ id, label: "", headRef: null, subs: [] }); return d; }); setEditing(id); };
  const addSub = (axis, teamId) => { const id = rid(); apply((d) => {
    const t = d[axis].find((x) => x.id === teamId); if (!t) return d;
    if (!t.subs.length) Object.keys(d.cells).forEach((k) => { if (side(k, axis) === t.id) { const [l, tp] = k.split("|"); const nk = axis === "left" ? ck(id, tp) : ck(l, id); d.cells[nk] = d.cells[k]; delete d.cells[k]; } }); // people placed on the whole team follow into its first subteam
    t.subs.push({ id, label: "", headRef: null }); return d; }); setEditing(id); };
  const find = (d, axis, teamId, subId) => { const t = d[axis].find((x) => x.id === teamId); return subId ? (t && t.subs.find((x) => x.id === subId)) : t; };
  const renameNode = (axis, teamId, subId, v) => apply((d) => { const n = find(d, axis, teamId, subId); if (n) n.label = v.trim(); return d; });
  const setHead = (axis, teamId, subId, pick) => apply((d) => { const n = find(d, axis, teamId, subId); if (n) { n.headRef = pick.ref || null; if (!pick.ref && pick.name) n.headName = pick.name; else delete n.headName; } return d; });
  const moveTeam = (axis, teamId, delta) => apply((d) => { const a = d[axis]; const i = a.findIndex((x) => x.id === teamId), j = i + delta; if (i < 0 || j < 0 || j >= a.length) return d; const [x] = a.splice(i, 1); a.splice(j, 0, x); return d; });
  const moveSub = (axis, teamId, subId, delta) => apply((d) => { const t = d[axis].find((x) => x.id === teamId); if (!t) return d; const a = t.subs; const i = a.findIndex((x) => x.id === subId), j = i + delta; if (i < 0 || j < 0 || j >= a.length) return d; const [x] = a.splice(i, 1); a.splice(j, 0, x); return d; });
  const removeTeam = (axis, t) => { const ids = lanesOf([t]).map((l) => l.id); const n = peopleIn((k) => ids.includes(side(k, axis)));
    if (!confirmLoss(`"${t.label || displayName(t.headRef, "this team")}"${t.subs.length ? ` and its ${t.subs.length} subteam${t.subs.length === 1 ? "" : "s"}` : ""}`, n)) return;
    apply((d) => { d[axis] = d[axis].filter((x) => x.id !== t.id); dropCells(d, (k) => ids.includes(side(k, axis))); return d; }); };
  const removeSub = (axis, t, sub) => { const n = peopleIn((k) => side(k, axis) === sub.id); if (!confirmLoss(`"${sub.label || "this subteam"}"`, n)) return;
    apply((d) => { const tt = d[axis].find((x) => x.id === t.id); if (tt) tt.subs = tt.subs.filter((x) => x.id !== sub.id); dropCells(d, (k) => side(k, axis) === sub.id); return d; }); };
  const addTo = (key, pick) => apply((d) => { const arr = d.cells[key] || (d.cells[key] = []); if (pick.ref && arr.some((c) => c.ref === pick.ref)) return d; arr.push({ id: rid(), ref: pick.ref || null, name: pick.name || "", role: "" }); return d; });
  const removeChip = (key, chipId) => apply((d) => { d.cells[key] = (d.cells[key] || []).filter((c) => c.id !== chipId); if (!d.cells[key].length) delete d.cells[key]; return d; });
  const setChipName = (key, chipId, nm) => apply((d) => { const c = (d.cells[key] || []).find((x) => x.id === chipId); if (c && !c.ref) c.name = nm; return d; });
  const setRole = (key, chipId, role) => apply((d) => { const c = (d.cells[key] || []).find((x) => x.id === chipId); if (c) c.role = role; return d; });
  const moveChip = (fromKey, chipId, toKey) => { if (fromKey === toKey) return; apply((d) => { const from = d.cells[fromKey] || []; const chip = from.find((c) => c.id === chipId); if (!chip) return d; const to = d.cells[toKey] || (d.cells[toKey] = []); if (chip.ref && to.some((c) => c.ref === chip.ref)) return d; d.cells[fromKey] = from.filter((c) => c.id !== chipId); if (!d.cells[fromKey].length) delete d.cells[fromKey]; to.push(chip); return d; }); };

  const onPick = (pick) => {
    const p = picker; if (!p) return;
    if (p.mode === "cell") { addTo(ck(p.leftId, p.topId), pick); return; }      // stays open — add several
    if (p.mode === "head") setHead(p.axis, p.teamId, p.subId, pick);
    if (p.mode === "teamLead") apply((d) => { d.leadRef = pick.ref || null; return d; });
    setPicker(null);
  };

  const stats = useMemo(() => {
    if (!doc) return { people: 0 };
    const refs = new Set(); Object.values(doc.cells || {}).forEach((arr) => arr.forEach((c) => refs.add(c.ref || c.id)));
    return { people: refs.size };
  }, [doc]);

  if (loadError) return (<div className="org-root"><style>{sharedStyles}</style><button className="tb" onClick={onBack}>← Back</button><p style={{ marginTop: 24 }}>Couldn't load this team: {loadError}</p></div>);
  if (tooNew) return (<div className="org-root"><style>{sharedStyles}</style><button className="tb" onClick={onBack}>← Back</button>
    <p style={{ marginTop: 24, maxWidth: 560, lineHeight: 1.6, fontFamily: "Iowan Old Style, Georgia, serif" }}>This board was saved by a newer version of the app than this tab is running. <strong>Reload the page</strong> to get the latest version — nothing has been changed.</p>
    <button className="tb tb-primary" onClick={() => window.location.reload()}>Reload</button></div>);
  if (!doc) return <div style={{ padding: 60, fontFamily: "Iowan Old Style, Georgia, serif", color: "#8a7d6c" }}>Loading…</div>;

  // ---- layout plan: explicit grid coordinates for both two-level axes -----------------------
  const TOP = doc.top, LEFT = doc.left;
  const tracks = ["204px", "190px"]; let col = 3;
  const topPlan = TOP.map((t, ti) => { const start = col; const lanes = lanesOf([t]).map((lane) => { tracks.push("minmax(232px, 1fr)"); return { lane, col: col++ }; }); return { t, ti, start, end: col, lanes, color: TOP_COLORS[ti % TOP_COLORS.length] }; });
  const lastCol = col; tracks.push("150px");
  let row = 3;
  const leftPlan = LEFT.map((t, ti) => { const start = row; const lanes = lanesOf([t]).map((lane) => ({ lane, row: row++ })); return { t, ti, start, end: row, lanes, color: LEFT_COLORS[ti % LEFT_COLORS.length] }; });
  const lastRow = row;

  const headCell = ({ axis, t, sub, color, idx, count }) => {
    const node = sub || t; const isTop = axis === "top";
    const hp = person(node.headRef) || (node.headName ? { name: node.headName, title: "not in the org chart", outside: true } : null);
    return (<>
      <div className="mx-fn-row">
        <InlineEdit className={sub ? "mx-sub-name" : "mx-team-name"} value={node.label} placeholder={sub ? "Name this subteam" : "Name this team"} autoEdit={editing === node.id} onDone={() => setEditing(null)} onCommit={(v) => renameNode(axis, t.id, sub?.id, v)} />
        <Tools what={sub ? "this subteam" : "this team"} prevIcon={isTop ? <ChevronLeft size={13} /> : <ChevronUp size={13} />} nextIcon={isTop ? <ChevronRight size={13} /> : <ChevronDown size={13} />} canPrev={idx > 0} canNext={idx < count - 1}
          onPrev={() => (sub ? moveSub(axis, t.id, sub.id, -1) : moveTeam(axis, t.id, -1))} onNext={() => (sub ? moveSub(axis, t.id, sub.id, 1) : moveTeam(axis, t.id, 1))} onRemove={() => (sub ? removeSub(axis, t, sub) : removeTeam(axis, t))} />
      </div>
      <button className={`mx-person ${hp ? "" : "mx-person-empty"}`} onClick={(e) => openPicker(e, { mode: "head", axis, teamId: t.id, subId: sub?.id })} title={hp ? "Change or clear this person" : "Put a person on this (optional)"}>
        {hp ? (<><span className={`mx-avatar ${sub ? "" : "mx-avatar-lg"} ${hp.outside ? "mx-avatar-new" : ""}`} style={{ "--c": color, background: hp.outside ? undefined : color }}>{initials(hp.name)}</span><span className="mx-head-text"><strong>{hp.name}</strong><em>{hp.title || ""}</em></span></>) : (<><UserPlus size={13} strokeWidth={1.7} /><span>person</span></>)}
      </button>
      {!sub && <button className="mx-plus mx-plus-sub" onClick={() => addSub(axis, t.id)} title={t.subs.length ? "Add another subteam" : "Split this team into subteams"}><Plus size={13} strokeWidth={1.8} /> subteam</button>}
    </>);
  };

  const renderChip = (k, color, c) => {
    const p = person(c.ref); const missing = c.ref && source.ready && !p;
    return (
      <button key={c.id} className={`mx-chip ${!c.ref ? (c.name ? "mx-chip-new" : "mx-chip-open") : ""} ${missing ? "mx-chip-missing" : ""} ${drag?.chipId === c.id ? "mx-chip-drag" : ""}`} style={{ "--c": color }}
        draggable onDragStart={(e) => { setDrag({ key: k, chipId: c.id }); if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", c.id); } }}
        onDragEnd={() => { setDrag(null); setOverKey(null); }}
        onClick={(e) => { const rc = e.currentTarget.getBoundingClientRect(); setPicker(null); setChipMenu({ key: k, chipId: c.id, rect: { left: rc.left, top: rc.top, bottom: rc.bottom } }); }}
        title={p ? `${p.title || "—"} · reports to ${p.managerName || "—"}` : missing ? `No longer in ${source.name}` : c.name ? "Not in the org chart — click to edit" : "Open role"}>
        <span className={`mx-avatar ${!c.ref && c.name ? "mx-avatar-new" : ""}`} style={c.ref ? { background: color } : undefined}>{c.ref || c.name ? initials(p?.name || c.name) : "?"}</span>
        <span className="mx-chip-text"><strong>{p?.name || c.name || "Open role"}</strong><em>{c.role || p?.title || (c.ref ? "" : c.name ? "not in org chart" : "open role")}</em></span>
      </button>
    );
  };
  const dropProps = (k) => ({
    onDragOver: (e) => { if (!drag) return; e.preventDefault(); if (overKey !== k) setOverKey(k); },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOverKey(null); },
    onDrop: (e) => { e.preventDefault(); if (drag) moveChip(drag.key, drag.chipId, k); setDrag(null); setOverKey(null); },
  });

  const laneName = (lane) => (lane.sub ? lane.sub.label || "subteam" : lane.team.label || displayName(lane.team.headRef, "team"));
  const pickerCtx = picker && (() => {
    if (picker.mode === "cell") {
      const L = lanesOf(LEFT).find((x) => x.id === picker.leftId), T = lanesOf(TOP).find((x) => x.id === picker.topId);
      const refs = [L?.sub?.headRef, L?.team.headRef, T?.sub?.headRef, T?.team.headRef].filter(Boolean);
      const anchors = [...new Set(refs)].map((id) => ({ id, label: `${displayName(id)}'s org` }));
      return { title: `${L ? laneName(L) : ""} × ${T ? laneName(T) : ""}`, anchors, byTeam: true, taken: new Set((doc.cells[ck(picker.leftId, picker.topId)] || []).map((c) => c.ref).filter(Boolean)), multi: true, allowNew: true };
    }
    if (picker.mode === "head") { const n = find(doc, picker.axis, picker.teamId, picker.subId); return { title: `Who's on “${n?.label || (picker.subId ? "this subteam" : "this team")}”?`, hint: "Optional — pick the person who leads or represents it.", clearable: !!(n?.headRef || n?.headName), allowNew: true }; }
    return { title: "Who leads the team?", clearable: !!doc.leadRef };
  })();

  const leftLanes = lanesOf(LEFT), topLanes = lanesOf(TOP);
  return (
    <div className="org-root mx-root">
      <style>{sharedStyles}</style>
      <style>{mxStyles}</style>

      <header className="mx-top">
        <button className="mx-back" onClick={onBack} title="Back to all charts"><ArrowLeft size={16} strokeWidth={1.8} /></button>
        <div className="mx-titleblock">
          <div className="mx-eyebrow">Team matrix</div>
          {editingName
            ? <input autoFocus className="mx-title-input" defaultValue={name} onBlur={(e) => saveName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") saveName(e.target.value); if (e.key === "Escape") setEditingName(false); }} />
            : <h1 className="mx-title" onClick={() => setEditingName(true)} title="Click to rename">{name}<Edit2 size={13} strokeWidth={1.8} className="mx-pen" /></h1>}
        </div>
        <button className="mx-lead" onClick={(e) => openPicker(e, { mode: "teamLead" })} title="Who leads this team?">
          <Crown size={14} strokeWidth={1.7} />
          {doc.leadRef ? (<span><strong>{displayName(doc.leadRef)}</strong><em>{person(doc.leadRef)?.title || "Team lead"}</em></span>) : <span><strong>Set team lead</strong><em>who runs {name || "this team"}?</em></span>}
        </button>
        <div className="mx-spacer" />
        <div className="mx-stats"><span><strong>{topLanes.length}</strong> across</span><span><strong>{leftLanes.length}</strong> down</span><span><strong>{stats.people}</strong> people</span></div>
        <button className="tb" onClick={undo} disabled={!history.length} title="Undo (⌘Z)"><RotateCcw size={14} strokeWidth={1.5} /> Undo</button>
        <div className={`mx-save mx-save-${saveStatus}`}>{saveStatus === "saving" ? "Saving…" : saveStatus === "error" ? "Save error" : "Saved"}</div>
      </header>

      {rescue && (
        <div className="mx-rescue">
          <div><strong>This board looks emptier than the last version saved from this browser</strong> ({new Date(rescue.at).toLocaleString()}). An out-of-date tab may have overwritten it.</div>
          <button className="tb tb-primary" onClick={() => { setHistory((h) => [...h, docRef.current]); setDoc(rescue.doc); setRescue(null); }}>Restore that version</button>
          <button className="tb" onClick={() => { try { localStorage.removeItem(bkKey(chartId)); } catch { /* ignore */ } setRescue(null); }}>Keep what's here</button>
        </div>
      )}
      <div className="mx-sub">
        Set up <strong>teams and subteams</strong> across the top and down the side however you like, then put people where they meet. People come from <strong>{source.name || "your functional org"}</strong>; their reporting line stays there.
      </div>

      <div className="mx-scroll">
        <div className="mx-grid" style={{ gridTemplateColumns: tracks.join(" ") }}>
          <div className="mx-corner" style={{ gridColumn: "1 / 3", gridRow: "1 / 3" }}>
            <span className="mx-axis mx-axis-col">team → subteam →</span>
            <span className="mx-axis mx-axis-row">team ↓ · subteam ↓</span>
          </div>

          {topPlan.map(({ t, ti, start, end, lanes, color }) => (
            <React.Fragment key={t.id}>
              <div className={`mx-team mx-team-top ${ti ? "mx-edge-l" : ""}`} style={{ gridColumn: `${start} / ${end}`, gridRow: t.subs.length ? 1 : "1 / 3", "--c": color }}>
                <div className="mx-fn-bar" />{headCell({ axis: "top", t, color, idx: ti, count: TOP.length })}
              </div>
              {t.subs.length > 0 && lanes.map(({ lane, col: c }, i) => (
                <div key={lane.id} className={`mx-subhead ${ti && i === 0 ? "mx-edge-l" : ""}`} style={{ gridColumn: c, gridRow: 2, "--c": color }}>{headCell({ axis: "top", t, sub: lane.sub, color, idx: i, count: lanes.length })}</div>
              ))}
            </React.Fragment>
          ))}
          <div className="mx-addfn" style={{ gridColumn: lastCol, gridRow: "1 / 3" }}>
            <button className="mx-addbtn" onClick={() => addTeam("top")}><Plus size={15} strokeWidth={1.8} /> Team</button>
            {TOP.length === 0 && <span className="mx-hint">Add the teams that go across the top</span>}
          </div>
          {lastRow > 3 && <div className="mx-fill" style={{ gridColumn: lastCol, gridRow: `3 / ${lastRow}` }} />}

          {leftPlan.map(({ t, ti, start, end, lanes, color }) => (
            <React.Fragment key={t.id}>
              <div className={`mx-team mx-team-left ${ti ? "mx-edge-t" : ""}`} style={{ gridColumn: t.subs.length ? 1 : "1 / 3", gridRow: `${start} / ${end}`, "--c": color }}>{headCell({ axis: "left", t, color, idx: ti, count: LEFT.length })}</div>
              {lanes.map(({ lane, row: r }, i) => (
                <React.Fragment key={lane.id}>
                  {lane.sub && <div className={`mx-subhead mx-subhead-left ${ti && i === 0 ? "mx-edge-t" : ""}`} style={{ gridColumn: 2, gridRow: r, "--c": color }}>{headCell({ axis: "left", t, sub: lane.sub, color, idx: i, count: lanes.length })}</div>}
                  {topPlan.flatMap(({ lanes: tl, ti: tti }) => tl.map((x, xi) => ({ ...x, edge: tti > 0 && xi === 0 }))).map(({ lane: tLane, col: c, edge }) => {
                    const k = ck(lane.id, tLane.id); const chips = doc.cells[k] || [];
                    return (
                      <div key={k} className={`mx-cell ${overKey === k ? "mx-cell-over" : ""} ${chips.length ? "mx-cell-linked" : "mx-cell-empty"} ${edge ? "mx-edge-l" : ""} ${ti && i === 0 ? "mx-edge-t" : ""}`} style={{ gridColumn: c, gridRow: r, "--c": color }} {...dropProps(k)}>
                        {chips.length > 0 && <div className="mx-chiprow">{chips.map((ch) => renderChip(k, color, ch))}</div>}
                        <button className="mx-add" onClick={(e) => openPicker(e, { mode: "cell", leftId: lane.id, topId: tLane.id })} title={`${laneName(lane)} × ${laneName(tLane)}`}><Plus size={14} strokeWidth={1.8} />{chips.length ? "" : <span>Add people</span>}</button>
                      </div>
                    );
                  })}
                </React.Fragment>
              ))}
            </React.Fragment>
          ))}
          <div className="mx-addrow" style={{ gridColumn: `1 / ${lastCol + 1}`, gridRow: lastRow }}>
            <button className="mx-addbtn" onClick={() => addTeam("left")}><Plus size={15} strokeWidth={1.8} /> Team</button>
            {LEFT.length === 0 && <span className="mx-hint">Add the teams that go down the side</span>}
          </div>
        </div>
      </div>

      {picker && <PeoplePicker ctx={pickerCtx} rect={picker.rect} source={source} onPick={onPick} onClose={() => setPicker(null)} />}
      {chipMenu && (() => {
        const chip = (doc.cells[chipMenu.key] || []).find((c) => c.id === chipMenu.chipId); if (!chip) return null;
        return (<ChipMenu chip={chip} p={person(chip.ref)} rect={chipMenu.rect} sourceName={source.name}
          onRole={(v) => setRole(chipMenu.key, chip.id, v)} onName={(v) => setChipName(chipMenu.key, chip.id, v)} onLead={null}
          onRemove={() => { removeChip(chipMenu.key, chip.id); setChipMenu(null); }}
          onClose={() => setChipMenu(null)} />);
      })()}
    </div>
  );
}

// ---- inline rename ----------------------------------------------------------------------------
function InlineEdit({ value, onCommit, onDone, className, placeholder, autoEdit }) {
  const [on, setOn] = useState(false);
  const [draft, setDraft] = useState(value || "");
  useEffect(() => { if (autoEdit) { setDraft(value || ""); setOn(true); } }, [autoEdit]); // eslint-disable-line
  const commit = () => { setOn(false); if ((draft || "").trim() !== (value || "")) onCommit(draft); onDone && onDone(); };
  if (on) return <input autoFocus className={`mx-inline ${className}`} value={draft} placeholder={placeholder} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setOn(false); onDone && onDone(); } }} />;
  return <div className={`${className} ${value ? "" : "mx-placeholder"}`} onClick={() => { setDraft(value || ""); setOn(true); }} title="Click to rename">{value || placeholder}</div>;
}

// ---- floating panels: clamp to the viewport next to whatever was clicked ----------------------
// Prefer opening BELOW the thing you clicked and shrinking to the room available; only flip above
// when there's genuinely no room underneath (so the panel doesn't cover the row you're working on).
const place = (rect, w, h) => {
  const left = Math.max(12, Math.min(rect.left, window.innerWidth - w - 12));
  const below = window.innerHeight - rect.bottom - 18, above = rect.top - 18;
  if (below >= 260 || below >= above) return { left, top: rect.bottom + 6, maxHeight: Math.max(200, Math.min(h, below)) };
  const mh = Math.min(h, above); return { left, top: Math.max(12, rect.top - 6 - mh), maxHeight: mh };
};

function PeoplePicker({ ctx, rect, source, onPick, onClose }) {
  const [q, setQ] = useState("");
  const [added, setAdded] = useState(() => new Set());
  const ql = q.trim().toLowerCase();
  const match = (p) => !ql || p.name.toLowerCase().includes(ql) || p.title.toLowerCase().includes(ql) || p.team.toLowerCase().includes(ql);
  const usableP = (p) => p && p.name && !/^\?+$/.test(p.name);
  const anchors = ctx.anchors || (ctx.anchor ? [ctx.anchor] : []);
  const org = useMemo(() => { const all = new Set(); anchors.forEach((an) => source.orgOf(an.id).forEach((x) => all.add(x))); return all; }, [anchors.map((x) => x.id).join(","), source]); // eslint-disable-line
  const isDone = (p) => added.has(p.id) || (ctx.taken && ctx.taken.has(p.id));
  // the anchor's org, laid out the way it's actually organised: the head, then each of their
  // direct reports' teams — so "engineers from one of Nick's teams" is a glance, not a search
  const sections = useMemo(() => {
    const out = []; const seen = new Set();
    const fresh = (people) => people.filter((p) => usableP(p) && match(p) && !seen.has(p.id)).map((p) => { seen.add(p.id); return p; });
    anchors.forEach((an) => {
      const head = source.byId.get(an.id);
      const direct = source.kidsOf(an.id).map((id) => source.byId.get(id)).filter(usableP);
      const solo = fresh([head, ...direct.filter((d) => !source.kidsOf(d.id).length)]);
      if (solo.length) out.push({ key: an.id + "_solo", label: an.label, people: solo });
      direct.filter((d) => source.kidsOf(d.id).length).forEach((d) => {
        const people = fresh([...source.orgOf(d.id)].map((id) => source.byId.get(id)));
        if (people.length) out.push({ key: an.id + d.id, label: `${d.name}'s team`, people, team: true });
      });
    });
    return out;
  }, [anchors.map((x) => x.id).join(","), source, ql]); // eslint-disable-line
  const rest = ql ? source.list.filter((p) => usableP(p) && match(p) && !org.has(p.id)).slice(0, 12) : [];
  const pick = (p) => { onPick({ ref: p.id, name: p.name }); if (ctx.multi) setAdded((s) => new Set(s).add(p.id)); };
  const addAll = (people) => { const todo = people.filter((p) => !isDone(p)); todo.forEach((p) => onPick({ ref: p.id, name: p.name })); setAdded((s) => { const n = new Set(s); todo.forEach((p) => n.add(p.id)); return n; }); };
  const Row = ({ p }) => { const done = isDone(p); return (
    <button className={`pk-row ${done ? "pk-done" : ""}`} disabled={done} onClick={() => pick(p)}>
      <span className="mx-avatar pk-avatar">{initials(p.name)}</span>
      <span className="pk-text"><strong>{p.name}</strong><em>{[p.title, p.managerName && `↳ ${p.managerName}`].filter(Boolean).join(" · ")}</em></span>
      {done && <span className="pk-tick">added</span>}
    </button>); };
  const pos = place(rect, 380, 460);
  const nothing = !sections.length && !rest.length;
  return (<>
    <div className="pk-veil" onClick={onClose} />
    <div className="pk" style={{ ...pos, width: 380 }}>
      <div className="pk-head"><span>{ctx.title}</span><button className="pk-x" onClick={onClose}>{ctx.multi ? "Done" : <X size={14} />}</button></div>
      <div className="pk-search"><Search size={14} strokeWidth={1.6} /><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, title or team…"
        onKeyDown={(e) => { if (e.key === "Enter") { const first = [...sections.flatMap((x) => x.people), ...rest].find((p) => !isDone(p)); if (first) { pick(first); setQ(""); } } }} /></div>
      <div className="pk-list">
        {!source.ready && <div className="pk-empty">Loading people…</div>}
        {sections.map((sec) => (
          <div key={sec.key}>
            <div className="pk-group">{sec.label}{sec.team && ctx.multi && sec.people.some((p) => !isDone(p)) && <button className="pk-all" onClick={() => addAll(sec.people)}>add whole team ({sec.people.length})</button>}</div>
            {sec.people.map((p) => <Row key={p.id} p={p} />)}
          </div>
        ))}
        {rest.length > 0 && <div className="pk-group">{anchors.length ? "Everyone else" : "People"}</div>}
        {rest.map((p) => <Row key={p.id} p={p} />)}
        {source.ready && nothing && <div className="pk-empty">{ql ? `No one matches “${q}”.` : ctx.hint || "Type a name to search the functional org."}</div>}
        {ctx.allowNew && (ql
          ? <button className="pk-row pk-ghost pk-new" onClick={() => { onPick({ ref: null, name: q.trim() }); setQ(""); }}><UserPlus size={15} /><span className="pk-text"><strong>Add “{q.trim()}” as a new person</strong><em>not in {source.name || "the org chart"} — lives on this matrix only</em></span></button>
          : <button className="pk-row pk-ghost pk-new" onClick={(e) => e.currentTarget.closest(".pk").querySelector("input")?.focus()}><UserPlus size={15} /><span className="pk-text"><strong>Someone not in the org chart?</strong><em>type their name above to add them (or an open role)</em></span></button>)}
        {ctx.clearable && !ql && <button className="pk-row pk-ghost" onClick={() => onPick({ ref: null })}><X size={14} /><span className="pk-text"><strong>Clear</strong><em>leave it unassigned</em></span></button>}
      </div>
    </div>
  </>);
}

function ChipMenu({ chip, p, rect, sourceName, onRole, onName, onLead, onRemove, onClose }) {
  const [role, setRoleDraft] = useState(chip.role || "");
  const [nm, setNm] = useState(chip.name || "");
  const own = !chip.ref;   // lives on this matrix only
  const pos = place(rect, 300, own ? 320 : 260);
  const commit = () => { if (own && onName && nm.trim() !== (chip.name || "")) onName(nm.trim()); if ((role || "") !== (chip.role || "")) onRole(role.trim()); };
  return (<>
    <div className="pk-veil" onClick={() => { commit(); onClose(); }} />
    <div className="pk cm" style={pos}>
      {own ? (<>
        <label className="cm-label" style={{ marginTop: 0 }}>Name</label>
        <input className="cm-input" value={nm} placeholder="Leave blank for an open role" onChange={(e) => setNm(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { commit(); onClose(); } }} />
        <div className="cm-meta">Not in {sourceName || "the org chart"} — lives on this matrix only.</div>
      </>) : (<>
        <div className="cm-name">{p?.name || chip.name}</div>
        {p ? <div className="cm-meta">{p.title || "—"}<br />↳ reports to {p.managerName || "—"} <span>in {sourceName}</span></div> : <div className="cm-meta">No longer in {sourceName}</div>}
      </>)}
      <label className="cm-label">{own ? "Title / role" : "Role in this team"}</label>
      <input className="cm-input" autoFocus={!own || !!chip.name} value={role} placeholder={p?.title || "e.g. Tech lead"} onChange={(e) => setRoleDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { commit(); onClose(); } }} />
      <div className="cm-actions">
        {onLead && <button className="tb" onClick={() => { commit(); onLead(); }}><Crown size={13} /> Make subteam lead</button>}
        <button className="tb tb-danger" onClick={onRemove}><Trash2 size={13} /> Remove</button>
      </div>
    </div>
  </>);
}

const mxStyles = `
.mx-root { --line: #ded5c2; }
.mx-top { display: flex; align-items: center; gap: 18px; padding: 4px 0 16px; border-bottom: 1px solid var(--rule); flex-wrap: wrap; }
.mx-back { width: 38px; height: 38px; border: 1px solid var(--rule); background: transparent; border-radius: 8px; cursor: pointer; display: grid; place-items: center; color: var(--ink-soft); }
.mx-back:hover { border-color: var(--ink); color: var(--ink); background: var(--paper-2); }
.mx-eyebrow { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 10px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: var(--accent); }
.mx-title { font-family: 'Iowan Old Style', Georgia, serif; font-size: 26px; font-weight: 600; letter-spacing: -0.01em; margin: 2px 0 0; cursor: pointer; display: inline-flex; align-items: center; gap: 8px; }
.mx-pen { opacity: 0; color: var(--ink-faint); transition: opacity .12s; } .mx-title:hover .mx-pen { opacity: 1; }
.mx-title-input { font-family: 'Iowan Old Style', Georgia, serif; font-size: 26px; font-weight: 600; border: 1px solid var(--ink); border-radius: 6px; padding: 2px 8px; background: #fffdf7; outline: none; min-width: 260px; }
.mx-lead { display: flex; align-items: center; gap: 10px; padding: 8px 14px; border: 1px solid var(--rule); border-radius: 999px; background: #fffdf7; cursor: pointer; color: var(--accent); font-family: inherit; }
.mx-lead:hover { border-color: var(--ink-faint); box-shadow: var(--shadow); }
.mx-lead span { display: flex; flex-direction: column; text-align: left; line-height: 1.2; }
.mx-lead strong { font-size: 13.5px; color: var(--ink); font-weight: 600; } .mx-lead em { font-size: 11px; color: var(--ink-faint); }
.mx-spacer { flex: 1; }
.mx-stats { display: flex; gap: 16px; font-family: 'Iowan Old Style', Georgia, serif; font-size: 13px; font-style: italic; color: var(--ink-faint); }
.mx-stats strong { color: var(--ink); font-style: normal; font-size: 15px; margin-right: 3px; }
.mx-save { font-size: 11.5px; font-style: italic; min-width: 54px; text-align: right; } .mx-save-synced { color: var(--ok); } .mx-save-saving { color: var(--ink-faint); } .mx-save-error { color: var(--accent); }
.mx-sub { margin: 14px 0 16px; font-family: 'Iowan Old Style', Georgia, serif; font-size: 13.5px; color: var(--ink-soft); }
.mx-sub strong { color: var(--ink); font-weight: 600; }

.mx-scroll { overflow: auto; max-height: calc(100vh - 210px); border: 1px solid var(--line); border-radius: 12px; background: #fbf8f0; box-shadow: var(--shadow); }
.mx-grid { display: grid; min-width: max-content; }
.mx-grid > div { border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.mx-corner { position: sticky; left: 0; z-index: 5; background: #f3eee1; display: flex; flex-direction: column; justify-content: space-between; padding: 12px 14px; min-height: 96px; }
.mx-axis { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 10px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-faint); } .mx-axis-col { align-self: flex-end; }
.mx-fn { background: #fffdf7; padding: 0 12px 12px; }
.mx-fn-bar { height: 4px; background: var(--c); margin: 0 -12px 10px; }
.mx-fn-row { display: flex; align-items: flex-start; gap: 6px; }
.mx-fn-label, .mx-sub-name { flex: 1; font-family: 'Iowan Old Style', Georgia, serif; font-size: 16px; font-weight: 600; letter-spacing: -0.005em; line-height: 1.25; cursor: text; border-radius: 4px; padding: 2px 4px; margin: -2px -4px; min-width: 0; }
.mx-fn-label:hover, .mx-sub-name:hover { background: var(--paper-2); }
.mx-placeholder { color: var(--ink-faint); font-style: italic; font-weight: 400; }
.mx-inline { border: 1px solid var(--ink); outline: none; background: #fff; width: 100%; box-sizing: border-box; }
.mx-tools { display: flex; gap: 1px; opacity: 0; transition: opacity .12s; } .mx-fn:hover .mx-tools, .mx-rowhead:hover .mx-tools { opacity: 1; }
.mx-tool { width: 22px; height: 22px; border: none; background: transparent; border-radius: 5px; color: var(--ink-faint); cursor: pointer; display: grid; place-items: center; }
.mx-tool:hover:not(:disabled) { background: var(--paper-2); color: var(--ink); } .mx-tool:disabled { opacity: .25; cursor: default; } .mx-tool-danger:hover:not(:disabled) { color: var(--accent); }
.mx-head, .mx-sublead { margin-top: 10px; width: 100%; display: flex; align-items: center; gap: 9px; text-align: left; border: 1px solid transparent; background: transparent; border-radius: 9px; padding: 5px 6px; margin-left: -6px; cursor: pointer; font-family: inherit; color: var(--ink); }
.mx-head:hover, .mx-sublead:hover { background: var(--paper-2); }
.mx-head-text { display: flex; flex-direction: column; line-height: 1.25; min-width: 0; } .mx-head-text strong { font-size: 13.5px; font-weight: 600; } .mx-head-text em { font-size: 11.5px; color: var(--ink-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 190px; }
.mx-head-empty { color: var(--ink-faint); font-size: 12.5px; font-style: italic; border: 1px dashed var(--rule); margin-left: 0; padding: 7px 10px; }
.mx-sublead { font-size: 12.5px; color: var(--ink-soft); gap: 7px; margin-top: 8px; } .mx-sublead strong { color: var(--ink); font-weight: 600; } .mx-sublead svg { color: var(--accent); }
.mx-sublead.mx-head-empty svg { color: var(--ink-faint); }
.mx-avatar { width: 28px; height: 28px; flex: none; border-radius: 50%; display: grid; place-items: center; font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 10.5px; font-weight: 700; color: #fff; background: #a89c86; letter-spacing: .02em; }
.mx-rowhead { position: sticky; left: 0; z-index: 2; background: #f7f3e8; padding: 14px 14px 12px; }
.mx-group { background: #fffdf7; padding: 0 14px 12px; }
.mx-group-row { display: flex; align-items: center; gap: 8px; min-height: 24px; }
.mx-group-label { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 10.5px; font-weight: 700; letter-spacing: .09em; text-transform: uppercase; color: var(--c); cursor: text; border-radius: 4px; padding: 3px 6px; margin-left: -6px; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mx-group-label:hover { background: var(--paper-2); } input.mx-group-label { text-transform: none; letter-spacing: 0; font-size: 13px; font-weight: 400; color: var(--ink); }
.mx-group:hover .mx-tools { opacity: 1; } .mx-sub-head:hover .mx-tools { opacity: 1; }
.mx-head-inline { margin-top: 6px; white-space: nowrap; } .mx-head-inline.mx-head-empty { width: auto; display: inline-flex; }
.mx-avatar-lg { width: 34px; height: 34px; font-size: 12px; } .mx-avatar-partner { background: #b8442a; }
.mx-sub-head { background: color-mix(in srgb, var(--c) 5%, #fffdf8); padding: 12px 12px 12px; display: flex; flex-direction: column; gap: 2px; box-shadow: inset 0 2px 0 color-mix(in srgb, var(--c) 35%, transparent); transition: background .12s, box-shadow .12s; }
.mx-sublead-empty { color: var(--ink-faint); font-style: italic; } .mx-sublead-empty svg { color: var(--ink-faint) !important; }
.mx-rel { margin-left: auto; font-size: 11px; font-style: italic; color: var(--accent); }
.mx-members { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 8px; }
.mx-add-on { opacity: .7 !important; } .mx-add-on:hover { opacity: 1 !important; }
.mx-addsub { background: #f3eee1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 10px 6px; text-align: center; }
.mx-addbtn-sm { padding: 7px 11px; font-size: 12.5px; position: static; }
.mx-cell-linked { background: color-mix(in srgb, var(--c) 4%, #fffdf8); }
.mx-cell { padding: 10px; display: flex; flex-wrap: wrap; align-content: flex-start; gap: 7px; min-height: 66px; background: #fffdf8; transition: background .12s, box-shadow .12s; }
.mx-cell-over { background: color-mix(in srgb, var(--c) 9%, #fffdf8); box-shadow: inset 0 0 0 2px var(--c); }
.mx-chip { display: flex; align-items: center; gap: 8px; max-width: 100%; text-align: left; padding: 5px 11px 5px 5px; border: 1px solid var(--line); border-radius: 999px; background: #fff; cursor: grab; font-family: inherit; color: var(--ink); transition: box-shadow .12s, border-color .12s, transform .12s; }
.mx-chip:hover { border-color: var(--c); box-shadow: 0 2px 10px -4px rgba(26,22,18,.35); transform: translateY(-1px); }
.mx-chip-text { display: flex; flex-direction: column; line-height: 1.2; min-width: 0; } .mx-chip-text strong { font-size: 13px; font-weight: 600; white-space: nowrap; } .mx-chip-text em { font-size: 11px; color: var(--ink-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 170px; }
.mx-chip-open { border-style: dashed; background: transparent; } .mx-chip-open .mx-avatar { background: transparent; color: var(--ink-faint); border: 1px dashed var(--ink-faint); }
.mx-chip-missing { border-color: var(--accent); border-style: dashed; } .mx-chip-drag { opacity: .35; }
.mx-add { display: inline-flex; align-items: center; gap: 6px; height: 40px; padding: 0 12px; border: 1px dashed var(--rule); border-radius: 999px; background: transparent; color: var(--ink-faint); cursor: pointer; font-family: 'Iowan Old Style', Georgia, serif; font-size: 12.5px; font-style: italic; opacity: 0; transition: opacity .12s, color .12s, border-color .12s; }
.mx-cell:hover .mx-add, .mx-cell-empty .mx-add { opacity: 1; } .mx-cell-empty .mx-add { opacity: .55; } .mx-cell-empty:hover .mx-add { opacity: 1; }
.mx-add:hover { color: var(--ink); border-color: var(--ink); border-style: solid; }
.mx-fill, .mx-addfn { background: #f3eee1; } .mx-addfn { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 14px; text-align: center; }
.mx-addrow { display: flex; align-items: center; gap: 16px; padding: 14px; background: #f3eee1; border-bottom: none !important; }
.mx-addbtn { display: inline-flex; align-items: center; gap: 7px; padding: 9px 16px; border: 1px dashed var(--ink-faint); border-radius: 999px; background: transparent; color: var(--ink-soft); cursor: pointer; font-family: 'Iowan Old Style', Georgia, serif; font-size: 13.5px; white-space: nowrap; position: sticky; left: 14px; }
.mx-addbtn:hover { background: var(--ink); color: var(--paper); border-color: var(--ink); border-style: solid; }
.mx-hint { font-family: 'Iowan Old Style', Georgia, serif; font-size: 13px; font-style: italic; color: var(--ink-faint); }

.mx-corner-add { align-self: flex-start; background: #fffdf7; }
.mx-team { background: #fffdf7; padding: 0 12px 12px; }
.mx-team-top { padding-top: 0; } .mx-team-left { padding: 14px 12px 12px 16px; box-shadow: inset 4px 0 0 var(--c); background: #f7f3e8; position: sticky; left: 0; z-index: 3; }
.mx-team:hover .mx-tools, .mx-subhead:hover .mx-tools { opacity: 1; }
.mx-team-name { flex: 1; min-width: 0; font-family: 'Iowan Old Style', Georgia, serif; font-size: 17px; font-weight: 600; letter-spacing: -0.005em; line-height: 1.25; cursor: text; border-radius: 4px; padding: 2px 4px; margin: -2px -4px; }
.mx-team-name:hover { background: var(--paper-2); }
.mx-subhead { background: color-mix(in srgb, var(--c) 5%, #fffdf8); padding: 10px 12px; box-shadow: inset 0 2px 0 color-mix(in srgb, var(--c) 40%, transparent); }
.mx-subhead .mx-sub-name { font-size: 14.5px; }
.mx-subhead-left { box-shadow: inset 2px 0 0 color-mix(in srgb, var(--c) 40%, transparent); background: #faf6ec; position: sticky; left: 204px; z-index: 2; }
.mx-subhead-none { display: flex; align-items: center; }
.mx-none { font-family: 'Iowan Old Style', Georgia, serif; font-size: 12px; font-style: italic; color: var(--ink-faint); }
.mx-person { margin-top: 7px; display: inline-flex; align-items: center; gap: 8px; max-width: 100%; text-align: left; border: 1px solid transparent; background: transparent; border-radius: 9px; padding: 3px 6px; margin-left: -6px; cursor: pointer; font-family: inherit; color: var(--ink); }
.mx-person:hover { background: var(--paper-2); }
.mx-person-empty { color: var(--ink-faint); font-size: 11.5px; font-style: italic; border: 1px dashed var(--rule); margin-left: 0; padding: 3px 9px; opacity: 0; transition: opacity .12s; }
.mx-team:hover .mx-person-empty, .mx-subhead:hover .mx-person-empty { opacity: 1; }
.mx-addcell { background: #f3eee1; display: grid; place-items: center; padding: 6px; }
.mx-addcell-left { place-items: center start; padding: 7px 10px; position: sticky; left: 176px; z-index: 2; }
.mx-plus { display: inline-flex; align-items: center; gap: 5px; height: 30px; min-width: 30px; justify-content: center; padding: 0 8px; border: 1px dashed var(--ink-faint); border-radius: 999px; background: transparent; color: var(--ink-soft); cursor: pointer; font-family: 'Iowan Old Style', Georgia, serif; font-size: 12.5px; font-style: italic; }
.mx-plus:hover { background: var(--ink); color: var(--paper); border-color: var(--ink); border-style: solid; }
.mx-fn-row { position: relative; }
.mx-team .mx-tools, .mx-subhead .mx-tools { position: absolute; top: -3px; right: -6px; background: #fffdf7; border: 1px solid var(--line); border-radius: 7px; padding: 1px; box-shadow: 0 2px 6px rgba(40,30,10,.08); pointer-events: none; }
.mx-team:hover > .mx-fn-row .mx-tools, .mx-subhead:hover .mx-tools { pointer-events: auto; }
.mx-plus-sub { margin-top: 9px; height: 25px; font-size: 12px; opacity: .55; display: flex; width: max-content; }
.mx-team:hover .mx-plus-sub { opacity: 1; }
.mx-team-top .mx-plus-sub { position: absolute; right: 12px; bottom: 10px; margin: 0; } .mx-team-top { position: relative; padding-bottom: 14px; min-height: 74px; }
.mx-grid > .mx-edge-l { border-left: 2px solid #cfc6b1; } .mx-grid > .mx-edge-t { border-top: 2px solid #cfc6b1; }
.mx-chip-new { border-style: dashed; }
.mx-avatar-new { background: color-mix(in srgb, var(--c) 14%, #fffdf8) !important; color: var(--c) !important; border: 1px dashed var(--c); }
.pk .pk-row.pk-new { position: sticky; bottom: 0; background: #f6f1e4; margin-top: 0; z-index: 1; border-top: 1px solid var(--rule); box-shadow: 0 -6px 10px -6px rgba(40,30,10,.12); } .pk .pk-row.pk-new:hover { background: #efe8d6; } .pk-new strong { color: var(--ink); }
.mx-rescue { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 14px; padding: 12px 14px; border: 1px solid #b8442a; border-radius: 10px; background: #fbeee9; font-family: 'Iowan Old Style', Georgia, serif; font-size: 13.5px; line-height: 1.5; }
.mx-rescue > div { flex: 1; min-width: 280px; }
.mx-pod { background: #fffdf7; padding: 14px 14px 12px; box-shadow: inset 0 3px 0 var(--ink); }
.mx-pod:hover .mx-tools, .mx-rowhead:hover .mx-tools { opacity: 1; }
.mx-bar { padding: 9px 0; background: #efe9da; }
.mx-bar-in { position: sticky; left: 14px; display: inline-flex; align-items: center; gap: 14px; max-width: calc(100vw - 120px); }
.mx-bar .mx-addbtn, .mx-corner .mx-addbtn { position: static; }
.mx-bar-title { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 10.5px; font-weight: 700; letter-spacing: .11em; text-transform: uppercase; color: var(--ink); white-space: nowrap; }
.mx-bar-wide .mx-bar-title { color: #b8442a; }
.mx-bar-blurb { font-family: 'Iowan Old Style', Georgia, serif; font-size: 12.5px; font-style: italic; color: var(--ink-faint); flex: 1; }
.mx-emptyrow { padding: 16px 18px; background: #fbf8f0; font-family: 'Iowan Old Style', Georgia, serif; font-size: 13px; font-style: italic; color: var(--ink-faint); }
.mx-rowhead { box-shadow: inset 4px 0 0 var(--c); padding-left: 18px !important; }
.mx-cell { flex-direction: column; flex-wrap: nowrap; align-items: flex-start; gap: 8px; }
.mx-chiprow { display: flex; flex-wrap: wrap; gap: 7px; }
.mx-branch { width: 100%; }
.mx-branch-label { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 9.5px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: color-mix(in srgb, var(--c) 75%, #000); margin: 2px 0 5px 2px; }
.pk-group { display: flex; align-items: center; gap: 8px; }
.pk-all { margin-left: auto; border: 1px solid var(--rule); background: transparent; border-radius: 999px; padding: 2px 9px; cursor: pointer; font-family: 'Iowan Old Style', Georgia, serif; font-size: 11px; font-style: italic; font-weight: 400; letter-spacing: 0; text-transform: none; color: var(--ink-soft); }
.pk-all:hover { background: var(--ink); color: var(--paper); border-color: var(--ink); }
.pk-veil { position: fixed; inset: 0; z-index: 80; }
.pk { position: fixed; z-index: 81; width: 360px; display: flex; flex-direction: column; background: var(--paper); border: 1px solid var(--ink); border-radius: 12px; box-shadow: 0 24px 60px -18px rgba(26,22,18,.5); overflow: hidden; font-family: 'Iowan Old Style', Georgia, serif; }
.pk-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 11px 14px; font-size: 14px; font-weight: 600; border-bottom: 1px solid var(--rule); }
.pk-x { border: 1px solid var(--rule); background: transparent; border-radius: 999px; padding: 3px 11px; cursor: pointer; font-family: inherit; font-size: 12px; color: var(--ink-soft); display: inline-flex; align-items: center; } .pk-x:hover { background: var(--ink); color: var(--paper); border-color: var(--ink); }
.pk-search { display: flex; align-items: center; gap: 8px; padding: 9px 14px; border-bottom: 1px solid var(--rule-soft); color: var(--ink-faint); }
.pk-search input { flex: 1; border: none; outline: none; background: transparent; font-family: inherit; font-size: 14px; color: var(--ink); }
.pk-list { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 4px 0 6px; }
.pk-group { padding: 9px 14px 4px; font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 9.5px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: var(--ink-faint); }
.pk-row { width: 100%; display: flex; align-items: center; gap: 10px; padding: 7px 14px; border: none; background: transparent; cursor: pointer; text-align: left; font-family: inherit; color: var(--ink); }
.pk-row:hover:not(:disabled) { background: var(--paper-2); } .pk-done { opacity: .45; cursor: default; }
.pk-text { display: flex; flex-direction: column; line-height: 1.25; min-width: 0; flex: 1; } .pk-text strong { font-size: 13.5px; font-weight: 600; } .pk-text em { font-size: 11.5px; color: var(--ink-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pk-tick { font-size: 11px; font-style: italic; color: var(--ok); } .pk-ghost { color: var(--ink-soft); border-top: 1px solid var(--rule-soft); margin-top: 4px; padding-top: 10px; }
.pk-empty { padding: 18px 14px; font-size: 13px; font-style: italic; color: var(--ink-faint); line-height: 1.5; }
.cm { width: 300px; padding: 14px; } .cm-name { font-size: 16px; font-weight: 600; }
.cm-meta { font-size: 12px; font-style: italic; color: var(--ink-soft); margin-top: 3px; line-height: 1.5; } .cm-meta span { color: var(--ink-faint); }
.cm-label { display: block; margin: 12px 0 5px; font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 9.5px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: var(--ink-faint); }
.cm-input { width: 100%; box-sizing: border-box; font-family: inherit; font-size: 13.5px; padding: 7px 9px; border: 1px solid var(--rule); border-radius: 7px; background: #fffdf7; outline: none; } .cm-input:focus { border-color: var(--ink); }
.cm-actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
`;
