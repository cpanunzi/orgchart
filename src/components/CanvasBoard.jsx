import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { ArrowLeft, Plus, X, RotateCcw, Square, UserPlus, Minus, Maximize2, Link2, Trash2, Edit2, Crown, LayoutGrid, Palette, Flag, Copy, Pin, PinOff, ArrowLeftRight, Presentation, ArrowLeft as BackIcon } from "lucide-react";
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
//   row    : a function down the side (Product, Engineering) — its head card sits inside it   { group? }
//   rgroup : a band down the left that a set of rows belong to (CCO, Finance…), head card inside { color }
//   cell   : the intersection                        { col, row, headId?, span? }  span = how many verticals
//            (this one and the next span-1 in order) the cell covers — a merged cell  headId = which card in
//            the row box this cell reports to (default: the row box itself — i.e. its first head)
// Cells hold cards; a card with lead:true is the lead of that cell. Dotted lines from each row
// head and column head into every cell are drawn automatically; `layoutMatrix` snaps the whole
// structure into place and runs after anything is added to a cell. Everything stays draggable.
const rid = () => Math.random().toString(36).slice(2, 10);
const clone = (x) => JSON.parse(JSON.stringify(x));
const GROUP_COLORS = ["#3b6ea5", "#6d5aa8", "#5b7a3f", "#b07d2a", "#b8442a", "#2f7f86"];
const RG_W = 232, ROWHEAD_W = 224, COL_W = 232, MGAP = 22, GROUP_H = 46, COLHEAD_H = 58, CPAD = 12, CGAP = 8, ROWLABEL_H = 34;
const cellH = (n) => Math.max(76, CPAD * 2 + n * CARD_H + Math.max(0, n - 1) * CGAP);
const rowHeadH = (n) => ROWLABEL_H + Math.max(1, n) * CARD_H + Math.max(0, n - 1) * CGAP + CPAD; // label on top, head card(s) under it
// Snap the matrix scaffold into a clean grid: verticals across (grouped), functions down, cells at
// the intersections sized to what they hold. Cards inside a cell stack top-down, lead first.
const layoutMatrix = (items) => {
  const groups = items.filter((i) => i.role === "group"), rgroups = items.filter((i) => i.role === "rgroup");
  const rows = items.filter((i) => i.role === "row");
  const cols = items.filter((i) => i.role === "col").sort((a, b) => groups.findIndex((g) => g.id === a.group) - groups.findIndex((g) => g.id === b.group));
  if (!cols.length && !rows.length) return items;
  const LEFT = rgroups.length ? RG_W + MGAP : 0;
  const cells = items.filter((i) => i.role === "cell");
  const cellsOf = (r, c) => cells.filter((x) => x.row === r.id && x.col === c.id);
  items.forEach((k) => { if (k.type === "card" && k.in && ownerOf(k, items)?.id !== k.in) delete k.in; });
  const cardsIn = (cell) => { return items.filter((i) => i.type === "card" && ownerOf(i, items)?.id === cell.id).sort((a, b) => (b.lead ? 1 : 0) - (a.lead ? 1 : 0) || a.y - b.y || a.x - b.x); };
  const colX = new Map(); cols.forEach((c, i) => colX.set(c.id, LEFT + ROWHEAD_W + MGAP + i * (COL_W + MGAP)));
  const headsOf = (f) => items.filter((i) => i.type === "card" && ownerOf(i, items)?.id === f.id).sort((a, b) => (b.lead ? 1 : 0) - (a.lead ? 1 : 0) || a.y - b.y || a.x - b.x);
  const stackIn = (f, cards, labelH) => cards.forEach((k, i) => { k.in = f.id; k.x = f.x + (f.w - CARD_W) / 2; k.y = f.y + labelH + i * (CARD_H + CGAP); });
  const bandH = (n) => (n ? ROWLABEL_H + n * CARD_H + (n - 1) * CGAP + CPAD : GROUP_H);
  const gHeads = new Map(groups.map((g) => [g.id, headsOf(g)]));
  const groupH = groups.length ? Math.max(...groups.map((g) => bandH(gHeads.get(g.id).length))) : 0;
  const top = groups.length ? groupH + 10 : 0;
  groups.forEach((g) => { const gc = cols.filter((c) => c.group === g.id); if (!gc.length) { g.w = COL_W; g.h = groupH; g.y = 0; stackIn(g, gHeads.get(g.id), ROWLABEL_H); return; } const xs = gc.map((c) => colX.get(c.id)); g.x = Math.min(...xs); g.y = 0; g.w = Math.max(...xs) + COL_W - g.x; g.h = groupH; stackIn(g, gHeads.get(g.id), ROWLABEL_H); });
  const cHeads = new Map(cols.map((c) => [c.id, headsOf(c)]));
  const colH = cols.length ? Math.max(COLHEAD_H, ...cols.map((c) => { const n = cHeads.get(c.id).length; return n ? 44 + n * CARD_H + (n - 1) * CGAP + CPAD : 0; })) : COLHEAD_H;
  cols.forEach((c) => { c.x = colX.get(c.id); c.y = top; c.w = COL_W; c.h = colH; stackIn(c, cHeads.get(c.id), 44); });
  // rows: first work out what each row holds and how tall it must be; cells merged DOWN (vspan)
  // cover the next rows in the column, don't count toward their first row's height, and can
  // stretch the last row they cover if they need more room
  const coveredDown = new Set(); // cell keys "rowIdx|colId" hidden under a vspan cell
  const info = rows.map((r, ri) => {
    const headCards = items.filter((i) => i.type === "card" && ownerOf(i, items)?.id === r.id);
    const rowCells = []; for (let ci = 0; ci < cols.length;) { const c = cols[ci]; if (coveredDown.has(`${ri}|${c.id}`)) { ci++; continue; } const cell = cellsOf(r, c)[0]; const span = Math.max(1, Math.min(cell?.span || 1, cols.length - ci)); const vspan = cell ? Math.max(1, Math.min(cell.vspan || 1, rows.length - ri)) : 1; for (let k = 1; k < vspan; k++) coveredDown.add(`${ri + k}|${c.id}`); rowCells.push({ c, cell, span, vspan, cards: cell ? cardsIn(cell) : [] }); ci += span; }
    const h = Math.max(rowHeadH(headCards.length), ...rowCells.filter((x) => x.vspan === 1).map((x) => cellH(Math.ceil(x.cards.length / Math.max(1, Math.min(x.span, x.cards.length))))));
    return { r, ri, headCards, rowCells, h };
  });
  info.forEach((inf) => inf.rowCells.forEach((x) => { if (x.vspan === 1) return; const need = cellH(x.cards.length); const have = info.slice(inf.ri, inf.ri + x.vspan).reduce((n, i2) => n + i2.h, 0) + (x.vspan - 1) * MGAP; if (need > have) info[inf.ri + x.vspan - 1].h += need - have; }));
  let y = top + colH + MGAP;
  info.forEach(({ r, headCards, rowCells, h }) => { r.x = LEFT; r.y = y; r.w = ROWHEAD_W; r.h = h; headCards.forEach((k, i) => { k.in = r.id; k.x = r.x + (ROWHEAD_W - CARD_W) / 2; k.y = r.y + ROWLABEL_H + i * (CARD_H + CGAP); }); y += h + MGAP; });
  info.forEach(({ ri, rowCells }) => rowCells.forEach(({ c, cell, span, vspan, cards }) => { if (!cell) return;
    cell.x = colX.get(c.id); cell.y = info[ri].r.y; cell.w = span * COL_W + (span - 1) * MGAP; const last = info[ri + vspan - 1].r; cell.h = last.y + last.h - cell.y;
    if (span > 1) cell.span = span; else delete cell.span; if (vspan > 1) cell.vspan = vspan; else delete cell.vspan;
    const ncols = Math.max(1, Math.min(span, cards.length)); const blockW = ncols * CARD_W + (ncols - 1) * 16; const x0 = cell.x + (cell.w - blockW) / 2;
    cards.forEach((k, i) => { k.in = cell.id; k.x = x0 + (i % ncols) * (CARD_W + 16); k.y = cell.y + CPAD + Math.floor(i / ncols) * (CARD_H + CGAP); }); }));
  // row-group bands: span their rows, head cards stacked under the label
  rgroups.forEach((g) => { const rs = rows.filter((r) => r.group === g.id); if (!rs.length) { g.w = RG_W; g.h = 120; g.x = 0; if (!(g.y >= 0 && g.y < y + 2000)) g.y = y; return; }
    const y0 = Math.min(...rs.map((r) => r.y)), y1 = Math.max(...rs.map((r) => r.y + r.h)); g.x = 0; g.y = y0; g.w = RG_W; g.h = y1 - y0;
    const heads = items.filter((i) => i.type === "card" && ownerOf(i, items)?.id === g.id).sort((a, b) => (b.lead ? 1 : 0) - (a.lead ? 1 : 0) || a.y - b.y);
    heads.forEach((k, i) => { k.in = g.id; k.x = g.x + (RG_W - CARD_W) / 2; k.y = g.y + ROWLABEL_H + i * (CARD_H + CGAP); }); });
  return items;
};
// Read the scaffold's order off its positions: rows top-to-bottom, groups left-to-right, verticals
// left-to-right inside whichever group band they sit under. Dragging a row/vertical/group and
// dropping it somewhere new is then just "re-read the order and lay out again".
// `moved` = ids the user just dragged: only those re-pick their group by position, so dragging a
// band over a row/vertical never swallows it
const orderScaffold = (items, moved = new Set()) => {
  const groups = items.filter((i) => i.role === "group").sort((a, b) => a.x - b.x);
  const cols = items.filter((i) => i.role === "col");
  cols.forEach((c) => { if (c._keep) { delete c._keep; return; } if (!moved.has(c.id) && groups.some((g) => g.id === c.group)) return; const ov = (gr) => Math.min(c.x + c.w, gr.x + gr.w) - Math.max(c.x, gr.x); const g = groups.map((gr) => [ov(gr) / Math.min(c.w, gr.w), gr]).filter(([o]) => o >= 0.4).sort((a, b) => b[0] - a[0])[0]; if (g) c.group = g[1].id; else if (!groups.some((gr) => gr.id === c.group)) c.group = groups.length ? (c.x < (groups[0].x) ? groups[0] : groups[groups.length - 1]).id : null; });
  cols.sort((a, b) => groups.findIndex((g) => g.id === a.group) - groups.findIndex((g) => g.id === b.group) || a.x - b.x);
  const rgroups = items.filter((i) => i.role === "rgroup").sort((a, b) => a.y - b.y);
  const rows = items.filter((i) => i.role === "row");
  rows.forEach((r) => { const known = rgroups.some((gr) => gr.id === r.group); if (r._keep) { delete r._keep; return; } if (!moved.has(r.id)) { if (!known) r.group = null; return; } const ov = (gr) => Math.min(r.y + r.h, gr.y + gr.h) - Math.max(r.y, gr.y); const g = rgroups.map((gr) => [ov(gr) / Math.min(r.h, gr.h), gr]).filter(([o]) => o >= 0.4).sort((a, b) => b[0] - a[0])[0]; r.group = g ? g[1].id : null; }); // enough vertical overlap with a band = in it
  // a group's rows travel as a block positioned where the band sits; ungrouped rows keep their own y
  const key = (r) => { const g = rgroups.find((gr) => gr.id === r.group); return g ? g.y : r.y; };
  rows.sort((a, b) => key(a) - key(b) || a.y - b.y);
  const cells = items.filter((i) => i.role === "cell");
  const rest = items.filter((i) => !i.role);
  return [...groups, ...rgroups, ...cols, ...rows, ...cells, ...rest];
};
// Present mode: a read-only picture of the same board. "overview" = structure only (no names, no
// cards, cells shrunk to a count); "focus" = one department's column/row/band with its people;
// "extended" = everything. Let-go flags never show. Built from a clone, so nothing is saved.
const presentItems = (items, mode, focusId) => {
  const counts = new Map(); items.forEach((i) => { if (i.type === "card" && i.in) counts.set(i.in, (counts.get(i.in) || 0) + 1); });
  const roleOf = new Map(items.filter((i) => i.type === "frame").map((f) => [f.id, f.role]));
  let keep = () => true;
  if (mode === "overview") keep = (c) => ["col", "row", "group", "rgroup"].includes(roleOf.get(c.in)); // heads only
  else if (mode === "focus" && focusId) {
    const f = items.find((i) => i.id === focusId); const colsOfGroup = f?.role === "group" ? new Set(items.filter((i) => i.role === "col" && i.group === f.id).map((c) => c.id)) : null;
    const rowsOfGroup = f?.role === "rgroup" ? new Set(items.filter((i) => i.role === "row" && i.group === f.id).map((r) => r.id)) : null;
    const boxes = new Set([focusId]);
    items.forEach((i) => { if (i.role !== "cell") return; if ((f?.role === "col" && i.col === f.id) || (f?.role === "row" && i.row === f.id) || (colsOfGroup && colsOfGroup.has(i.col)) || (rowsOfGroup && rowsOfGroup.has(i.row))) boxes.add(i.id); });
    if (colsOfGroup) colsOfGroup.forEach((id) => boxes.add(id)); if (rowsOfGroup) rowsOfGroup.forEach((id) => boxes.add(id));
    keep = (c) => boxes.has(c.in);
  }
  const out = clone(items.filter((i) => i.type === "card" ? (i.in && keep(i)) : !!i.role)); // scaffold + the people in it; free boxes and loose cards are working notes
  out.forEach((i) => { if (i.role === "cell") i.count = counts.get(i.id) || 0; if (i.type === "card") delete i.letGo; });
  return layoutMatrix(ensureCells(orderScaffold(out)));
};

