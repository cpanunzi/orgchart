import React, { useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect } from "react";
import { ChevronDown, ChevronRight, Plus, Trash2, Download, Upload, Users, Search, RotateCcw, FileDown, ArrowLeft, Edit2, Spline, X } from "lucide-react";
import { supabase } from "../lib/supabase.js";
import { sharedStyles } from "./styles.js";

// ---------- matrix accents ----------
// Optional per-card colour role. Keys are stored on nodes as `accent`.
// A missing/`"slate"` accent is the neutral default, so old charts render unchanged.
const ACCENTS = {
  slate:  { label: "Neutral",         color: "#6b6252" },
  blue:   { label: "Resource owner",  color: "#3b6ea5" },
  purple: { label: "Platform",        color: "#6d5aa8" },
  red:    { label: "Client / GM",     color: "#b8442a" },
  green:  { label: "Support",         color: "#5b7a3f" },
  amber:  { label: "Advisory",        color: "#b07d2a" },
};
const ACCENT_KEYS = Object.keys(ACCENTS);
const accentColor = (key) => (ACCENTS[key] || ACCENTS.slate).color;

// ---------- helpers ----------
const uid = () => Math.random().toString(36).slice(2, 10);

const walk = (node, fn, parent = null) => {
  fn(node, parent);
  (node.children || []).forEach((c) => walk(c, fn, node));
};
const findNode = (root, id) => { let f = null; walk(root, (n) => { if (n.id === id) f = n; }); return f; };
const isDescendant = (root, ancestorId, id) => {
  const a = findNode(root, ancestorId); if (!a) return false;
  let yes = false; walk(a, (n) => { if (n.id === id) yes = true; }); return yes;
};
const cloneTree = (n) => JSON.parse(JSON.stringify(n));
const updateNode = (root, id, patch) => { const n = cloneTree(root); walk(n, (x) => { if (x.id === id) Object.assign(x, patch); }); return n; };
const collectIds = (node) => { const s = new Set(); walk(node, (n) => s.add(n.id)); return s; };

// Drop any dotted link whose target no longer exists in the tree.
const pruneDottedLinks = (root) => {
  const alive = collectIds(root);
  walk(root, (n) => {
    if (n.dotted && n.dotted.length) n.dotted = n.dotted.filter((d) => alive.has(d.to));
  });
  return root;
};

const removeNode = (root, id) => {
  if (root.id === id) return root;
  const next = cloneTree(root);
  const recur = (node) => {
    node.children = (node.children || []).filter((c) => c.id !== id);
    node.children.forEach(recur);
  };
  recur(next);
  return pruneDottedLinks(next);
};

// Add a dotted (matrix) link from one node to another; ignores self-links and dupes.
const addDottedLink = (root, fromId, toId, label = "") => {
  if (fromId === toId) return root;
  const next = cloneTree(root);
  walk(next, (n) => {
    if (n.id === fromId) {
      n.dotted = n.dotted || [];
      if (!n.dotted.some((d) => d.to === toId)) n.dotted.push({ to: toId, label });
    }
  });
  return next;
};

const removeDottedLink = (root, fromId, toId) => {
  const next = cloneTree(root);
  walk(next, (n) => {
    if (n.id === fromId && n.dotted) n.dotted = n.dotted.filter((d) => d.to !== toId);
  });
  return next;
};

// Flat list of every dotted link in the tree, for the overlay renderer.
const flattenLinks = (root) => {
  const out = [];
  walk(root, (n) => {
    (n.dotted || []).forEach((d) => out.push({ from: n.id, to: d.to, label: d.label || "", accent: n.accent }));
  });
  return out;
};
const addChild = (root, parentId, child) => {
  const next = cloneTree(root);
  walk(next, (n) => {
    if (n.id === parentId) { n.children = n.children || []; n.children.push(child); n.collapsed = false; }
  });
  return next;
};
const moveNode = (root, draggedId, newParentId) => {
  if (draggedId === newParentId || draggedId === "root") return root;
  if (isDescendant(root, draggedId, newParentId)) return root;
  const next = cloneTree(root);
  let dragged = null;
  const detach = (node) => {
    if (!node.children) return;
    const idx = node.children.findIndex((c) => c.id === draggedId);
    if (idx >= 0) { dragged = node.children[idx]; node.children.splice(idx, 1); return; }
    node.children.forEach(detach);
  };
  detach(next);
  if (!dragged) return root;
  walk(next, (n) => {
    if (n.id === newParentId) { n.children = n.children || []; n.children.push(dragged); n.collapsed = false; }
  });
  return next;
};
const collapseAllExceptRoot = (root) => { const n = cloneTree(root); walk(n, (x) => { x.collapsed = x.id !== "root"; }); return n; };
const expandAll = (root) => { const n = cloneTree(root); walk(n, (x) => { x.collapsed = false; }); return n; };

const flatten = (root) => {
  const out = [];
  const recur = (n, mgr) => {
    out.push({ id: n.id, name: n.name, title: n.title, team: n.team, manager: mgr });
    (n.children || []).forEach((c) => recur(c, n.name));
  };
  recur(root, "");
  return out;
};
const countDescendants = (n) => { let c = 0; (n.children || []).forEach((ch) => { c += 1 + countDescendants(ch); }); return c; };

