import React, { useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect } from "react";
import { ChevronDown, ChevronRight, Plus, Trash2, Download, Upload, Users, Search, RotateCcw, FileDown, ArrowLeft, Edit2, Spline, X, Maximize2, Eye, EyeOff } from "lucide-react";
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

// A chart may override any role's label/colour; overrides live on the tree root
// as `root.palette = { <key>: { label?, color? } }`. mergePalette folds those onto
// the defaults so old charts (no palette) render exactly as before.
const mergePalette = (root) => {
  const o = (root && root.palette) || {};
  const m = {};
  for (const k of ACCENT_KEYS) {
    const ov = o[k] || {};
    m[k] = { label: ov.label || ACCENTS[k].label, color: ov.color || ACCENTS[k].color };
  }
  return m;
};
const palColor = (pal, key) => (pal[key] || pal.slate).color;
const palLabel = (pal, key) => (pal[key] || pal.slate).label;

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
// ancestors-first path from the root down to `id` (empty if not found)
const pathTo = (root, id) => {
  let found = null;
  const recur = (n, trail) => {
    if (found) return;
    const next = [...trail, n];
    if (n.id === id) { found = next; return; }
    (n.children || []).forEach((c) => recur(c, next));
  };
  recur(root, []);
  return found || [];
};

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
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const [focusId, setFocusId] = useState(null); // drill-down: show only this subtree (null = whole chart)
  // Public view: hides colour coding, the legend and role labels so the chart is safe to show
  // anyone. Mirrored into the URL (?public=1) so the address bar becomes a shareable clean link.
  const [publicView, setPublicView] = useState(() => new URLSearchParams(window.location.search).get("public") === "1");
  const togglePublic = useCallback(() => {
    const next = !publicView;
    const url = new URL(window.location.href);
    if (next) url.searchParams.set("public", "1"); else url.searchParams.delete("public");
    window.history.replaceState(null, "", url.toString());
    setPublicView(next);
  }, [publicView]);
  const canvasRef = useRef(null);   // the .canvas viewport
  const treeRef = useRef(null);     // the natural-size tree layer (for Fit)
  const panRef = useRef(null);      // in-flight pan drag state
  const didFitRef = useRef(false);
  const userMovedRef = useRef(false); // has the user panned/zoomed yet?
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
  const handleToggleGroup = (id, val) => apply((prev) => updateNode(prev, id, { group: val }));
  const handleSetStack = (id, val) => apply((prev) => updateNode(prev, id, { stack: val }));
  // rename/recolour a role — stored on the tree root so it persists per-chart
  const handleEditAccentMeta = (key, patch) => apply((prev) => ({
    ...prev,
    palette: { ...(prev.palette || {}), [key]: { ...((prev.palette || {})[key] || {}), ...patch } },
  }));
  const handleStartLink = (id) => { setLinkingFrom(id); setSelectedId(id); };
  const handleRemoveLink = (fromId, toId) => apply((prev) => removeDottedLink(prev, fromId, toId));
  // add a dotted line to a person picked by name (works even if they're off-screen / in another team)
  const handleAddLinkTo = (fromId, toId) => apply((prev) => addDottedLink(prev, fromId, toId));
  // Called when a card is clicked while we're in "draw dotted line" mode.
  const handleLinkTarget = (targetId) => {
    if (!linkingFrom) return false;
    if (targetId !== linkingFrom) apply((prev) => addDottedLink(prev, linkingFrom, targetId));
    setLinkingFrom(null);
    return true;
  };
  // Esc cancels link-drawing, or backs out of a drilled-in team.
  useEffect(() => {
    if (!linkingFrom && !focusId) return;
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      if (linkingFrom) setLinkingFrom(null); else setFocusId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [linkingFrom, focusId]);

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
  const people = useMemo(() => (tree ? flatten(tree) : []), [tree]); // everyone, for the link-by-name picker
  const palette = useMemo(() => mergePalette(tree), [tree]);

  // ---------- drill-down (focus on one team) ----------
  // The focused subtree becomes the rendered root; edits still hit the real tree by id.
  const focusNode = useMemo(() => (tree && focusId ? findNode(tree, focusId) : null), [tree, focusId]);
  const focusPath = useMemo(() => (tree && focusNode ? pathTo(tree, focusId) : []), [tree, focusNode, focusId]);
  const viewRoot = focusNode || tree;
  const enterFocus = useCallback((id) => {
    if (!id || id === "root") { setFocusId(null); return; }
    // digging into a team should show it — un-collapse the team's root (no history entry,
    // same as the chevron toggle)
    setTree((prev) => (prev && findNode(prev, id)?.collapsed ? updateNode(prev, id, { collapsed: false }) : prev));
    setFocusId(id); setSelectedId(null); setLinkingFrom(null);
  }, []);
  const exitFocus = useCallback(() => setFocusId(null), []);
  // re-fit whenever the focused subtree changes (an explicit navigation, so always fit)
  useEffect(() => {
    if (!tree) return;
    let cancelled = false, n = 0, timer = 0;
    const tryFit = () => {
      if (cancelled) return;
      if (fitView()) return;
      if (++n < 30) timer = setTimeout(tryFit, 50);
    };
    timer = setTimeout(tryFit, 0);
    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId]);
  const selectedNode = useMemo(() => (tree && selectedId ? findNode(tree, selectedId) : null), [tree, selectedId]);
  const nameOf = useCallback((id) => { const n = tree && findNode(tree, id); return n ? n.name : "—"; }, [tree]);

  // ---------- pan / zoom canvas ----------
  const clampZoom = (z) => Math.min(2.2, Math.max(0.15, z));

  // zoom by `factor`, keeping the content point under (sx, sy) — canvas-relative px — fixed
  const zoomAt = useCallback((factor, sx, sy) => {
    userMovedRef.current = true;
    setZoom((z) => {
      const nz = clampZoom(z * factor);
      const r = nz / z;
      setPan((p) => ({ x: sx - r * (sx - p.x), y: sy - r * (sy - p.y) }));
      return nz;
    });
  }, []);

  const zoomButton = useCallback((factor) => {
    const cv = canvasRef.current;
    if (cv) zoomAt(factor, cv.clientWidth / 2, cv.clientHeight / 2);
  }, [zoomAt]);

  // scale + center the whole tree to fit the viewport
  const fitView = useCallback(() => {
    const cv = canvasRef.current, tr = treeRef.current;
    if (!cv || !tr) return false;
    const cw = cv.clientWidth, ch = cv.clientHeight;
    const tw = tr.offsetWidth, th = tr.offsetHeight;
    if (!tw || !th) return false;
    const z = clampZoom(Math.min(cw / tw, ch / th) * 0.92);
    setZoom(z);
    setPan({ x: (cw - tw * z) / 2, y: Math.max(20, (ch - th * z) / 2) });
    return true;
  }, []);

  // auto-fit once the tree lays out, unless the user has already moved the view.
  // Polls with setTimeout (survives StrictMode's mount/unmount/mount) until it measures.
  useEffect(() => {
    if (!tree || didFitRef.current || userMovedRef.current) return;
    let cancelled = false, n = 0, timer = 0;
    const tryFit = () => {
      if (cancelled || didFitRef.current || userMovedRef.current) return;
      if (fitView()) { didFitRef.current = true; return; }
      if (++n < 30) timer = setTimeout(tryFit, 50);
    };
    timer = setTimeout(tryFit, 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [tree, fitView]);

  // wheel to zoom toward the cursor (native, non-passive so we can preventDefault)
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const onWheel = (e) => {
      e.preventDefault();
      const cr = cv.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - cr.left, e.clientY - cr.top);
    };
    cv.addEventListener("wheel", onWheel, { passive: false });
    return () => cv.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  // drag empty canvas to pan; a click on empty space clears selection
  const onCanvasMouseDown = (e) => {
    if (e.button !== 0) return;
    if (e.target.closest(".card") || e.target.closest(".zoom-controls") || e.target.closest(".legend")) return;
    panRef.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y, moved: false };
    setPanning(true);
  };
  useEffect(() => {
    if (!panning) return;
    const mv = (e) => {
      const s = panRef.current; if (!s) return;
      const dx = e.clientX - s.x, dy = e.clientY - s.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) { s.moved = true; userMovedRef.current = true; }
      setPan({ x: s.px + dx, y: s.py + dy });
    };
    const up = () => {
      const s = panRef.current;
      if (s && !s.moved) { setSelectedId(null); if (linkingFrom) setLinkingFrom(null); }
      panRef.current = null;
      setPanning(false);
    };
    window.addEventListener("mousemove", mv);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); };
  }, [panning, linkingFrom]);

  const viewKey = `${zoom.toFixed(4)}|${Math.round(pan.x)}|${Math.round(pan.y)}`;

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
          <button className={`tb ${showLinks ? "tb-on" : ""}`} onClick={() => setShowLinks((v) => !v)} title="Dotted lines are shown when you dig into a team — this toggles them there">
            <Spline size={14} strokeWidth={1.5} /> Dotted lines
          </button>
          <button className={`tb ${publicView ? "tb-public" : ""}`} onClick={togglePublic}
            title={publicView
              ? "Public view is ON — colour coding, legend and role labels are hidden. Copy this page's URL to share the clean version."
              : "Switch to a public-safe view (hides colour coding, legend and role labels)"}>
            {publicView ? <EyeOff size={14} strokeWidth={1.5} /> : <Eye size={14} strokeWidth={1.5} />} Public view
          </button>
          {publicView && <span className="public-chip">colours &amp; legend hidden · share this URL</span>}
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

      <main
        className={`canvas ${panning ? "is-panning" : ""}`}
        ref={canvasRef}
        onMouseDown={onCanvasMouseDown}
        onDragOver={(e) => e.preventDefault()}
      >
        {/* dotted lines are only drawn once you've dug into a team — the overview stays clean */}
        <MatrixLinks
          canvasRef={canvasRef} links={links} enabled={showLinks && !!focusId}
          viewKey={viewKey} selectedId={selectedId} palette={palette}
          nameOf={nameOf} focused={!!focusId} publicView={publicView}
        />
        <div
          className={`zoom-layer ${linkingFrom ? "is-linking" : ""}`}
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
        >
          <div className="tree-scroll" ref={treeRef}>
            <Node
              node={viewRoot} depth={0}
              onToggle={handleToggle} onAdd={handleAddChild} onDelete={handleDelete} onEdit={handleEdit}
              editingField={editingField} setEditingField={setEditingField}
              selectedId={selectedId} setSelectedId={setSelectedId}
              onDragStart={handleDragStart} onDragOver={handleDragOver} onDragLeave={handleDragLeave}
              onDrop={handleDrop} onDragEnd={handleDragEnd}
              draggedId={draggedId} dragOverId={dragOverId}
              matches={matches} searchActive={!!search.trim()}
              linkingFrom={linkingFrom} onLinkTarget={handleLinkTarget}
              onStartLink={handleStartLink} palette={palette}
              onFocus={enterFocus}
              publicView={publicView}
            />
          </div>
        </div>

        {!publicView && <Legend tree={tree} palette={palette} onEdit={handleEditAccentMeta} />}

        {focusNode && (
          <div className="crumbs">
            <button className="crumb" onClick={exitFocus} title="Show the whole chart (Esc)">All</button>
            {focusPath.map((n, i) => (
              <React.Fragment key={n.id}>
                <span className="crumb-sep">›</span>
                {i === focusPath.length - 1
                  ? <span className="crumb crumb-here">{n.name}</span>
                  : <button className="crumb" onClick={() => enterFocus(n.id)}>{n.name}</button>}
              </React.Fragment>
            ))}
            <span className="crumb-hint">double-click a card to dig in · Esc to back out</span>
          </div>
        )}

        <div className="zoom-controls">
          <button className="zc" onClick={() => zoomButton(1 / 1.2)} title="Zoom out">−</button>
          <button className="zc zc-pct" onClick={fitView} title="Fit to screen">{Math.round(zoom * 100)}%</button>
          <button className="zc" onClick={() => zoomButton(1.2)} title="Zoom in">+</button>
          <button className="zc zc-fit" onClick={fitView} title="Fit to screen"><Maximize2 size={13} strokeWidth={1.8} /></button>
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
          onToggleGroup={handleToggleGroup}
          onSetStack={handleSetStack}
          palette={palette}
          onFocus={enterFocus}
          people={people}
          onAddLink={handleAddLinkTo}
          publicView={publicView}
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
    draggedId, dragOverId, matches, searchActive, linkingFrom, onLinkTarget, onStartLink, palette, onFocus, publicView } = props;

  const hasKids = (node.children || []).length > 0;
  const collapsed = node.collapsed && hasKids;
  const isSelected = selectedId === node.id;
  const isDragOver = dragOverId === node.id;
  const isDragging = draggedId === node.id;
  const dimmed = searchActive && !matches.has(node.id) && !hasMatchingDescendant(node, matches);
  const directReports = (node.children || []).length;
  const totalReports = countDescendants(node);
  const accent = palColor(palette, node.accent);
  const hasAccent = !publicView && node.accent && node.accent !== "slate"; // public view strips colour coding
  const isLinkSource = linkingFrom === node.id;
  const isLinkTarget = linkingFrom && linkingFrom !== node.id;

  const handleCardClick = (e) => {
    // In "draw dotted line" mode, a click picks the target instead of selecting.
    if (linkingFrom && onLinkTarget(node.id)) { e.stopPropagation(); return; }
    if (e.metaKey || e.ctrlKey) { e.preventDefault(); onAdd(node.id); return; }
    setSelectedId(node.id);
  };

  const isBand = !!node.group;

  const cardEl = (
    <div
      data-node-id={node.id}
      className={["card", isBand ? "card-band-head" : "", isSelected ? "card-sel" : "", isDragOver ? "card-over" : "", isDragging ? "card-dragging" : "", dimmed ? "card-dim" : "", node.id === "root" ? "card-root" : "", hasAccent ? "card-accent" : "", isLinkSource ? "card-link-src" : "", isLinkTarget ? "card-link-target" : ""].join(" ")}
      style={hasAccent ? { "--card-accent": accent } : undefined}
      draggable={node.id !== "root"}
      onDragStart={(e) => onDragStart(e, node.id)}
      onDragOver={(e) => onDragOver(e, node.id)}
      onDragLeave={() => onDragLeave(node.id)}
      onDrop={(e) => onDrop(e, node.id)}
      onDragEnd={onDragEnd}
      onClick={handleCardClick}
      onDoubleClick={(e) => { if (hasKids && onFocus) { e.stopPropagation(); onFocus(node.id); } }}
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
  );

  // ----- band (matrix container): children laid out as columns inside a bordered region -----
  if (isBand) {
    return (
      <div className={`branch ${depth === 0 ? "branch-root" : ""}`}>
        <div data-band-id={node.id}
          className={`band ${node.stack ? "band-stack" : ""} ${hasAccent ? "band-accent" : ""} ${dimmed ? "card-dim" : ""}`}
          style={hasAccent ? { "--card-accent": accent } : undefined}>
          {cardEl}
          {hasKids && !collapsed && (
            <div className="band-body">
              {node.children.map((child) => (
                <Node {...props} key={child.id} node={child} depth={depth + 1} />
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`branch ${depth === 0 ? "branch-root" : ""}`}>
      {cardEl}

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
// A screen-space SVG pinned over the .canvas viewport. It measures where each linked
// card currently appears on screen (after pan/zoom) and draws a dashed arc that rises
// above the row, clearing intervening cards. Recomputes on view change, resize, edits.
function MatrixLinks({ canvasRef, links, enabled, viewKey, selectedId, palette, nameOf, focused, publicView }) {
  const [segs, setSegs] = useState([]);
  const [size, setSize] = useState({ w: 0, h: 0 });

  const measure = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv || !enabled || !links.length) { setSegs([]); return; }
    const cr = cv.getBoundingClientRect();
    // a link endpoint resolves to the whole band box when the node is a group,
    // so arrows land on the band's near edge rather than its far-left header card
    const findEl = (id) => cv.querySelector(`[data-band-id="${cssId(id)}"]`) || cv.querySelector(`[data-node-id="${cssId(id)}"]`);
    const out = [];
    const stubIdx = new Map(); // how many stubs already hang off a given card (to stack them)
    for (const link of links) {
      const a = findEl(link.from);
      const b = findEl(link.to);
      if (!a && !b) continue;
      // In a drilled-in team, a link whose other end lives outside the team becomes a
      // short labelled stub on the visible card — the relationship stays legible without
      // dragging a line across the whole org. At full view a missing end is just collapsed.
      if (!a || !b) {
        if (!focused) continue;
        const vis = a || b, isOut = !!a;
        const r = vis.getBoundingClientRect();
        const visId = isOut ? link.from : link.to;
        const idx = stubIdx.get(visId) || 0; stubIdx.set(visId, idx + 1);
        // Hang the stub BELOW the card (never sideways — that runs into the next card in
        // the row). If the card's reports are showing underneath, hang it ABOVE instead.
        const branch = vis.closest(".branch");
        const expanded = !!(branch && (branch.querySelector(":scope > .children-wrap") || branch.querySelector(":scope > .band > .band-body")));
        const gap = 12 + idx * 22;
        const y0 = expanded ? r.top - cr.top : r.bottom - cr.top;
        out.push({
          key: `${link.from}->${link.to}`, stub: true, from: link.from, to: link.to,
          color: publicView ? palColor(palette, "slate") : palColor(palette, link.accent),
          lx: r.left - cr.left + 22, y0, y1: expanded ? y0 - gap : y0 + gap, up: expanded,
          pillLeft: r.left - cr.left + 10,
          text: `${isOut ? "→" : "←"} ${nameOf(isOut ? link.to : link.from)}`,
        });
        continue;
      }
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      // screen coords relative to the canvas viewport
      const ax = ra.left - cr.left, ay = ra.top - cr.top;
      const bx = rb.left - cr.left, by = rb.top - cr.top;
      const rightward = (bx + rb.width / 2) >= (ax + ra.width / 2);
      const p1 = { x: rightward ? ax + ra.width : ax, y: ay + ra.height / 2 };
      const p2 = { x: rightward ? bx : bx + rb.width, y: by + rb.height / 2 };
      const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const dir = rightward ? 1 : -1;
      const lift = 26 + Math.min(90, dist * 0.22);      // arc rises above the row
      const bowX = Math.min(70, dist * 0.28);
      const c1 = { x: p1.x + dir * bowX, y: p1.y - lift };
      const c2 = { x: p2.x - dir * bowX, y: p2.y - lift };
      out.push({
        key: `${link.from}->${link.to}`,
        from: link.from, to: link.to, label: link.label,
        color: publicView ? palColor(palette, "slate") : palColor(palette, link.accent),
        d: `M ${p1.x} ${p1.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p2.x} ${p2.y}`,
        mx: bez(p1.x, c1.x, c2.x, p2.x, 0.5),
        my: bez(p1.y, c1.y, c2.y, p2.y, 0.5),
      });
    }
    setSegs(out);
    setSize({ w: cv.clientWidth, h: cv.clientHeight });
  }, [canvasRef, links, enabled, palette, focused, nameOf, publicView]);

  useLayoutEffect(() => { measure(); }, [measure, viewKey]);
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(cv);
    window.addEventListener("resize", measure);
    const raf = requestAnimationFrame(measure);
    return () => { ro.disconnect(); window.removeEventListener("resize", measure); cancelAnimationFrame(raf); };
  }, [measure, canvasRef]);

  if (!enabled || !segs.length) return null;
  const colors = [...new Set(segs.map((s) => s.color))];
  // only fade unrelated lines when the selected card is actually an endpoint of one
  const selTouches = selectedId && segs.some((s) => s.from === selectedId || s.to === selectedId);
  return (
    <svg className="matrix-svg" width={size.w} height={size.h}>
      <defs>
        {colors.map((c) => (
          <marker key={c} id={`arw-${c.replace("#", "")}`} viewBox="0 0 10 10" refX="8" refY="5"
            markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" fill={c} />
          </marker>
        ))}
      </defs>
      {segs.map((s) => {
        const active = !selTouches || s.from === selectedId || s.to === selectedId;
        if (s.stub) {
          const sw = s.text.length * 6.6 + 16;
          const py = s.up ? s.y1 - 9 : s.y1 + 9; // pill centre sits just past the line's end
          return (
            <g key={s.key} className={active ? "seg" : "seg seg-dim"}>
              <path className="matrix-path" d={`M ${s.lx} ${s.y0} L ${s.lx} ${s.y1}`} stroke={s.color} />
              <g transform={`translate(${s.pillLeft + sw / 2}, ${py})`}>
                <rect className="matrix-pill" x={-sw / 2} y={-9} width={sw} height={18} rx={9} stroke={s.color} />
                <text className="matrix-label" x={0} y={0} fill={s.color}>{s.text}</text>
              </g>
            </g>
          );
        }
        const w = Math.max(6, (s.label || "").length * 6.6 + 14);
        return (
          <g key={s.key} className={active ? "seg" : "seg seg-dim"}>
            <path className="matrix-path" d={s.d} stroke={s.color}
              markerEnd={`url(#arw-${s.color.replace("#", "")})`} />
            {s.label && (
              <g transform={`translate(${s.mx}, ${s.my})`}>
                <rect className="matrix-pill" x={-w / 2} y={-9} width={w} height={18} rx={9}
                  stroke={s.color} />
                <text className="matrix-label" x={0} y={0} fill={s.color}>{s.label}</text>
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ---------- role legend (editable) ----------
// Shows the accent roles used in the chart. Each row's colour and label are
// editable and persist to the chart (root.palette) via onEdit(key, patch).
function Legend({ tree, palette, onEdit }) {
  const used = useMemo(() => {
    if (!tree) return [];
    const seen = new Set();
    walk(tree, (n) => { if (n.accent && n.accent !== "slate") seen.add(n.accent); });
    return ACCENT_KEYS.filter((k) => seen.has(k));
  }, [tree]);
  if (used.length < 1) return null;
  return (
    <div className="legend">
      <div className="legend-head">Roles <span>· click to edit</span></div>
      {used.map((k) => (
        <div className="legend-row" key={k}>
          <label className="legend-dot" style={{ background: palColor(palette, k) }} title="Change colour">
            <input type="color" value={palColor(palette, k)} onChange={(e) => onEdit(k, { color: e.target.value })} />
          </label>
          <LegendLabel value={palLabel(palette, k)} onCommit={(v) => onEdit(k, { label: v })} />
        </div>
      ))}
    </div>
  );
}

function LegendLabel({ value, onCommit }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value, editing]);
  if (editing) {
    return (
      <input className="legend-input" autoFocus value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { onCommit(draft.trim() || value); setEditing(false); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") { onCommit(draft.trim() || value); setEditing(false); }
          if (e.key === "Escape") { setDraft(value); setEditing(false); }
        }} />
    );
  }
  return <span className="legend-label" onClick={() => setEditing(true)} title="Click to rename">{value}</span>;
}

// ---------- selection inspector (accent + dotted-line editing) ----------
function Inspector({ node, nameOf, onClose, onSetAccent, onStartLink, onRemoveLink, onToggleGroup, onSetStack, palette, onFocus, people, onAddLink, publicView }) {
  const dotted = node.dotted || [];
  const current = node.accent || "slate";
  const isGroup = !!node.group;
  const isStack = !!node.stack;
  return (
    <div className="inspector">
      <div className="insp-head">
        <span className="insp-title">{node.name || "Untitled"}</span>
        <button className="x" onClick={onClose} title="Close">×</button>
      </div>

      {(node.children || []).length > 0 && (
        <div className="insp-sec">
          <button className="tb tb-primary insp-add" style={{ marginTop: 0 }} onClick={() => onFocus(node.id)}>
            <Maximize2 size={13} strokeWidth={1.8} /> Dig into this team
          </button>
          <div className="insp-hint">Shows just this team, big and clear. Dotted lines to people outside it become small labelled stubs.</div>
        </div>
      )}

      {!publicView && (
        <div className="insp-sec">
          <div className="insp-label">Card colour</div>
          <div className="swatches">
            {ACCENT_KEYS.map((k) => (
              <button key={k} title={palLabel(palette, k)}
                className={`swatch ${current === k ? "swatch-on" : ""}`}
                style={{ "--sw": palColor(palette, k) }}
                onClick={() => onSetAccent(node.id, k)} />
            ))}
          </div>
          <div className="insp-role">{palLabel(palette, current)}</div>
        </div>
      )}

      <div className="insp-sec">
        <label className="insp-check">
          <input type="checkbox" checked={isGroup} onChange={(e) => onToggleGroup(node.id, e.target.checked)} />
          <span>Make this a section</span>
        </label>
        <div className="insp-hint">Wraps this card's reports in a bordered, titled region — a "Product" / "GTM" style group.</div>
        {isGroup && (
          <div className="insp-seg">
            <button className={`seg-btn ${!isStack ? "seg-on" : ""}`} onClick={() => onSetStack(node.id, false)}>Columns</button>
            <button className={`seg-btn ${isStack ? "seg-on" : ""}`} onClick={() => onSetStack(node.id, true)}>Stacked</button>
          </div>
        )}
      </div>

      <div className="insp-sec">
        <div className="insp-label">Dotted lines from here</div>
        {dotted.length === 0 && <div className="insp-empty">None yet.</div>}
        {dotted.map((d) => (
          <div className="link-row" key={d.to}>
            <Spline size={12} strokeWidth={1.7} />
            <span className="link-to">{nameOf(d.to)}</span>
            <button className="link-x" title="Remove line" onClick={() => onRemoveLink(node.id, d.to)}>
              <X size={12} strokeWidth={2} />
            </button>
          </div>
        ))}
        <LinkSearch people={people || []} excludeIds={[node.id, ...dotted.map((d) => d.to)]}
          onPick={(id) => onAddLink(node.id, id)} />
        <button className="tb insp-add insp-secondary" onClick={() => onStartLink(node.id)}>
          <Spline size={12} strokeWidth={1.7} /> …or click a card on the canvas
        </button>
      </div>
    </div>
  );
}

// Search everyone in the chart by name/title/team and pick one to link to.
// Works regardless of what's on screen — the whole point when drilled into a team.
function LinkSearch({ people, excludeIds, onPick }) {
  const [q, setQ] = useState("");
  const ex = new Set(excludeIds);
  const ql = q.trim().toLowerCase();
  const results = ql
    ? people.filter((p) => !ex.has(p.id) && (
        (p.name || "").toLowerCase().includes(ql) ||
        (p.title || "").toLowerCase().includes(ql) ||
        (p.team || "").toLowerCase().includes(ql)))
      .slice(0, 8)
    : [];
  const pick = (id) => { onPick(id); setQ(""); };
  return (
    <div className="link-search">
      <input className="link-search-input" placeholder="Add dotted line to… type a name" value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && results[0]) { e.preventDefault(); pick(results[0].id); }
          if (e.key === "Escape") setQ("");
        }} />
      {ql && (
        <div className="link-results">
          {results.length === 0 && <div className="link-result-empty">No one matches "{q}"</div>}
          {results.map((p) => (
            <button key={p.id} className="link-result" onClick={() => pick(p.id)}>
              <span className="lr-name">{p.name}</span>
              <span className="lr-meta">{[p.title, p.manager && `↳ ${p.manager}`].filter(Boolean).join(" · ")}</span>
            </button>
          ))}
        </div>
      )}
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
    radial-gradient(ellipse at 50% 0%, rgba(216, 200, 160, 0.14), transparent 62%),
    var(--paper-2);
  border-radius: 6px;
  overflow: hidden;
  position: relative;
  height: calc(100vh - 208px);
  min-height: 460px;
  cursor: grab;
}
.canvas.is-panning { cursor: grabbing; }
.zoom-layer { position: absolute; top: 0; left: 0; transform-origin: 0 0; will-change: transform; }
.tree-scroll { display: inline-flex; padding: 8px; }

.branch { display: flex; flex-direction: column; align-items: center; }

.card {
  position: relative; width: 176px;
  background: #fffdf7;
  border: 1px solid var(--rule);
  border-radius: 8px;
  padding: 9px 11px 9px 13px;
  box-shadow: 0 1px 2px rgba(26, 22, 18, 0.05), 0 8px 18px -12px rgba(26, 22, 18, 0.30);
  cursor: grab;
  transition: transform 0.15s cubic-bezier(0.4, 0, 0.2, 1), box-shadow 0.15s ease, border-color 0.15s ease;
  user-select: none;
}
.card:hover { box-shadow: 0 2px 3px rgba(26, 22, 18, 0.06), 0 16px 30px -14px rgba(26, 22, 18, 0.40); transform: translateY(-1px); border-color: var(--ink-faint); }
.card:active { cursor: grabbing; }
.card-rail { position: absolute; left: 0; top: 0; bottom: 0; width: 4px;
  background: var(--ink-faint); opacity: 0.25; border-radius: 8px 0 0 8px; transition: all 0.15s ease; }
.card-root { border-color: color-mix(in srgb, var(--accent) 40%, var(--rule)); }
.card-root .card-rail { background: var(--accent); opacity: 1; width: 5px; }
.card-accent { border-color: color-mix(in srgb, var(--card-accent) 45%, var(--rule));
  background: color-mix(in srgb, var(--card-accent) 6%, #fffdf7); }
.card-accent .card-rail { background: var(--card-accent); opacity: 1; width: 5px; }
.card-accent .team { color: var(--card-accent); }
.card-sel { border-color: var(--ink); box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 22%, transparent), 0 16px 30px -14px rgba(26, 22, 18, 0.40); }
.card-sel .card-rail { background: var(--ink); opacity: 1; }
.card-accent.card-sel { border-color: var(--card-accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--card-accent) 35%, transparent), 0 16px 30px -14px rgba(26, 22, 18, 0.40); }
.card-over { border-color: var(--accent); border-style: dashed; transform: scale(1.02);
  box-shadow: 0 0 0 3px rgba(184, 68, 42, 0.14), var(--shadow-lift); }
.card-dragging { opacity: 0.4; }
.card-dim { opacity: 0.32; }

.card-head { display: flex; align-items: center; gap: 3px; margin-bottom: 2px; }
.chev {
  width: 16px; height: 16px;
  display: grid; place-items: center;
  background: transparent; border: none;
  color: var(--ink-soft); cursor: pointer; padding: 0;
  border-radius: 2px; transition: all 0.12s ease;
}
.chev:hover { background: var(--paper-2); color: var(--ink); }
.chev-spacer { width: 16px; height: 16px; }

.card-actions { margin-left: auto; display: flex; gap: 2px; opacity: 0; transition: opacity 0.15s ease; }
.card:hover .card-actions { opacity: 1; }
.card .ghost { width: 22px; height: 22px; }

.field { cursor: text; border-radius: 1px; padding: 1px 4px; margin: 0 -4px;
  transition: background 0.1s ease; word-break: break-word; }
.field:hover { background: var(--paper-2); }
.field-empty { color: var(--ink-faint); font-style: italic; }
.name { flex: 1; font-size: 13.5px; font-weight: 600; letter-spacing: -0.005em; line-height: 1.2;
  font-family: 'Iowan Old Style', Georgia, serif; }
.title { font-size: 11px; color: var(--ink-soft); margin-bottom: 5px; margin-left: 19px;
  font-style: italic; line-height: 1.3; }
.card-foot {
  display: flex; align-items: center; justify-content: space-between;
  margin-left: 19px; padding-top: 5px;
  border-top: 1px dotted var(--rule);
  gap: 8px;
}
.team { font-size: 9.5px; letter-spacing: 0.07em; text-transform: uppercase;
  color: var(--accent); font-weight: 700; font-family: 'Helvetica Neue', 'Arial', sans-serif; }
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
.connector-v { width: 2px; height: 22px; background: var(--rule); border-radius: 2px; }
.children { display: flex; gap: 24px; position: relative; padding-top: 0; }
.child-slot { display: flex; flex-direction: column; align-items: center; position: relative; }
.connector-h { position: absolute; top: -22px; left: 0; right: 0; height: 2px;
  background: var(--rule); }
.connector-h::before { content: ""; position: absolute; top: 0; bottom: 0; left: 50%;
  width: 2px; background: var(--rule); height: 22px; transform: translateX(-1px); }
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
.tb.tb-public { background: var(--ok); color: var(--paper); border-color: var(--ok); }
.tb.tb-public:hover { background: #4a6633; border-color: #4a6633; }
.public-chip { font-size: 11px; font-style: italic; color: var(--ok); font-family: 'Iowan Old Style', Georgia, serif; }

/* ---------- matrix: link-drawing affordances ---------- */
.zoom-layer.is-linking .card { cursor: crosshair; }
.card-link-src { outline: 2px dashed var(--accent); outline-offset: 2px; }
.card-link-target:hover {
  border-color: var(--accent); border-style: dashed;
  box-shadow: 0 0 0 3px rgba(184, 68, 42, 0.14), var(--shadow-lift);
}

/* ---------- matrix: SVG overlay (screen-space, above cards) ---------- */
.matrix-svg { position: absolute; left: 0; top: 0; z-index: 4; pointer-events: none; overflow: hidden; }
.seg { transition: opacity 0.15s ease; }
.seg-dim { opacity: 0.16; }
.matrix-path {
  fill: none; stroke-width: 2;
  stroke-dasharray: 1 6; stroke-linecap: round;
}
.matrix-pill { fill: #fffdf7; stroke-width: 1.2; }
.matrix-label {
  font-family: 'Helvetica Neue', Arial, sans-serif;
  font-size: 10px; font-weight: 700; letter-spacing: 0.03em;
  text-anchor: middle; dominant-baseline: central;
}

/* ---------- matrix: zoom controls + legend ---------- */
.zoom-controls {
  position: absolute; left: 14px; bottom: 14px; z-index: 6;
  display: flex; align-items: center; gap: 1px;
  background: var(--paper); border: 1px solid var(--rule);
  border-radius: 9px; padding: 3px; box-shadow: var(--shadow);
}
.zc {
  min-width: 30px; height: 28px; border: none; background: transparent;
  color: var(--ink-soft); font-size: 17px; line-height: 1; cursor: pointer;
  border-radius: 6px; display: grid; place-items: center; font-family: inherit;
}
.zc:hover { background: var(--paper-2); color: var(--ink); }
.zc-pct { font-size: 12px; padding: 0 8px; font-variant-numeric: tabular-nums;
  font-family: 'Helvetica Neue', Arial, sans-serif; }
.zc-fit { font-size: 13px; }
.legend {
  position: absolute; right: 14px; top: 14px; z-index: 6;
  background: var(--paper); border: 1px solid var(--rule);
  border-radius: 9px; padding: 9px 12px; box-shadow: var(--shadow);
  display: flex; flex-direction: column; gap: 6px;
  font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 11px; color: var(--ink-soft);
}
.legend-head {
  font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.09em;
  color: var(--ink-faint); margin-bottom: 3px;
}
.legend-head span { text-transform: none; letter-spacing: 0; font-style: italic; opacity: 0.8; }
.legend-row { display: flex; align-items: center; gap: 8px; white-space: nowrap; }
.legend-dot {
  position: relative; width: 13px; height: 13px; border-radius: 3px; flex: none;
  cursor: pointer; box-shadow: 0 0 0 1px rgba(26,22,18,0.12) inset;
  transition: transform 0.1s ease;
}
.legend-dot:hover { transform: scale(1.15); }
.legend-dot input { position: absolute; inset: 0; opacity: 0; cursor: pointer; padding: 0; border: none; }
.legend-label { cursor: text; padding: 1px 4px; margin: 0 -4px; border-radius: 3px; }
.legend-label:hover { background: var(--paper-2); }
.legend-input {
  font-family: inherit; font-size: 11px; color: var(--ink);
  border: 1px solid var(--ink); border-radius: 3px; padding: 1px 4px; margin: 0 -5px;
  outline: none; background: #fffdf7; width: 110px; box-sizing: border-box;
}

/* ---------- drill-down breadcrumbs ---------- */
.crumbs {
  position: absolute; left: 14px; top: 14px; z-index: 6;
  display: flex; align-items: center; gap: 4px; flex-wrap: wrap;
  background: var(--paper); border: 1px solid var(--rule);
  border-radius: 9px; padding: 6px 10px; box-shadow: var(--shadow);
  font-family: 'Iowan Old Style', Georgia, serif; font-size: 13px;
}
.crumb {
  font-family: inherit; font-size: 13px; background: transparent; border: none;
  color: var(--ink-soft); cursor: pointer; padding: 2px 6px; border-radius: 5px;
}
.crumb:hover { background: var(--paper-2); color: var(--ink); }
.crumb-here { color: var(--ink); font-weight: 600; cursor: default; }
.crumb-sep { color: var(--ink-faint); }
.crumb-hint {
  margin-left: 10px; padding-left: 10px; border-left: 1px solid var(--rule);
  font-size: 11px; font-style: italic; color: var(--ink-faint);
}

/* ---------- matrix: band (grouping container) ---------- */
.band {
  --band-c: var(--card-accent, var(--ink-faint));
  display: inline-flex; flex-direction: column; gap: 14px;
  padding: 13px 14px 15px;
  border: 1.5px solid color-mix(in srgb, var(--band-c) 50%, var(--rule));
  background:
    linear-gradient(color-mix(in srgb, var(--band-c) 7%, #fffdf7),
                    color-mix(in srgb, var(--band-c) 11%, #fffdf7));
  border-radius: 14px;
  box-shadow: 0 1px 2px rgba(26, 22, 18, 0.04), 0 18px 40px -22px rgba(26, 22, 18, 0.45);
}
/* bands get horizontal breathing room from siblings (e.g. the client GMs) so
   the dotted lines spanning the gap are legible — scoped to bands, not all charts */
.band { margin: 0 64px; }
.band-body { display: flex; align-items: flex-start; gap: 20px; }
.band-stack .band-body { flex-direction: column; align-items: stretch; gap: 14px; }
/* the band's header card reads as a title bar, not a floating card */
.card-band-head {
  width: auto; min-width: 190px; max-width: 320px; align-self: stretch;
  box-shadow: none; background: transparent; border: none;
  border-bottom: 1px dashed color-mix(in srgb, var(--band-c) 45%, var(--rule));
  border-radius: 0; padding: 2px 4px 9px 10px;
}
.card-band-head:hover { transform: none; box-shadow: none; }
.card-band-head .card-rail { border-radius: 3px; }
.card-band-head .name { font-size: 15px; }

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
.insp-check { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; }
.insp-check input { width: 15px; height: 15px; accent-color: var(--ink); cursor: pointer; }
.insp-hint { margin-top: 6px; font-size: 11px; font-style: italic; color: var(--ink-faint); line-height: 1.4; }
.insp-seg { display: flex; gap: 0; margin-top: 10px; border: 1px solid var(--rule); border-radius: 6px; overflow: hidden; width: fit-content; }
.seg-btn { font-family: inherit; font-size: 12px; padding: 5px 12px; border: none; background: transparent; color: var(--ink-soft); cursor: pointer; }
.seg-btn + .seg-btn { border-left: 1px solid var(--rule); }
.seg-btn:hover { background: var(--paper-2); }
.seg-on { background: var(--ink); color: var(--paper); }
.seg-on:hover { background: var(--ink); }
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
.insp-secondary { font-size: 11.5px; color: var(--ink-soft); margin-top: 8px; }
.link-search { margin-top: 10px; }
.link-search-input {
  width: 100%; box-sizing: border-box; font-family: inherit; font-size: 12.5px;
  padding: 7px 9px; border: 1px solid var(--rule); border-radius: 6px;
  background: #fffdf7; outline: none; color: var(--ink);
}
.link-search-input:focus { border-color: var(--ink); }
.link-search-input::placeholder { color: var(--ink-faint); font-style: italic; }
.link-results {
  margin-top: 4px; border: 1px solid var(--rule); border-radius: 6px;
  background: var(--paper); box-shadow: var(--shadow-lift); max-height: 230px; overflow: auto;
}
.link-result {
  display: flex; flex-direction: column; align-items: flex-start; gap: 1px;
  width: 100%; text-align: left; padding: 7px 10px; border: none;
  border-bottom: 1px solid var(--rule-soft); background: transparent; cursor: pointer; font-family: inherit;
}
.link-result:last-child { border-bottom: none; }
.link-result:hover { background: var(--paper-2); }
.lr-name { font-size: 13px; font-weight: 600; color: var(--ink); font-family: 'Iowan Old Style', Georgia, serif; }
.lr-meta { font-size: 10.5px; color: var(--ink-faint); font-style: italic; }
.link-result-empty { padding: 8px 10px; font-size: 11.5px; font-style: italic; color: var(--ink-faint); }
`;

