import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { ArrowLeft, Plus, X, RotateCcw, Square, UserPlus, Minus, Maximize2, Link2, Trash2, Edit2, Crown, LayoutGrid, Palette, Users } from "lucide-react";
import { supabase } from "../lib/supabase.js";
import { sharedStyles } from "./styles.js";
import { PeoplePicker, place, buildSource, initials, mxStyles } from "./MatrixBoard.jsx";

// ---------------------------------------------------------------------------------------------
// Canvas board — a blank canvas with boxes and people cards you move around freely.
//   { id:"root", kind:"canvas", v:1, sourceChartId, headRef,
//     items:[ { id, type:"frame", x, y, w, h, label, tint }           // a box; whatever sits inside moves with it
//             { id, type:"card",  x, y, ref, name, title, cat, note } ],// a person; ref → functional chart, or own name
//     links:[ { id, from, to, style:"dotted"|"solid" } ],
//     legend:{ <cat>: { label, color } } }
// Colour comes from the card's category: head / L1 / L2 / L3 are depth under the org head
// (auto, from the functional chart), "outside" = in the company but not under the head,
// "hire" = to be hired. Any card can be overridden.
// ---------------------------------------------------------------------------------------------

// Matrix scaffold (optional, on the same canvas): frames carry a `role` —
//   group  : a band across the top that a set of verticals belong to (Stays, Interfaces…)   { color }
//   col    : a vertical (Payments & finance…)                                                 { group }
//   row    : a function down the side (Product, Engineering) — its head card sits inside it
//   cell   : the intersection                                                                 { col, row }
// Cells hold cards; a card with lead:true is the lead of that cell. Dotted lines from each row
// head and column head into every cell are drawn automatically; `layoutMatrix` snaps the whole
// structure into place and runs after anything is added to a cell. Everything stays draggable.
const rid = () => Math.random().toString(36).slice(2, 10);
const clone = (x) => JSON.parse(JSON.stringify(x));
const GROUP_COLORS = ["#3b6ea5", "#6d5aa8", "#5b7a3f", "#b07d2a", "#b8442a", "#2f7f86"];
const ROWHEAD_W = 224, COL_W = 232, MGAP = 22, GROUP_H = 46, COLHEAD_H = 58, CPAD = 12, CGAP = 8, ROWLABEL_H = 34;
const cellH = (n) => Math.max(76, CPAD * 2 + n * CARD_H + Math.max(0, n - 1) * CGAP);
const rowHeadH = (n) => ROWLABEL_H + Math.max(1, n) * CARD_H + Math.max(0, n - 1) * CGAP + CPAD; // label on top, head card(s) under it
// Snap the matrix scaffold into a clean grid: verticals across (grouped), functions down, cells at
// the intersections sized to what they hold. Cards inside a cell stack top-down, lead first.
const layoutMatrix = (items) => {
  const groups = items.filter((i) => i.role === "group"), rows = items.filter((i) => i.role === "row");
  const cols = items.filter((i) => i.role === "col").sort((a, b) => groups.findIndex((g) => g.id === a.group) - groups.findIndex((g) => g.id === b.group));
  if (!cols.length && !rows.length) return items;
  const cells = items.filter((i) => i.role === "cell");
  const cellsOf = (r, c) => cells.filter((x) => x.row === r.id && x.col === c.id);
  const cardsIn = (cell) => { const fr = rectOf(cell); return items.filter((i) => i.type === "card" && inside(rectOf(i), fr)).sort((a, b) => (b.lead ? 1 : 0) - (a.lead ? 1 : 0) || a.y - b.y || a.x - b.x); };
  const colX = new Map(); cols.forEach((c, i) => colX.set(c.id, ROWHEAD_W + MGAP + i * (COL_W + MGAP)));
  const top = groups.length ? GROUP_H + 10 : 0;
  groups.forEach((g) => { const gc = cols.filter((c) => c.group === g.id); if (!gc.length) { g.w = COL_W; g.h = GROUP_H; return; } g.x = colX.get(gc[0].id); g.y = 0; g.w = colX.get(gc[gc.length - 1].id) + COL_W - g.x; g.h = GROUP_H; });
  cols.forEach((c) => { c.x = colX.get(c.id); c.y = top; c.w = COL_W; c.h = COLHEAD_H; });
  let y = top + COLHEAD_H + MGAP;
  rows.forEach((r) => {
    const headCards = (() => { const fr = rectOf(r); return items.filter((i) => i.type === "card" && inside(rectOf(i), fr)); })();
    const rowCells = cols.map((c) => { let cell = cellsOf(r, c)[0]; return { c, cell, cards: cell ? cardsIn(cell) : [] }; });
    const h = Math.max(rowHeadH(headCards.length), ...rowCells.map((x) => cellH(x.cards.length)));
    r.x = 0; r.y = y; r.w = ROWHEAD_W; r.h = h;
    headCards.forEach((k, i) => { k.x = r.x + (ROWHEAD_W - CARD_W) / 2; k.y = r.y + ROWLABEL_H + i * (CARD_H + CGAP); });
    rowCells.forEach(({ c, cell, cards }) => { if (!cell) return; cell.x = colX.get(c.id); cell.y = y; cell.w = COL_W; cell.h = h; cards.forEach((k, i) => { k.x = cell.x + (COL_W - CARD_W) / 2; k.y = cell.y + CPAD + i * (CARD_H + CGAP); }); });
    y += h + MGAP;
  });
  return items;
};
const ensureCells = (items) => { const rows = items.filter((i) => i.role === "row"), cols = items.filter((i) => i.role === "col"); rows.forEach((r) => cols.forEach((c) => { if (!items.some((x) => x.role === "cell" && x.row === r.id && x.col === c.id)) items.push({ id: rid(), type: "frame", role: "cell", row: r.id, col: c.id, x: 0, y: 0, w: COL_W, h: 76, label: "" }); })); return items; };
const CARD_W = 184, CARD_H = 56, GRID = 8;
const snap = (v) => Math.round(v / GRID) * GRID;
const V = 1;
const DEFAULT_LEGEND = {
  head: { label: "Org head", color: "#1a1612" },
  L1: { label: "Leads (report to the head)", color: "#b8442a" },
  L2: { label: "Managers / leads", color: "#3b6ea5" },
  L3: { label: "Team members", color: "#6d9a5b" },
  outside: { label: "Outside the org — dotted line", color: "#2f7f86" },
  hire: { label: "To be hired", color: "#b07d2a" },
};
const CAT_ORDER = ["head", "L1", "L2", "L3", "outside", "hire"];
const TINTS = ["#f3efe4", "#eaf0f7", "#f9ece8", "#eef3e8", "#efecf7", "#e6f2f2", "#fbf3e0"];
const bkKey = (id) => `atelier-canvas-backup:${id}`;
const weight = (d) => (d && d.items ? d.items.length + (d.links || []).length : 0);
const readBackup = (id) => { try { const b = JSON.parse(localStorage.getItem(bkKey(id)) || "null"); return b && b.doc && b.doc.v === V ? b : null; } catch { return null; } };
const writeBackup = (id, doc) => { try { if (weight(doc) > 0) localStorage.setItem(bkKey(id), JSON.stringify({ at: Date.now(), doc })); } catch { /* ignore */ } };
const EMPTY_SOURCE = { list: [], byId: new Map(), orgOf: () => new Set(), kidsOf: () => [], name: "", ready: false };
const rectOf = (it) => (it.type === "frame" ? { x: it.x, y: it.y, w: it.w, h: it.h } : { x: it.x, y: it.y, w: CARD_W, h: CARD_H });
const inside = (inner, outer) => { const c = { x: inner.x + inner.w / 2, y: inner.y + inner.h / 2 }; return c.x >= outer.x && c.x <= outer.x + outer.w && c.y >= outer.y && c.y <= outer.y + outer.h; };
const area = (r) => r.w * r.h;