// functions ↔ verticals: bands follow, cells keep their people (merged cells are split)
const transposeItems = (items) => {
  const swap = { group: "rgroup", rgroup: "group", col: "row", row: "col" };
  items.forEach((i) => { if (i.role === "cell") { const r = i.row; i.row = i.col; i.col = r; const sp = i.span; i.span = i.vspan; i.vspan = sp; if (!i.span) delete i.span; if (!i.vspan) delete i.vspan; delete i.headId; } else if (swap[i.role]) { i.role = swap[i.role]; if (i.role === "group" || i.role === "rgroup") i.color = i.color || GROUP_COLORS[0]; } });
  items.forEach((i) => { if (i.role === "row" || i.role === "col") i._keep = true; });
  return items;
};
const ensureCells = (items) => {
  const rows = items.filter((i) => i.role === "row"), groups = items.filter((i) => i.role === "group");
  const cols = items.filter((i) => i.role === "col").sort((a, b) => groups.findIndex((g) => g.id === a.group) - groups.findIndex((g) => g.id === b.group));
  const down = new Set(); // "rowIdx|colId" covered by a cell merged downwards
  rows.forEach((r, ri) => {
    const covered = new Set();
    cols.forEach((c, ci) => { if (covered.has(c.id) || down.has(`${ri}|${c.id}`)) return; const cell = items.find((x) => x.role === "cell" && x.row === r.id && x.col === c.id); const span = Math.max(1, Math.min(cell?.span || 1, cols.length - ci)); for (let k = 1; k < span; k++) covered.add(cols[ci + k].id); const vspan = Math.max(1, Math.min(cell?.vspan || 1, rows.length - ri)); for (let k = 1; k < vspan; k++) down.add(`${ri + k}|${c.id}`); });
    // cells under a merged cell go (their people were moved on merge); missing ones get made
    for (let i = items.length - 1; i >= 0; i--) { const x = items[i]; if (x.role === "cell" && x.row === r.id && (covered.has(x.col) || down.has(`${ri}|${x.col}`))) items.splice(i, 1); }
    cols.forEach((c) => { if (covered.has(c.id) || down.has(`${ri}|${c.id}`)) return; if (!items.some((x) => x.role === "cell" && x.row === r.id && x.col === c.id)) items.push({ id: rid(), type: "frame", role: "cell", row: r.id, col: c.id, x: 0, y: 0, w: COL_W, h: 76, label: "" }); });
  });
  return items;
};
const CARD_W = 184, CARD_H = 60, GRID = 8;
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
const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
// An item belongs to the SMALLEST frame around its centre (so a box laid over a matrix cell
// doesn't claim the cell's people, and a box inside a box belongs to the inner one).
const overlapRatio = (a, b) => { const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y); return w > 0 && h > 0 ? (w * h) / (a.w * a.h) : 0; };
const ownerOf = (it, all) => {
  if (it.role) return null; // matrix pieces belong to the layout, never to a box laid over them
  const r = rectOf(it);
  // a card counts as in a matrix cell / row box as soon as about a third of it overlaps — no need
  // to drop it dead centre; the layout then pulls it fully inside
  if (it.type === "card") {
    if (it.in) { const f = all.find((x) => x.id === it.in); if (f && f.role && overlapRatio(r, rectOf(f)) >= 0.3) return f; } // moved together with its box → still its box
    // dropped just outside a full cell (below its last card, say) still counts — nearest cell/row
    // box in the same column within about a card's height
    let near = null, nd = 64; all.forEach((f) => { if (f.type !== "frame" || !f.role || f.role === "group" || f.role === "col") return; const fr = rectOf(f); const ox = Math.min(r.x + r.w, fr.x + fr.w) - Math.max(r.x, fr.x); if (ox < CARD_W * 0.5) return; const dy = Math.max(0, fr.y - (r.y + r.h), r.y - (fr.y + fr.h)); if (dy < nd) { nd = dy; near = f; } });
    let best = null, br = 0.3; all.forEach((f) => { if (f.type !== "frame" || !f.role) return; const o = overlapRatio(r, rectOf(f)); if (o > br) { br = o; best = f; } }); if (best) return best; if (near) return near; }
  let best = null, ba = Infinity;
  all.forEach((f) => { if (f.type !== "frame" || f.id === it.id || f.role) return; const fr = rectOf(f); if (!inside(r, fr)) return; if (it.type === "frame" && area(fr) <= area(r)) return; const a = area(fr); if (a < ba) { ba = a; best = f; } });
  return best;
};
const contentsOfFrame = (frameId, all) => { const out = []; const direct = all.filter((i) => ownerOf(i, all)?.id === frameId); direct.forEach((i) => { out.push(i.id); if (i.type === "frame") out.push(...contentsOfFrame(i.id, all)); }); return out; };

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
  // default orientation: functions (Product, Engineering…) across the top, verticals down the side
  return { items: layoutMatrix(ensureCells(orderScaffold(transposeItems(layoutMatrix(all))))), links: [] };
};