const toCSV = (root) => {
  const rows = flatten(root);
  const esc = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return "Name,Title,Team,Manager\n" + rows.map((r) => [r.name, r.title, r.team, r.manager].map(esc).join(",")).join("\n");
};
const fromCSV = (text) => {
  const rows = []; let cur = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { cur.push(field); field = ""; }
      else if (c === "\n") { cur.push(field); rows.push(cur); cur = []; field = ""; }
      else if (c === "\r") {} else field += c;
    }
  }
  if (field.length || cur.length) { cur.push(field); rows.push(cur); }
  if (!rows.length) return null;
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const ni = header.indexOf("name"), ti = header.indexOf("title"), tmi = header.indexOf("team"), mi = header.indexOf("manager");
  if (ni < 0) return null;
  const records = rows.slice(1).filter((r) => r.some((v) => v && v.length)).map((r) => ({
    name: r[ni] || "", title: ti >= 0 ? (r[ti] || "") : "", team: tmi >= 0 ? (r[tmi] || "") : "", manager: mi >= 0 ? (r[mi] || "") : "",
  }));
  const byName = {};
  records.forEach((r) => { byName[r.name] = { id: uid(), name: r.name, title: r.title, team: r.team, collapsed: false, children: [] }; });
  let root = null;
  records.forEach((r) => {
    const node = byName[r.name];
    if (!r.manager || !byName[r.manager]) {
      if (!root) { node.id = "root"; root = node; }
    } else { byName[r.manager].children.push(node); }
  });
  if (!root) root = { id: "root", name: "Root", title: "", team: "", collapsed: false, children: Object.values(byName) };
  return root;
};