// Build a matrix from a team grid: the grid's top teams become groups, their subteams the
// verticals; a "Product" row takes each vertical's head (lead PM); each team down the side of the
// grid becomes a function row with its head, and its people land in the cells.
export const canvasFromMatrix = (m) => {
  const items = [];
  const groups = (m.top || []).map((t, i) => ({ id: rid(), type: "frame", role: "group", label: t.label || "", color: GROUP_COLORS[i % GROUP_COLORS.length], x: 0, y: 0, w: COL_W, h: GROUP_H, src: t }));
  const cols = [];
  groups.forEach((g) => { const t = g.src; const subs = t.subs && t.subs.length ? t.subs : [{ id: t.id, label: t.label, headRef: t.headRef, headName: t.headName }]; subs.forEach((sub) => cols.push({ id: rid(), type: "frame", role: "col", group: g.id, label: sub.label || "", x: 0, y: 0, w: COL_W, h: COLHEAD_H, src: sub, laneId: sub.id })); delete g.src; });
  const rows = [];
  const firstHead = (m.top || []).find((t) => t.headRef)?.headRef || null;
  const productRow = { id: rid(), type: "frame", role: "row", label: "Product", x: 0, y: 0, w: ROWHEAD_W, h: rowHeadH(1) };
  rows.push(productRow);
  if (firstHead) items.push({ id: rid(), type: "card", x: 0, y: 0, ref: firstHead, name: "", title: "", cat: "auto", lead: true, _in: productRow.id });
  (m.left || []).forEach((t) => {
    const r = { id: rid(), type: "frame", role: "row", label: t.label || "", x: 0, y: 0, w: ROWHEAD_W, h: rowHeadH(1), lanes: (t.subs && t.subs.length ? t.subs.map((x) => x.id) : [t.id]) };
    rows.push(r);
    if (t.headRef || t.headName) items.push({ id: rid(), type: "card", x: 0, y: 0, ref: t.headRef || null, name: t.headRef ? "" : t.headName, title: "", cat: t.headRef ? "auto" : "hire", lead: true, _in: r.id });
  });
  const cells = [];
  rows.forEach((r) => cols.forEach((c) => {
    const cell = { id: rid(), type: "frame", role: "cell", row: r.id, col: c.id, x: 0, y: 0, w: COL_W, h: 76, label: "" }; cells.push(cell);
    if (r === productRow) { const sub = c.src; if (sub.headRef || sub.headName) items.push({ id: rid(), type: "card", x: 0, y: 0, ref: sub.headRef || null, name: sub.headRef ? "" : sub.headName, title: "", cat: sub.headRef ? "auto" : "hire", lead: true, _in: cell.id }); return; }
    const seen = new Set();
    Object.entries(m.cells || {}).forEach(([k, chips]) => { const [l, t] = k.split("|"); if (t !== c.laneId || !r.lanes.includes(l)) return; chips.forEach((ch) => { const key = ch.ref || ch.id; if (seen.has(key)) return; seen.add(key); items.push({ id: rid(), type: "card", x: 0, y: 0, ref: ch.ref || null, name: ch.ref ? "" : (ch.name || ""), title: ch.role || "", cat: ch.ref ? "auto" : "hire", _in: cell.id }); }); });
  }));
  cols.forEach((c) => { delete c.src; delete c.laneId; }); rows.forEach((r) => { delete r.lanes; });
  const all = [...groups, ...cols, ...rows, ...cells, ...items];
  // place each card inside its frame before the layout pass decides the real positions
  all.forEach((i) => { if (i._in) { const f = all.find((x) => x.id === i._in); i.x = f.x + 1; i.y = f.y + 1; } });
  // frames need distinct positions for "inside" to resolve: give every frame its own slot first
  let k = 0; all.forEach((f) => { if (f.type === "frame") { f.x = (k % 8) * 300; f.y = Math.floor(k / 8) * 300; k++; } });
  all.forEach((i) => { if (i._in) { const f = all.find((x) => x.id === i._in); i.x = f.x + 8; i.y = f.y + 8; delete i._in; } });
  return { items: layoutMatrix(all), links: [] };
};

