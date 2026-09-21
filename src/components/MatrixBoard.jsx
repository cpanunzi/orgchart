import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { ArrowLeft, Plus, X, Search, RotateCcw, Crown, ChevronLeft, ChevronRight, ChevronUp, ChevronDown, Trash2, Edit2, UserPlus } from "lucide-react";
import { supabase } from "../lib/supabase.js";
import { sharedStyles } from "./styles.js";

// ---------------------------------------------------------------------------------------------
// Team matrix board.
//   columns = the team's subteams (Customer Operations, Field Engineering …). A subteam doesn't
//             belong to one leader — it is staffed from several functions at once.
//   rows    = the functions that staff them, each headed by a person, in two blocks:
//               core  — the team's own leadership (Tali · Product, Nick · Engineering)
//               wider — the rest of the business (Ericka · Account Mgmt)
//   cells   = the people from that function dedicated to that subteam, shown grouped by which
//             of the function head's teams they come from ("Julian's team").
// People are references (`ref`) into a functional chart (doc.sourceChartId), read live from it.
//   { id:"root", kind:"matrix", v:4, sourceChartId, leadRef,
//     pods:[{id,name,leadRef}], rows:[{id,label,headRef,core}],
//     cells:{ "<rowId>|<podId>": [{id, ref, name, role}] } }
// ---------------------------------------------------------------------------------------------

const rid = () => Math.random().toString(36).slice(2, 10);
const clone = (x) => JSON.parse(JSON.stringify(x));
const ck = (rowId, podId) => `${rowId}|${podId}`;
const COLORS = ["#3b6ea5", "#6d5aa8", "#2f7f86", "#5b7a3f", "#b07d2a", "#a0527a", "#6b6252"];
const WIDE_COLOR = "#b8442a";
const fnLabelFrom = (p) => {
  if (!p) return "";
  const t = (p.title || "").replace(/^\s*(chief|s?e?vp|svp|evp|vp|vice president|head|director|lead|manager|gm|general manager)\b[\s,]*(of\s+)?/i, "").trim();
  return t || p.team || p.title || "";
};
const initials = (name) => (name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0] || "").join("").toUpperCase() || "?";

// ---- upgrades from earlier board formats ------------------------------------------------------
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
  if (raw && raw.v === 4) return { doc: raw, migrated: false };
  const pods = [], rows = [], cells = {};
  const put = (k, chips) => { if (chips && chips.length) cells[k] = [...(cells[k] || []), ...chips]; };
  let t = raw || {};
  if (t.v === 3) {
    // v3: leaders (groups) owned subteams; partners ran down the side. Subteams stay as columns;
    // leaders and partners both become function rows; a subteam's members sit in its leader's row.
    (t.subteams || []).forEach((st) => pods.push({ id: st.id, name: st.name || "", leadRef: st.leadRef || null }));
    (t.groups || []).forEach((g) => rows.push({ id: g.id, label: g.label || "", headRef: g.headRef || null, core: true }));
    (t.partners || []).forEach((pt) => rows.push({ id: pt.id, label: pt.label || "", headRef: pt.headRef || null, core: false }));
    Object.entries(t.cells || {}).forEach(([k, chips]) => {
      const [rowId, stId] = k.split("|");
      if (rowId === "_m") { const st = (t.subteams || []).find((x) => x.id === stId); if (st) put(ck(st.groupId, stId), chips); } else put(k, chips);
    });
  } else {
    if (t.v !== 2) t = v1toV2(t);
    (t.subteams || []).forEach((st) => { if ((st.name || "").trim() || st.leadRef) pods.push({ id: st.id, name: st.name || "", leadRef: st.leadRef || null }); });
    (t.functions || []).forEach((f) => { rows.push({ id: f.id, label: f.label || "", headRef: f.headRef || null, core: true }); });
    Object.entries(t.cells || {}).forEach(([k, chips]) => { const [sid, fid] = k.split("|"); put(ck(fid, sid), chips); });
  }
  const doc = { id: "root", kind: "matrix", v: 4, sourceChartId: t.sourceChartId || null, leadRef: t.leadRef || null, pods, rows, cells, children: [] };
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
  // which of `headId`'s direct reports does `id` roll up to? (null if it's the head, or outside their org)
  const branchOf = (headId, id) => { if (!headId || id === headId) return null; let cur = byId.get(id), guard = 0; while (cur && cur.managerId && cur.managerId !== headId && guard++ < 60) cur = byId.get(cur.managerId); return cur && cur.managerId === headId ? cur : null; };
  return { list, byId, orgOf, kidsOf, branchOf };
};
// ---- safety net against out-of-date tabs ------------------------------------------------------
// An old tab running an earlier build doesn't understand this format; if it saves, it overwrites
// the board with an empty one. We can't fix old tabs, so: keep a copy of every save in this
// browser, refuse to load/overwrite formats NEWER than this build, and when a stale write lands
// on an open board, put the good version straight back.
const V = 4;
const weight = (d) => (d ? (d.pods || []).length + (d.rows || []).length + Object.values(d.cells || {}).reduce((n, a) => n + a.length, 0) : 0);
const bkKey = (id) => `atelier-matrix-backup:${id}`;
const readBackup = (id) => { try { const b = JSON.parse(localStorage.getItem(bkKey(id)) || "null"); return b && b.doc && b.doc.v === V ? b : null; } catch { return null; } };
const writeBackup = (id, doc) => { try { if (weight(doc) > 0) localStorage.setItem(bkKey(id), JSON.stringify({ at: Date.now(), doc })); } catch { /* storage full/blocked — not fatal */ } };