// ---------- main component ----------
export default function OrgChart({ chartId, chartName, onBack, onRenamed, onDeleted }) {
  const [tree, setTree] = useState(null);
  const [name, setName] = useState(chartName || "");
  const [editingName, setEditingName] = useState(false);
  const [history, setHistory] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [editingField, setEditingField] = useState(null);
  const [draggedId, setDraggedId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);
  const [search, setSearch] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState("");
  const [saveStatus, setSaveStatus] = useState("synced"); // synced | saving | error
  const [loadError, setLoadError] = useState(null);
  const [linkingFrom, setLinkingFrom] = useState(null); // id of node we're drawing a dotted line FROM
  const [showLinks, setShowLinks] = useState(true);
  const canvasRef = useRef(null);
  const fileInputRef = useRef(null);
  const saveTimer = useRef(null);
  const hasLoadedRef = useRef(false);
  const isDirtyRef = useRef(false);
  const lastSavedAtRef = useRef(0); // ms timestamp of last local save we initiated
  const lastAppliedRemoteAtRef = useRef(0); // ms timestamp of last remote update we applied

  // initial load
  useEffect(() => {
    let cancelled = false;
    hasLoadedRef.current = false;
    isDirtyRef.current = false;
    (async () => {
      const { data, error } = await supabase
        .from("charts")
        .select("id, name, tree, updated_at")
        .eq("id", chartId)
        .single();
      if (cancelled) return;
      if (error) { setLoadError(error.message); return; }
      setName(data.name);
      setTree(data.tree);
      lastAppliedRemoteAtRef.current = new Date(data.updated_at).getTime();
      // mark as loaded on the next tick, AFTER the tree state is applied
      // so the save effect doesn't fire on initial hydration
      setTimeout(() => { hasLoadedRef.current = true; }, 0);
    })();
    return () => { cancelled = true; };
  }, [chartId]);

  // realtime subscription for collaborative editing
  useEffect(() => {
    const channel = supabase
      .channel(`chart-${chartId}`)
      .on("postgres_changes",
        { event: "UPDATE", schema: "public", table: "charts", filter: `id=eq.${chartId}` },
        (payload) => {
          const remote = payload.new;
          const remoteTs = new Date(remote.updated_at).getTime();

          // ignore echoes of our own recent saves (within 3s)
          if (Math.abs(remoteTs - lastSavedAtRef.current) < 3000) return;

          // ignore stale or duplicate updates
          if (remoteTs <= lastAppliedRemoteAtRef.current) return;

          // if we have unsaved local edits in flight, don't clobber them
          if (isDirtyRef.current || saveTimer.current) return;

          lastAppliedRemoteAtRef.current = remoteTs;
          setTree(remote.tree);
          setName(remote.name);
        })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [chartId]);

  // debounced save
  const scheduleSave = useCallback((nextTree, nextName) => {
    isDirtyRef.current = true;
    setSaveStatus("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const nowIso = new Date().toISOString();
      lastSavedAtRef.current = Date.now();
      const updates = { updated_at: nowIso };
      if (nextTree !== undefined) updates.tree = nextTree;
      if (nextName !== undefined) updates.name = nextName;
      const { data, error } = await supabase
        .from("charts")
        .update(updates)
        .eq("id", chartId)
        .select("updated_at")
        .single();
      saveTimer.current = null;
      if (error) { setSaveStatus("error"); return; }
      const savedTs = new Date(data.updated_at).getTime();
      lastSavedAtRef.current = savedTs;
      lastAppliedRemoteAtRef.current = Math.max(lastAppliedRemoteAtRef.current, savedTs);
      isDirtyRef.current = false;
      setSaveStatus("synced");
    }, 600);
  }, [chartId]);

  // save tree changes (but not on initial hydration)
  useEffect(() => {
    if (tree === null) return;
    if (!hasLoadedRef.current) return;
    scheduleSave(tree, undefined);
  }, [tree, scheduleSave]);

  const pushHistory = (prev) => setHistory((h) => [...h.slice(-49), prev]);
  const apply = (fn) => { setTree((prev) => { pushHistory(prev); return fn(prev); }); };
  const undo = () => {
    setHistory((h) => {
      if (!h.length) return h;
      const last = h[h.length - 1];
      setTree(last);
      return h.slice(0, -1);
    });
  };

  const handleAddChild = (parentId) => {
    const child = { id: uid(), name: "New Person", title: "Title", team: "", collapsed: false, children: [] };
    apply((prev) => addChild(prev, parentId, child));
    setSelectedId(child.id);
    setTimeout(() => setEditingField({ id: child.id, field: "name" }), 50);
  };
  const handleDelete = (id) => { if (id === "root") return; apply((prev) => removeNode(prev, id)); if (selectedId === id) setSelectedId(null); };
  const handleToggle = (id) => {
    setTree((prev) => { const n = findNode(prev, id); if (!n) return prev; return updateNode(prev, id, { collapsed: !n.collapsed }); });
  };
  const handleEdit = (id, field, value) => apply((prev) => updateNode(prev, id, { [field]: value }));

  // ----- matrix: accents + dotted links -----
  const handleSetAccent = (id, accent) => apply((prev) => updateNode(prev, id, { accent }));
  const handleStartLink = (id) => { setLinkingFrom(id); setSelectedId(id); };
  const handleRemoveLink = (fromId, toId) => apply((prev) => removeDottedLink(prev, fromId, toId));
  // Called when a card is clicked while we're in "draw dotted line" mode.
  const handleLinkTarget = (targetId) => {
    if (!linkingFrom) return false;
    if (targetId !== linkingFrom) apply((prev) => addDottedLink(prev, linkingFrom, targetId));
    setLinkingFrom(null);
    return true;
  };
  // Esc cancels link-drawing.
  useEffect(() => {
    if (!linkingFrom) return;
    const onKey = (e) => { if (e.key === "Escape") setLinkingFrom(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [linkingFrom]);

  const handleDragStart = (e, id) => {
    if (id === "root") { e.preventDefault(); return; }
    setDraggedId(id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", id);
  };
  const handleDragOver = (e, id) => {
    if (!draggedId || draggedId === id) return;
    if (isDescendant(tree, draggedId, id)) return;
    e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDragOverId(id);
  };
  const handleDragLeave = (id) => { if (dragOverId === id) setDragOverId(null); };
  const handleDrop = (e, newParentId) => {
    e.preventDefault(); e.stopPropagation();
    if (!draggedId) return;
    apply((prev) => moveNode(prev, draggedId, newParentId));
    setDraggedId(null); setDragOverId(null);
  };
  const handleDragEnd = () => { setDraggedId(null); setDragOverId(null); };

  const exportJSON = () => {
    const data = JSON.stringify(tree, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${name.replace(/[^a-z0-9]/gi, "-")}.json`; a.click();
    URL.revokeObjectURL(url);
  };
  const exportCSV = () => {
    const blob = new Blob([toCSV(tree)], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${name.replace(/[^a-z0-9]/gi, "-")}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const handleFileImport = (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = String(ev.target.result || "");
      try {
        if (file.name.endsWith(".json")) {
          const data = JSON.parse(text);
          if (data && data.id && data.name !== undefined) apply(() => data);
        } else {
          const parsed = fromCSV(text);
          if (parsed) apply(() => parsed);
        }
      } catch (err) { alert("Could not parse file: " + err.message); }
    };
    reader.readAsText(file);
    e.target.value = "";
  };
  const importFromText = () => {
    try {
      const parsed = importText.trim().startsWith("{") ? JSON.parse(importText) : fromCSV(importText);
      if (parsed) { apply(() => parsed); setShowImport(false); setImportText(""); }
    } catch (err) { alert("Could not parse: " + err.message); }
  };

  const saveName = (nextName) => {
    setName(nextName);
    scheduleSave(undefined, nextName);
    setEditingName(false);
    onRenamed && onRenamed();
  };

  const handleDeleteChart = async () => {
    if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) return;
    await supabase.from("charts").delete().eq("id", chartId);
    onDeleted && onDeleted();
  };

  const stats = useMemo(() => {
    if (!tree) return { total: 0, teams: 0 };
    const flat = flatten(tree);
    return { total: flat.length, teams: new Set(flat.map((p) => p.team).filter(Boolean)).size };
  }, [tree]);

  const matches = useMemo(() => {
    if (!tree || !search.trim()) return new Set();
    const q = search.toLowerCase(); const ids = new Set();
    walk(tree, (n) => {
      if ((n.name || "").toLowerCase().includes(q) ||
          (n.title || "").toLowerCase().includes(q) ||
          (n.team || "").toLowerCase().includes(q)) ids.add(n.id);
    });
    return ids;
  }, [tree, search]);

  const links = useMemo(() => (tree ? flattenLinks(tree) : []), [tree]);
  const selectedNode = useMemo(() => (tree && selectedId ? findNode(tree, selectedId) : null), [tree, selectedId]);
  const nameOf = useCallback((id) => { const n = tree && findNode(tree, id); return n ? n.name : "—"; }, [tree]);

  if (loadError) {
    return (
      <div className="org-root">
        <style>{sharedStyles}</style>
        <button className="tb" onClick={onBack}>← Back</button>
        <p style={{ marginTop: 24 }}>Couldn't load chart: {loadError}</p>
      </div>
    );
  }

  if (!tree) {
    return <div style={{ padding: 60, fontFamily: "Iowan Old Style, Georgia, serif", color: "#8a7d6c" }}>Loading…</div>;
  }

  return (
    <div className="org-root">
      <style>{sharedStyles}</style>
      <style>{chartStyles}</style>

      <header className="topbar">
        <button className="back-btn" onClick={onBack} title="Back to all charts">
          <ArrowLeft size={16} strokeWidth={1.8} />
        </button>

        <div className="chart-title">
          {editingName ? (
            <input
              autoFocus
              className="title-input"
              defaultValue={name}
              onBlur={(e) => saveName(e.target.value || "Untitled chart")}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveName(e.target.value || "Untitled chart");
                if (e.key === "Escape") setEditingName(false);
              }}
            />
          ) : (
            <h1 onClick={() => setEditingName(true)} title="Click to rename">
              {name} <Edit2 size={12} strokeWidth={1.8} className="title-pen" />
            </h1>
          )}
          <div className={`save-status save-${saveStatus}`}>
            {saveStatus === "saving" && "Saving…"}
            {saveStatus === "synced" && "All changes saved"}
            {saveStatus === "error" && "Save error"}
          </div>
        </div>

        <div className="search-wrap">
          <Search size={14} strokeWidth={1.5} />
          <input className="search" placeholder="Find a person, title, or team" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>

        <div className="toolbar">
          <button className="tb" onClick={undo} disabled={!history.length}><RotateCcw size={14} strokeWidth={1.5} /> Undo</button>
          <button className="tb" onClick={() => apply(expandAll)}>Expand all</button>
          <button className="tb" onClick={() => apply(collapseAllExceptRoot)}>Collapse all</button>
          <div className="tb-sep" />
          <button className={`tb ${showLinks ? "tb-on" : ""}`} onClick={() => setShowLinks((v) => !v)} title="Show or hide dotted matrix lines">
            <Spline size={14} strokeWidth={1.5} /> Dotted lines
          </button>
          <div className="tb-sep" />
          <button className="tb" onClick={() => fileInputRef.current?.click()}><Upload size={14} strokeWidth={1.5} /> Import</button>
          <input ref={fileInputRef} type="file" accept=".json,.csv" onChange={handleFileImport} style={{ display: "none" }} />
          <button className="tb" onClick={() => setShowImport(true)}>Paste</button>
          <button className="tb" onClick={exportCSV}><FileDown size={14} strokeWidth={1.5} /> CSV</button>
          <button className="tb" onClick={exportJSON}><Download size={14} strokeWidth={1.5} /> JSON</button>
          <div className="tb-sep" />
          <button className="tb tb-danger" onClick={handleDeleteChart}>Delete chart</button>
        </div>
      </header>

      <div className="meta">
        <span><strong>{stats.total}</strong> people</span>
        <span className="dot">·</span>
        <span><strong>{stats.teams}</strong> teams</span>
        <span className="dot">·</span>
        <span className="hint">drag a card onto another to reassign · click a field to edit · ⌘/Ctrl-click to add a report</span>
      </div>

      <main className="canvas" onDragOver={(e) => e.preventDefault()}>
        <div className={`tree-scroll ${linkingFrom ? "is-linking" : ""}`} ref={canvasRef}>
          <MatrixLinks containerRef={canvasRef} links={links} tree={tree} enabled={showLinks} onRemove={handleRemoveLink} />
          <Node
            node={tree} depth={0}
            onToggle={handleToggle} onAdd={handleAddChild} onDelete={handleDelete} onEdit={handleEdit}
            editingField={editingField} setEditingField={setEditingField}
            selectedId={selectedId} setSelectedId={setSelectedId}
            onDragStart={handleDragStart} onDragOver={handleDragOver} onDragLeave={handleDragLeave}
            onDrop={handleDrop} onDragEnd={handleDragEnd}
            draggedId={draggedId} dragOverId={dragOverId}
            matches={matches} searchActive={!!search.trim()}
            linkingFrom={linkingFrom} onLinkTarget={handleLinkTarget}
            onStartLink={handleStartLink}
          />
        </div>
      </main>

      {linkingFrom && (
        <div className="link-banner">
          <Spline size={15} strokeWidth={1.6} />
          Click a card to draw a dotted line from <strong>{nameOf(linkingFrom)}</strong>
          <button className="tb" onClick={() => setLinkingFrom(null)}>Cancel (Esc)</button>
        </div>
      )}

      {selectedNode && !linkingFrom && (
        <Inspector
          node={selectedNode}
          nameOf={nameOf}
          onClose={() => setSelectedId(null)}
          onSetAccent={handleSetAccent}
          onStartLink={handleStartLink}
          onRemoveLink={handleRemoveLink}
        />
      )}

      {showImport && (
        <div className="modal-bg" onClick={() => setShowImport(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div>Paste JSON or CSV</div>
              <button className="x" onClick={() => setShowImport(false)}>×</button>
            </div>
            <div className="modal-body">
              <p className="modal-hint">CSV columns: <code>Name, Title, Team, Manager</code>. The first person with no manager becomes the root.</p>
              <textarea value={importText} onChange={(e) => setImportText(e.target.value)} placeholder="Paste here..." />
              <div className="modal-actions">
                <button className="tb" onClick={() => setShowImport(false)}>Cancel</button>
                <button className="tb tb-primary" onClick={importFromText}>Import</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- node ----------
function Node(props) {
  const { node, depth, onToggle, onAdd, onDelete, onEdit, editingField, setEditingField,
    selectedId, setSelectedId, onDragStart, onDragOver, onDragLeave, onDrop, onDragEnd,
    draggedId, dragOverId, matches, searchActive, linkingFrom, onLinkTarget, onStartLink } = props;

  const hasKids = (node.children || []).length > 0;
  const collapsed = node.collapsed && hasKids;
  const isSelected = selectedId === node.id;
  const isDragOver = dragOverId === node.id;
  const isDragging = draggedId === node.id;
  const dimmed = searchActive && !matches.has(node.id) && !hasMatchingDescendant(node, matches);
  const directReports = (node.children || []).length;
  const totalReports = countDescendants(node);
  const accent = accentColor(node.accent);
  const hasAccent = node.accent && node.accent !== "slate";
  const isLinkSource = linkingFrom === node.id;
  const isLinkTarget = linkingFrom && linkingFrom !== node.id;

  const handleCardClick = (e) => {
    // In "draw dotted line" mode, a click picks the target instead of selecting.
    if (linkingFrom && onLinkTarget(node.id)) { e.stopPropagation(); return; }
    if (e.metaKey || e.ctrlKey) { e.preventDefault(); onAdd(node.id); return; }
    setSelectedId(node.id);
  };

  return (
    <div className={`branch ${depth === 0 ? "branch-root" : ""}`}>
      <div
        data-node-id={node.id}
        className={["card", isSelected ? "card-sel" : "", isDragOver ? "card-over" : "", isDragging ? "card-dragging" : "", dimmed ? "card-dim" : "", node.id === "root" ? "card-root" : "", hasAccent ? "card-accent" : "", isLinkSource ? "card-link-src" : "", isLinkTarget ? "card-link-target" : ""].join(" ")}
        style={hasAccent ? { "--card-accent": accent } : undefined}
        draggable={node.id !== "root"}
        onDragStart={(e) => onDragStart(e, node.id)}
        onDragOver={(e) => onDragOver(e, node.id)}
        onDragLeave={() => onDragLeave(node.id)}
        onDrop={(e) => onDrop(e, node.id)}
        onDragEnd={onDragEnd}
        onClick={handleCardClick}
      >
        <div className="card-rail" />

        <div className="card-head">
          {hasKids ? (
            <button className="chev" onClick={(e) => { e.stopPropagation(); onToggle(node.id); }} title={collapsed ? "Expand" : "Collapse"}>
              {collapsed ? <ChevronRight size={14} strokeWidth={2} /> : <ChevronDown size={14} strokeWidth={2} />}
            </button>
          ) : <div className="chev-spacer" />}

          <EditableField value={node.name} field="name" id={node.id}
            editing={editingField?.id === node.id && editingField?.field === "name"}
            setEditing={setEditingField} onChange={onEdit}
            className="name" placeholder="Name" />

          <div className="card-actions">
            <button className="ghost" title="Add direct report" onClick={(e) => { e.stopPropagation(); onAdd(node.id); }}>
              <Plus size={13} strokeWidth={1.8} />
            </button>
            <button className="ghost" title="Draw a dotted (matrix) line from here" onClick={(e) => { e.stopPropagation(); onStartLink(node.id); }}>
              <Spline size={13} strokeWidth={1.8} />
            </button>
            {node.id !== "root" && (
              <button className="ghost ghost-danger" title="Remove" onClick={(e) => { e.stopPropagation(); onDelete(node.id); }}>
                <Trash2 size={13} strokeWidth={1.8} />
              </button>
            )}
          </div>
        </div>

        <EditableField value={node.title} field="title" id={node.id}
          editing={editingField?.id === node.id && editingField?.field === "title"}
          setEditing={setEditingField} onChange={onEdit}
          className="title" placeholder="Title" />

        <div className="card-foot">
          <EditableField value={node.team} field="team" id={node.id}
            editing={editingField?.id === node.id && editingField?.field === "team"}
            setEditing={setEditingField} onChange={onEdit}
            className="team" placeholder="+ team" />
          {hasKids && (
            <span className="report-count" title={`${directReports} direct, ${totalReports} total`}>
              <Users size={11} strokeWidth={1.8} />
              {directReports}{totalReports !== directReports ? ` · ${totalReports}` : ""}
            </span>
          )}
        </div>
      </div>

      {hasKids && !collapsed && (
        <div className="children-wrap">
          <div className="connector-v" />
          <div className="children">
            {node.children.map((child, idx) => (
              <div className="child-slot" key={child.id}>
                <div className={`connector-h ${idx === 0 ? "first" : ""} ${idx === node.children.length - 1 ? "last" : ""}`} />
                <Node {...props} node={child} depth={depth + 1} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function hasMatchingDescendant(node, matches) {
  let yes = false;
  (function recur(n) { if (matches.has(n.id)) yes = true; (n.children || []).forEach(recur); })(node);
  return yes;
}

// point on a cubic bezier at parameter t (used to place link labels)
const bez = (a, b, c, d, t) => { const m = 1 - t; return m*m*m*a + 3*m*m*t*b + 3*m*t*t*c + t*t*t*d; };
const cssId = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/"/g, '\\"'));

// ---------- dotted-line (matrix) overlay ----------
// An absolutely-positioned SVG inside .tree-scroll. It measures each linked card's
// live DOM rect and draws a dashed bezier between them. Recomputes whenever the tree
// changes (edits, collapse/expand) or the container resizes.
function MatrixLinks({ containerRef, links, tree, enabled, onRemove }) {
  const [segs, setSegs] = useState([]);
  const [size, setSize] = useState({ w: 0, h: 0 });

  const measure = useCallback(() => {
    const cont = containerRef.current;
    if (!cont || !enabled || !links.length) { setSegs([]); return; }
    const crect = cont.getBoundingClientRect();
    const out = [];
    for (const link of links) {
      const a = cont.querySelector(`[data-node-id="${cssId(link.from)}"]`);
      const b = cont.querySelector(`[data-node-id="${cssId(link.to)}"]`);
      if (!a || !b) continue; // an endpoint is collapsed away — skip its line
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const ax = ra.left - crect.left, ay = ra.top - crect.top;
      const bx = rb.left - crect.left, by = rb.top - crect.top;
      const aMid = ax + ra.width / 2, bMid = bx + rb.width / 2;
      // anchor on the facing vertical edges, mid-height
      const rightward = bMid >= aMid;
      const p1 = { x: rightward ? ax + ra.width : ax, y: ay + ra.height / 2 };
      const p2 = { x: rightward ? bx : bx + rb.width, y: by + rb.height / 2 };
      const dir = rightward ? 1 : -1;
      const bow = Math.max(36, Math.abs(p2.x - p1.x) * 0.4);
      const c1 = { x: p1.x + bow * dir, y: p1.y };
      const c2 = { x: p2.x - bow * dir, y: p2.y };
      out.push({
        key: `${link.from}->${link.to}`,
        from: link.from, to: link.to, label: link.label,
        color: accentColor(link.accent),
        d: `M ${p1.x} ${p1.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p2.x} ${p2.y}`,
        end: p2,
        mx: bez(p1.x, c1.x, c2.x, p2.x, 0.5),
        my: bez(p1.y, c1.y, c2.y, p2.y, 0.5),
      });
    }
    setSegs(out);
    setSize({ w: cont.scrollWidth, h: cont.scrollHeight });
  }, [containerRef, links, enabled]);

  useLayoutEffect(() => { measure(); }, [measure, tree]);
  useEffect(() => {
    const cont = containerRef.current;
    if (!cont) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(cont);
    window.addEventListener("resize", measure);
    const raf = requestAnimationFrame(measure);
    return () => { ro.disconnect(); window.removeEventListener("resize", measure); cancelAnimationFrame(raf); };
  }, [measure, containerRef]);

  if (!enabled || !segs.length) return null;
  const colors = [...new Set(segs.map((s) => s.color))];
  return (
    <svg className="matrix-svg" width={size.w} height={size.h}>
      <defs>
        {colors.map((c) => (
          <marker key={c} id={`arw-${c.replace("#", "")}`} viewBox="0 0 8 8" refX="6" refY="4"
            markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L8 4 L0 8 z" fill={c} />
          </marker>
        ))}
      </defs>
      {segs.map((s) => (
        <g key={s.key}>
          <path className="matrix-path" d={s.d} stroke={s.color}
            markerEnd={`url(#arw-${s.color.replace("#", "")})`} />
          {s.label && (
            <text className="matrix-label" x={s.mx} y={s.my} fill={s.color}>{s.label}</text>
          )}
        </g>
      ))}
    </svg>
  );
}

// ---------- selection inspector (accent + dotted-line editing) ----------
function Inspector({ node, nameOf, onClose, onSetAccent, onStartLink, onRemoveLink }) {
  const dotted = node.dotted || [];
  const current = node.accent || "slate";
  return (
    <div className="inspector">
      <div className="insp-head">
        <span className="insp-title">{node.name || "Untitled"}</span>
        <button className="x" onClick={onClose} title="Close">×</button>
      </div>

      <div className="insp-sec">
        <div className="insp-label">Card colour</div>
        <div className="swatches">
          {ACCENT_KEYS.map((k) => (
            <button key={k} title={ACCENTS[k].label}
              className={`swatch ${current === k ? "swatch-on" : ""}`}
              style={{ "--sw": accentColor(k) }}
              onClick={() => onSetAccent(node.id, k)} />
          ))}
        </div>
        <div className="insp-role">{ACCENTS[current].label}</div>
      </div>

      <div className="insp-sec">
        <div className="insp-label">Dotted lines from here</div>
        {dotted.length === 0 && <div className="insp-empty">None yet — draw one to another card.</div>}
        {dotted.map((d) => (
          <div className="link-row" key={d.to}>
            <Spline size={12} strokeWidth={1.7} />
            <span className="link-to">{nameOf(d.to)}</span>
            <button className="link-x" title="Remove line" onClick={() => onRemoveLink(node.id, d.to)}>
              <X size={12} strokeWidth={2} />
            </button>
          </div>
        ))}
        <button className="tb tb-primary insp-add" onClick={() => onStartLink(node.id)}>
          <Spline size={13} strokeWidth={1.7} /> Draw dotted line
        </button>
      </div>
    </div>
  );
}

function EditableField({ value, field, id, editing, setEditing, onChange, className, placeholder }) {
  const ref = useRef(null);
  const [draft, setDraft] = useState(value || "");
  useEffect(() => { setDraft(value || ""); }, [value, editing]);
  useEffect(() => { if (editing && ref.current) { ref.current.focus(); ref.current.select(); } }, [editing]);
  const commit = () => { onChange(id, field, draft); setEditing(null); };
  if (editing) {
    return (
      <input ref={ref} className={`field-input ${className}`} value={draft}
        onChange={(e) => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); commit(); }
          if (e.key === "Escape") { setDraft(value || ""); setEditing(null); }
        }}
        onClick={(e) => e.stopPropagation()} placeholder={placeholder} />
    );
  }
  return (
    <div className={`field ${className} ${!value ? "field-empty" : ""}`}
      onClick={(e) => { e.stopPropagation(); setEditing({ id, field }); }}>
      {value || placeholder}
    </div>
  );
}

