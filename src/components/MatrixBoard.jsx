import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { ArrowLeft, Plus, X, Search, RotateCcw, Crown, ChevronLeft, ChevronRight, ChevronUp, ChevronDown, Trash2, Edit2, UserPlus } from "lucide-react";
import { supabase } from "../lib/supabase.js";
import { sharedStyles } from "./styles.js";

// ---------------------------------------------------------------------------------------------
// Team matrix board.
//   rows    = subteams of the team (each with an optional lead)
//   columns = functions, each headed by a person from the functional org
//   cells   = the people from that function who work with that subteam
// People are references (`ref`) into a functional chart (doc.sourceChartId); names, titles and
// managers are read live from it, so the board never goes stale. Stored in the chart's JSON:
//   { id:"root", kind:"matrix", v:2, sourceChartId, leadRef,
//     functions:[{id,label,headRef}], subteams:[{id,name,leadRef}],
//     cells:{ "<subteamId>|<functionId>": [{id, ref, name, role}] } }
// ---------------------------------------------------------------------------------------------

const rid = () => Math.random().toString(36).slice(2, 10);
const clone = (x) => JSON.parse(JSON.stringify(x));
const cellKey = (sid, fid) => `${sid}|${fid}`;
const COLORS = ["#3b6ea5", "#6d5aa8", "#b8442a", "#5b7a3f", "#b07d2a", "#2f7f86", "#a0527a", "#6b6252"];
const fnLabelFrom = (p) => {
  if (!p) return "";
  const t = (p.title || "").replace(/^\s*(chief|s?e?vp|svp|evp|vp|vice president|head|director|lead|manager|gm|general manager)\b[\s,]*(of\s+)?/i, "").trim();
  return t || p.team || p.title || "";
};
const initials = (name) => (name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0] || "").join("").toUpperCase() || "?";

// First-generation matrices were trees of sections. Carry them over: sections → subteams,
// everyone inside → a single "Core team" column. `_automatch` asks the board to link subteams
// that were named after a person to that person (as lead) once the source org has loaded.
const toV2 = (tree) => {
  if (tree && tree.v === 2) return { doc: tree, migrated: false };
  const core = { id: rid(), label: "Core team", headRef: null };
  const subteams = [], cells = {};
  ((tree && tree.children) || []).forEach((sec) => {
    const sid = rid();
    subteams.push({ id: sid, name: (sec.name || "Subteam").trim(), leadRef: null });
    const chips = [];
    const rec = (n) => (n.children || []).forEach((c) => {
      const placeholder = !c.ref && (!c.name || c.name === "New Person");
      if (!placeholder) chips.push({ id: rid(), ref: c.ref || null, name: c.name || "", role: c.ref && c.title && c.title !== c.refTitle ? c.title : "" });
      rec(c);
    });
    rec(sec);
    if (chips.length) cells[cellKey(sid, core.id)] = chips;
  });
  const doc = { id: "root", kind: "matrix", v: 2, sourceChartId: tree?.sourceChartId || null, leadRef: null,
    functions: [core], subteams, cells, children: [], _automatch: true };
  if (tree && tree.archived) doc.archived = tree.archived;
  return { doc, migrated: true };
};

// Index the functional org: everyone, by id, with their manager and their whole org beneath them.
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
  const orgOf = (id) => { const out = new Set(); const go = (x) => { if (out.has(x)) return; out.add(x); (kids.get(x) || []).forEach(go); }; if (id) go(id); return out; };
  return { list, byId, orgOf };
};