const EMPTY_SOURCE = { list: [], byId: new Map(), orgOf: () => new Set(), kidsOf: () => [], branchOf: () => null, name: "", ready: false };

// small move/remove toolbar shown on hover (module-level so it isn't remounted every render)
const Tools = ({ onPrev, onNext, onRemove, prevIcon, nextIcon, canPrev, canNext, what, extra }) => (
  <div className="mx-tools">
    {extra}
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
  const [picker, setPicker] = useState(null);     // { mode, podId?, rowId?, core?, rect }
  const [chipMenu, setChipMenu] = useState(null); // { key, chipId, podId, rect }
  const [editing, setEditing] = useState(null);   // { type:"pod"|"row", id }
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
      const { doc: d, migrated } = toV4(data.tree);
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
        if (!incoming || incoming.v !== V) { if (docRef.current && weight(docRef.current) > 0) scheduleSave(docRef.current, undefined); return; }
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

  // ---- actions ------------------------------------------------------------------------------
  const dropCells = (d, pred) => Object.keys(d.cells).forEach((k) => { if (pred(k)) delete d.cells[k]; });
  const peopleIn = (pred) => Object.entries(doc.cells || {}).reduce((n, [k, v]) => n + (pred(k) ? v.length : 0), 0);
  const confirmLoss = (what, n) => !n || window.confirm(`Remove ${what} and the ${n} ${n === 1 ? "person" : "people"} placed in it?`);

  const addPod = () => { const id = rid(); apply((d) => { d.pods.push({ id, name: "", leadRef: null }); return d; }); setEditing({ type: "pod", id }); };
  const addRow = (core, headRef, label) => { const id = rid(); apply((d) => { d.rows.push({ id, label: label || "", headRef: headRef || null, core }); return d; }); setEditing({ type: "row", id }); };
  const rename = (arr, id, field, v) => apply((d) => { const x = d[arr].find((y) => y.id === id); if (x) x[field] = v.trim(); return d; });
  const moveIn = (arr, id, delta, within) => apply((d) => {
    const a = d[arr]; const i = a.findIndex((x) => x.id === id); if (i < 0) return d;
    let j = i + delta; if (within) while (j >= 0 && j < a.length && !!a[j][within] !== !!a[i][within]) j += delta;
    if (j < 0 || j >= a.length) return d;
    const [x] = a.splice(i, 1); a.splice(j, 0, x); return d;
  });
  const toggleCore = (row) => apply((d) => { const x = d.rows.find((y) => y.id === row.id); if (x) x.core = !x.core; return d; });
  const removePod = (pod) => { const n = peopleIn((k) => k.split("|")[1] === pod.id); if (!confirmLoss(`"${pod.name || "this subteam"}"`, n)) return;
    apply((d) => { d.pods = d.pods.filter((x) => x.id !== pod.id); dropCells(d, (k) => k.split("|")[1] === pod.id); return d; }); };
  const removeRow = (row) => { const n = peopleIn((k) => k.split("|")[0] === row.id); if (!confirmLoss(`the "${row.label || displayName(row.headRef, "function")}" row`, n)) return;
    apply((d) => { d.rows = d.rows.filter((x) => x.id !== row.id); dropCells(d, (k) => k.split("|")[0] === row.id); return d; }); };
  const addTo = (key, pick) => apply((d) => { const arr = d.cells[key] || (d.cells[key] = []); if (pick.ref && arr.some((c) => c.ref === pick.ref)) return d; arr.push({ id: rid(), ref: pick.ref || null, name: pick.name || "", role: "" }); return d; });
  const removeChip = (key, chipId) => apply((d) => { d.cells[key] = (d.cells[key] || []).filter((c) => c.id !== chipId); if (!d.cells[key].length) delete d.cells[key]; return d; });
  const setRole = (key, chipId, role) => apply((d) => { const c = (d.cells[key] || []).find((x) => x.id === chipId); if (c) c.role = role; return d; });
  const moveChip = (fromKey, chipId, toKey) => { if (fromKey === toKey) return; apply((d) => { const from = d.cells[fromKey] || []; const chip = from.find((c) => c.id === chipId); if (!chip) return d; const to = d.cells[toKey] || (d.cells[toKey] = []); if (chip.ref && to.some((c) => c.ref === chip.ref)) return d; d.cells[fromKey] = from.filter((c) => c.id !== chipId); if (!d.cells[fromKey].length) delete d.cells[fromKey]; to.push(chip); return d; }); };

  const onPick = (pick) => {
    const p = picker; if (!p) return;
    if (p.mode === "cell") { addTo(ck(p.rowId, p.podId), pick); return; }      // stays open — add several
    if (p.mode === "newRow") addRow(p.core, pick.ref, pick.ref ? fnLabelFrom(person(pick.ref)) : pick.name);
    if (p.mode === "rowHead") apply((d) => { const x = d.rows.find((y) => y.id === p.rowId); if (x) x.headRef = pick.ref || null; return d; });
    if (p.mode === "podLead") apply((d) => { const x = d.pods.find((y) => y.id === p.podId); if (x) x.leadRef = pick.ref || null; return d; });
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

  const PODS = doc.pods, ROWS = doc.rows;
  const coreRows = ROWS.filter((r) => r.core), wideRows = ROWS.filter((r) => !r.core);
  const lastCol = PODS.length + 2;
  const tracks = ["272px", ...PODS.map(() => "minmax(250px, 1fr)"), "180px"].join(" ");
  const rowColor = (row) => (row.core ? COLORS[coreRows.indexOf(row) % COLORS.length] : WIDE_COLOR);
  const podStaffing = (podId) => ROWS.filter((r) => (doc.cells[ck(r.id, podId)] || []).length).length;

  const renderChip = (k, podId, color, c) => {
    const p = person(c.ref); const missing = c.ref && source.ready && !p;
    return (
      <button key={c.id} className={`mx-chip ${!c.ref ? "mx-chip-open" : ""} ${missing ? "mx-chip-missing" : ""} ${drag?.chipId === c.id ? "mx-chip-drag" : ""}`} style={{ "--c": color }}
        draggable onDragStart={(e) => { setDrag({ key: k, chipId: c.id }); if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", c.id); } }}
        onDragEnd={() => { setDrag(null); setOverKey(null); }}
        onClick={(e) => { const rc = e.currentTarget.getBoundingClientRect(); setPicker(null); setChipMenu({ key: k, chipId: c.id, podId, rect: { left: rc.left, top: rc.top, bottom: rc.bottom } }); }}
        title={p ? `${p.title || "—"} · reports to ${p.managerName || "—"}` : missing ? `No longer in ${source.name}` : "Open role / not in the org"}>
        <span className="mx-avatar" style={c.ref ? { background: color } : undefined}>{c.ref ? initials(p?.name || c.name) : "?"}</span>
        <span className="mx-chip-text"><strong>{p?.name || c.name || "Open role"}</strong><em>{c.role || p?.title || (c.ref ? "" : "open role")}</em></span>
      </button>
    );
  };
  // people in a cell, grouped by which of the function head's teams they roll up to
  const renderCellPeople = (k, podId, row, color) => {
    const chips = doc.cells[k] || []; if (!chips.length) return null;
    const loose = [], teams = new Map();
    chips.forEach((c) => {
      const br = row.headRef && c.ref ? source.branchOf(row.headRef, c.ref) : null;
      if (br && source.kidsOf(br.id).length) { if (!teams.has(br.id)) teams.set(br.id, { lead: br, chips: [] }); teams.get(br.id).chips.push(c); } else loose.push(c);
    });
    return (<>
      {loose.length > 0 && <div className="mx-chiprow">{loose.map((c) => renderChip(k, podId, color, c))}</div>}
      {[...teams.values()].map((t) => (
        <div className="mx-branch" key={t.lead.id}>
          <div className="mx-branch-label">from {t.lead.name}'s team</div>
          <div className="mx-chiprow">{t.chips.map((c) => renderChip(k, podId, color, c))}</div>
        </div>
      ))}
    </>);
  };
  const dropProps = (k) => ({
    onDragOver: (e) => { if (!drag) return; e.preventDefault(); if (overKey !== k) setOverKey(k); },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOverKey(null); },
    onDrop: (e) => { e.preventDefault(); if (drag) moveChip(drag.key, drag.chipId, k); setDrag(null); setOverKey(null); },
  });

  const pickerCtx = picker && (() => {
    const pod = PODS.find((x) => x.id === picker.podId), row = ROWS.find((x) => x.id === picker.rowId);
    const org = (ref) => (ref ? { id: ref, label: `${displayName(ref)}'s org` } : null);
    if (picker.mode === "cell") return { title: `${row?.label || displayName(row?.headRef, "This function")} people on ${pod?.name || "this subteam"}`, anchor: org(row?.headRef), byTeam: true, taken: new Set((doc.cells[ck(picker.rowId, picker.podId)] || []).map((c) => c.ref).filter(Boolean)), multi: true, allowPlaceholder: true };
    if (picker.mode === "newRow") return picker.core
      ? { title: `Who leads a function inside ${name || "this team"}?`, hint: "Pick the leader — e.g. the product lead, the engineering lead. Or type a function name to add it without a leader.", allowPlaceholder: true, placeholderLabel: (q) => `Add “${q}” with no leader yet` }
      : { title: "Which other part of the business?", hint: "Pick who heads it — e.g. the head of account management. Or type a name to add it without a head.", allowPlaceholder: true, placeholderLabel: (q) => `Add “${q}” with no head yet` };
    if (picker.mode === "rowHead") return { title: `Who heads ${row?.label || "this function"}?`, clearable: !!row?.headRef };
    if (picker.mode === "podLead") return { title: `Who leads ${pod?.name || "this subteam"}?`, clearable: !!pod?.leadRef };
    return { title: "Who leads the team?", clearable: !!doc.leadRef };
  })();

  // ---- grid rows: header, then the two blocks of function rows ------------------------------
  let gr = 2; const body = [];
  const block = (core, rowsIn, title, blurb, addLabel) => {
    body.push(
      <div key={`bar-${core}`} className={`mx-bar ${core ? "mx-bar-core" : "mx-bar-wide"}`} style={{ gridColumn: `1 / ${lastCol + 1}`, gridRow: gr++ }}>
        <div className="mx-bar-in">
          <span className="mx-bar-title">{title}</span>
          <button className="mx-addbtn mx-addbtn-sm" onClick={(e) => openPicker(e, { mode: "newRow", core })}><Plus size={14} strokeWidth={1.8} /> {addLabel}</button>
          <span className="mx-bar-blurb">{blurb}</span>
        </div>
      </div>
    );
    rowsIn.forEach((row, i) => {
      const r = gr++; const head = person(row.headRef); const color = rowColor(row);
      body.push(
        <div key={row.id} className="mx-rowhead" style={{ gridColumn: 1, gridRow: r, "--c": color }}>
          <div className="mx-fn-row">
            <InlineEdit className="mx-fn-label" value={row.label} placeholder="Name this function" autoEdit={editing?.type === "row" && editing.id === row.id} onDone={() => setEditing(null)} onCommit={(v) => rename("rows", row.id, "label", v)} />
            <Tools what="this function" prevIcon={<ChevronUp size={13} />} nextIcon={<ChevronDown size={13} />} canPrev={i > 0} canNext={i < rowsIn.length - 1}
              onPrev={() => moveIn("rows", row.id, -1, "core")} onNext={() => moveIn("rows", row.id, 1, "core")} onRemove={() => removeRow(row)}
              extra={<button className="mx-tool" onClick={() => toggleCore(row)} title={row.core ? "Move to “Rest of the business”" : `Move to “${name || "Team"} leadership”`}>{row.core ? <ChevronDown size={13} strokeWidth={2.4} /> : <ChevronUp size={13} strokeWidth={2.4} />}</button>} />
          </div>
          <button className={`mx-head ${head ? "" : "mx-head-empty"}`} onClick={(e) => openPicker(e, { mode: "rowHead", rowId: row.id })}>
            {head ? (<><span className="mx-avatar mx-avatar-lg" style={{ background: color }}>{initials(head.name)}</span><span className="mx-head-text"><strong>{head.name}</strong><em>{head.title || "Head"}</em></span></>) : (<><UserPlus size={14} strokeWidth={1.7} /><span>Who heads it?</span></>)}
          </button>
        </div>
      );
      PODS.forEach((pod, ci) => {
        const k = ck(row.id, pod.id); const has = (doc.cells[k] || []).length > 0;
        body.push(
          <div key={k} className={`mx-cell ${overKey === k ? "mx-cell-over" : ""} ${has ? "mx-cell-linked" : "mx-cell-empty"}`} style={{ gridColumn: ci + 2, gridRow: r, "--c": color }} {...dropProps(k)}>
            {renderCellPeople(k, pod.id, row, color)}
            <button className="mx-add" onClick={(e) => openPicker(e, { mode: "cell", rowId: row.id, podId: pod.id })} title={`Who from ${row.label || "this function"} is on ${pod.name || "this subteam"}?`}><Plus size={14} strokeWidth={1.8} />{has ? "" : <span>Add people</span>}</button>
          </div>
        );
      });
      body.push(<div key={row.id + "-fill"} className="mx-fill" style={{ gridColumn: lastCol, gridRow: r }} />);
    });
    if (!rowsIn.length) body.push(<div key={`empty-${core}`} className="mx-emptyrow" style={{ gridColumn: `1 / ${lastCol + 1}`, gridRow: gr++ }}>{core ? "e.g. Tali for Product, Nick for Engineering — the people who lead a function inside this team." : "e.g. Account Mgmt (Ericka) — add as many as the subteams need."}</div>);
  };
  block(true, coreRows, `${name || "Team"} leadership`, "the functions inside this team — who each gives to every subteam", "Add a function lead");
  block(false, wideRows, "Rest of the business", "other parts of the business these subteams also sit in or work with", "Add a part of the business");

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
        <div className="mx-stats"><span><strong>{PODS.length}</strong> subteams</span><span><strong>{ROWS.length}</strong> functions</span><span><strong>{stats.people}</strong> people</span></div>
        <button className="tb" onClick={undo} disabled={!history.length} title="Undo (⌘Z)"><RotateCcw size={14} strokeWidth={1.5} /> Undo</button>
        <div className={`mx-save mx-save-${saveStatus}`}>{saveStatus === "saving" ? "Saving…" : saveStatus === "error" ? "Save error" : "Saved"}</div>
      </header>

      {rescue && (
        <div className="mx-rescue">
          <div><strong>This board looks emptier than the last version saved from this browser</strong> ({new Date(rescue.at).toLocaleString()} — {rescue.doc.pods.length} subteams, {rescue.doc.rows.length} functions). An out-of-date tab may have overwritten it.</div>
          <button className="tb tb-primary" onClick={() => { setHistory((h) => [...h, docRef.current]); setDoc(rescue.doc); setRescue(null); }}>Restore that version</button>
          <button className="tb" onClick={() => { writeBackup(chartId, docRef.current); try { if (weight(docRef.current) === 0) localStorage.removeItem(bkKey(chartId)); } catch { /* ignore */ } setRescue(null); }}>Keep what's here</button>
        </div>
      )}
      <div className="mx-sub">
        Each <strong>subteam</strong> (a column) is staffed from several <strong>functions</strong> (the rows) at once — e.g. a PM from product, dedicated engineers, someone from account management. People come from <strong>{source.name || "your functional org"}</strong>; their reporting line stays there.
      </div>

      <div className="mx-scroll">
        <div className="mx-grid" style={{ gridTemplateColumns: tracks }}>
          <div className="mx-corner" style={{ gridColumn: 1, gridRow: 1 }}>
            <span className="mx-axis mx-axis-col">Subteams →</span>
            <button className="mx-addbtn mx-addbtn-sm mx-corner-add" onClick={addPod}><Plus size={14} strokeWidth={1.8} /> Add subteam</button>
            <span className="mx-axis mx-axis-row">Staffed by ↓</span>
          </div>
          {PODS.map((pod, i) => { const n = podStaffing(pod.id); return (
            <div className="mx-pod" key={pod.id} style={{ gridColumn: i + 2, gridRow: 1 }}>
              <div className="mx-fn-row">
                <InlineEdit className="mx-sub-name" value={pod.name} placeholder="Name this subteam" autoEdit={editing?.type === "pod" && editing.id === pod.id} onDone={() => setEditing(null)} onCommit={(v) => rename("pods", pod.id, "name", v)} />
                <Tools what="this subteam" prevIcon={<ChevronLeft size={13} />} nextIcon={<ChevronRight size={13} />} canPrev={i > 0} canNext={i < PODS.length - 1} onPrev={() => moveIn("pods", pod.id, -1)} onNext={() => moveIn("pods", pod.id, 1)} onRemove={() => removePod(pod)} />
              </div>
              <button className={`mx-sublead ${pod.leadRef ? "" : "mx-sublead-empty"}`} onClick={(e) => openPicker(e, { mode: "podLead", podId: pod.id })}>
                <Crown size={12} strokeWidth={pod.leadRef ? 1.8 : 1.6} /><span>{pod.leadRef ? <><strong>{displayName(pod.leadRef)}</strong> leads</> : "set a lead"}</span>
                <span className="mx-rel">{n ? `staffed from ${n} function${n === 1 ? "" : "s"}` : ""}</span>
              </button>
            </div>); })}
          <div className="mx-addfn" style={{ gridColumn: lastCol, gridRow: 1 }}>
            <button className="mx-addbtn" onClick={addPod}><Plus size={15} strokeWidth={1.8} /> Add subteam</button>
            {PODS.length === 0 && <span className="mx-hint">e.g. “Customer Operations”, “Field Engineering”</span>}
          </div>
          {body}
        </div>
      </div>

      {picker && <PeoplePicker ctx={pickerCtx} rect={picker.rect} source={source} onPick={onPick} onClose={() => setPicker(null)} />}
      {chipMenu && (() => {
        const chip = (doc.cells[chipMenu.key] || []).find((c) => c.id === chipMenu.chipId); if (!chip) return null;
        return (<ChipMenu chip={chip} p={person(chip.ref)} rect={chipMenu.rect} sourceName={source.name}
          onRole={(v) => setRole(chipMenu.key, chip.id, v)}
          onLead={chip.ref ? () => { apply((d) => { const x = d.pods.find((y) => y.id === chipMenu.podId); if (x) x.leadRef = chip.ref; return d; }); setChipMenu(null); } : null}
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
  const org = useMemo(() => (ctx.anchor ? source.orgOf(ctx.anchor.id) : new Set()), [ctx.anchor, source]);
  const isDone = (p) => added.has(p.id) || (ctx.taken && ctx.taken.has(p.id));
  // the anchor's org, laid out the way it's actually organised: the head, then each of their
  // direct reports' teams — so "engineers from one of Nick's teams" is a glance, not a search
  const sections = useMemo(() => {
    if (!ctx.anchor) return [];
    const head = source.byId.get(ctx.anchor.id); const out = [];
    const direct = source.kidsOf(ctx.anchor.id).map((id) => source.byId.get(id)).filter(usableP);
    const solo = [head, ...direct.filter((d) => !source.kidsOf(d.id).length)].filter(usableP).filter(match);
    if (solo.length) out.push({ key: "_solo", label: ctx.anchor.label, people: solo });
    direct.filter((d) => source.kidsOf(d.id).length).forEach((d) => {
      const people = [...source.orgOf(d.id)].map((id) => source.byId.get(id)).filter(usableP).filter(match);
      if (people.length) out.push({ key: d.id, label: `${d.name}'s team`, sub: d.title, people, team: true });
    });
    return ctx.byTeam ? out : [{ key: "_all", label: ctx.anchor.label, people: out.flatMap((x) => x.people).slice(0, 40) }].filter((x) => x.people.length);
  }, [ctx.anchor, ctx.byTeam, source, ql]); // eslint-disable-line
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
        {rest.length > 0 && <div className="pk-group">{ctx.anchor ? "Everyone else" : "People"}</div>}
        {rest.map((p) => <Row key={p.id} p={p} />)}
        {source.ready && nothing && <div className="pk-empty">{ql ? `No one matches “${q}”.` : ctx.hint || "Type a name to search the functional org."}</div>}
        {ctx.allowPlaceholder && ql && (<button className="pk-row pk-ghost" onClick={() => { onPick({ ref: null, name: q.trim() }); setQ(""); }}><Plus size={14} /><span className="pk-text"><strong>{ctx.placeholderLabel ? ctx.placeholderLabel(q.trim()) : `Add “${q.trim()}” as an open role`}</strong><em>not linked to the functional org</em></span></button>)}
        {ctx.clearable && !ql && <button className="pk-row pk-ghost" onClick={() => onPick({ ref: null })}><X size={14} /><span className="pk-text"><strong>Clear</strong><em>leave it unassigned</em></span></button>}
      </div>
    </div>
  </>);
}

function ChipMenu({ chip, p, rect, sourceName, onRole, onLead, onRemove, onClose }) {
  const [role, setRoleDraft] = useState(chip.role || "");
  const pos = place(rect, 300, 260);
  const commit = () => { if ((role || "") !== (chip.role || "")) onRole(role.trim()); };
  return (<>
    <div className="pk-veil" onClick={() => { commit(); onClose(); }} />
    <div className="pk cm" style={pos}>
      <div className="cm-name">{p?.name || chip.name || "Open role"}</div>
      {p ? <div className="cm-meta">{p.title || "—"}<br />↳ reports to {p.managerName || "—"} <span>in {sourceName}</span></div> : <div className="cm-meta">{chip.ref ? `No longer in ${sourceName}` : "Open role — not linked to the functional org"}</div>}
      <label className="cm-label">Role in this team</label>
      <input className="cm-input" autoFocus value={role} placeholder={p?.title || "e.g. Tech lead"} onChange={(e) => setRoleDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { commit(); onClose(); } }} />
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
.mx-corner { position: sticky; left: 0; z-index: 4; background: #f3eee1; display: flex; flex-direction: column; justify-content: space-between; padding: 12px 14px; min-height: 96px; }
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
.mx-cell { padding: 10px; display: flex; flex-wrap: wrap; align-content: flex-start; gap: 7px; min-height: 84px; background: #fffdf8; transition: background .12s, box-shadow .12s; }
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