const chartStyles = `
.back-btn {
  width: 36px; height: 36px;
  border: 1px solid var(--rule);
  background: transparent; cursor: pointer;
  display: grid; place-items: center;
  color: var(--ink-soft);
  border-radius: 2px;
  transition: all 0.12s ease;
}
.back-btn:hover { border-color: var(--ink); color: var(--ink); background: var(--paper-2); }

.chart-title { display: flex; flex-direction: column; min-width: 200px; }
.chart-title h1 {
  font-family: 'Iowan Old Style', Georgia, serif;
  font-size: 18px; font-weight: 600; margin: 0;
  letter-spacing: -0.005em;
  cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
}
.chart-title h1:hover .title-pen { opacity: 1; }
.title-pen { opacity: 0; color: var(--ink-faint); transition: opacity 0.12s ease; }
.title-input {
  font-family: 'Iowan Old Style', Georgia, serif;
  font-size: 18px; font-weight: 600;
  border: 1px solid var(--ink); background: #fffdf6;
  padding: 3px 6px; outline: none;
  color: var(--ink); letter-spacing: -0.005em;
  min-width: 220px;
}
.save-status {
  font-size: 11px; font-style: italic;
  font-family: 'Iowan Old Style', Georgia, serif;
  margin-top: 3px;
}
.save-saving { color: var(--ink-faint); }
.save-synced { color: var(--ok); }
.save-error { color: var(--accent); }

.search-wrap {
  flex: 1; min-width: 200px; max-width: 320px;
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px;
  background: rgba(255, 253, 246, 0.6);
  border: 1px solid var(--rule);
  border-radius: 2px;
  color: var(--ink-faint);
}
.search { flex: 1; border: none; outline: none; background: transparent;
  font-family: inherit; font-size: 13.5px; color: var(--ink); }
.search::placeholder { color: var(--ink-faint); font-style: italic; }

.toolbar { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }

.meta {
  font-family: 'Iowan Old Style', Georgia, serif;
  font-size: 12px; color: var(--ink-faint); font-style: italic;
  display: flex; gap: 10px; align-items: center;
  margin-bottom: 22px; flex-wrap: wrap;
}
.meta strong { color: var(--ink); font-style: normal; font-weight: 600; }
.meta .dot { color: var(--rule); }
.meta .hint { font-size: 11.5px; }

.canvas {
  border: 1px solid var(--rule);
  background:
    linear-gradient(rgba(255, 253, 246, 0.4), rgba(255, 253, 246, 0.4)),
    repeating-linear-gradient(0deg, transparent 0 31px, rgba(184, 156, 110, 0.06) 31px 32px);
  padding: 36px 24px;
  border-radius: 2px;
  overflow: auto;
  min-height: 500px;
}
.tree-scroll { display: flex; justify-content: center; min-width: max-content; }

.branch { display: flex; flex-direction: column; align-items: center; }
.branch-root { padding-top: 8px; }

.card {
  position: relative; width: 220px;
  background: #fffdf6;
  border: 1px solid var(--rule);
  border-radius: 2px;
  padding: 12px 14px 10px;
  box-shadow: var(--shadow);
  cursor: grab;
  transition: transform 0.18s cubic-bezier(0.4, 0, 0.2, 1), box-shadow 0.18s ease, border-color 0.15s ease;
  user-select: none;
}
.card:hover { box-shadow: var(--shadow-lift); transform: translateY(-1px); border-color: var(--ink-faint); }
.card:active { cursor: grabbing; }
.card-rail { position: absolute; left: 0; top: 0; bottom: 0; width: 3px;
  background: var(--ink-faint); opacity: 0.3; transition: all 0.15s ease; }
.card-root .card-rail { background: var(--accent); opacity: 1; width: 4px; }
.card-sel { border-color: var(--ink); }
.card-sel .card-rail { background: var(--ink); opacity: 1; }
.card-over { border-color: var(--accent); border-style: dashed; transform: scale(1.02);
  box-shadow: 0 0 0 3px rgba(184, 68, 42, 0.12), var(--shadow-lift); }
.card-dragging { opacity: 0.4; }
.card-dim { opacity: 0.32; }

.card-head { display: flex; align-items: center; gap: 4px; margin-bottom: 4px; }
.chev {
  width: 18px; height: 18px;
  display: grid; place-items: center;
  background: transparent; border: none;
  color: var(--ink-soft); cursor: pointer; padding: 0;
  border-radius: 2px; transition: all 0.12s ease;
}
.chev:hover { background: var(--paper-2); color: var(--ink); }
.chev-spacer { width: 18px; height: 18px; }

.card-actions { margin-left: auto; display: flex; gap: 2px; opacity: 0; transition: opacity 0.15s ease; }
.card:hover .card-actions { opacity: 1; }
.card .ghost { width: 22px; height: 22px; }

.field { cursor: text; border-radius: 1px; padding: 1px 4px; margin: 0 -4px;
  transition: background 0.1s ease; word-break: break-word; }
.field:hover { background: var(--paper-2); }
.field-empty { color: var(--ink-faint); font-style: italic; }
.name { flex: 1; font-size: 14.5px; font-weight: 600; letter-spacing: -0.005em;
  font-family: 'Iowan Old Style', Georgia, serif; }
.title { font-size: 12px; color: var(--ink-soft); margin-bottom: 6px; margin-left: 22px;
  font-style: italic; line-height: 1.35; }
.card-foot {
  display: flex; align-items: center; justify-content: space-between;
  margin-left: 22px; padding-top: 6px;
  border-top: 1px dotted var(--rule);
  gap: 8px;
}
.team { font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--accent); font-weight: 600; font-family: 'Helvetica Neue', 'Arial', sans-serif; }
.team.field-empty { color: var(--ink-faint); }
.report-count {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 10.5px; color: var(--ink-faint);
  font-family: 'Helvetica Neue', Arial, sans-serif; letter-spacing: 0.04em;
}

.field-input {
  font-family: inherit; border: 1px solid var(--ink); outline: none;
  background: #fffdf6; padding: 1px 4px; margin: 0 -5px;
  border-radius: 1px; width: 100%; box-sizing: border-box;
}
.field-input.name { font-size: 14.5px; font-weight: 600; }
.field-input.title { font-size: 12px; font-style: italic; color: var(--ink-soft); }
.field-input.team { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--accent); font-weight: 600; }

.children-wrap { display: flex; flex-direction: column; align-items: center; position: relative; }
.connector-v { width: 1px; height: 28px; background: var(--ink-soft); opacity: 0.45; }
.children { display: flex; gap: 28px; position: relative; padding-top: 0; }
.child-slot { display: flex; flex-direction: column; align-items: center; position: relative; }
.connector-h { position: absolute; top: -28px; left: 0; right: 0; height: 1px;
  background: var(--ink-soft); opacity: 0.45; }
.connector-h::before { content: ""; position: absolute; top: 0; bottom: 0; left: 50%;
  width: 1px; background: var(--ink-soft); height: 28px; }
.connector-h.first { left: 50%; }
.connector-h.last { right: 50%; }
.children .child-slot:only-child .connector-h { left: 50%; right: 50%; }

.modal-bg { position: fixed; inset: 0; background: rgba(26, 22, 18, 0.5);
  display: grid; place-items: center; z-index: 50; padding: 20px; }
.modal { background: var(--paper); border: 1px solid var(--ink);
  width: 560px; max-width: 100%; box-shadow: var(--shadow-lift); }
.modal-head { display: flex; justify-content: space-between; align-items: center;
  padding: 14px 18px; border-bottom: 1px solid var(--rule);
  font-family: 'Iowan Old Style', Georgia, serif; font-size: 15px; font-weight: 600; }
.x { background: transparent; border: none; font-size: 20px; cursor: pointer;
  color: var(--ink-soft); line-height: 1; }
.x:hover { color: var(--ink); }
.modal-body { padding: 16px 18px 18px; }
.modal-hint { font-size: 12.5px; color: var(--ink-soft);
  font-family: 'Iowan Old Style', Georgia, serif; font-style: italic;
  margin: 0 0 12px; line-height: 1.5; }
.modal-hint code { font-family: 'SF Mono', 'Menlo', monospace; font-style: normal;
  font-size: 11.5px; background: var(--paper-2); padding: 1px 4px; border-radius: 2px; }
.modal textarea { width: 100%; box-sizing: border-box; height: 220px;
  padding: 10px; font-family: 'SF Mono', 'Menlo', monospace; font-size: 12px;
  border: 1px solid var(--rule); background: #fffdf6; resize: vertical; outline: none; }
.modal textarea:focus { border-color: var(--ink); }
.modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }

/* ---------- matrix: toolbar toggle ---------- */
.tb.tb-on { background: var(--ink); color: var(--paper); border-color: var(--ink); }

/* ---------- matrix: accent-coloured cards ---------- */
/* the card's left rail + a faint tint pick up --card-accent (set inline) */
.card-accent { border-color: color-mix(in srgb, var(--card-accent) 40%, var(--rule)); }
.card-accent .card-rail { background: var(--card-accent); opacity: 1; width: 4px; }
.card-accent .team { color: var(--card-accent); }
.card-accent.card-sel { border-color: var(--card-accent); }

/* ---------- matrix: link-drawing affordances ---------- */
.tree-scroll.is-linking .card { cursor: crosshair; }
.card-link-src { outline: 2px dashed var(--accent); outline-offset: 2px; }
.card-link-target:hover {
  border-color: var(--accent); border-style: dashed;
  box-shadow: 0 0 0 3px rgba(184, 68, 42, 0.12), var(--shadow-lift);
}

/* ---------- matrix: SVG overlay ---------- */
.tree-scroll { position: relative; }
.branch-root { position: relative; z-index: 1; }
.matrix-svg { position: absolute; left: 0; top: 0; z-index: 0; pointer-events: none; overflow: visible; }
.matrix-path {
  fill: none; stroke-width: 1.6;
  stroke-dasharray: 2 5; stroke-linecap: round;
  opacity: 0.85;
}
.matrix-label {
  font-family: 'Helvetica Neue', Arial, sans-serif;
  font-size: 10px; font-weight: 600; letter-spacing: 0.03em;
  text-anchor: middle; dominant-baseline: middle;
  paint-order: stroke; stroke: var(--paper); stroke-width: 4px; stroke-linejoin: round;
}

/* ---------- matrix: link-drawing banner ---------- */
.link-banner {
  position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
  z-index: 60; display: flex; align-items: center; gap: 10px;
  background: var(--ink); color: var(--paper);
  padding: 10px 14px; border-radius: 3px;
  font-family: 'Iowan Old Style', Georgia, serif; font-size: 13px;
  box-shadow: var(--shadow-lift);
}
.link-banner strong { font-weight: 600; }
.link-banner .tb {
  background: transparent; color: var(--paper); border-color: rgba(245,241,232,0.4);
  padding: 4px 9px; font-size: 12px;
}
.link-banner .tb:hover { background: var(--paper); color: var(--ink); border-color: var(--paper); }

/* ---------- matrix: selection inspector ---------- */
.inspector {
  position: fixed; right: 24px; bottom: 24px; z-index: 55;
  width: 244px;
  background: var(--paper); border: 1px solid var(--ink);
  border-radius: 3px; box-shadow: var(--shadow-lift);
  font-family: 'Iowan Old Style', Georgia, serif;
}
.insp-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px; border-bottom: 1px solid var(--rule);
}
.insp-title { font-size: 14px; font-weight: 600; letter-spacing: -0.005em;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.insp-sec { padding: 12px; border-bottom: 1px solid var(--rule-soft); }
.insp-sec:last-child { border-bottom: none; }
.insp-label {
  font-family: 'Helvetica Neue', Arial, sans-serif;
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.09em;
  color: var(--ink-faint); margin-bottom: 8px;
}
.swatches { display: flex; gap: 7px; }
.swatch {
  width: 22px; height: 22px; border-radius: 50%;
  background: var(--sw); border: 2px solid var(--paper);
  box-shadow: 0 0 0 1px var(--rule); cursor: pointer; padding: 0;
  transition: transform 0.1s ease;
}
.swatch:hover { transform: scale(1.12); }
.swatch-on { box-shadow: 0 0 0 2px var(--ink); }
.insp-role {
  margin-top: 8px; font-size: 11.5px; font-style: italic; color: var(--ink-soft);
}
.insp-empty { font-size: 12px; font-style: italic; color: var(--ink-faint); }
.link-row {
  display: flex; align-items: center; gap: 6px;
  font-size: 12.5px; color: var(--ink-soft); padding: 3px 0;
}
.link-row .link-to { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.link-x {
  background: transparent; border: none; cursor: pointer; padding: 2px;
  color: var(--ink-faint); display: grid; place-items: center; border-radius: 2px;
}
.link-x:hover { color: var(--accent); background: var(--paper-2); }
.insp-add { margin-top: 10px; width: 100%; justify-content: center; }
`;