export default function MatrixBoard({ chartId, chartName, onBack, onRenamed }) {
  const [doc, setDocState] = useState(null);
  const [name, setName] = useState(chartName || "");
  const [editingName, setEditingName] = useState(false);
  const [history, setHistory] = useState([]);
  const [saveStatus, setSaveStatus] = useState("synced");
  const [loadError, setLoadError] = useState(null);
  const [source, setSource] = useState({ list: [], byId: new Map(), orgOf: () => new Set(), name: "", ready: false });
  const [picker, setPicker] = useState(null);   // { mode, sid?, fid?, rect }
  const [chipMenu, setChipMenu] = useState(null); // { sid, fid, chipId, rect }
  const [editing, setEditing] = useState(null);   // { type:"sub"|"fn", id } — inline rename
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
      if (nextDoc !== undefined) { const { _automatch, ...clean } = nextDoc; updates.tree = clean; }
      if (nextName !== undefined) updates.name = nextName;
      lastSavedAt.current = Date.now();
      const { data, error } = await supabase.from("charts").update(updates).eq("id", chartId).select("updated_at").single();
      saveTimer.current = null;
      if (error) { setSaveStatus("error"); return; }
      const ts = new Date(data.updated_at).getTime();
      lastSavedAt.current = ts; lastRemoteAt.current = Math.max(lastRemoteAt.current, ts);
      dirty.current = false; setSaveStatus("synced");
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
      setName(data.name);
      lastRemoteAt.current = new Date(data.updated_at).getTime();
      const { doc: d, migrated } = toV2(data.tree);
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
        setDoc(toV2(payload.new.tree).doc, { save: false }); setName(payload.new.name);
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
      if (cancelled || error || !data) return;
      setSource({ ...buildSource(data.tree), name: data.name, ready: true });
    })();
    return () => { cancelled = true; };
  }, [sourceChartId]);

  // carried-over matrices: a subteam named after a person becomes led by that person
  useEffect(() => {
    const d = docRef.current;
    if (!d || !d._automatch || !source.ready) return;
    const next = clone(d); delete next._automatch;
    const byName = new Map(source.list.map((p) => [p.name.toLowerCase(), p]));
    next.subteams.forEach((st) => { const hit = !st.leadRef && byName.get((st.name || "").trim().toLowerCase()); if (hit) st.leadRef = hit.id; });
    setDoc(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, source.ready]);

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
  const addSubteam = () => { const id = rid(); apply((d) => { d.subteams.push({ id, name: "", leadRef: null }); return d; }); setEditing({ type: "sub", id }); };
  const addFunction = (headRef, label) => { const id = rid(); apply((d) => { d.functions.push({ id, label: label || "", headRef: headRef || null }); return d; }); setEditing({ type: "fn", id }); };
  const renameSub = (id, v) => apply((d) => { const s = d.subteams.find((x) => x.id === id); if (s) s.name = v.trim(); return d; });
  const renameFn = (id, v) => apply((d) => { const f = d.functions.find((x) => x.id === id); if (f) f.label = v.trim(); return d; });
  const move = (arrKey, id, delta) => apply((d) => { const a = d[arrKey]; const i = a.findIndex((x) => x.id === id); const j = i + delta; if (i < 0 || j < 0 || j >= a.length) return d; const [x] = a.splice(i, 1); a.splice(j, 0, x); return d; });
  const countIn = (pred) => Object.entries(doc.cells || {}).reduce((n, [k, v]) => n + (pred(k) ? v.length : 0), 0);
  const removeSub = (st) => { const n = countIn((k) => k.startsWith(st.id + "|")); if (n && !window.confirm(`Remove "${st.name || "this subteam"}" and the ${n} ${n === 1 ? "person" : "people"} placed in it?`)) return; apply((d) => { d.subteams = d.subteams.filter((x) => x.id !== st.id); Object.keys(d.cells).forEach((k) => { if (k.startsWith(st.id + "|")) delete d.cells[k]; }); return d; }); };
  const removeFn = (f) => { const n = countIn((k) => k.endsWith("|" + f.id)); if (n && !window.confirm(`Remove the "${f.label || "function"}" column and the ${n} ${n === 1 ? "person" : "people"} placed in it?`)) return; apply((d) => { d.functions = d.functions.filter((x) => x.id !== f.id); Object.keys(d.cells).forEach((k) => { if (k.endsWith("|" + f.id)) delete d.cells[k]; }); return d; }); };
  const addToCell = (sid, fid, pick) => apply((d) => { const k = cellKey(sid, fid); const arr = d.cells[k] || (d.cells[k] = []); if (pick.ref && arr.some((c) => c.ref === pick.ref)) return d; arr.push({ id: rid(), ref: pick.ref || null, name: pick.name || "", role: "" }); return d; });
  const removeChip = (sid, fid, chipId) => apply((d) => { const k = cellKey(sid, fid); d.cells[k] = (d.cells[k] || []).filter((c) => c.id !== chipId); if (!d.cells[k].length) delete d.cells[k]; return d; });
  const setRole = (sid, fid, chipId, role) => apply((d) => { const c = (d.cells[cellKey(sid, fid)] || []).find((x) => x.id === chipId); if (c) c.role = role; return d; });
  const moveChip = (fromKey, chipId, toKey) => { if (fromKey === toKey) return; apply((d) => { const from = d.cells[fromKey] || []; const chip = from.find((c) => c.id === chipId); if (!chip) return d; const to = d.cells[toKey] || (d.cells[toKey] = []); if (chip.ref && to.some((c) => c.ref === chip.ref)) return d; d.cells[fromKey] = from.filter((c) => c.id !== chipId); if (!d.cells[fromKey].length) delete d.cells[fromKey]; to.push(chip); return d; }); };

  const onPick = (pick) => {
    const p = picker; if (!p) return;
    if (p.mode === "cell") { addToCell(p.sid, p.fid, pick); return; } // stays open — add several in a row
    if (p.mode === "newFn") addFunction(pick.ref, pick.ref ? fnLabelFrom(person(pick.ref)) : pick.name);
    if (p.mode === "fnHead") apply((d) => { const f = d.functions.find((x) => x.id === p.fid); if (f) f.headRef = pick.ref || null; return d; });
    if (p.mode === "subLead") apply((d) => { const s = d.subteams.find((x) => x.id === p.sid); if (s) s.leadRef = pick.ref || null; return d; });
    if (p.mode === "teamLead") apply((d) => { d.leadRef = pick.ref || null; return d; });
    setPicker(null);
  };

  const stats = useMemo(() => {
    if (!doc) return { people: 0, placements: 0 };
    const refs = new Set(); let placements = 0;
    Object.values(doc.cells || {}).forEach((arr) => arr.forEach((c) => { placements++; refs.add(c.ref || c.id); }));
    return { people: refs.size, placements };
  }, [doc]);

  if (loadError) return (<div className="org-root"><style>{sharedStyles}</style><button className="tb" onClick={onBack}>← Back</button><p style={{ marginTop: 24 }}>Couldn't load this team: {loadError}</p></div>);
  if (!doc) return <div style={{ padding: 60, fontFamily: "Iowan Old Style, Georgia, serif", color: "#8a7d6c" }}>Loading…</div>;

  const F = doc.functions, S = doc.subteams;
  const pickerCtx = picker && (() => {
    const fn = F.find((f) => f.id === picker.fid), st = S.find((s) => s.id === picker.sid);
    if (picker.mode === "cell") {
      const anchor = fn?.headRef ? { id: fn.headRef, label: `${displayName(fn.headRef)}'s org` } : st?.leadRef ? { id: st.leadRef, label: `${displayName(st.leadRef)}'s org` } : null;
      const taken = new Set((doc.cells[cellKey(picker.sid, picker.fid)] || []).map((c) => c.ref).filter(Boolean));
      return { title: `Add to ${st?.name || "subteam"} · ${fn?.label || "function"}`, anchor, taken, multi: true, allowPlaceholder: true };
    }
    if (picker.mode === "newFn") return { title: "Who heads this function?", hint: "Pick the person who leads it — or type a name for the function and add it without a head.", allowPlaceholder: true, placeholderLabel: (q) => `Add “${q}” as a function with no head yet` };
    if (picker.mode === "fnHead") return { title: `Who heads ${fn?.label || "this function"}?`, clearable: !!fn?.headRef };
    if (picker.mode === "subLead") return { title: `Who leads ${st?.name || "this subteam"}?`, clearable: !!st?.leadRef };
    return { title: "Who leads the team?", clearable: !!doc.leadRef };
  })();

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
        <div className="mx-stats">
          <span><strong>{S.length}</strong> subteams</span><span><strong>{F.length}</strong> functions</span><span><strong>{stats.people}</strong> people</span>
        </div>
        <button className="tb" onClick={undo} disabled={!history.length} title="Undo (⌘Z)"><RotateCcw size={14} strokeWidth={1.5} /> Undo</button>
        <div className={`mx-save mx-save-${saveStatus}`}>{saveStatus === "saving" ? "Saving…" : saveStatus === "error" ? "Save error" : "Saved"}</div>
      </header>

      <div className="mx-sub">
        People come from <strong>{source.name || "your functional org"}</strong> — their reporting line stays there. This board shows who works with which subteam.
      </div>

      <div className="mx-scroll">
        <div className="mx-grid" style={{ gridTemplateColumns: `248px repeat(${F.length}, minmax(236px, 1fr)) 190px` }}>
          <div className="mx-corner"><span className="mx-axis mx-axis-col">Functions →</span><span className="mx-axis mx-axis-row">Subteams ↓</span></div>

          {F.map((f, i) => {
            const head = person(f.headRef); const color = COLORS[i % COLORS.length];
            return (
              <div className="mx-fn" key={f.id} style={{ "--c": color }}>
                <div className="mx-fn-bar" />
                <div className="mx-fn-row">
                  <InlineEdit className="mx-fn-label" value={f.label} placeholder="Name this function" autoEdit={editing?.type === "fn" && editing.id === f.id} onDone={() => setEditing(null)} onCommit={(v) => renameFn(f.id, v)} />
                  <div className="mx-tools">
                    <button className="mx-tool" disabled={i === 0} onClick={() => move("functions", f.id, -1)} title="Move left"><ChevronLeft size={13} /></button>
                    <button className="mx-tool" disabled={i === F.length - 1} onClick={() => move("functions", f.id, 1)} title="Move right"><ChevronRight size={13} /></button>
                    <button className="mx-tool mx-tool-danger" onClick={() => removeFn(f)} title="Remove this function"><Trash2 size={13} /></button>
                  </div>
                </div>
                <button className={`mx-head ${head ? "" : "mx-head-empty"}`} onClick={(e) => openPicker(e, { mode: "fnHead", fid: f.id })}>
                  {head ? (<><span className="mx-avatar" style={{ background: color }}>{initials(head.name)}</span><span className="mx-head-text"><strong>{head.name}</strong><em>{head.title || "Head"}</em></span></>) : (<><UserPlus size={14} strokeWidth={1.7} /><span>Who heads it?</span></>)}
                </button>
              </div>
            );
          })}

          <div className="mx-addfn"><button className="mx-addbtn" onClick={(e) => openPicker(e, { mode: "newFn" })}><Plus size={15} strokeWidth={1.8} /> Add function</button></div>

          {S.map((st, r) => (
            <React.Fragment key={st.id}>
              <div className="mx-rowhead">
                <div className="mx-fn-row">
                  <InlineEdit className="mx-sub-name" value={st.name} placeholder="Name this subteam" autoEdit={editing?.type === "sub" && editing.id === st.id} onDone={() => setEditing(null)} onCommit={(v) => renameSub(st.id, v)} />
                  <div className="mx-tools">
                    <button className="mx-tool" disabled={r === 0} onClick={() => move("subteams", st.id, -1)} title="Move up"><ChevronUp size={13} /></button>
                    <button className="mx-tool" disabled={r === S.length - 1} onClick={() => move("subteams", st.id, 1)} title="Move down"><ChevronDown size={13} /></button>
                    <button className="mx-tool mx-tool-danger" onClick={() => removeSub(st)} title="Remove this subteam"><Trash2 size={13} /></button>
                  </div>
                </div>
                <button className={`mx-sublead ${st.leadRef ? "" : "mx-head-empty"}`} onClick={(e) => openPicker(e, { mode: "subLead", sid: st.id })}>
                  {st.leadRef ? (<><Crown size={12} strokeWidth={1.8} /><span><strong>{displayName(st.leadRef)}</strong> leads</span></>) : (<><UserPlus size={13} strokeWidth={1.7} /><span>Add a lead</span></>)}
                </button>
              </div>

              {F.map((f, i) => {
                const k = cellKey(st.id, f.id); const chips = doc.cells[k] || []; const color = COLORS[i % COLORS.length];
                return (
                  <div key={k} className={`mx-cell ${overKey === k ? "mx-cell-over" : ""} ${chips.length ? "" : "mx-cell-empty"}`} style={{ "--c": color }}
                    onDragOver={(e) => { if (!drag) return; e.preventDefault(); if (overKey !== k) setOverKey(k); }}
                    onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOverKey(null); }}
                    onDrop={(e) => { e.preventDefault(); if (drag) moveChip(drag.key, drag.chipId, k); setDrag(null); setOverKey(null); }}>
                    {chips.map((c) => {
                      const p = person(c.ref); const missing = c.ref && source.ready && !p;
                      return (
                        <button key={c.id} className={`mx-chip ${!c.ref ? "mx-chip-open" : ""} ${missing ? "mx-chip-missing" : ""} ${drag?.chipId === c.id ? "mx-chip-drag" : ""}`}
                          draggable onDragStart={(e) => { setDrag({ key: k, chipId: c.id }); if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", c.id); } }}
                          onDragEnd={() => { setDrag(null); setOverKey(null); }}
                          onClick={(e) => { const rc = e.currentTarget.getBoundingClientRect(); setPicker(null); setChipMenu({ sid: st.id, fid: f.id, chipId: c.id, rect: { left: rc.left, top: rc.top, bottom: rc.bottom } }); }}
                          title={p ? `${p.title || "—"} · reports to ${p.managerName || "—"}` : missing ? `No longer in ${source.name}` : "Open role / not in the org"}>
                          <span className="mx-avatar" style={c.ref ? { background: color } : undefined}>{c.ref ? initials(p?.name || c.name) : "?"}</span>
                          <span className="mx-chip-text"><strong>{p?.name || c.name || "Open role"}</strong><em>{c.role || p?.title || (c.ref ? "" : "open role")}</em></span>
                        </button>
                      );
                    })}
                    <button className="mx-add" onClick={(e) => openPicker(e, { mode: "cell", sid: st.id, fid: f.id })} title={`Add people to ${st.name || "this subteam"} · ${f.label || "this function"}`}><Plus size={14} strokeWidth={1.8} />{chips.length ? "" : <span>Add people</span>}</button>
                  </div>
                );
              })}
              <div className="mx-fill" />
            </React.Fragment>
          ))}

          <div className="mx-addrow" style={{ gridColumn: `1 / span ${F.length + 2}` }}>
            <button className="mx-addbtn" onClick={addSubteam}><Plus size={15} strokeWidth={1.8} /> Add subteam</button>
            {S.length === 0 && <span className="mx-hint">Start here — e.g. “Connect Lite API”, “Connect Field Engineers”. Then add the functions that work with them across the top.</span>}
          </div>
        </div>
      </div>

      {picker && <PeoplePicker ctx={pickerCtx} rect={picker.rect} source={source} onPick={onPick} onClose={() => setPicker(null)} />}
      {chipMenu && (() => {
        const chip = (doc.cells[cellKey(chipMenu.sid, chipMenu.fid)] || []).find((c) => c.id === chipMenu.chipId); if (!chip) return null;
        const p = person(chip.ref);
        return (<ChipMenu chip={chip} p={p} rect={chipMenu.rect} sourceName={source.name}
          onRole={(v) => setRole(chipMenu.sid, chipMenu.fid, chip.id, v)}
          onLead={chip.ref ? () => { apply((d) => { const s = d.subteams.find((x) => x.id === chipMenu.sid); if (s) s.leadRef = chip.ref; return d; }); setChipMenu(null); } : null}
          onRemove={() => { removeChip(chipMenu.sid, chipMenu.fid, chip.id); setChipMenu(null); }}
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
  const org = useMemo(() => (ctx.anchor ? source.orgOf(ctx.anchor.id) : new Set()), [ctx.anchor, source]);
  const usable = source.list.filter((p) => p.name && !/^\?+$/.test(p.name) && match(p));
  const near = ctx.anchor ? usable.filter((p) => org.has(p.id)).slice(0, 40) : [];
  const rest = ql ? usable.filter((p) => !org.has(p.id)).slice(0, 12) : [];
  const pick = (p) => { onPick({ ref: p.id, name: p.name }); if (ctx.multi) setAdded((s) => new Set(s).add(p.id)); };
  const Row = ({ p }) => { const done = added.has(p.id) || (ctx.taken && ctx.taken.has(p.id)); return (
    <button className={`pk-row ${done ? "pk-done" : ""}`} disabled={done} onClick={() => pick(p)}>
      <span className="mx-avatar pk-avatar">{initials(p.name)}</span>
      <span className="pk-text"><strong>{p.name}</strong><em>{[p.title, p.managerName && `↳ ${p.managerName}`].filter(Boolean).join(" · ")}</em></span>
      {done && <span className="pk-tick">added</span>}
    </button>); };
  const pos = place(rect, 360, 430);
  return (<>
    <div className="pk-veil" onClick={onClose} />
    <div className="pk" style={pos}>
      <div className="pk-head"><span>{ctx.title}</span><button className="pk-x" onClick={onClose}>{ctx.multi ? "Done" : <X size={14} />}</button></div>
      <div className="pk-search"><Search size={14} strokeWidth={1.6} /><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, title or team…"
        onKeyDown={(e) => { if (e.key === "Enter") { const first = [...near, ...rest].find((p) => !added.has(p.id) && !(ctx.taken && ctx.taken.has(p.id))); if (first) { pick(first); setQ(""); } } }} /></div>
      <div className="pk-list">
        {!source.ready && <div className="pk-empty">Loading people…</div>}
        {near.length > 0 && <div className="pk-group">{ctx.anchor.label}</div>}
        {near.map((p) => <Row key={p.id} p={p} />)}
        {rest.length > 0 && <div className="pk-group">{ctx.anchor ? "Everyone else" : "People"}</div>}
        {rest.map((p) => <Row key={p.id} p={p} />)}
        {source.ready && !near.length && !rest.length && <div className="pk-empty">{ql ? `No one matches “${q}”.` : ctx.hint || "Type a name to search the functional org."}</div>}
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
.mx-corner { position: sticky; left: 0; top: 0; z-index: 4; background: #f3eee1; display: flex; flex-direction: column; justify-content: space-between; padding: 12px 14px; min-height: 96px; }
.mx-axis { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 10px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-faint); } .mx-axis-col { align-self: flex-end; }
.mx-fn { position: sticky; top: 0; z-index: 3; background: #fffdf7; padding: 0 12px 12px; }
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
.mx-fill, .mx-addfn { background: #f3eee1; } .mx-addfn { position: sticky; top: 0; z-index: 3; display: grid; place-items: center; padding: 12px; }
.mx-addrow { display: flex; align-items: center; gap: 16px; padding: 14px; background: #f3eee1; border-bottom: none !important; }
.mx-addbtn { display: inline-flex; align-items: center; gap: 7px; padding: 9px 16px; border: 1px dashed var(--ink-faint); border-radius: 999px; background: transparent; color: var(--ink-soft); cursor: pointer; font-family: 'Iowan Old Style', Georgia, serif; font-size: 13.5px; white-space: nowrap; position: sticky; left: 14px; }
.mx-addbtn:hover { background: var(--ink); color: var(--paper); border-color: var(--ink); border-style: solid; }
.mx-hint { font-family: 'Iowan Old Style', Georgia, serif; font-size: 13px; font-style: italic; color: var(--ink-faint); }

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
