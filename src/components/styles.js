export const sharedStyles = `
.org-root {
  --paper: #f5f1e8;
  --paper-2: #ebe5d4;
  --ink: #1a1612;
  --ink-soft: #4a4036;
  --ink-faint: #8a7d6c;
  --rule: #d6cdb8;
  --rule-soft: #e6dfcf;
  --accent: #b8442a;
  --accent-soft: #d97757;
  --ok: #5b7a3f;
  --shadow: 0 1px 0 rgba(26, 22, 18, 0.04), 0 8px 24px -12px rgba(26, 22, 18, 0.18);
  --shadow-lift: 0 2px 0 rgba(26, 22, 18, 0.06), 0 16px 40px -12px rgba(26, 22, 18, 0.28);

  font-family: 'Iowan Old Style', 'Palatino Linotype', 'Palatino', 'Book Antiqua', Georgia, serif;
  color: var(--ink);
  background:
    radial-gradient(ellipse at top, rgba(216, 200, 160, 0.18), transparent 60%),
    radial-gradient(ellipse at bottom right, rgba(184, 68, 42, 0.04), transparent 50%),
    var(--paper);
  min-height: 100vh;
  padding: 20px 28px 60px;
  position: relative;
}
.org-root::before {
  content: "";
  position: fixed; inset: 0;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/><feColorMatrix values='0 0 0 0 0.1 0 0 0 0 0.08 0 0 0 0 0.06 0 0 0 0 0.025 0'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>");
  pointer-events: none;
  opacity: 0.6;
  z-index: 0;
}
.org-root > * { position: relative; z-index: 1; }

.topbar {
  display: flex; align-items: center; gap: 28px;
  padding: 6px 0 18px;
  border-bottom: 1px solid var(--rule);
  margin-bottom: 14px;
  flex-wrap: wrap;
}
.brand { display: flex; align-items: center; gap: 12px; }
.brand-mark {
  width: 36px; height: 36px;
  border: 1.5px solid var(--ink);
  border-radius: 50%;
  display: grid; place-items: center;
  font-size: 22px;
  font-family: 'Iowan Old Style', Georgia, serif;
}
.brand-name {
  font-family: 'Iowan Old Style', Georgia, serif;
  font-size: 19px; font-weight: 600; letter-spacing: 0.01em; line-height: 1;
}
.brand-sub {
  font-family: 'Iowan Old Style', Georgia, serif;
  font-size: 11.5px; font-style: italic;
  color: var(--ink-faint); margin-top: 4px;
}

.tb {
  font-family: inherit;
  font-size: 12.5px;
  letter-spacing: 0.02em;
  padding: 6px 11px;
  background: transparent;
  color: var(--ink);
  border: 1px solid var(--rule);
  border-radius: 2px;
  cursor: pointer;
  display: inline-flex; align-items: center; gap: 6px;
  transition: all 0.15s ease;
}
.tb:hover:not(:disabled) {
  background: var(--ink); color: var(--paper); border-color: var(--ink);
}
.tb:disabled { opacity: 0.35; cursor: not-allowed; }
.tb-sep { width: 1px; height: 18px; background: var(--rule); margin: 0 4px; }
.tb-danger:hover { background: var(--accent); border-color: var(--accent); color: var(--paper); }
.tb-primary { background: var(--ink); color: var(--paper); border-color: var(--ink); }
.tb-primary:hover { background: var(--accent); border-color: var(--accent); }

.ghost {
  width: 28px; height: 28px;
  background: transparent; border: 1px solid transparent;
  color: var(--ink-soft);
  cursor: pointer; padding: 0;
  border-radius: 2px;
  display: grid; place-items: center;
  transition: all 0.12s ease;
}
.ghost:hover { border-color: var(--rule); background: var(--paper); color: var(--ink); }
.ghost-danger:hover { border-color: var(--accent); background: rgba(184, 68, 42, 0.06); color: var(--accent); }

.foot {
  text-align: center;
  margin-top: 30px;
  font-family: 'Iowan Old Style', Georgia, serif;
  font-size: 11.5px; font-style: italic; color: var(--ink-faint);
}
`;