// One-slide version of the matrix: bands and headers with their leads, a lead name or a people
// count in every box. Scaled to fit whatever it's shown in — screenshot it or project it.
function SlideView({ items, person, legend, catOf, title }) {
  const wrapRef = useRef(null), innerRef = useRef(null); const [scale, setScale] = useState(1);
  useEffect(() => { const fitIt = () => { const w = wrapRef.current, n = innerRef.current; if (!w || !n) return; const z = parseFloat(n.style.zoom) || 1; const r = n.getBoundingClientRect(); const nw = r.width / z, nh = r.height / z; if (!nw || !nh) return; setScale(Math.min((w.clientWidth - 48) / nw, (w.clientHeight - 48) / nh, 1.4)); }; fitIt(); const t = setTimeout(fitIt, 150); window.addEventListener("resize", fitIt); return () => { clearTimeout(t); window.removeEventListener("resize", fitIt); }; }, [items]);
  const groups = items.filter((i) => i.role === "group").sort((a, b) => a.x - b.x), rgroups = items.filter((i) => i.role === "rgroup").sort((a, b) => a.y - b.y);
  const cols = items.filter((i) => i.role === "col").sort((a, b) => a.x - b.x), rows = items.filter((i) => i.role === "row").sort((a, b) => a.y - b.y);
  const cards = items.filter((i) => i.type === "card" && i.in); const inBox = (id) => cards.filter((c) => c.in === id);
  const name = (c) => c.title || person(c.ref)?.title || c.name || person(c.ref)?.name || "Open role"; // roles, not people
  const heads = (id) => inBox(id).sort((a, b) => (b.lead ? 1 : 0) - (a.lead ? 1 : 0));
  const cellOf = (r, c) => items.find((i) => i.role === "cell" && i.row === r.id && i.col === c.id);
  const covered = new Set(); items.filter((i) => i.role === "cell" && (i.span > 1 || i.vspan > 1)).forEach((cell) => { const ci = cols.findIndex((c) => c.id === cell.col), ri = rows.findIndex((r) => r.id === cell.row); for (let a = 0; a < (cell.vspan || 1); a++) for (let b = 0; b < (cell.span || 1); b++) if (a || b) covered.add(`${rows[ri + a]?.id}|${cols[ci + b]?.id}`); });
  const colGroups = groups.map((g) => ({ g, cols: cols.filter((c) => c.group === g.id) })).filter((x) => x.cols.length); const loose = cols.filter((c) => !groups.some((g) => g.id === c.group)); if (loose.length) colGroups.push({ g: null, cols: loose });
  const rowGroups = rgroups.map((g) => ({ g, rows: rows.filter((r) => r.group === g.id) })).filter((x) => x.rows.length); const looseR = rows.filter((r) => !rgroups.some((g) => g.id === r.group)); if (looseR.length) rowGroups.push({ g: null, rows: looseR });
  const hasRG = rowGroups.some((x) => x.g);
  const Head = ({ c, big }) => c ? <span className={`sl-head ${big ? "sl-head-big" : ""} ${!c.ref ? "sl-head-hire" : ""}`}><i className="sl-dot" style={{ background: legend[catOf(c)]?.color }} />{name(c)}</span> : null;
  return (
    <div ref={wrapRef} className="sl-wrap">
      <div ref={innerRef} className="sl-slide" style={{ zoom: scale }}>
        <div className="sl-title">{title}</div>
        <table className="sl-table">
          <thead>
            {colGroups.some((x) => x.g) && <tr>{hasRG && <th className="sl-corner" />}<th className="sl-corner" />{colGroups.map(({ g, cols: gc }) => <th key={g?.id || "loose"} colSpan={gc.length} className="sl-band" style={{ background: g?.color || "transparent" }}>{g && <>{g.label}{heads(g.id).slice(0, 2).map((c) => <Head key={c.id} c={c} big />)}</>}</th>)}</tr>}
            <tr>{hasRG && <th className="sl-corner" />}<th className="sl-corner" />{cols.map((c) => <th key={c.id} className="sl-col">{c.label}{heads(c.id).slice(0, 2).map((h) => <Head key={h.id} c={h} />)}</th>)}</tr>
          </thead>
          <tbody>
            {rowGroups.map(({ g, rows: gr }) => gr.map((r, ri) => (
              <tr key={r.id}>
                {hasRG && ri === 0 && <th rowSpan={gr.length} className="sl-rband" style={{ background: g?.color || "transparent", color: g ? "#fff" : "inherit" }}>{g?.label}{g && heads(g.id).slice(0, 2).map((c) => <Head key={c.id} c={c} big />)}</th>}
                <th className="sl-row">{r.label}{heads(r.id).slice(0, 2).map((h) => <Head key={h.id} c={h} />)}</th>
                {cols.map((c) => { if (covered.has(`${r.id}|${c.id}`)) return null; const cell = cellOf(r, c); const ppl = cell ? inBox(cell.id) : []; const lead = ppl.find((x) => x.lead); return (
                  <td key={c.id} colSpan={cell?.span || 1} rowSpan={cell?.vspan || 1} className={`sl-cell ${ppl.length ? "sl-cell-on" : ""}`}>
                    {lead && <Head c={lead} />}
                  </td>); })}
              </tr>)))}
          </tbody>
        </table>
      </div>
    </div>);
}

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
  // present mode (?present=1): read-only, shareable; overview → click a department → extended
  const [present, setPresentState] = useState(() => new URLSearchParams(window.location.search).get("present") === "1");
  const [pmode, setPmode] = useState("slide");  // "overview" | "focus" | "extended"
  const [focusId, setFocusId] = useState(null);
  const setPresent = (on) => { const url = new URL(window.location.href); if (on) url.searchParams.set("present", "1"); else url.searchParams.delete("present"); window.history.replaceState(null, "", url.toString()); setPresentState(on); setPmode("slide"); setFocusId(null); setSel(new Set()); setMenu(null); setPicker(null); setTimeout(fit, 60); };
  const [freeze, setFreezeState] = useState(() => { try { return localStorage.getItem(`atelier-canvas-freeze:${chartId}`) !== "off"; } catch { return true; } });
  const setFreeze = (v) => { setFreezeState(v); try { localStorage.setItem(`atelier-canvas-freeze:${chartId}`, v ? "on" : "off"); } catch { /* ignore */ } };
  const [dragIds, setDragIds] = useState(() => new Set());
  const presentRef = useRef(false); presentRef.current = present;
  const PIN_PAD = 10;
  const pinInfo = () => { const v = viewRef.current; const on = freeze && (docRef.current?.items || []).some((i) => i.role); return { on, pinX: on ? Math.max(v.x, PIN_PAD) : v.x, pinY: on ? Math.max(v.y, PIN_PAD) : v.y }; };
  const pinLayerOf = (it, all) => { if (it.type === "frame") return it.role === "group" || it.role === "col" ? "top" : it.role === "row" || it.role === "rgroup" ? "left" : "main"; const o = it.in && all.find((x) => x.id === it.in); return o && (o.role === "row" || o.role === "rgroup") ? "left" : o && (o.role === "col" || o.role === "group") ? "top" : "main"; }; // cards being dragged render in the main layer so they don't jump between pinned layers
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
  const contentsOf = (frameId, all) => contentsOfFrame(frameId, all);

  // ---- view (pan / zoom) ---------------------------------------------------------------------
  const toWorld = (sx, sy) => { const r = cvRef.current.getBoundingClientRect(); const v = viewRef.current; return { x: (sx - r.left - v.x) / v.z, y: (sy - r.top - v.y) / v.z }; };
  const zoomAt = (sx, sy, factor) => setView((v) => { const z = Math.min(2.5, Math.max(0.2, v.z * factor)); const r = cvRef.current.getBoundingClientRect(); const px = sx - r.left, py = sy - r.top; const wx = (px - v.x) / v.z, wy = (py - v.y) / v.z; return { z, x: px - wx * z, y: py - wy * z }; });
  const zoomBy = (f) => { const r = cvRef.current.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, f); };
  const shownRef = useRef(null);
  const fit = () => { const its = shownRef.current || docRef.current?.items || []; if (!its.length || !cvRef.current) return; const rs = its.map(rectOf); const x0 = Math.min(...rs.map((r) => r.x)) - 40, y0 = Math.min(...rs.map((r) => r.y)) - 40, x1 = Math.max(...rs.map((r) => r.x + r.w)) + 40, y1 = Math.max(...rs.map((r) => r.y + r.h)) + 40; const r = cvRef.current.getBoundingClientRect(); const z = Math.min(1.25, r.width / (x1 - x0), r.height / (y1 - y0)); setView({ z, x: (r.width - (x1 - x0) * z) / 2 - x0 * z, y: (r.height - (y1 - y0) * z) / 2 - y0 * z }); };
  const canvasReady = !!doc && !tooNew && !(present && pmode === "slide");
  useEffect(() => { document.documentElement.classList.add("cv-lock"); document.body.classList.add("cv-lock"); window.scrollTo(0, 0); return () => { document.documentElement.classList.remove("cv-lock"); document.body.classList.remove("cv-lock"); }; }, []);
  useEffect(() => {
    const cv = cvRef.current; if (!cv) return;
    const onWheel = (e) => { e.preventDefault(); if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01)); else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY })); };
    cv.addEventListener("wheel", onWheel, { passive: false });
    return () => cv.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasReady]);
  useEffect(() => { if (canvasReady && (docRef.current?.items || []).length) setTimeout(fit, 50); }, [canvasReady]); // eslint-disable-line
  useEffect(() => { if (present && pmode !== "slide") setTimeout(fit, 60); }, [present, pmode, focusId]); // eslint-disable-line

  // ---- keyboard -----------------------------------------------------------------------------
  useEffect(() => {
    const typing = (e) => { const t = e.target; return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable); };
    const down = (e) => {
      if (e.key === "Escape") { setPicker(null); setMenu(null); setLinkFrom(null); setSel(new Set()); setSelLink(null); }
      if (typing(e)) return;
      if (presentRef.current && e.key !== "Escape" && !((e.metaKey || e.ctrlKey) && ["0", "=", "+", "-"].includes(e.key))) return; // read-only
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
  const withContents = (ids) => { const all = docRef.current.items; const out = new Set(ids);
    const addFrame = (id) => { out.add(id); contentsOf(id, all).forEach((c) => out.add(c)); };
    ids.forEach((id) => { const it = all.find((i) => i.id === id); if (!it) return;
      if (it.type === "frame") addFrame(id);
      if (it.role === "row") all.filter((i) => i.role === "cell" && i.row === id).forEach((c) => addFrame(c.id));
      if (it.role === "rgroup") all.filter((i) => i.role === "row" && i.group === id).forEach((r) => { addFrame(r.id); all.filter((x) => x.role === "cell" && x.row === r.id).forEach((x) => addFrame(x.id)); });
      if (it.role === "col") all.filter((i) => i.role === "cell" && i.col === id).forEach((c) => addFrame(c.id));
      if (it.role === "group") all.filter((i) => i.role === "col" && i.group === id).forEach((c) => { addFrame(c.id); all.filter((x) => x.role === "cell" && x.col === c.id).forEach((x) => addFrame(x.id)); }); });
    return [...out]; };
  const moveIds = (ids, dx, dy, commit) => { const full = withContents(ids); apply((d) => { d.items.forEach((i) => { if (full.includes(i.id)) { i.x = commit ? snap(i.x + dx) : i.x + dx; i.y = commit ? snap(i.y + dy) : i.y + dy; } }); if (commit) d.items = reflow(d.items, new Set(full)); return d; }); };
  const centreOfView = () => { const r = cvRef.current.getBoundingClientRect(); return toWorld(r.left + r.width / 2 - CARD_W / 2, r.top + r.height / 2 - CARD_H / 2); };
  const freeSpot = (p) => { const taken = (x, y) => (docRef.current.items || []).some((i) => i.type === "card" && Math.abs(i.x - x) < 24 && Math.abs(i.y - y) < 24); let { x, y } = p; x = snap(x); y = snap(y); while (taken(x, y)) { x += 24; y += 24; } return { x, y }; };
  const addCard = (pick, at, extra = {}) => { const id = rid(); const p = freeSpot(at || centreOfView()); apply((d) => { d.items.push({ id, type: "card", x: p.x, y: p.y, ref: pick.ref || null, name: pick.ref ? "" : (pick.name || ""), title: "", cat: pick.ref ? "auto" : "hire", ...extra }); d.items = reflow(d.items); return d; }); setSel(new Set([id])); return id; };
  const addFrame = () => { const id = rid(); const p = centreOfView(); apply((d) => {
    const box = { id, type: "frame", x: snap(p.x - 60), y: snap(p.y - 60), w: 320, h: 240, label: "", tint: TINTS[d.items.filter((i) => i.type === "frame").length % TINTS.length] };
    const others = d.items.filter((i) => i.type === "frame").map(rectOf);
    if (others.some((o) => overlaps(box, o))) { // don't land on the matrix — go below everything in view
      const rs = d.items.map(rectOf); box.x = snap(Math.min(...rs.map((r) => r.x))); box.y = snap(Math.max(...rs.map((r) => r.y + r.h)) + 40); }
    d.items.push(box); return d; }); setSel(new Set([id])); setEditingLabel(id); };
  const addHire = () => { const id = addCard({ ref: null, name: "" }, null, { cat: "hire", title: "" }); setTimeout(() => { const el = document.querySelector(`[data-id="${id}"]`); if (el) { const r = el.getBoundingClientRect(); setMenu({ id, rect: { left: r.left, top: r.top, bottom: r.bottom } }); } }, 30); };
  const removeSel = () => { const ids = selRef.current; if (!ids.size) { if (selLink) { apply((d) => { d.links = d.links.filter((l) => l.id !== selLink); return d; }); setSelLink(null); } return; } apply((d) => { const touched = d.items.some((i) => ids.has(i.id) && (i.role || i.type === "card")); d.items.filter((i) => ids.has(i.id) && i.role).forEach((f) => { if (f.role === "group") d.items.filter((i) => i.role === "col" && i.group === f.id).forEach((c) => ids.add(c.id)); if (f.role === "rgroup") d.items.forEach((i) => { if (i.role === "row" && i.group === f.id) i.group = null; }); }); d.items.filter((i) => i.role === "cell" && (ids.has(i.col) || ids.has(i.row))).forEach((c) => ids.add(c.id)); d.items = d.items.filter((i) => !ids.has(i.id)); d.items.forEach((i) => { if (i.headId && ids.has(i.headId)) delete i.headId; }); d.links = d.links.filter((l) => !ids.has(l.from) && !ids.has(l.to)); if (touched && d.items.some((i) => i.role)) d.items = layoutMatrix(d.items); return d; }); setSel(new Set()); setMenu(null); };
  const duplicateSel = () => { const ids = withContents([...selRef.current]); const map = new Map(); apply((d) => { const copies = d.items.filter((i) => ids.includes(i.id)).map((i) => { const { in: _in, ...rest } = i; const c = { ...rest, id: rid(), x: i.x + (i.type === "card" && i.in ? CARD_W + 40 : 40), y: i.y + (i.type === "card" && i.in ? 0 : 40), lead: false }; map.set(i.id, c.id); return c; }); d.items.push(...copies); d.items = reflow(d.items); return d; }); setSel(new Set(map.values())); };
  const update = (id, patch) => apply((d) => { const it = d.items.find((i) => i.id === id); if (it) Object.assign(it, patch);
    if (it && "title" in patch && it.ref) d.items.forEach((i) => { if (i.type === "card" && i.ref === it.ref) i.title = patch.title; }); // one person, one title — everywhere they appear
    if ("lead" in patch) d.items = reflow(d.items); return d; });
  const addLink = (from, to, style = "dotted") => { if (from === to) return; apply((d) => { if (d.links.some((l) => (l.from === from && l.to === to) || (l.from === to && l.to === from))) return d; d.links.push({ id: rid(), from, to, style }); return d; }); };
  const tidy = (frameId) => apply((d) => { // lay the frame's cards out in a neat grid, grow the frame to fit
    const f = d.items.find((i) => i.id === frameId); if (!f) return d;
    const cards = contentsOf(frameId, d.items).map((id) => d.items.find((i) => i.id === id)).filter((i) => i.type === "card").sort((a, b) => a.y - b.y || a.x - b.x);
    const cols = Math.max(1, Math.floor((f.w - 32) / (CARD_W + 12)));
    cards.forEach((c, i) => { c.x = f.x + 16 + (i % cols) * (CARD_W + 12); c.y = f.y + 44 + Math.floor(i / cols) * (CARD_H + 10); });
    const rows = Math.ceil(cards.length / cols); f.h = Math.max(f.h, 44 + rows * (CARD_H + 10) + 8); return d; });
  const hasMatrix = items.some((i) => i.role);
  const reflow = (its, moved) => (its.some((i) => i.role) ? layoutMatrix(ensureCells(orderScaffold(its, moved))) : its);
  const relayout = () => apply((d) => { d.items = reflow(d.items); return d; });
  const startMatrix = () => apply((d) => {
    const g = { id: rid(), type: "frame", role: "group", label: "Leadership", color: GROUP_COLORS[0], x: 0, y: 0, w: COL_W, h: GROUP_H };
    const c = { id: rid(), type: "frame", role: "col", group: g.id, label: "Product", x: 0, y: 0, w: COL_W, h: COLHEAD_H };
    const r = { id: rid(), type: "frame", role: "row", label: "First vertical", x: 0, y: 0, w: ROWHEAD_W, h: rowHeadH(1) };
    d.items.push(g, c, r); d.items = layoutMatrix(ensureCells(d.items)); return d; });
  const addGroup = () => { const id = rid(); apply((d) => { const n = d.items.filter((i) => i.role === "group").length; d.items.push({ id, type: "frame", role: "group", label: "", color: GROUP_COLORS[n % GROUP_COLORS.length], x: 1e9, y: 0, w: COL_W, h: GROUP_H }); d.items.push({ id: rid(), type: "frame", role: "col", group: id, label: "", x: 1e9, y: 0, w: COL_W, h: COLHEAD_H }); d.items = reflow(d.items); return d; }); setEditingLabel(id); };
  const addCol = (groupId) => { const id = rid(); apply((d) => { const gid = groupId || (d.items.filter((i) => i.role === "group").slice(-1)[0] || {}).id || null; const g = d.items.find((i) => i.id === gid); d.items.push({ id, type: "frame", role: "col", group: gid, label: "", x: g ? g.x + g.w - COL_W / 2 : 1e9, y: 0, w: COL_W, h: COLHEAD_H }); d.items = reflow(d.items); return d; }); setEditingLabel(id); };
  const addRowGroup = () => { const id = rid(); const selRows = [...sel].map((x) => byId.get(x)).filter((i) => i?.role === "row"); apply((d) => {
    const n = d.items.filter((i) => i.role === "rgroup").length; const rs = selRows.length ? selRows.map((r) => d.items.find((i) => i.id === r.id)) : [];
    const rows = d.items.filter((i) => i.role === "row"); const bottom = rows.length ? Math.max(...rows.map((r) => r.y + r.h)) + MGAP : 0; // an empty band goes just under the last row
    const y0 = rs.length ? Math.min(...rs.map((r) => r.y)) : bottom, y1 = rs.length ? Math.max(...rs.map((r) => r.y + r.h)) : bottom + 120;
    d.items.push({ id, type: "frame", role: "rgroup", label: "", color: GROUP_COLORS[(n + 3) % GROUP_COLORS.length], x: 0, y: y0, w: RG_W, h: Math.max(120, y1 - y0) });
    rs.forEach((r) => { r.group = id; r._keep = true; }); d.items = reflow(d.items); return d; }); setEditingLabel(id); };
  const addRow = () => { const id = rid(); apply((d) => { d.items.push({ id, type: "frame", role: "row", label: "", x: 0, y: 1e9, w: ROWHEAD_W, h: rowHeadH(1) }); d.items = reflow(d.items); return d; }); setEditingLabel(id); };
  const removeFrame = (f) => apply((d) => { // a scaffold piece takes its cells (not their people) with it
    const gone = new Set([f.id]);
    if (f.role === "group") d.items.filter((i) => i.role === "col" && i.group === f.id).forEach((c) => gone.add(c.id));
    if (f.role === "rgroup") d.items.forEach((i) => { if (i.role === "row" && i.group === f.id) i.group = null; }); // rows stay, just ungrouped
    d.items.filter((i) => i.role === "cell" && ([...gone].includes(i.col) || i.row === f.id)).forEach((c) => gone.add(c.id));
    d.items = d.items.filter((i) => !gone.has(i.id)); if (f.role) d.items = layoutMatrix(d.items); return d; });
  const addToFrame = (frameId, pick, lead) => { const id = rid(); apply((d) => { const f = d.items.find((i) => i.id === frameId); if (!f) return d; const n = d.items.filter((i) => i.type === "card" && ownerOf(i, d.items)?.id === f.id).length;
    // land it inside the box, bottom-right, pinned to it — the layout then orders it last
    d.items.push({ id, type: "card", in: f.role ? f.id : undefined, x: f.x + Math.max(CPAD, f.w - CARD_W - CPAD), y: f.y + Math.max(CPAD, f.h - CARD_H - CPAD), ref: pick.ref || null, name: pick.ref ? "" : (pick.name || ""), title: "", cat: pick.ref ? "auto" : "hire", lead: !!lead || (f.role === "cell" && n === 0) }); if (f.role) d.items = reflow(d.items); return d; }); return id; };
  const colOrder = items.filter((i) => i.role === "col").map((c) => c.id);
  const selCells = [...sel].map((id) => byId.get(id)).filter((i) => i?.role === "cell");
  const rowOrder = items.filter((i) => i.role === "row").map((r) => r.id);
  const contiguous = (idx) => { for (let i = 1; i < idx.length; i++) if (idx[i] !== idx[i - 1] + 1) return false; return true; };
  // merging: cells side by side in a row, or stacked in a column — an already-merged cell can be
  // merged further with its neighbours (the ranges it covers just have to join up)
  const mergeable = (() => { if (selCells.length < 2) return null;
    const expand = (c, dir) => { const i0 = dir === "across" ? colOrder.indexOf(c.col) : rowOrder.indexOf(c.row); const n = dir === "across" ? (c.span || 1) : (c.vspan || 1); return Array.from({ length: n }, (_, k) => i0 + k); };
    if (new Set(selCells.map((c) => c.row)).size === 1 && new Set(selCells.map((c) => c.vspan || 1)).size === 1) { const idx = [...new Set(selCells.flatMap((c) => expand(c, "across")))].sort((a, b) => a - b); return contiguous(idx) ? { dir: "across", idx } : null; }
    if (new Set(selCells.map((c) => c.col)).size === 1 && new Set(selCells.map((c) => c.span || 1)).size === 1) { const idx = [...new Set(selCells.flatMap((c) => expand(c, "down")))].sort((a, b) => a - b); return contiguous(idx) ? { dir: "down", idx } : null; }
    return null; })();
  const mergeCells = () => { if (!mergeable) return; const { dir, idx } = mergeable; const first = selCells.find((c) => (dir === "across" ? colOrder.indexOf(c.col) : rowOrder.indexOf(c.row)) === idx[0]); const n = idx[idx.length - 1] - idx[0] + 1;
    apply((d) => { const keep = d.items.find((i) => i.id === first.id); if (dir === "across") keep.span = n; else keep.vspan = n; const others = selCells.filter((c) => c.id !== first.id).map((c) => c.id);
      d.items.forEach((i) => { if (i.type === "card" && others.includes(i.in)) { i.in = keep.id; i.x = keep.x + CPAD; i.y = keep.y + CPAD; } });
      d.items = d.items.filter((i) => !others.includes(i.id)); d.items = reflow(d.items); return d; }); setSel(new Set([first.id])); };
  const transpose = () => apply((d) => { d.items = reflow(transposeItems(d.items)); return d; });
  const splitCell = (cell) => apply((d) => { const c = d.items.find((i) => i.id === cell.id); if (c) { delete c.span; delete c.vspan; } d.items = reflow(d.items); return d; });
  const shrinkCell = (cell) => apply((d) => { const c = d.items.find((i) => i.id === cell.id); if (!c) return d; if (c.vspan > 1) { c.vspan -= 1; if (c.vspan === 1) delete c.vspan; } else if (c.span > 1) { c.span -= 1; if (c.span === 1) delete c.span; } d.items = reflow(d.items); return d; }); // peel the last row / column off a merge
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
    if (present) { e.stopPropagation(); if (it.type === "frame" && ["col", "row", "group", "rgroup"].includes(it.role)) { setFocusId(it.id); setPmode("focus"); } return; }
    e.stopPropagation(); setMenu(null);
    if (linkFromRef.current && it.type === "card") { if (linkFromRef.current !== it.id) addLink(linkFromRef.current, it.id); setLinkFrom(null); return; }
    let next = new Set(selRef.current);
    if (e.shiftKey) { next.has(it.id) ? next.delete(it.id) : next.add(it.id); }
    else if (!next.has(it.id)) next = new Set([it.id]);
    setSel(next); setSelLink(null);
    const ids = withContents([...next]); const start = toWorld(e.clientX, e.clientY);
    const orig = new Map(ids.map((id) => { const o = byId.get(id); return [id, { x: o.x, y: o.y }]; }));
    dragRef.current = { kind: "move", ids, start, orig, preShift: new Map(orig), moved: false, clickId: it.id }; // layers switch only once it actually moves (a click must leave the DOM node alone, or double-click never fires)
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* synthetic events have no active pointer */ }
  };
  const onResizeDown = (e, it) => { e.stopPropagation(); if (e.button !== 0) return; const start = toWorld(e.clientX, e.clientY); dragRef.current = { kind: "resize", id: it.id, start, w: it.w, h: it.h }; setSel(new Set([it.id])); };
  const onCanvasDown = (e) => {
    if (e.button === 1 || spaceDown || e.button === 0 && e.altKey || present) { dragRef.current = { kind: "pan", sx: e.clientX, sy: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y }; return; }
    if (e.button !== 0) return;
    setMenu(null); setLinkFrom(null); setSelLink(null); if (!e.shiftKey) setSel(new Set());
    const start = toWorld(e.clientX, e.clientY); dragRef.current = { kind: "marquee", start, add: e.shiftKey ? new Set(selRef.current) : new Set() }; setMarquee({ x: start.x, y: start.y, w: 0, h: 0 });
  };
  const onMove = (e) => {
    const d = dragRef.current; if (!d) return;
    if (d.kind === "pan") { setView((v) => ({ ...v, x: d.vx + e.clientX - d.sx, y: d.vy + e.clientY - d.sy })); return; }
    const p = toWorld(e.clientX, e.clientY);
    if (d.kind === "move") { const dx = p.x - d.start.x, dy = p.y - d.start.y;
      if (!d.moved && Math.abs(dx) + Math.abs(dy) > 2) { d.moved = true;
        // items leaving a frozen strip: shift their world position by the strip's offset so they
        // render under the pointer once they move into the scrolling layer
        const pin = pinInfo(); const v = viewRef.current; const sx = (pin.pinX - v.x) / v.z, sy = (pin.pinY - v.y) / v.z;
        if (pin.on && (sx || sy)) { const all = docRef.current.items; d.ids.forEach((id) => { const i = all.find((x) => x.id === id); if (!i) return; const layer = pinLayerOf(i, all); const o = d.orig.get(id); if (layer === "left") d.orig.set(id, { x: o.x + sx, y: o.y }); else if (layer === "top") d.orig.set(id, { x: o.x, y: o.y + sy }); }); }
        setDragIds(new Set(d.ids)); }
      if (!d.moved) return;
      setDocState((cur) => { const n = { ...cur, items: cur.items.map((i) => (d.orig.has(i.id) ? { ...i, x: d.orig.get(i.id).x + dx, y: d.orig.get(i.id).y + dy } : i)) }; docRef.current = n; return n; }); return; }
    if (d.kind === "resize") { setDocState((cur) => { const n = { ...cur, items: cur.items.map((i) => (i.id === d.id ? { ...i, w: Math.max(160, d.w + p.x - d.start.x), h: Math.max(80, d.h + p.y - d.start.y) } : i)) }; docRef.current = n; return n; }); return; }
    if (d.kind === "marquee") { const r = { x: Math.min(d.start.x, p.x), y: Math.min(d.start.y, p.y), w: Math.abs(p.x - d.start.x), h: Math.abs(p.y - d.start.y) }; setMarquee(r);
      const hit = (docRef.current.items || []).filter((i) => { const ir = rectOf(i); return ir.x >= r.x && ir.y >= r.y && ir.x + ir.w <= r.x + r.w && ir.y + ir.h <= r.y + r.h; }).map((i) => i.id); setSel(new Set([...d.add, ...hit])); }
  };
  const onUp = (e) => {
    const d = dragRef.current; dragRef.current = null; setMarquee(null); setDragIds(new Set());
    if (!d) return;
    if (d.kind === "move") {
      if (!d.moved) { // a plain click on a card opens its menu
        if (d.preShift) { const n = { ...docRef.current, items: docRef.current.items.map((i) => (d.preShift.has(i.id) ? { ...i, ...d.preShift.get(i.id) } : i)) }; docRef.current = n; setDocState(n); }
        const it = byId.get(d.clickId); if (it && it.type === "card" && !e.shiftKey) { const el = document.querySelector(`[data-id="${it.id}"]`); const r = el.getBoundingClientRect(); setMenu({ id: it.id, rect: { left: r.left, top: r.top, bottom: r.bottom } }); }
        return; }
      const before = { ...docRef.current, items: docRef.current.items.map((i) => (d.preShift?.has(i.id) ? { ...i, ...d.preShift.get(i.id) } : d.orig.has(i.id) ? { ...i, ...d.orig.get(i.id) } : i)) };
      setHistory((h) => [...h.slice(-59), before]);
      setDoc({ ...docRef.current, items: reflow(docRef.current.items.map((i) => (d.orig.has(i.id) ? { ...i, x: snap(i.x), y: snap(i.y) } : i)), new Set(d.orig.keys())) });
    }
    if (d.kind === "resize") { const before = { ...docRef.current, items: docRef.current.items.map((i) => (i.id === d.id ? { ...i, w: d.w, h: d.h } : i)) }; setHistory((h) => [...h.slice(-59), before]); setDoc({ ...docRef.current, items: docRef.current.items.map((i) => (i.id === d.id ? { ...i, w: snap(i.w), h: snap(i.h) } : i)) }); }
  };

  // ---- render --------------------------------------------------------------------------------
  const saveName = (v) => { const nv = v.trim() || "Untitled canvas"; setName(nv); scheduleSave(undefined, nv); setEditingName(false); onRenamed && onRenamed(); };
  const openPicker = (e, p) => { const r = e.currentTarget.getBoundingClientRect(); setMenu(null); setPicker({ ...p, rect: { left: r.left, top: r.top, bottom: r.bottom } }); };

  if (loadError) return (<div className="org-root"><style>{sharedStyles}</style><button className="tb" onClick={onBack}>← Back</button><p style={{ marginTop: 24 }}>Couldn't load this canvas: {loadError}</p></div>);
  if (tooNew) return (<div className="org-root"><style>{sharedStyles}</style><button className="tb" onClick={onBack}>← Back</button><p style={{ marginTop: 24, maxWidth: 560, lineHeight: 1.6 }}>This canvas was saved by a newer version of the app. <strong>Reload the page</strong> to get the latest version.</p><button className="tb tb-primary" onClick={() => window.location.reload()}>Reload</button></div>);
  if (!doc) return <div style={{ padding: 60, fontFamily: "Iowan Old Style, Georgia, serif", color: "#8a7d6c" }}>Loading…</div>;

  const vItems = present ? presentItems(items, pmode, focusId) : items; shownRef.current = vItems;
  const vFrames = vItems.filter((i) => i.type === "frame"); const vById = new Map(vItems.map((i) => [i.id, i]));
  const linkGeom = (l) => { const a = vById.get(l.from), b = vById.get(l.to); if (!a || !b) return null; const ra = rectOf(a), rb = rectOf(b); const ca = { x: ra.x + ra.w / 2, y: ra.y + ra.h / 2 }, cb = { x: rb.x + rb.w / 2, y: rb.y + rb.h / 2 };
    const clip = (r, c, o) => { const dx = o.x - c.x, dy = o.y - c.y; if (!dx && !dy) return c; const sx = (r.w / 2) / Math.abs(dx || 1e-9), sy = (r.h / 2) / Math.abs(dy || 1e-9); const s = Math.min(sx, sy); return { x: c.x + dx * s, y: c.y + dy * s }; };
    return { a: clip(ra, ca, cb), b: clip(rb, cb, ca) }; };
  const headP = person(doc.headRef);
  const menuItem = menu && vById.get(menu.id);
  const selFrame = sel.size === 1 && vById.get([...sel][0])?.type === "frame" ? vById.get([...sel][0]) : null;

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
        <button className="mx-lead" disabled={present} onClick={(e) => !present && openPicker(e, { mode: "head" })} title="Levels are coloured by depth under this person">
          <Crown size={14} strokeWidth={1.7} />
          {headP ? <span><strong>{headP.name}</strong><em>org head · levels counted from here</em></span> : <span><strong>Set the org head</strong><em>to colour people by level</em></span>}
        </button>
        <div className="mx-spacer" />
        {present ? (
          <div className="cv-tools">
            {pmode === "focus" && <button className="tb" onClick={() => { setPmode("overview"); setFocusId(null); }}><BackIcon size={14} strokeWidth={1.8} /> Overview</button>}
            <div className="cv-seg">
              <button className={pmode === "slide" ? "on" : ""} onClick={() => { setPmode("slide"); setFocusId(null); }}>Slide</button>
              <button className={pmode === "overview" ? "on" : ""} onClick={() => { setPmode("overview"); setFocusId(null); }}>Overview</button>
              <button className={pmode === "extended" ? "on" : ""} onClick={() => { setPmode("extended"); setFocusId(null); }}>Extended</button>
            </div>
            <span className="cv-hint-inline">{pmode === "slide" ? "one screen, scaled to fit" : pmode === "overview" ? "click a department to open it" : pmode === "focus" ? (vById.get(focusId)?.label || "") : "everyone, every box"}</span>
          </div>
        ) : (
        <div className="cv-tools">
          <button className="tb" onClick={(e) => openPicker(e, { mode: "add" })} title="Add people from the functional org"><UserPlus size={14} strokeWidth={1.7} /> Person</button>
          <button className="tb" onClick={addHire} title="Add a role to be hired"><Plus size={14} strokeWidth={1.7} /> To hire</button>
          <button className="tb" onClick={addFrame} title="Add a free box"><Square size={14} strokeWidth={1.7} /> Box</button>
          <span className="tb-sep" />
          {hasMatrix ? (<>
            <button className="tb" onClick={addGroup} title="Add a band across the top that groups columns (e.g. CPTO)"><Plus size={13} strokeWidth={1.8} /> Column group</button>
            <button className="tb" onClick={() => addCol(selFrame?.role === "group" ? selFrame.id : selFrame?.role === "col" ? selFrame.group : null)} title="Add a column — into the selected band"><Plus size={13} strokeWidth={1.8} /> Column</button>
            <button className="tb" onClick={addRow} title="Add a row"><Plus size={13} strokeWidth={1.8} /> Row</button>
            <button className="tb" onClick={addRowGroup} title="Add a band down the left that groups the selected rows (e.g. Stays)"><Plus size={13} strokeWidth={1.8} /> Row group</button>
            <button className="tb" onClick={relayout} title="Snap the matrix back into a clean grid"><LayoutGrid size={14} strokeWidth={1.7} /> Re-layout</button>
            <button className="tb" onClick={() => { if (window.confirm("Swap rows and columns?")) transpose(); }} title="Swap rows ↔ columns"><ArrowLeftRight size={14} strokeWidth={1.7} /> Swap</button>
          </>) : <button className="tb" onClick={startMatrix} title="Start a matrix: verticals across, functions down, people where they meet"><LayoutGrid size={14} strokeWidth={1.7} /> Start a matrix</button>}
          <button className={`tb ${linkFrom ? "tb-primary" : ""}`} disabled={!linkFrom && !(sel.size === 1 && vById.get([...sel][0])?.type === "card")} onClick={() => setLinkFrom(linkFrom ? null : [...sel][0])} title="Select a person, then click the person they have a dotted line to"><Link2 size={14} strokeWidth={1.7} /> {linkFrom ? "Click the other person…" : "Dotted line"}</button>
          {mergeable && <button className="tb" onClick={mergeCells} title="Merge these cells into one across the verticals"><LayoutGrid size={14} strokeWidth={1.7} /> Merge {selCells.length}</button>}
          {selFrame?.role === "cell" && (selFrame.span > 1 || selFrame.vspan > 1) && <>
            <button className="tb" onClick={() => shrinkCell(selFrame)} title={selFrame.vspan > 1 ? "Take the bottom row out of this merge" : "Take the right-hand column out of this merge"}><LayoutGrid size={14} strokeWidth={1.7} /> Unmerge last</button>
            <button className="tb" onClick={() => splitCell(selFrame)} title="Split this merged cell back into single cells"><LayoutGrid size={14} strokeWidth={1.7} /> Split all</button>
          </>}
          {selFrame?.role === "cell" && (() => { const r = vById.get(selFrame.row); const heads = r ? vItems.filter((i) => i.type === "card" && ownerOf(i, vItems)?.id === r.id) : []; return (
            <label className="cv-reports" title="Who this box reports to — any person sitting in its row box">
              <span>reports to</span>
              <select value={selFrame.headId || ""} onChange={(e) => update(selFrame.id, { headId: e.target.value || null })}>
                <option value="">{r?.label || "row"} (default)</option>
                {heads.map((h) => <option key={h.id} value={h.id}>{person(h.ref)?.name || h.name || "Open role"}</option>)}
              </select>
            </label>); })()}
          {selFrame && !selFrame.role && <button className="tb" onClick={() => tidy(selFrame.id)} title="Arrange the people in this box in a neat grid"><LayoutGrid size={14} strokeWidth={1.7} /> Tidy box</button>}
          {sel.size > 0 && <button className="tb tb-danger" onClick={removeSel} title="Remove selected (⌫)"><Trash2 size={14} strokeWidth={1.7} /></button>}
        </div>)}
        <div className="mx-zoom">
          <button onClick={() => zoomBy(1 / 1.15)} aria-label="Zoom out"><Minus size={14} strokeWidth={1.9} /></button>
          <button className="mx-zoom-pct" onClick={() => setView((v) => ({ ...v, z: 1 }))}>{Math.round(view.z * 100)}%</button>
          <button onClick={() => zoomBy(1.15)} aria-label="Zoom in"><Plus size={14} strokeWidth={1.9} /></button>
          <button className="mx-zoom-fit" onClick={fit} title="Fit everything (⌘0)"><Maximize2 size={13} strokeWidth={1.8} /> Fit</button>
        </div>
        {!present && <button className="tb" onClick={undo} disabled={!history.length} title="Undo (⌘Z)"><RotateCcw size={14} strokeWidth={1.5} /></button>}
        {hasMatrix && <button className={`tb ${present ? "tb-primary" : ""}`} onClick={() => setPresent(!present)} title={present ? "Back to editing" : "Present: read-only overview → department → extended view (the URL becomes shareable)"}><Presentation size={14} strokeWidth={1.7} /> {present ? "Exit" : "Present"}</button>}
        {hasMatrix && <button className={`tb ${freeze ? "" : "tb-off"}`} onClick={() => setFreeze(!freeze)} title={freeze ? "Headers are frozen while you scroll — click to unfreeze" : "Freeze the top headers and left-hand heads while you scroll"}>{freeze ? <Pin size={14} strokeWidth={1.7} /> : <PinOff size={14} strokeWidth={1.7} />}</button>}
        <button className={`tb ${showLegend ? "" : "tb-off"}`} onClick={() => setShowLegend((s) => !s)} title="Legend"><Palette size={14} strokeWidth={1.6} /></button>
        {!present && <div className={`mx-save mx-save-${saveStatus}`}>{saveStatus === "saving" ? "Saving…" : saveStatus === "error" ? "Save error" : "Saved"}</div>}
      </header>
      {rescue && (
        <div className="mx-rescue">
          <div><strong>This canvas looks emptier than the last version saved from this browser</strong> ({new Date(rescue.at).toLocaleString()}).</div>
          <button className="tb tb-primary" onClick={() => { setHistory((h) => [...h, docRef.current]); setDoc(rescue.doc); setRescue(null); }}>Restore that version</button>
          <button className="tb" onClick={() => { try { localStorage.removeItem(bkKey(chartId)); } catch { /* ignore */ } setRescue(null); }}>Keep what's here</button>
        </div>
      )}

      {(() => {
        // frozen panes: the top header strip (group bands + vertical headers) pins to the top edge
        // when you scroll past it; the left strip (row-group bands + function heads) pins to the
        // left edge. Everything else scrolls underneath.
        const PAD = PIN_PAD; const pinned = freeze && hasMatrix;
        const pinY = pinned ? Math.max(view.y, PAD) : view.y, pinX = pinned ? Math.max(view.x, PAD) : view.x;
        const hasGroups = vItems.some((i) => i.role === "group"), hasRG = vItems.some((i) => i.role === "rgroup");
        const tops = vFrames.filter((f) => f.role === "group" || f.role === "col"), lefts = vFrames.filter((f) => f.role === "row" || f.role === "rgroup");
        const headerBottom = tops.length ? Math.max(...tops.map((f) => f.y + f.h)) : 0, leftRight = lefts.length ? Math.max(...lefts.map((f) => f.x + f.w)) : 0; void hasGroups; void hasRG;
        const layerOf = (it) => (!pinned || dragIds.has(it.id)) ? "main" : pinLayerOf(it, vItems);
        const frameEl = (f) => (
            <div key={f.id} data-id={f.id} className={`cv-frame ${f.role ? `cv-${f.role}` : ""} ${sel.has(f.id) ? "cv-sel" : ""} ${present && ["col", "row", "group", "rgroup"].includes(f.role) ? "cv-clickable" : ""} ${present && focusId === f.id ? "cv-focus" : ""} ${present && f.role === "cell" && f.count === 0 ? "cv-cell-none" : ""}`} style={{ left: f.x, top: f.y, width: f.w, height: f.h, background: f.role === "group" ? f.color : f.role === "col" ? "#fffdf8" : f.role ? undefined : (f.tint || TINTS[0]), "--g": f.role === "col" ? (vById.get(f.group)?.color || "#8a7d6c") : f.color }}
              onPointerDown={(e) => onItemDown(e, f)} onDoubleClick={(e) => { e.stopPropagation(); if (!present && f.role !== "cell") setEditingLabel(f.id); }}>
              {present && f.role === "cell" && pmode !== "extended" && !vItems.some((i) => i.type === "card" && i.in === f.id) && f.count > 0 && <span className="cv-count" title={`${f.count} ${f.count === 1 ? "person" : "people"}`}>{f.count}</span>}
              {!present && f.role === "cell" && <button className="cv-cell-add" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { const rr = e.currentTarget.getBoundingClientRect(); setMenu(null); setPicker({ mode: "cell", frameId: f.id, rect: { left: rr.left, top: rr.top, bottom: rr.bottom } }); }} title="Add people here"><Plus size={12} strokeWidth={2} /></button>}
              {!present && (f.role === "rgroup" || f.role === "row" || f.role === "col" || f.role === "group") && <button className="cv-cell-add" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { const rr = e.currentTarget.getBoundingClientRect(); setMenu(null); setPicker({ mode: "cell", frameId: f.id, rect: { left: rr.left, top: rr.top, bottom: rr.bottom } }); }} title="Add people here"><Plus size={12} strokeWidth={2} /></button>}
              {!present && (f.role === "group" || f.role === "rgroup") && sel.has(f.id) && <div className="cv-tint-row" onPointerDown={(e) => e.stopPropagation()}>{GROUP_COLORS.map((t) => <button key={t} className={`cv-tint ${f.color === t ? "cv-tint-on" : ""}`} style={{ background: t }} onClick={() => update(f.id, { color: t })} />)}</div>}
              {editingLabel === f.id
                ? <input autoFocus className="cv-frame-input" defaultValue={f.label} onPointerDown={(e) => e.stopPropagation()} onBlur={(e) => { update(f.id, { label: e.target.value.trim() }); setEditingLabel(null); }} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setEditingLabel(null); }} placeholder="Name this box" />
                : f.role !== "cell" && <div className={`cv-frame-label ${f.label ? "" : "cv-frame-label-empty"}`}>{f.label || "Double-click to name"}</div>}
              {sel.has(f.id) && !f.role && <>
                <div className="cv-tint-row" onPointerDown={(e) => e.stopPropagation()}>{TINTS.map((t) => <button key={t} className={`cv-tint ${f.tint === t ? "cv-tint-on" : ""}`} style={{ background: t }} onClick={() => update(f.id, { tint: t })} />)}</div>
                <div className="cv-resize" onPointerDown={(e) => onResizeDown(e, f)} />
              </>}
            </div>);
        const cardEl = (c) => { const p = person(c.ref); const cat = catOf(c); const col = colorOf(c); const nm = p?.name || c.name || "Open role"; const missing = c.ref && source.ready && !p; return (
            <div key={c.id} data-id={c.id} className={`cv-card cv-cat-${cat} ${c.lead ? "cv-lead" : ""} ${c.letGo ? "cv-letgo" : ""} ${sel.has(c.id) ? "cv-sel" : ""} ${linkFrom === c.id ? "cv-link-src" : ""} ${missing ? "cv-missing" : ""}`} onPointerDown={(e) => onItemDown(e, c)} style={{ left: c.x, top: c.y, width: CARD_W, height: CARD_H, "--c": col, cursor: present ? "default" : undefined }} title={p ? `${p.title || ""}${p.managerName ? ` · reports to ${p.managerName}` : ""}` : ""}>
              <span className="cv-avatar">{cat === "hire" && !c.name ? "?" : initials(nm)}</span>
              <span className="cv-text"><strong>{nm}</strong><em>{c.title || p?.title || (cat === "hire" ? "to be hired" : "")}</em></span>
              {c.letGo && !present && <span className="cv-flag" title="Flagged: to let go"><Flag size={10} strokeWidth={2.2} /> let go</span>}
            </div>); };
        const L = { main: [], top: [], left: [] }; vFrames.forEach((f) => L[layerOf(f)].push(frameEl(f))); const CL = { main: [], top: [], left: [] }; vItems.filter((i) => i.type === "card").forEach((c) => CL[layerOf(c)].push(cardEl(c)));
        if (present && pmode === "slide") return <SlideView items={items} person={person} legend={legend} catOf={catOf} title={name} />;
        return (
      <div ref={cvRef} className={`cv-canvas ${spaceDown ? "cv-panning" : ""} ${linkFrom ? "cv-linking" : ""}`} onPointerDown={onCanvasDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp}>
        <div className="cv-layer" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}>
          <svg className="cv-links cv-autolinks" style={{ overflow: "visible" }}>
            {vFrames.filter((f) => f.role === "cell").map((cell) => { const r = vById.get(cell.row), c = vById.get(cell.col); const g = c && vById.get(c.group); const col = g?.color || "#8a7d6c"; return (
              <g key={cell.id}>
                {r && cell.vspan > 1 && Array.from({ length: cell.vspan - 1 }, (_, k) => { const rr = vById.get(rowOrder[rowOrder.indexOf(r.id) + k + 1]); return rr ? <line key={k} x1={rr.x + rr.w} y1={rr.y + 30} x2={cell.x} y2={rr.y + 30} stroke="#8a7d6c" strokeWidth="1.5" strokeDasharray="3 4" /> : null; })}
                {r && (() => { const hc = cell.headId && vById.get(cell.headId); if (!hc) return <line x1={r.x + r.w} y1={cell.y + 30} x2={cell.x} y2={cell.y + 30} stroke="#8a7d6c" strokeWidth="1.5" strokeDasharray="3 4" />;
                  const x1 = hc.x + CARD_W, y1 = hc.y + CARD_H / 2, x2 = cell.x, y2 = cell.y + 30, xm = r.x + r.w + 10;
                  return <polyline points={`${x1},${y1} ${xm},${y1} ${xm},${y2} ${x2},${y2}`} fill="none" stroke="#8a7d6c" strokeWidth="1.5" strokeDasharray="3 4" />; })()}
                {c && Array.from({ length: cell.span || 1 }, (_, k) => { const cc = vById.get(colOrder[colOrder.indexOf(c.id) + k]); if (!cc) return null; const gg = vById.get(cc.group); return <line key={k} x1={cc.x + cc.w / 2} y1={cc.y + cc.h} x2={cc.x + cc.w / 2} y2={cell.y} stroke={gg?.color || col} strokeWidth="1.5" strokeDasharray="3 4" />; })}
              </g>); })}
          </svg>
          {L.main}
          <svg className="cv-links" style={{ overflow: "visible" }}>
            {doc.links.map((l) => { const g = linkGeom(l); if (!g) return null; return (
              <g key={l.id} className={`cv-link ${selLink === l.id ? "cv-link-sel" : ""}`} onPointerDown={(e) => { e.stopPropagation(); setSel(new Set()); setSelLink(l.id); setMenu(null); }}>
                <line x1={g.a.x} y1={g.a.y} x2={g.b.x} y2={g.b.y} className="cv-link-hit" />
                <line x1={g.a.x} y1={g.a.y} x2={g.b.x} y2={g.b.y} className="cv-link-line" strokeDasharray={l.style === "solid" ? "0" : "5 5"} />
                <circle cx={g.a.x} cy={g.a.y} r="3.5" className="cv-link-dot" /><circle cx={g.b.x} cy={g.b.y} r="3.5" className="cv-link-dot" />
              </g>); })}
          </svg>
          {CL.main}
          {marquee && <div className="cv-marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />}
        </div>
        {pinned && <>
          <div className="cv-pinbg cv-pinbg-top" style={{ height: pinY + headerBottom * view.z + 6, opacity: view.y < PAD ? 1 : 0 }} />
          <div className="cv-layer cv-pinlayer" style={{ transform: `translate(${view.x}px, ${pinY}px) scale(${view.z})` }}>{L.top}{CL.top}</div>
          <div className="cv-pinbg cv-pinbg-left" style={{ width: pinX + leftRight * view.z + 6, opacity: view.x < PAD ? 1 : 0 }} />
          <div className="cv-layer cv-pinlayer" style={{ transform: `translate(${pinX}px, ${view.y}px) scale(${view.z})` }}>{L.left}{CL.left}</div>
          <div className="cv-pinbg cv-pinbg-corner" style={{ width: pinX + leftRight * view.z + 6, height: pinY + headerBottom * view.z + 6, opacity: view.y < PAD || view.x < PAD ? 1 : 0 }} />
        </>}
        {vItems.length === 0 && <div className="cv-empty">A blank canvas. <strong>Start a matrix</strong> (verticals across, functions down, people where they meet) or add <strong>people</strong> and <strong>boxes</strong> freely and draw <strong>dotted lines</strong>. Drag to move, shift-click to select several, scroll to pan, ⌘-scroll to zoom.</div>}
        {showLegend && (
          <div className="cv-legend" onPointerDown={(e) => e.stopPropagation()}>
            <div className="cv-legend-head">Legend {!present && <span>click a label to rename · swatch to recolour</span>}</div>
            {CAT_ORDER.map((k) => { const L = legend[k] || DEFAULT_LEGEND[k]; return (
              <div key={k} className="cv-legend-row">
                <label className="cv-swatch" style={{ background: L.color }}>{!present && <input type="color" value={L.color} onChange={(e) => setLegend(k, { color: e.target.value })} />}</label>
                <input className="cv-legend-label" value={L.label} readOnly={present} onChange={(e) => !present && setLegend(k, { label: e.target.value })} />
              </div>); })}
            {!present && <div className="cv-legend-row cv-legend-static"><span className="cv-flag"><Flag size={10} strokeWidth={2.2} /> let go</span><span className="cv-legend-text">flagged to let go (card menu)</span></div>}
            {!doc.headRef && <div className="cv-legend-hint">Set the org head (top left) and levels colour themselves.</div>}
          </div>
        )}
      </div>
        ); })()}

      {picker && <PeoplePicker ctx={picker.mode === "head" ? { title: "Who heads this org?", hint: "Levels are counted from this person.", clearable: !!doc.headRef }
        : picker.mode === "cell" ? (() => { const f = byId.get(picker.frameId); const r = f?.role === "cell" ? byId.get(f.row) : f; const c = f?.role === "cell" ? byId.get(f.col) : null; const rg = r?.role === "row" && r.group ? byId.get(r.group) : null; const cg = c && c.group ? byId.get(c.group) : null; const boxes = new Set([r?.id, rg?.id, c?.id, cg?.id].filter(Boolean)); const heads = items.filter((i) => i.type === "card" && i.ref && boxes.has(ownerOf(i, items)?.id)).map((i) => i.ref); return { title: `${r?.label || "Function"}${c ? ` × ${c.label || "vertical"}` : ""}`, anchors: [...new Set([...heads, doc.headRef].filter(Boolean))].map((id) => ({ id, label: `${person(id)?.name || "?"}'s org` })), byTeam: true, multi: true, allowNew: true, taken: new Set(f ? items.filter((i) => i.ref && ownerOf(i, items)?.id === f.id).map((i) => i.ref) : []) }; })()
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
            <button className="tb" title="Make a copy of this person to drag into another box (⌘D also copies the selection)" onClick={() => { const id = rid(); apply((d) => { const src = d.items.find((i) => i.id === c.id); if (!src) return d; const { in: _in, lead, ...rest } = src; d.items.push({ ...rest, id, x: snap(src.x + CARD_W + 40), y: snap(src.y), lead: false }); return d; }); setMenu(null); setSel(new Set([id])); }}><Copy size={13} /> Copy</button>
            <button className={`tb ${c.letGo ? "tb-flag-on" : ""}`} onClick={() => update(c.id, { letGo: !c.letGo })} title="Flag this person as to let go"><Flag size={13} /> {c.letGo ? "To let go" : "Let go?"}</button>
            <button className={`tb ${c.lead ? "tb-primary" : ""}`} onClick={() => update(c.id, { lead: !c.lead })} title="The lead sits first in its box, with a strong border"><Crown size={13} /> {c.lead ? "Lead" : "Make lead"}</button>
            <button className="tb" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu(null); setPicker({ mode: "linkTo", from: c.id, rect: { left: r.left, top: r.top, bottom: r.bottom } }); }}><Link2 size={13} /> Dotted line to…</button>
            <button className="tb tb-danger" onClick={() => { apply((d) => { d.items = d.items.filter((i) => i.id !== c.id); d.items.forEach((i) => { if (i.headId === c.id) delete i.headId; }); d.links = d.links.filter((l) => l.from !== c.id && l.to !== c.id); d.items = reflow(d.items); return d; }); setMenu(null); setSel(new Set()); }}><Trash2 size={13} /> Remove</button>
          </div>
        </div></>); })()}
    </div>
  );
}