export default function CanvasBoard({ chartId, chartName, onBack, onRenamed }) {
  const [doc, setDocState] = useState(null);
  const [name, setName] = useState(chartName || "");
  const [editingName, setEditingName] = useState(false);
  const [history, setHistory] = useState([]);
  const [saveStatus, setSaveStatus] = useState("synced");
  const [loadError, setLoadError] = useState(null);
  const [tooNew, setTooNew] = useState(false);
  const [rescue, setRescue] = useState(null);
  const [source, setSource] = useState(EMPTY_SOURCE);
  const [view, setView] = useState({ x: 80, y: 40, z: 1 });
  const [sel, setSel] = useState(() => new Set());
  const [selLink, setSelLink] = useState(null);
  const [picker, setPicker] = useState(null);     // { mode:"add"|"head"|"linkTo", rect, from? }
  const [menu, setMenu] = useState(null);         // { id, rect }
  const [editingLabel, setEditingLabel] = useState(null);
  const [linkFrom, setLinkFrom] = useState(null);  // connect mode: waiting for the target card
  const [marquee, setMarquee] = useState(null);
  const [showLegend, setShowLegend] = useState(true);
  const [spaceDown, setSpaceDown] = useState(false);
  const docRef = useRef(null); const viewRef = useRef(view); viewRef.current = view;
  const selRef = useRef(sel); selRef.current = sel;
  const linkFromRef = useRef(null); linkFromRef.current = linkFrom;
  const saveTimer = useRef(null); const lastSavedAt = useRef(0); const lastRemoteAt = useRef(0); const dirty = useRef(false);
  const cvRef = useRef(null);
  const dragRef = useRef(null);

  // ---- persistence (same safeguards as the matrix board) ----------------------------------
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
  const apply = (fn) => { const prev = docRef.current; if (!prev) return; const next = fn(clone(prev)) || prev; setHistory((h) => [...h.slice(-59), prev]); setDoc(next); };
  const undo = () => setHistory((h) => { if (!h.length) return h; setDoc(h[h.length - 1]); return h.slice(0, -1); });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.from("charts").select("id, name, tree, updated_at").eq("id", chartId).single();
      if (cancelled) return;
      if (error) { setLoadError(error.message); return; }
      setName(data.name); lastRemoteAt.current = new Date(data.updated_at).getTime();
      const t = data.tree || {};
      if (t.v > V) { setTooNew(true); return; }
      const d = { ...t, items: t.items || [], links: t.links || [], legend: { ...DEFAULT_LEGEND, ...(t.legend || {}) } };
      const bk = readBackup(chartId);
      if (bk && weight(bk.doc) > weight(d)) { setRescue(bk); setDoc(d, { save: false }); return; }
      setDoc(d, { save: false });
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartId]);

  useEffect(() => {
    const ch = supabase.channel(`canvas-${chartId}`).on("postgres_changes", { event: "UPDATE", schema: "public", table: "charts", filter: `id=eq.${chartId}` }, (payload) => {
      const ts = new Date(payload.new.updated_at).getTime();
      if (Math.abs(ts - lastSavedAt.current) < 3000 || ts <= lastRemoteAt.current) return;
      if (dirty.current || saveTimer.current) return;
      lastRemoteAt.current = ts;
      const incoming = payload.new.tree;
      if (incoming && incoming.v > V) { setTooNew(true); return; }
      if (!incoming || incoming.kind !== "canvas") { if (docRef.current && weight(docRef.current) > 0) scheduleSave(docRef.current, undefined); return; }
      setDoc({ ...incoming, legend: { ...DEFAULT_LEGEND, ...(incoming.legend || {}) } }, { save: false }); setName(payload.new.name);
    }).subscribe();
    return () => { supabase.removeChannel(ch); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartId]);

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

  // ---- derived -----------------------------------------------------------------------------
  const person = (ref) => (ref ? source.byId.get(ref) : null) || null;
  const depth = useMemo(() => { // depth of everyone under the org head
    const m = new Map(); const head = doc?.headRef; if (!head || !source.ready) return m;
    const go = (id, d) => { m.set(id, d); source.kidsOf(id).forEach((k) => go(k, d + 1)); }; go(head, 0); return m;
  }, [doc?.headRef, source]);
  const catOf = (c) => {
    if (c.cat && c.cat !== "auto") return c.cat;
    if (!c.ref) return "hire";
    if (!doc.headRef || !source.ready) return "L3";
    if (!depth.has(c.ref)) return "outside";
    const d = depth.get(c.ref); return d === 0 ? "head" : d === 1 ? "L1" : d === 2 ? "L2" : "L3";
  };
  const legend = doc?.legend || DEFAULT_LEGEND;
  const colorOf = (c) => (legend[catOf(c)] || DEFAULT_LEGEND.L3).color;
  const items = doc?.items || [];
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const frames = items.filter((i) => i.type === "frame");
  // what moves with a frame: everything whose centre sits inside it
  const contentsOf = (frameId, all) => { const f = all.find((i) => i.id === frameId); if (!f) return []; const fr = rectOf(f); return all.filter((i) => i.id !== frameId && inside(rectOf(i), fr) && (i.type === "card" || area(rectOf(i)) < area(fr))).map((i) => i.id); };

  // ---- view (pan / zoom) ---------------------------------------------------------------------
  const toWorld = (sx, sy) => { const r = cvRef.current.getBoundingClientRect(); const v = viewRef.current; return { x: (sx - r.left - v.x) / v.z, y: (sy - r.top - v.y) / v.z }; };
  const zoomAt = (sx, sy, factor) => setView((v) => { const z = Math.min(2.5, Math.max(0.2, v.z * factor)); const r = cvRef.current.getBoundingClientRect(); const px = sx - r.left, py = sy - r.top; const wx = (px - v.x) / v.z, wy = (py - v.y) / v.z; return { z, x: px - wx * z, y: py - wy * z }; });
  const zoomBy = (f) => { const r = cvRef.current.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, f); };
  const fit = () => { const its = docRef.current?.items || []; if (!its.length || !cvRef.current) return; const rs = its.map(rectOf); const x0 = Math.min(...rs.map((r) => r.x)) - 40, y0 = Math.min(...rs.map((r) => r.y)) - 40, x1 = Math.max(...rs.map((r) => r.x + r.w)) + 40, y1 = Math.max(...rs.map((r) => r.y + r.h)) + 40; const r = cvRef.current.getBoundingClientRect(); const z = Math.min(1.25, r.width / (x1 - x0), r.height / (y1 - y0)); setView({ z, x: (r.width - (x1 - x0) * z) / 2 - x0 * z, y: (r.height - (y1 - y0) * z) / 2 - y0 * z }); };
  const canvasReady = !!doc && !tooNew;
  useEffect(() => {
    const cv = cvRef.current; if (!cv) return;
    const onWheel = (e) => { e.preventDefault(); if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01)); else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY })); };
    cv.addEventListener("wheel", onWheel, { passive: false });
    return () => cv.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasReady]);
  useEffect(() => { if (canvasReady && (docRef.current?.items || []).length) setTimeout(fit, 50); }, [canvasReady]); // eslint-disable-line

  // ---- keyboard -----------------------------------------------------------------------------
  useEffect(() => {
    const typing = (e) => { const t = e.target; return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable); };
    const down = (e) => {
      if (e.key === "Escape") { setPicker(null); setMenu(null); setLinkFrom(null); setSel(new Set()); setSelLink(null); }
      if (typing(e)) return;
      if (e.code === "Space") { setSpaceDown(true); e.preventDefault(); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); }
      if ((e.metaKey || e.ctrlKey) && e.key === "0") { e.preventDefault(); fit(); }
      if ((e.metaKey || e.ctrlKey) && (e.key === "=" || e.key === "+")) { e.preventDefault(); zoomBy(1.15); }
      if ((e.metaKey || e.ctrlKey) && e.key === "-") { e.preventDefault(); zoomBy(1 / 1.15); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") { e.preventDefault(); setSel(new Set((docRef.current?.items || []).map((i) => i.id))); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d" && selRef.current.size) { e.preventDefault(); duplicateSel(); }
      if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); removeSel(); }
      const step = e.shiftKey ? GRID * 5 : GRID; const nudge = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (nudge && selRef.current.size) { e.preventDefault(); moveIds([...selRef.current], nudge[0], nudge[1], true); }
    };
    const up = (e) => { if (e.code === "Space") setSpaceDown(false); };
    window.addEventListener("keydown", down); window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- actions -------------------------------------------------------------------------------
  const withContents = (ids) => { const all = docRef.current.items; const out = new Set(ids); ids.forEach((id) => { const it = all.find((i) => i.id === id); if (it?.type === "frame") contentsOf(id, all).forEach((c) => out.add(c)); }); return [...out]; };
  const moveIds = (ids, dx, dy, commit) => { const full = withContents(ids); apply((d) => { d.items.forEach((i) => { if (full.includes(i.id)) { i.x = commit ? snap(i.x + dx) : i.x + dx; i.y = commit ? snap(i.y + dy) : i.y + dy; } }); return d; }); };
  const centreOfView = () => { const r = cvRef.current.getBoundingClientRect(); return toWorld(r.left + r.width / 2 - CARD_W / 2, r.top + r.height / 2 - CARD_H / 2); };
  const freeSpot = (p) => { const taken = (x, y) => (docRef.current.items || []).some((i) => i.type === "card" && Math.abs(i.x - x) < 24 && Math.abs(i.y - y) < 24); let { x, y } = p; x = snap(x); y = snap(y); while (taken(x, y)) { x += 24; y += 24; } return { x, y }; };
  const addCard = (pick, at, extra = {}) => { const id = rid(); const p = freeSpot(at || centreOfView()); apply((d) => { d.items.push({ id, type: "card", x: p.x, y: p.y, ref: pick.ref || null, name: pick.ref ? "" : (pick.name || ""), title: "", cat: pick.ref ? "auto" : "hire", ...extra }); return d; }); setSel(new Set([id])); return id; };
  const addFrame = () => { const id = rid(); const p = centreOfView(); apply((d) => { d.items.unshift({ id, type: "frame", x: snap(p.x - 60), y: snap(p.y - 60), w: 320, h: 240, label: "", tint: TINTS[d.items.filter((i) => i.type === "frame").length % TINTS.length] }); return d; }); setSel(new Set([id])); setEditingLabel(id); };
  const addHire = () => { const id = addCard({ ref: null, name: "" }, null, { cat: "hire", title: "" }); setTimeout(() => { const el = document.querySelector(`[data-id="${id}"]`); if (el) { const r = el.getBoundingClientRect(); setMenu({ id, rect: { left: r.left, top: r.top, bottom: r.bottom } }); } }, 30); };
  const removeSel = () => { const ids = selRef.current; if (!ids.size) { if (selLink) { apply((d) => { d.links = d.links.filter((l) => l.id !== selLink); return d; }); setSelLink(null); } return; } apply((d) => { const touched = d.items.some((i) => ids.has(i.id) && (i.role || i.type === "card")); d.items.filter((i) => ids.has(i.id) && i.role).forEach((f) => { if (f.role === "group") d.items.filter((i) => i.role === "col" && i.group === f.id).forEach((c) => ids.add(c.id)); }); d.items.filter((i) => i.role === "cell" && (ids.has(i.col) || ids.has(i.row))).forEach((c) => ids.add(c.id)); d.items = d.items.filter((i) => !ids.has(i.id)); d.links = d.links.filter((l) => !ids.has(l.from) && !ids.has(l.to)); if (touched && d.items.some((i) => i.role)) d.items = layoutMatrix(d.items); return d; }); setSel(new Set()); setMenu(null); };
  const duplicateSel = () => { const ids = withContents([...selRef.current]); const map = new Map(); apply((d) => { const copies = d.items.filter((i) => ids.includes(i.id)).map((i) => { const c = { ...i, id: rid(), x: i.x + 40, y: i.y + 40 }; map.set(i.id, c.id); return c; }); d.items.push(...copies); return d; }); setSel(new Set(map.values())); };
  const update = (id, patch) => apply((d) => { const it = d.items.find((i) => i.id === id); if (it) Object.assign(it, patch); return d; });
  const addLink = (from, to, style = "dotted") => { if (from === to) return; apply((d) => { if (d.links.some((l) => (l.from === from && l.to === to) || (l.from === to && l.to === from))) return d; d.links.push({ id: rid(), from, to, style }); return d; }); };
  const tidy = (frameId) => apply((d) => { // lay the frame's cards out in a neat grid, grow the frame to fit
    const f = d.items.find((i) => i.id === frameId); if (!f) return d;
    const cards = contentsOf(frameId, d.items).map((id) => d.items.find((i) => i.id === id)).filter((i) => i.type === "card").sort((a, b) => a.y - b.y || a.x - b.x);
    const cols = Math.max(1, Math.floor((f.w - 32) / (CARD_W + 12)));
    cards.forEach((c, i) => { c.x = f.x + 16 + (i % cols) * (CARD_W + 12); c.y = f.y + 44 + Math.floor(i / cols) * (CARD_H + 10); });
    const rows = Math.ceil(cards.length / cols); f.h = Math.max(f.h, 44 + rows * (CARD_H + 10) + 8); return d; });
  const hasMatrix = items.some((i) => i.role);
  const relayout = () => apply((d) => { d.items = layoutMatrix(ensureCells(d.items)); return d; });
  const startMatrix = () => apply((d) => {
    const g = { id: rid(), type: "frame", role: "group", label: "Connect", color: GROUP_COLORS[0], x: 0, y: 0, w: COL_W, h: GROUP_H };
    const c = { id: rid(), type: "frame", role: "col", group: g.id, label: "First vertical", x: 0, y: 0, w: COL_W, h: COLHEAD_H };
    const r = { id: rid(), type: "frame", role: "row", label: "Product", x: 0, y: 0, w: ROWHEAD_W, h: rowHeadH(1) };
    d.items.push(g, c, r); d.items = layoutMatrix(ensureCells(d.items)); return d; });
  const addGroup = () => { const id = rid(); apply((d) => { const n = d.items.filter((i) => i.role === "group").length; d.items.push({ id, type: "frame", role: "group", label: "", color: GROUP_COLORS[n % GROUP_COLORS.length], x: 0, y: 0, w: COL_W, h: GROUP_H }); d.items.push({ id: rid(), type: "frame", role: "col", group: id, label: "", x: 0, y: 0, w: COL_W, h: COLHEAD_H }); d.items = layoutMatrix(ensureCells(d.items)); return d; }); setEditingLabel(id); };
  const addCol = (groupId) => { const id = rid(); apply((d) => { const gid = groupId || (d.items.filter((i) => i.role === "group").slice(-1)[0] || {}).id || null; d.items.push({ id, type: "frame", role: "col", group: gid, label: "", x: 0, y: 0, w: COL_W, h: COLHEAD_H }); d.items = layoutMatrix(ensureCells(d.items)); return d; }); setEditingLabel(id); };
  const addRow = () => { const id = rid(); apply((d) => { d.items.push({ id, type: "frame", role: "row", label: "", x: 0, y: 0, w: ROWHEAD_W, h: rowHeadH(1) }); d.items = layoutMatrix(ensureCells(d.items)); return d; }); setEditingLabel(id); };
  const removeFrame = (f) => apply((d) => { // a scaffold piece takes its cells (not their people) with it
    const gone = new Set([f.id]);
    if (f.role === "group") d.items.filter((i) => i.role === "col" && i.group === f.id).forEach((c) => gone.add(c.id));
    d.items.filter((i) => i.role === "cell" && ([...gone].includes(i.col) || i.row === f.id)).forEach((c) => gone.add(c.id));
    d.items = d.items.filter((i) => !gone.has(i.id)); if (f.role) d.items = layoutMatrix(d.items); return d; });
  const addToFrame = (frameId, pick, lead) => { const id = rid(); apply((d) => { const f = d.items.find((i) => i.id === frameId); if (!f) return d; const n = d.items.filter((i) => i.type === "card" && inside(rectOf(i), rectOf(f))).length; d.items.push({ id, type: "card", x: f.x + CPAD, y: f.y + CPAD + n * (CARD_H + CGAP), ref: pick.ref || null, name: pick.ref ? "" : (pick.name || ""), title: "", cat: pick.ref ? "auto" : "hire", lead: !!lead || (f.role === "cell" && n === 0) }); if (f.role) d.items = layoutMatrix(d.items); return d; }); return id; };
  const setLegend = (cat, patch) => apply((d) => { d.legend = { ...DEFAULT_LEGEND, ...(d.legend || {}) }; d.legend[cat] = { ...d.legend[cat], ...patch }; return d; });

  const onPick = (pick) => {
    const p = picker; if (!p) return;
    if (p.mode === "add") { addCard(pick, p.at); return; } // stays open
    if (p.mode === "cell") { addToFrame(p.frameId, pick); return; } // stays open
    if (p.mode === "head") { apply((d) => { d.headRef = pick.ref || null; return d; }); }
    if (p.mode === "linkTo") { const src = byId.get(p.from); const existing = pick.ref && items.find((i) => i.type === "card" && i.ref === pick.ref); const to = existing ? existing.id : addCard(pick, src ? { x: src.x + CARD_W + 80, y: src.y } : null); setTimeout(() => addLink(p.from, to), 0); }
    setPicker(null);
  };

  // ---- pointer handling on the canvas ----------------------------------------------------------
  const onItemDown = (e, it) => {
    if (e.button !== 0) return;
    e.stopPropagation(); setMenu(null);
    if (linkFromRef.current && it.type === "card") { if (linkFromRef.current !== it.id) addLink(linkFromRef.current, it.id); setLinkFrom(null); return; }
    let next = new Set(selRef.current);
    if (e.shiftKey) { next.has(it.id) ? next.delete(it.id) : next.add(it.id); }
    else if (!next.has(it.id)) next = new Set([it.id]);
    setSel(next); setSelLink(null);
    const ids = withContents([...next]); const start = toWorld(e.clientX, e.clientY);
    const orig = new Map(ids.map((id) => { const o = byId.get(id); return [id, { x: o.x, y: o.y }]; }));
    dragRef.current = { kind: "move", ids, start, orig, moved: false, clickId: it.id };
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* synthetic events have no active pointer */ }
  };
  const onResizeDown = (e, it) => { e.stopPropagation(); if (e.button !== 0) return; const start = toWorld(e.clientX, e.clientY); dragRef.current = { kind: "resize", id: it.id, start, w: it.w, h: it.h }; setSel(new Set([it.id])); };
  const onCanvasDown = (e) => {
    if (e.button === 1 || spaceDown || e.button === 0 && e.altKey) { dragRef.current = { kind: "pan", sx: e.clientX, sy: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y }; return; }
    if (e.button !== 0) return;
    setMenu(null); setLinkFrom(null); setSelLink(null); if (!e.shiftKey) setSel(new Set());
    const start = toWorld(e.clientX, e.clientY); dragRef.current = { kind: "marquee", start, add: e.shiftKey ? new Set(selRef.current) : new Set() }; setMarquee({ x: start.x, y: start.y, w: 0, h: 0 });
  };
  const onMove = (e) => {
    const d = dragRef.current; if (!d) return;
    if (d.kind === "pan") { setView((v) => ({ ...v, x: d.vx + e.clientX - d.sx, y: d.vy + e.clientY - d.sy })); return; }
    const p = toWorld(e.clientX, e.clientY);
    if (d.kind === "move") { const dx = p.x - d.start.x, dy = p.y - d.start.y; if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true; if (!d.moved) return;
      setDocState((cur) => { const n = { ...cur, items: cur.items.map((i) => (d.orig.has(i.id) ? { ...i, x: d.orig.get(i.id).x + dx, y: d.orig.get(i.id).y + dy } : i)) }; docRef.current = n; return n; }); return; }
    if (d.kind === "resize") { setDocState((cur) => { const n = { ...cur, items: cur.items.map((i) => (i.id === d.id ? { ...i, w: Math.max(160, d.w + p.x - d.start.x), h: Math.max(80, d.h + p.y - d.start.y) } : i)) }; docRef.current = n; return n; }); return; }
    if (d.kind === "marquee") { const r = { x: Math.min(d.start.x, p.x), y: Math.min(d.start.y, p.y), w: Math.abs(p.x - d.start.x), h: Math.abs(p.y - d.start.y) }; setMarquee(r);
      const hit = (docRef.current.items || []).filter((i) => { const ir = rectOf(i); return ir.x >= r.x && ir.y >= r.y && ir.x + ir.w <= r.x + r.w && ir.y + ir.h <= r.y + r.h; }).map((i) => i.id); setSel(new Set([...d.add, ...hit])); }
  };
  const onUp = (e) => {
    const d = dragRef.current; dragRef.current = null; setMarquee(null);
    if (!d) return;
    if (d.kind === "move") {
      if (!d.moved) { // a plain click on a card opens its menu
        const it = byId.get(d.clickId); if (it && it.type === "card" && !e.shiftKey) { const el = document.querySelector(`[data-id="${it.id}"]`); const r = el.getBoundingClientRect(); setMenu({ id: it.id, rect: { left: r.left, top: r.top, bottom: r.bottom } }); }
        return; }
      const before = { ...docRef.current, items: docRef.current.items.map((i) => (d.orig.has(i.id) ? { ...i, ...d.orig.get(i.id) } : i)) };
      setHistory((h) => [...h.slice(-59), before]);
      setDoc({ ...docRef.current, items: docRef.current.items.map((i) => (d.orig.has(i.id) ? { ...i, x: snap(i.x), y: snap(i.y) } : i)) });
    }
    if (d.kind === "resize") { const before = { ...docRef.current, items: docRef.current.items.map((i) => (i.id === d.id ? { ...i, w: d.w, h: d.h } : i)) }; setHistory((h) => [...h.slice(-59), before]); setDoc({ ...docRef.current, items: docRef.current.items.map((i) => (i.id === d.id ? { ...i, w: snap(i.w), h: snap(i.h) } : i)) }); }
  };

  // ---- render --------------------------------------------------------------------------------
  const saveName = (v) => { const nv = v.trim() || "Untitled canvas"; setName(nv); scheduleSave(undefined, nv); setEditingName(false); onRenamed && onRenamed(); };
  const openPicker = (e, p) => { const r = e.currentTarget.getBoundingClientRect(); setMenu(null); setPicker({ ...p, rect: { left: r.left, top: r.top, bottom: r.bottom } }); };

  if (loadError) return (<div className="org-root"><style>{sharedStyles}</style><button className="tb" onClick={onBack}>← Back</button><p style={{ marginTop: 24 }}>Couldn't load this canvas: {loadError}</p></div>);
  if (tooNew) return (<div className="org-root"><style>{sharedStyles}</style><button className="tb" onClick={onBack}>← Back</button><p style={{ marginTop: 24, maxWidth: 560, lineHeight: 1.6 }}>This canvas was saved by a newer version of the app. <strong>Reload the page</strong> to get the latest version.</p><button className="tb tb-primary" onClick={() => window.location.reload()}>Reload</button></div>);
  if (!doc) return <div style={{ padding: 60, fontFamily: "Iowan Old Style, Georgia, serif", color: "#8a7d6c" }}>Loading…</div>;

  const linkGeom = (l) => { const a = byId.get(l.from), b = byId.get(l.to); if (!a || !b) return null; const ra = rectOf(a), rb = rectOf(b); const ca = { x: ra.x + ra.w / 2, y: ra.y + ra.h / 2 }, cb = { x: rb.x + rb.w / 2, y: rb.y + rb.h / 2 };
    const clip = (r, c, o) => { const dx = o.x - c.x, dy = o.y - c.y; if (!dx && !dy) return c; const sx = (r.w / 2) / Math.abs(dx || 1e-9), sy = (r.h / 2) / Math.abs(dy || 1e-9); const s = Math.min(sx, sy); return { x: c.x + dx * s, y: c.y + dy * s }; };
    return { a: clip(ra, ca, cb), b: clip(rb, cb, ca) }; };
  const headP = person(doc.headRef);
  const menuItem = menu && byId.get(menu.id);
  const selFrame = sel.size === 1 && byId.get([...sel][0])?.type === "frame" ? byId.get([...sel][0]) : null;

  return (
    <div className="org-root cv-root">
      <style>{sharedStyles}</style><style>{mxStyles}</style><style>{cvStyles}</style>
      <header className="mx-top cv-top">
        <button className="mx-back" onClick={onBack} title="Back to all charts"><ArrowLeft size={16} strokeWidth={1.8} /></button>
        <div className="mx-titleblock">
          <div className="mx-eyebrow">Matrix canvas</div>
          {editingName ? <input autoFocus className="mx-title-input" defaultValue={name} onBlur={(e) => saveName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") saveName(e.target.value); if (e.key === "Escape") setEditingName(false); }} />
            : <h1 className="mx-title" onClick={() => setEditingName(true)} title="Click to rename">{name}<Edit2 size={13} strokeWidth={1.8} className="mx-pen" /></h1>}
        </div>
        <button className="mx-lead" onClick={(e) => openPicker(e, { mode: "head" })} title="Levels are coloured by depth under this person">
          <Crown size={14} strokeWidth={1.7} />
          {headP ? <span><strong>{headP.name}</strong><em>org head · levels counted from here</em></span> : <span><strong>Set the org head</strong><em>to colour people by level</em></span>}
        </button>
        <div className="mx-spacer" />
        <div className="cv-tools">
          <button className="tb" onClick={(e) => openPicker(e, { mode: "add" })} title="Add people from the functional org"><UserPlus size={14} strokeWidth={1.7} /> Person</button>
          <button className="tb" onClick={addHire} title="Add a role to be hired"><Plus size={14} strokeWidth={1.7} /> To hire</button>
          <button className="tb" onClick={addFrame} title="Add a free box"><Square size={14} strokeWidth={1.7} /> Box</button>
          <span className="tb-sep" />
          {hasMatrix ? (<>
            <button className="tb" onClick={addGroup} title="Add a group of verticals across the top (e.g. Stays)"><Plus size={13} strokeWidth={1.8} /> Group</button>
            <button className="tb" onClick={() => addCol(selFrame?.role === "group" ? selFrame.id : selFrame?.role === "col" ? selFrame.group : null)} title="Add a vertical (column) — into the selected group"><Plus size={13} strokeWidth={1.8} /> Vertical</button>
            <button className="tb" onClick={addRow} title="Add a function (row) — Product, Engineering…"><Plus size={13} strokeWidth={1.8} /> Function</button>
            <button className="tb" onClick={relayout} title="Snap the matrix back into a clean grid"><LayoutGrid size={14} strokeWidth={1.7} /> Re-layout</button>
          </>) : <button className="tb" onClick={startMatrix} title="Start a matrix: verticals across, functions down, people where they meet"><LayoutGrid size={14} strokeWidth={1.7} /> Start a matrix</button>}
          <button className={`tb ${linkFrom ? "tb-primary" : ""}`} disabled={!linkFrom && !(sel.size === 1 && byId.get([...sel][0])?.type === "card")} onClick={() => setLinkFrom(linkFrom ? null : [...sel][0])} title="Select a person, then click the person they have a dotted line to"><Link2 size={14} strokeWidth={1.7} /> {linkFrom ? "Click the other person…" : "Dotted line"}</button>
          {selFrame && !selFrame.role && <button className="tb" onClick={() => tidy(selFrame.id)} title="Arrange the people in this box in a neat grid"><LayoutGrid size={14} strokeWidth={1.7} /> Tidy box</button>}
          {sel.size > 0 && <button className="tb tb-danger" onClick={removeSel} title="Remove selected (⌫)"><Trash2 size={14} strokeWidth={1.7} /></button>}
        </div>
        <div className="mx-zoom">
          <button onClick={() => zoomBy(1 / 1.15)} aria-label="Zoom out"><Minus size={14} strokeWidth={1.9} /></button>
          <button className="mx-zoom-pct" onClick={() => setView((v) => ({ ...v, z: 1 }))}>{Math.round(view.z * 100)}%</button>
          <button onClick={() => zoomBy(1.15)} aria-label="Zoom in"><Plus size={14} strokeWidth={1.9} /></button>
          <button className="mx-zoom-fit" onClick={fit} title="Fit everything (⌘0)"><Maximize2 size={13} strokeWidth={1.8} /> Fit</button>
        </div>
        <button className="tb" onClick={undo} disabled={!history.length} title="Undo (⌘Z)"><RotateCcw size={14} strokeWidth={1.5} /></button>
        <button className={`tb ${showLegend ? "" : "tb-off"}`} onClick={() => setShowLegend((s) => !s)} title="Legend"><Palette size={14} strokeWidth={1.6} /></button>
        <div className={`mx-save mx-save-${saveStatus}`}>{saveStatus === "saving" ? "Saving…" : saveStatus === "error" ? "Save error" : "Saved"}</div>
      </header>
      {rescue && (
        <div className="mx-rescue">
          <div><strong>This canvas looks emptier than the last version saved from this browser</strong> ({new Date(rescue.at).toLocaleString()}).</div>
          <button className="tb tb-primary" onClick={() => { setHistory((h) => [...h, docRef.current]); setDoc(rescue.doc); setRescue(null); }}>Restore that version</button>
          <button className="tb" onClick={() => { try { localStorage.removeItem(bkKey(chartId)); } catch { /* ignore */ } setRescue(null); }}>Keep what's here</button>
        </div>
      )}

      <div ref={cvRef} className={`cv-canvas ${spaceDown ? "cv-panning" : ""} ${linkFrom ? "cv-linking" : ""}`} onPointerDown={onCanvasDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp}>
        <div className="cv-layer" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}>
          <svg className="cv-links cv-autolinks" style={{ overflow: "visible" }}>
            {frames.filter((f) => f.role === "cell").map((cell) => { const r = byId.get(cell.row), c = byId.get(cell.col); const g = c && byId.get(c.group); const col = g?.color || "#8a7d6c"; return (
              <g key={cell.id}>
                {r && <line x1={r.x + r.w} y1={cell.y + 30} x2={cell.x} y2={cell.y + 30} stroke="#8a7d6c" strokeWidth="1.5" strokeDasharray="3 4" />}
                {c && <line x1={cell.x + cell.w / 2} y1={c.y + c.h} x2={cell.x + cell.w / 2} y2={cell.y} stroke={col} strokeWidth="1.5" strokeDasharray="3 4" />}
              </g>); })}
          </svg>
          {frames.map((f) => (
            <div key={f.id} data-id={f.id} className={`cv-frame ${f.role ? `cv-${f.role}` : ""} ${sel.has(f.id) ? "cv-sel" : ""}`} style={{ left: f.x, top: f.y, width: f.w, height: f.h, background: f.role === "group" ? f.color : f.role === "col" ? "#fffdf8" : f.role ? undefined : (f.tint || TINTS[0]), "--g": f.role === "col" ? (byId.get(f.group)?.color || "#8a7d6c") : f.color }}
              onPointerDown={(e) => onItemDown(e, f)} onDoubleClick={(e) => { e.stopPropagation(); if (f.role !== "cell") setEditingLabel(f.id); }}>
              {(f.role === "cell" || f.role === "row") && <button className="cv-cell-add" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { const rr = e.currentTarget.getBoundingClientRect(); setMenu(null); setPicker({ mode: "cell", frameId: f.id, rect: { left: rr.left, top: rr.top, bottom: rr.bottom } }); }} title="Add people here"><Plus size={12} strokeWidth={2} /></button>}
              {f.role === "group" && sel.has(f.id) && <div className="cv-tint-row" onPointerDown={(e) => e.stopPropagation()}>{GROUP_COLORS.map((t) => <button key={t} className={`cv-tint ${f.color === t ? "cv-tint-on" : ""}`} style={{ background: t }} onClick={() => update(f.id, { color: t })} />)}</div>}
              {editingLabel === f.id
                ? <input autoFocus className="cv-frame-input" defaultValue={f.label} onPointerDown={(e) => e.stopPropagation()} onBlur={(e) => { update(f.id, { label: e.target.value.trim() }); setEditingLabel(null); }} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setEditingLabel(null); }} placeholder="Name this box" />
                : f.role !== "cell" && <div className={`cv-frame-label ${f.label ? "" : "cv-frame-label-empty"}`}>{f.label || "Double-click to name"}</div>}
              {sel.has(f.id) && !f.role && <>
                <div className="cv-tint-row" onPointerDown={(e) => e.stopPropagation()}>{TINTS.map((t) => <button key={t} className={`cv-tint ${f.tint === t ? "cv-tint-on" : ""}`} style={{ background: t }} onClick={() => update(f.id, { tint: t })} />)}</div>
                <div className="cv-resize" onPointerDown={(e) => onResizeDown(e, f)} />
              </>}
            </div>
          ))}
          <svg className="cv-links" style={{ overflow: "visible" }}>
            {doc.links.map((l) => { const g = linkGeom(l); if (!g) return null; return (
              <g key={l.id} className={`cv-link ${selLink === l.id ? "cv-link-sel" : ""}`} onPointerDown={(e) => { e.stopPropagation(); setSel(new Set()); setSelLink(l.id); setMenu(null); }}>
                <line x1={g.a.x} y1={g.a.y} x2={g.b.x} y2={g.b.y} className="cv-link-hit" />
                <line x1={g.a.x} y1={g.a.y} x2={g.b.x} y2={g.b.y} className="cv-link-line" strokeDasharray={l.style === "solid" ? "0" : "5 5"} />
                <circle cx={g.a.x} cy={g.a.y} r="3.5" className="cv-link-dot" /><circle cx={g.b.x} cy={g.b.y} r="3.5" className="cv-link-dot" />
              </g>); })}
          </svg>
          {items.filter((i) => i.type === "card").map((c) => { const p = person(c.ref); const cat = catOf(c); const col = colorOf(c); const nm = p?.name || c.name || "Open role"; const missing = c.ref && source.ready && !p; return (
            <div key={c.id} data-id={c.id} className={`cv-card cv-cat-${cat} ${c.lead ? "cv-lead" : ""} ${sel.has(c.id) ? "cv-sel" : ""} ${linkFrom === c.id ? "cv-link-src" : ""} ${missing ? "cv-missing" : ""}`} style={{ left: c.x, top: c.y, width: CARD_W, height: CARD_H, "--c": col }} onPointerDown={(e) => onItemDown(e, c)} title={p ? `${p.title || ""}${p.managerName ? ` · reports to ${p.managerName}` : ""}` : ""}>
              <span className="cv-avatar">{cat === "hire" && !c.name ? "?" : initials(nm)}</span>
              <span className="cv-text"><strong>{nm}</strong><em>{c.title || p?.title || (cat === "hire" ? "to be hired" : "")}</em></span>
            </div>); })}
          {marquee && <div className="cv-marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />}
        </div>
        {items.length === 0 && <div className="cv-empty">A blank canvas. <strong>Start a matrix</strong> (verticals across, functions down, people where they meet) or add <strong>people</strong> and <strong>boxes</strong> freely and draw <strong>dotted lines</strong>. Drag to move, shift-click to select several, scroll to pan, ⌘-scroll to zoom.</div>}
        {showLegend && (
          <div className="cv-legend" onPointerDown={(e) => e.stopPropagation()}>
            <div className="cv-legend-head">Legend <span>click a label to rename · swatch to recolour</span></div>
            {CAT_ORDER.map((k) => { const L = legend[k] || DEFAULT_LEGEND[k]; return (
              <div key={k} className="cv-legend-row">
                <label className="cv-swatch" style={{ background: L.color }}><input type="color" value={L.color} onChange={(e) => setLegend(k, { color: e.target.value })} /></label>
                <input className="cv-legend-label" value={L.label} onChange={(e) => setLegend(k, { label: e.target.value })} />
              </div>); })}
            {!doc.headRef && <div className="cv-legend-hint">Set the org head (top left) and levels colour themselves.</div>}
          </div>
        )}
      </div>

      {picker && <PeoplePicker ctx={picker.mode === "head" ? { title: "Who heads this org?", hint: "Levels are counted from this person.", clearable: !!doc.headRef }
        : picker.mode === "cell" ? (() => { const f = byId.get(picker.frameId); const r = f?.role === "cell" ? byId.get(f.row) : f; const c = f?.role === "cell" ? byId.get(f.col) : null; const heads = (r ? items.filter((i) => i.type === "card" && i.ref && inside(rectOf(i), rectOf(r))).map((i) => i.ref) : []); return { title: `${r?.label || "Function"}${c ? ` × ${c.label || "vertical"}` : ""}`, anchors: [...new Set([...heads, doc.headRef].filter(Boolean))].map((id) => ({ id, label: `${person(id)?.name || "?"}'s org` })), byTeam: true, multi: true, allowNew: true, taken: new Set(f ? items.filter((i) => i.ref && inside(rectOf(i), rectOf(f))).map((i) => i.ref) : []) }; })()
        : picker.mode === "linkTo" ? { title: `Dotted line from ${person(byId.get(picker.from)?.ref)?.name || byId.get(picker.from)?.name || "this person"} to…`, anchors: doc.headRef ? [{ id: doc.headRef, label: `${headP?.name}'s org` }] : [], byTeam: true, allowNew: true }
        : { title: "Add people to the canvas", anchors: doc.headRef ? [{ id: doc.headRef, label: `${headP?.name}'s org` }] : [], byTeam: true, multi: true, allowNew: true, taken: new Set(items.filter((i) => i.ref).map((i) => i.ref)) }}
        rect={picker.rect} source={source} onPick={onPick} onClose={() => setPicker(null)} />}

      {menuItem && menuItem.type === "card" && (() => { const c = menuItem; const p = person(c.ref); const pos = place(menu.rect, 300, 360); const own = !c.ref; return (<>
        <div className="pk-veil" onClick={() => setMenu(null)} />
        <div className="pk cm cv-menu" style={pos}>
          {own ? <><label className="cm-label" style={{ marginTop: 0 }}>Name</label><input className="cm-input" autoFocus={!c.name} value={c.name} placeholder="Leave blank for an open role" onChange={(e) => update(c.id, { name: e.target.value })} /></>
            : <><div className="cm-name">{p?.name || "No longer in the org"}</div><div className="cm-meta">{p?.title || "—"}{p?.managerName && <><br />↳ reports to {p.managerName} <span>in {source.name}</span></>}</div></>}
          <label className="cm-label">Title on this canvas</label>
          <input className="cm-input" value={c.title || ""} placeholder={p?.title || "e.g. EM, Payments"} onChange={(e) => update(c.id, { title: e.target.value })} />
          <label className="cm-label">Colour</label>
          <div className="cv-cat-row">
            {["auto", ...CAT_ORDER].map((k) => <button key={k} className={`cv-cat-btn ${(c.cat || "auto") === k ? "cv-cat-on" : ""}`} style={{ "--c": k === "auto" ? "#8a7d6c" : legend[k].color }} onClick={() => update(c.id, { cat: k })} title={k === "auto" ? "Automatic from the org chart" : legend[k].label}>{k === "auto" ? "auto" : legend[k].label}</button>)}
          </div>
          <div className="cm-actions">
            <button className={`tb ${c.lead ? "tb-primary" : ""}`} onClick={() => update(c.id, { lead: !c.lead })} title="The lead sits first in its box, with a strong border"><Crown size={13} /> {c.lead ? "Lead" : "Make lead"}</button>
            <button className="tb" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu(null); setPicker({ mode: "linkTo", from: c.id, rect: { left: r.left, top: r.top, bottom: r.bottom } }); }}><Link2 size={13} /> Dotted line to…</button>
            <button className="tb tb-danger" onClick={() => { apply((d) => { d.items = d.items.filter((i) => i.id !== c.id); d.links = d.links.filter((l) => l.from !== c.id && l.to !== c.id); return d; }); setMenu(null); setSel(new Set()); }}><Trash2 size={13} /> Remove</button>
          </div>
        </div></>); })()}
    </div>
  );
}

