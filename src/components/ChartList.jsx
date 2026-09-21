import React, { useState } from "react";
import { Plus, Trash2, ArrowRight, Copy, Archive, ArchiveRestore } from "lucide-react";
import { supabase } from "../lib/supabase.js";
import { sharedStyles } from "./styles.js";

const seedTree = () => ({
  id: "root",
  name: "CEO",
  title: "Chief Executive Officer",
  team: "Executive",
  collapsed: false,
  children: [],
});

// The archived flag is stored inside the chart's JSON (tree.archived) — no DB column needed.
// The list query reads it back as text via `archived:tree->>archived`.
const isArchived = (c) => c.archived === true || c.archived === "true";

// A team matrix is a chart whose JSON carries kind:"matrix" + the functional chart it pulls
// its people from. It opens in MatrixBoard (subteams × functions), not the tree editor.
const isMatrix = (c) => c.kind === "matrix";
const rid = () => Math.random().toString(36).slice(2, 10);
const matrixSeed = (name, sourceChartId) => ({
  id: "root", kind: "matrix", v: 4, sourceChartId, leadRef: null,
  pods: [], rows: [], cells: {}, children: [],
});

export default function ChartList({ charts, onOpen, onCreated, onDeleted }) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [showArchive, setShowArchive] = useState(false);
  const [creatingMatrix, setCreatingMatrix] = useState(false);
  const [matrixName, setMatrixName] = useState("");
  const [matrixSource, setMatrixSource] = useState("");
  const [dragId, setDragId] = useState(null);     // chart being dragged
  const [overZone, setOverZone] = useState(null); // "archive" | "active" while hovering a drop zone

  const create = async (name, tree) => {
    const { data, error } = await supabase
      .from("charts")
      .insert({ name: name || "Untitled chart", tree: tree || seedTree() })
      .select()
      .single();
    if (error) { alert(error.message); return null; }
    onCreated();
    return data;
  };

  const handleCreate = async () => {
    const data = await create(newName.trim() || "Untitled chart", seedTree());
    if (data) {
      setCreating(false);
      setNewName("");
      window.location.hash = data.id;
    }
  };

  const handleCreateMatrix = async () => {
    if (!matrixSource) { alert("Pick the functional org to pull people from."); return; }
    const nm = matrixName.trim() || "New team";
    const data = await create(nm, matrixSeed(nm, matrixSource));
    if (data) { setCreatingMatrix(false); setMatrixName(""); window.location.hash = data.id; }
  };

  const handleDuplicate = async (chart) => {
    const { data: full, error } = await supabase
      .from("charts")
      .select("tree")
      .eq("id", chart.id)
      .single();
    if (error) { alert(error.message); return; }
    const data = await create(`${chart.name} (copy)`, full.tree);
    if (data) window.location.hash = data.id;
  };

  const handleDelete = async (chart) => {
    if (!window.confirm(`Delete "${chart.name}"? This cannot be undone.`)) return;
    const { error } = await supabase.from("charts").delete().eq("id", chart.id);
    if (error) { alert(error.message); return; }
    onDeleted();
  };

  // Archive / restore: set or clear `archived` on the chart's JSON. Doesn't touch updated_at,
  // so "edited … ago" stays truthful — filing a chart away isn't an edit.
  const setArchived = async (chart, flag) => {
    const { data, error } = await supabase.from("charts").select("tree").eq("id", chart.id).single();
    if (error) { alert(error.message); return; }
    const tree = { ...data.tree };
    if (flag) tree.archived = true; else delete tree.archived;
    const { error: e2 } = await supabase.from("charts").update({ tree }).eq("id", chart.id);
    if (e2) { alert(e2.message); return; }
    onCreated(); // reloads the list
  };

  const active = charts.filter((c) => !isArchived(c));
  const archived = charts.filter(isArchived);
  const functional = active.filter((c) => !isMatrix(c));
  const matrices = active.filter(isMatrix);
  // any functional chart can be a people source (active ones first); default to the one called "Final"
  const sources = [...functional, ...archived.filter((c) => !isMatrix(c))];
  const defaultSourceId = (sources.find((c) => (c.name || "").trim().toLowerCase() === "final") || sources[0] || {}).id || "";
  const dragged = dragId ? charts.find((c) => c.id === dragId) : null;

  // drop-zone handlers: drop an active chart on the Archive to file it, an archived one on
  // the main list to bring it back
  const zoneProps = (zone) => ({
    onDragOver: (e) => {
      if (!dragged) return;
      const valid = zone === "archive" ? !isArchived(dragged) : isArchived(dragged);
      if (!valid) return;
      e.preventDefault();
      if (overZone !== zone) setOverZone(zone);
    },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOverZone(null); },
    onDrop: (e) => {
      e.preventDefault();
      if (dragged) setArchived(dragged, zone === "archive");
      setDragId(null); setOverZone(null);
    },
  });

  const row = (chart, inArchive) => (
    <li key={chart.id}
      className={`chart-row ${dragId === chart.id ? "dragging" : ""}`}
      draggable
      onDragStart={(e) => { setDragId(chart.id); if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", chart.id); } }}
      onDragEnd={() => { setDragId(null); setOverZone(null); }}
    >
      <button className="chart-main" onClick={() => onOpen(chart.id)}>
        <div className="chart-name">{chart.name}</div>
        <div className="chart-meta">{isMatrix(chart) ? "team matrix · " : ""}edited {formatDate(chart.updated_at)}</div>
      </button>
      <div className="chart-actions">
        {inArchive ? (
          <button className="ghost" title="Restore to the main list" onClick={() => setArchived(chart, false)}>
            <ArchiveRestore size={14} strokeWidth={1.8} />
          </button>
        ) : (
          <button className="ghost" title="Archive" onClick={() => setArchived(chart, true)}>
            <Archive size={14} strokeWidth={1.8} />
          </button>
        )}
        <button className="ghost" title="Duplicate" onClick={() => handleDuplicate(chart)}>
          <Copy size={14} strokeWidth={1.8} />
        </button>
        <button className="ghost ghost-danger" title="Delete" onClick={() => handleDelete(chart)}>
          <Trash2 size={14} strokeWidth={1.8} />
        </button>
        <button className="ghost" title="Open" onClick={() => onOpen(chart.id)}>
          <ArrowRight size={14} strokeWidth={1.8} />
        </button>
      </div>
    </li>
  );

  const restoreArmed = dragged && isArchived(dragged);
  const archiveArmed = dragged && !isArchived(dragged);

  return (
    <div className="org-root">
      <style>{sharedStyles}</style>
      <style>{listStyles}</style>

      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">○</div>
          <div className="brand-text">
            <div className="brand-name">Atelier Org</div>
            <div className="brand-sub">a working chart, not a wall poster</div>
          </div>
        </div>
      </header>

      <div className="list-wrap">
        <div className="list-head">
          <h2>Functional orgs</h2>
          <button className="tb tb-primary" onClick={() => setCreating(true)}>
            <Plus size={14} strokeWidth={1.8} /> New chart
          </button>
        </div>

        {creating && (
          <div className="new-row">
            <input
              autoFocus
              className="new-input"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. Current state, Proposed v1, Cupid restructure"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
                if (e.key === "Escape") { setCreating(false); setNewName(""); }
              }}
            />
            <button className="tb tb-primary" onClick={handleCreate}>Create</button>
            <button className="tb" onClick={() => { setCreating(false); setNewName(""); }}>Cancel</button>
          </div>
        )}

        {charts.length === 0 && !creating && (
          <div className="empty">
            <p>No charts yet.</p>
            <p className="empty-sub">Create your first one to start mapping people and teams.</p>
          </div>
        )}

        <div className={`active-zone zone ${restoreArmed ? "zone-armed" : ""} ${overZone === "active" ? "zone-over" : ""}`} {...zoneProps("active")}>
          <ul className="chart-list">
            {functional.map((c) => row(c, false))}
            {functional.length === 0 && charts.length > 0 && (
              <li className="zone-empty">No functional orgs here — drag one back from the Archive.</li>
            )}
          </ul>

          <div className="list-head list-head-2">
            <div>
              <h2>Team matrices</h2>
              <div className="list-sub">A team's subteams across the top; down the side, the functions — inside the team and across the business — that staff them.</div>
            </div>
            <button className="tb tb-primary" disabled={!sources.length}
              onClick={() => { setCreatingMatrix(true); setMatrixSource(defaultSourceId); }}>
              <Plus size={14} strokeWidth={1.8} /> New team matrix
            </button>
          </div>

          {creatingMatrix && (
            <div className="new-row new-row-matrix">
              <input autoFocus className="new-input" value={matrixName}
                onChange={(e) => setMatrixName(e.target.value)}
                placeholder="Team name — e.g. Connect, Cloud, Payments squad"
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreateMatrix();
                  if (e.key === "Escape") { setCreatingMatrix(false); setMatrixName(""); }
                }} />
              <label className="src-pick">
                <span>People from</span>
                <select className="src-select" value={matrixSource} onChange={(e) => setMatrixSource(e.target.value)}>
                  {sources.map((c) => <option key={c.id} value={c.id}>{c.name}{isArchived(c) ? " (archived)" : ""}</option>)}
                </select>
              </label>
              <button className="tb tb-primary" onClick={handleCreateMatrix}>Create</button>
              <button className="tb" onClick={() => { setCreatingMatrix(false); setMatrixName(""); }}>Cancel</button>
            </div>
          )}

          <ul className="chart-list">
            {matrices.map((c) => row(c, false))}
            {matrices.length === 0 && !creatingMatrix && (
              <li className="zone-empty">No team matrices yet — create one and pull people in from your functional org.</li>
            )}
          </ul>
        </div>

        {(archived.length > 0 || archiveArmed) && (
          <section className={`archive zone ${archiveArmed ? "zone-armed" : ""} ${overZone === "archive" ? "zone-over" : ""}`} {...zoneProps("archive")}>
            <button className="archive-head" onClick={() => setShowArchive((v) => !v)}>
              <Archive size={14} strokeWidth={1.8} />
              <span>Archive · {archived.length}</span>
              <span className="archive-hint">
                {archiveArmed ? "drop here to archive" : showArchive ? "hide" : "show"}
              </span>
            </button>
            {(showArchive || overZone === "archive") && archived.length > 0 && (
              <ul className="chart-list archived-list">{archived.map((c) => row(c, true))}</ul>
            )}
            {showArchive && archived.length === 0 && (
              <div className="zone-empty">Nothing archived yet — drag old versions here.</div>
            )}
          </section>
        )}
      </div>

      <footer className="foot">
        Saved live to your shared workspace. Anyone with the link can view and edit.
      </footer>
    </div>
  );
}

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const now = new Date();
  const diffMin = Math.round((now - d) / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffMin < 60 * 24) return `${Math.round(diffMin / 60)}h ago`;
  if (diffMin < 60 * 24 * 7) return `${Math.round(diffMin / 60 / 24)}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

const listStyles = `
.list-wrap {
  max-width: 720px;
  margin: 0 auto;
  padding: 30px 0;
}
.list-head {
  display: flex; justify-content: space-between; align-items: baseline;
  margin-bottom: 24px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--rule);
}
.list-head h2 {
  font-family: 'Iowan Old Style', Georgia, serif;
  font-size: 20px; font-weight: 600; margin: 0;
  letter-spacing: -0.005em;
}
.new-row {
  display: flex; gap: 8px; margin-bottom: 16px;
  padding: 12px;
  background: rgba(255, 253, 246, 0.6);
  border: 1px solid var(--rule);
}
.new-input {
  flex: 1; border: 1px solid var(--rule); padding: 8px 10px;
  font-family: inherit; font-size: 14px; background: #fffdf6; color: var(--ink);
  outline: none;
}
.new-input:focus { border-color: var(--ink); }
.empty {
  text-align: center; padding: 60px 20px;
  color: var(--ink-faint);
  font-family: 'Iowan Old Style', Georgia, serif;
  font-style: italic;
}
.empty p { margin: 4px 0; }
.empty-sub { font-size: 13px; }
.chart-list { list-style: none; padding: 0; margin: 0; }
.chart-row {
  display: flex; align-items: stretch;
  border: 1px solid var(--rule);
  margin-bottom: 8px;
  background: #fffdf6;
  transition: all 0.12s ease;
  cursor: grab;
}
.chart-row:hover { border-color: var(--ink-faint); box-shadow: var(--shadow); }
.chart-row.dragging { opacity: 0.4; }
.chart-main {
  flex: 1; text-align: left;
  background: transparent; border: none;
  padding: 14px 16px; cursor: pointer;
  font-family: inherit; color: var(--ink);
}
.chart-name {
  font-family: 'Iowan Old Style', Georgia, serif;
  font-size: 15.5px; font-weight: 600;
  letter-spacing: -0.005em;
}
.chart-meta {
  font-size: 11.5px; color: var(--ink-faint);
  margin-top: 3px; font-style: italic;
}
.chart-actions {
  display: flex; gap: 2px; align-items: center;
  padding: 0 10px;
  opacity: 0; transition: opacity 0.15s ease;
}
.chart-row:hover .chart-actions { opacity: 1; }