const cvStyles = `
.cv-root { padding-bottom: 0; height: 100vh; box-sizing: border-box; display: flex; flex-direction: column; overflow: hidden; }
.cv-lock { overflow: hidden !important; height: 100%; }
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
.cv-text strong { font-family: 'Iowan Old Style', Georgia, serif; font-size: 13px; font-weight: 600; line-height: 1.15; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.cv-text em { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 10px; font-style: normal; color: var(--ink-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cv-group { border: none; border-radius: 10px; box-shadow: 0 2px 6px -2px rgba(26,22,18,.35); }
.cv-group .cv-frame-label { color: #fff; text-align: center; left: 12px; right: 12px; top: 12px; font-size: 15.5px; }
.cv-group .cv-cell-add { opacity: 0; } .cv-group:hover .cv-cell-add, .cv-group.cv-sel .cv-cell-add, .cv-col:hover .cv-cell-add, .cv-col.cv-sel .cv-cell-add { opacity: 1; } .cv-col .cv-cell-add { opacity: 0; } .cv-group .cv-frame-label-empty { color: rgba(255,255,255,.75); }
.cv-col { border: 1.5px solid #d6cdb8; border-top: 6px solid var(--g); border-radius: 8px; }
.cv-col .cv-frame-label { top: 12px; text-align: center; left: 10px; right: 10px; white-space: normal; line-height: 1.2; font-size: 14px; }
.cv-rgroup { border: none; border-radius: 10px; background: color-mix(in srgb, var(--g) 14%, #fffdf8); box-shadow: inset 5px 0 0 var(--g); }
.cv-rgroup .cv-frame-label { left: 16px; top: 10px; font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 10px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: var(--g); }
.cv-rgroup .cv-cell-add { opacity: 0; } .cv-rgroup:hover .cv-cell-add, .cv-rgroup.cv-sel .cv-cell-add { opacity: 1; }
.cv-row { background: #fffdf8; border: 1.5px solid #d6cdb8; border-radius: 10px; }
.cv-row .cv-frame-label { top: 9px; font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 10px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: var(--ink-faint); }
.cv-cell { background: rgba(255,253,248,.85); border: 1.5px solid #e2dac8; border-radius: 10px; }
.cv-cell:hover, .cv-row:hover { border-color: #bfb49a; }
.cv-cell-add { position: absolute; right: 6px; bottom: 6px; width: 22px; height: 22px; border-radius: 50%; border: 1px dashed var(--ink-faint); background: #fffdf8; color: var(--ink-soft); display: grid; place-items: center; cursor: pointer; opacity: 0; transition: opacity .12s; }
.cv-cell:hover .cv-cell-add, .cv-row:hover .cv-cell-add, .cv-cell.cv-sel .cv-cell-add { opacity: 1; } .cv-cell-add:hover { background: var(--ink); color: var(--paper); border-style: solid; }
.cv-autolinks { z-index: 0; }
.cv-card.cv-lead { border-width: 2px; border-left-width: 6px; box-shadow: 0 2px 4px rgba(26,22,18,.12), 0 8px 18px -10px rgba(26,22,18,.35); }
.cv-card.cv-lead strong { font-size: 13.5px; }
.cv-reports { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 8px 0 10px; border: 1px solid var(--line); border-radius: 9px; background: #fffdf7; font-family: 'Iowan Old Style', Georgia, serif; font-size: 12px; font-style: italic; color: var(--ink-soft); }
.cv-reports select { font: inherit; font-style: normal; border: none; background: transparent; color: var(--ink); outline: none; max-width: 180px; }
.cv-flag { position: absolute; right: -6px; top: -9px; display: inline-flex; align-items: center; gap: 3px; padding: 2px 7px; border-radius: 999px; background: #b8442a; color: #fff; font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 9.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; box-shadow: 0 1px 3px rgba(26,22,18,.25); }
.cv-letgo { border-color: #b8442a !important; background: repeating-linear-gradient(135deg, #fffdf8 0 6px, #fbeae5 6px 12px); } .cv-letgo .cv-text strong { text-decoration: line-through; text-decoration-color: #b8442a; text-decoration-thickness: 1.5px; }
.cv-legend-static { gap: 10px; } .cv-legend-static .cv-flag { position: static; } .cv-legend-text { font-size: 12.5px; color: var(--ink-soft); }
.tb-flag-on { background: #b8442a; color: #fff; border-color: #b8442a; }
.cv-pinlayer { z-index: 5; pointer-events: none; } .cv-pinlayer > * { pointer-events: auto; }
.cv-pinbg { position: absolute; left: 0; top: 0; z-index: 4; background: #faf7ef; background-image: radial-gradient(circle, #d9d1be 1px, transparent 1.2px); background-size: 24px 24px; pointer-events: none; transition: opacity .12s; }
.cv-pinbg-top { right: 0; box-shadow: 0 6px 12px -8px rgba(26,22,18,.3); } .cv-pinbg-left { bottom: 0; box-shadow: 6px 0 12px -8px rgba(26,22,18,.3); } .cv-pinbg-corner { z-index: 4; }
.cv-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 9px; overflow: hidden; height: 32px; background: #fffdf7; }
.cv-seg button { border: none; background: transparent; padding: 0 12px; font-family: 'Iowan Old Style', Georgia, serif; font-size: 13px; color: var(--ink-soft); cursor: pointer; } .cv-seg button.on { background: var(--ink); color: var(--paper); }
.cv-hint-inline { font-family: 'Iowan Old Style', Georgia, serif; font-size: 12.5px; font-style: italic; color: var(--ink-faint); margin-left: 4px; }
.cv-clickable { cursor: pointer; } .cv-clickable:hover { box-shadow: 0 0 0 3px rgba(26,22,18,.14); } .cv-focus { box-shadow: 0 0 0 3px var(--ink); }
.cv-count { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); min-width: 34px; height: 34px; padding: 0 10px; border-radius: 999px; background: var(--ink); color: var(--paper); display: grid; place-items: center; font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 13px; font-weight: 700; }
.cv-cell-none { background: transparent; border-style: dashed; border-color: #e6dfcf; }
.sl-wrap { flex: 1; min-height: 0; margin: 12px -28px 0; border-top: 1px solid var(--line); display: grid; place-items: center; overflow: auto; background: #efeadc; }
.sl-slide { width: max-content; background: #fffdf8; border: 1px solid var(--line); box-shadow: 0 24px 60px -24px rgba(26,22,18,.4); padding: 28px 34px 30px; font-family: 'Iowan Old Style', Georgia, serif; }
.sl-title { font-size: 22px; font-weight: 600; letter-spacing: -0.01em; margin-bottom: 14px; }
.sl-table { border-collapse: separate; border-spacing: 6px; }
.sl-table th, .sl-table td { vertical-align: top; text-align: left; }
.sl-corner { background: transparent; }
.sl-band { color: #fff; text-align: center !important; padding: 7px 12px; border-radius: 9px; font-size: 14px; font-weight: 700; }
.sl-band .sl-head { color: #fff; background: rgba(255,255,255,.16); } .sl-band .sl-dot { background: #fff !important; }
.sl-col { min-width: 150px; max-width: 190px; padding: 8px 10px 9px; border-radius: 8px; background: #f3eee1; font-size: 13.5px; font-weight: 700; line-height: 1.2; }
.sl-row { min-width: 160px; max-width: 200px; padding: 8px 10px 9px; border-radius: 8px; background: #f3eee1; font-size: 13px; font-weight: 700; line-height: 1.2; }
.sl-rband { width: 120px; padding: 10px 10px; border-radius: 9px; font-size: 12.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; vertical-align: top; }
.sl-rband .sl-head { color: #fff; background: rgba(255,255,255,.16); text-transform: none; letter-spacing: 0; } .sl-rband .sl-dot { background: #fff !important; }
.sl-cell { min-width: 150px; height: 52px; padding: 6px 8px; border: 1.5px dashed #e3dccb; border-radius: 8px; font-size: 12.5px; }
.sl-cell-on { border-style: solid; border-color: #d6cdb8; background: #fff; }
.sl-head { display: flex; align-items: center; gap: 6px; margin-top: 5px; font-weight: 500; font-size: 12.5px; color: var(--ink); background: #fffdf8; border: 1px solid #e3dccb; border-radius: 999px; padding: 2px 9px 2px 6px; width: max-content; max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sl-head-hire { border-style: dashed; font-style: italic; color: var(--ink-soft); } .sl-head-big { font-size: 13px; }
.sl-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.sl-count { display: inline-block; margin-top: 5px; margin-left: 2px; padding: 1px 8px; border-radius: 999px; background: var(--ink); color: var(--paper); font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 11px; font-weight: 700; }
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
