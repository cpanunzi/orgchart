import React, { useState } from "react";
import { Plus, Trash2, ArrowRight, Copy } from "lucide-react";
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

export default function ChartList({ charts, onOpen, onCreated, onDeleted }) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

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
          <h2>Charts</h2>
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

        <ul className="chart-list">
          {charts.map((chart) => (
            <li key={chart.id} className="chart-row">
              <button className="chart-main" onClick={() => onOpen(chart.id)}>
                <div className="chart-name">{chart.name}</div>
                <div className="chart-meta">edited {formatDate(chart.updated_at)}</div>
              </button>
              <div className="chart-actions">
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
          ))}
        </ul>
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
}
.chart-row:hover { border-color: var(--ink-faint); box-shadow: var(--shadow); }
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
`;