/* drop zones: the main list (restore) and the Archive (file away) */
.zone { border-radius: 4px; transition: box-shadow 0.15s ease, background 0.15s ease, border-color 0.15s ease; }
.active-zone.zone-armed { box-shadow: 0 0 0 2px var(--rule-soft); }
.active-zone.zone-over { box-shadow: 0 0 0 2px var(--accent); background: rgba(184, 68, 42, 0.04); }
.list-head-2 { margin-top: 40px; align-items: flex-end; }
.list-sub { font-family: 'Iowan Old Style', Georgia, serif; font-size: 12.5px; font-style: italic; color: var(--ink-faint); margin-top: 4px; }
.new-row-matrix { flex-wrap: wrap; align-items: center; }
.new-row-matrix .new-input { min-width: 220px; }
.src-pick { display: flex; align-items: center; gap: 6px; font-family: 'Iowan Old Style', Georgia, serif; font-size: 12.5px; font-style: italic; color: var(--ink-soft); }
.src-select { font-family: inherit; font-size: 13px; font-style: normal; padding: 7px 8px; border: 1px solid var(--rule); background: #fffdf6; color: var(--ink); outline: none; max-width: 220px; }
.src-select:focus { border-color: var(--ink); }
.zone-empty {
  padding: 18px; text-align: center; list-style: none;
  font-family: 'Iowan Old Style', Georgia, serif; font-size: 13px; font-style: italic;
  color: var(--ink-faint);
}
.archive {
  margin-top: 28px; padding: 8px 12px 10px;
  border: 1px dashed var(--rule);
}
.archive.zone-armed { border-color: var(--ink-faint); border-style: dashed; }
.archive.zone-over { border-color: var(--accent); background: rgba(184, 68, 42, 0.05); }
.archive-head {
  width: 100%; display: flex; align-items: center; gap: 8px;
  background: transparent; border: none; cursor: pointer; padding: 6px 0;
  font-family: 'Iowan Old Style', Georgia, serif; font-size: 14.5px; font-weight: 600;
  color: var(--ink-soft);
}
.archive-head:hover { color: var(--ink); }
.archive-hint { margin-left: auto; font-size: 11.5px; font-style: italic; font-weight: 400; color: var(--ink-faint); }
.archived-list { margin-top: 10px; }
.archived-list .chart-row { background: rgba(255, 253, 246, 0.55); }
.archived-list .chart-name { color: var(--ink-soft); }
`;