const cvStyles = `
.cv-root { padding-bottom: 0; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
.cv-top { flex: none; }
.cv-tools { display: flex; gap: 6px; align-items: center; }
.tb-off { opacity: .5; }
.cv-canvas { position: relative; flex: 1; min-height: 0; margin: 12px -28px 0; border-top: 1px solid var(--line); overflow: hidden; cursor: default; user-select: none; touch-action: none;
  background-color: #faf7ef; background-image: radial-gradient(circle, #d9d1be 1px, transparent 1.2px); background-size: 24px 24px; }
.cv-panning { cursor: grab; } .cv-linking { cursor: crosshair; }
.cv-layer { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.cv-frame { position: absolute; border: 1.5px solid #cfc6b1; border-radius: 12px; box-shadow: 0 1px 0 rgba(26,22,18,.03); cursor: move; }
.cv-frame.cv-sel { border-color: var(--ink); box-shadow: 0 0 0 3px rgba(26,22,18,.12); }
.cv-frame-label { position: absolute; left: 14px; top: 10px; right: 14px; font-family: 'Iowan Old Style', Georgia, serif; font-size: 15px; font-weight: 600; letter-spacing: -0.005em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none; }
.cv-frame-label-empty { color: var(--ink-faint); font-style: italic; font-weight: 400; }
.cv-frame-input { position: absolute; left: 10px; top: 6px; width: calc(100% - 20px); font: inherit; font-family: 'Iowan Old Style', Georgia, serif; font-size: 15px; font-weight: 600; padding: 2px 4px; border: 1px solid var(--ink); border-radius: 5px; background: #fff; outline: none; }
.cv-resize { position: absolute; right: -6px; bottom: -6px; width: 14px; height: 14px; border-radius: 4px; background: var(--ink); cursor: nwse-resize; }
.cv-tint-row { position: absolute; right: 10px; top: 9px; display: flex; gap: 4px; }
.cv-tint { width: 14px; height: 14px; border-radius: 50%; border: 1px solid rgba(26,22,18,.25); cursor: pointer; padding: 0; } .cv-tint-on { box-shadow: 0 0 0 2px var(--ink); }
.cv-links { position: absolute; left: 0; top: 0; width: 1px; height: 1px; pointer-events: none; }
.cv-link { pointer-events: auto; cursor: pointer; }
.cv-link-hit { stroke: transparent; stroke-width: 14; }
.cv-link-line { stroke: #6d5aa8; stroke-width: 2; fill: none; } .cv-link-dot { fill: #6d5aa8; }
.cv-link:hover .cv-link-line { stroke-width: 3; } .cv-link-sel .cv-link-line { stroke: var(--accent); stroke-width: 3; } .cv-link-sel .cv-link-dot { fill: var(--accent); }
.cv-card { position: absolute; display: flex; align-items: center; gap: 10px; padding: 0 12px 0 10px; background: #fffdf8; border: 1.5px solid var(--c); border-left-width: 5px; border-radius: 10px; box-shadow: 0 1px 2px rgba(26,22,18,.08), 0 6px 16px -10px rgba(26,22,18,.25); cursor: grab; box-sizing: border-box; }
.cv-card:active { cursor: grabbing; }
.cv-card.cv-sel { outline: 2px solid var(--ink); outline-offset: 2px; }
.cv-card.cv-link-src { outline: 2px dashed #6d5aa8; outline-offset: 2px; }
.cv-cat-hire { border-style: dashed; background: #fffdf8; } .cv-cat-hire .cv-avatar { background: transparent; color: var(--c); border: 1.5px dashed var(--c); }
.cv-cat-outside .cv-avatar { background: var(--c); }
.cv-missing { opacity: .55; }
.cv-avatar { width: 30px; height: 30px; flex: none; border-radius: 50%; display: grid; place-items: center; font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 11px; font-weight: 700; color: #fff; background: var(--c); }
.cv-text { display: flex; flex-direction: column; min-width: 0; line-height: 1.2; }
.cv-text strong { font-family: 'Iowan Old Style', Georgia, serif; font-size: 13.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cv-text em { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 10.5px; font-style: normal; color: var(--ink-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cv-group { border: none; border-radius: 10px; box-shadow: 0 2px 6px -2px rgba(26,22,18,.35); }
.cv-group .cv-frame-label { color: #fff; text-align: center; left: 12px; right: 12px; top: 12px; font-size: 15.5px; } .cv-group .cv-frame-label-empty { color: rgba(255,255,255,.75); }
.cv-col { border: 1.5px solid #d6cdb8; border-top: 6px solid var(--g); border-radius: 8px; }
.cv-col .cv-frame-label { top: 14px; text-align: center; left: 10px; right: 10px; white-space: normal; line-height: 1.2; font-size: 14px; }
.cv-row { background: #fffdf8; border: 1.5px solid #d6cdb8; border-radius: 10px; }
.cv-row .cv-frame-label { top: 9px; font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 10px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: var(--ink-faint); }
.cv-cell { background: rgba(255,253,248,.85); border: 1.5px solid #e2dac8; border-radius: 10px; }
.cv-cell:hover, .cv-row:hover { border-color: #bfb49a; }
.cv-cell-add { position: absolute; right: 6px; bottom: 6px; width: 22px; height: 22px; border-radius: 50%; border: 1px dashed var(--ink-faint); background: #fffdf8; color: var(--ink-soft); display: grid; place-items: center; cursor: pointer; opacity: 0; transition: opacity .12s; }
.cv-cell:hover .cv-cell-add, .cv-row:hover .cv-cell-add, .cv-cell.cv-sel .cv-cell-add { opacity: 1; } .cv-cell-add:hover { background: var(--ink); color: var(--paper); border-style: solid; }
.cv-autolinks { z-index: 0; }
.cv-card.cv-lead { border-width: 2px; border-left-width: 6px; box-shadow: 0 2px 4px rgba(26,22,18,.12), 0 8px 18px -10px rgba(26,22,18,.35); }
.cv-card.cv-lead strong { font-size: 14px; }
.cv-marquee { position: absolute; border: 1px dashed var(--ink); background: rgba(26,22,18,.05); pointer-events: none; }
.cv-empty { position: absolute; left: 50%; top: 42%; transform: translate(-50%, -50%); max-width: 520px; text-align: center; font-family: 'Iowan Old Style', Georgia, serif; font-size: 15px; line-height: 1.6; color: var(--ink-faint); pointer-events: none; }
.cv-legend { position: absolute; right: 18px; bottom: 18px; width: 290px; background: rgba(255,253,248,.96); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); padding: 10px 12px 12px; font-family: 'Iowan Old Style', Georgia, serif; }
.cv-legend-head { font-size: 12.5px; font-weight: 600; margin-bottom: 6px; display: flex; flex-direction: column; } .cv-legend-head span { font-weight: 400; font-style: italic; font-size: 10.5px; color: var(--ink-faint); }
.cv-legend-row { display: flex; align-items: center; gap: 9px; padding: 3px 0; }
.cv-swatch { width: 16px; height: 16px; border-radius: 50%; flex: none; cursor: pointer; position: relative; overflow: hidden; border: 1px solid rgba(26,22,18,.2); } .cv-swatch input { position: absolute; inset: -10px; opacity: 0; cursor: pointer; }
.cv-legend-label { flex: 1; border: none; background: transparent; font: inherit; font-size: 13px; color: var(--ink); padding: 2px 4px; border-radius: 4px; outline: none; } .cv-legend-label:hover, .cv-legend-label:focus { background: var(--paper-2); }
.cv-legend-hint { margin-top: 6px; font-size: 11px; font-style: italic; color: var(--ink-faint); }
.cv-cat-row { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 4px; }
.cv-cat-btn { border: 1px solid var(--c); color: var(--c); background: transparent; border-radius: 999px; padding: 3px 9px; font-family: 'Iowan Old Style', Georgia, serif; font-size: 11.5px; cursor: pointer; } .cv-cat-on { background: var(--c); color: #fff; }
.cv-menu { width: 300px; }
`;
