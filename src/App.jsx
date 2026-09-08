import React, { useState, useEffect, useCallback } from "react";
import { supabase, isConfigured } from "./lib/supabase.js";
import OrgChart from "./components/OrgChart.jsx";
import ChartList from "./components/ChartList.jsx";

export default function App() {
  const [currentChartId, setCurrentChartId] = useState(null);
  const [charts, setCharts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // read chart id from URL hash
  useEffect(() => {
    const readHash = () => {
      const id = window.location.hash.replace("#", "").trim();
      setCurrentChartId(id || null);
    };
    readHash();
    window.addEventListener("hashchange", readHash);
    return () => window.removeEventListener("hashchange", readHash);
  }, []);

  const loadCharts = useCallback(async () => {
    if (!isConfigured) { setLoading(false); return; }
    try {
      const { data, error: err } = await supabase
        .from("charts")
        .select("id, name, updated_at, created_at, archived:tree->>archived") // archived flag lives in the chart JSON
        .order("updated_at", { ascending: false });
      if (err) throw err;
      setCharts(data || []);
      setError(null);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadCharts(); }, [loadCharts]);

  const goTo = (id) => { window.location.hash = id || ""; };

  if (!isConfigured) {
    return (
      <div style={{ fontFamily: "Iowan Old Style, Palatino, Georgia, serif", padding: 60, maxWidth: 720, margin: "0 auto", color: "#1a1612" }}>
        <h1 style={{ fontSize: 22 }}>Setup not finished</h1>
        <p style={{ lineHeight: 1.6 }}>
          The app is missing its Supabase keys. In your Vercel project, go to <em>Settings → Environment Variables</em> and add:
        </p>
        <ul style={{ lineHeight: 1.8, fontFamily: "monospace", fontSize: 13 }}>
          <li>VITE_SUPABASE_URL</li>
          <li>VITE_SUPABASE_ANON_KEY</li>
        </ul>
        <p style={{ lineHeight: 1.6 }}>Then redeploy. Both values are in your Supabase dashboard under <em>Settings → API</em>.</p>
      </div>
    );
  }

  if (loading) {
    return <div style={{ padding: 60, fontFamily: "Iowan Old Style, Georgia, serif", color: "#8a7d6c" }}>Loading…</div>;
  }

  if (error) {
    return (
      <div style={{ padding: 60, fontFamily: "Iowan Old Style, Georgia, serif", maxWidth: 720, margin: "0 auto", color: "#1a1612" }}>
        <h1 style={{ fontSize: 20 }}>Database error</h1>
        <p style={{ background: "#f8e8e2", padding: 12, fontFamily: "monospace", fontSize: 13, border: "1px solid #b8442a" }}>{error}</p>
        <p style={{ lineHeight: 1.6, color: "#4a4036" }}>
          This usually means the database table hasn't been created yet, or the Supabase keys are wrong.
          Go back to the setup guide and run the SQL snippet, then refresh.
        </p>
      </div>
    );
  }

  if (currentChartId) {
    const meta = charts.find((c) => c.id === currentChartId);
    return (
      <OrgChart
        chartId={currentChartId}
        chartName={meta?.name}
        onBack={() => goTo(null)}
        onRenamed={loadCharts}
        onDeleted={() => { loadCharts(); goTo(null); }}
      />
    );
  }

  return (
    <ChartList
      charts={charts}
      onOpen={goTo}
      onCreated={loadCharts}
      onDeleted={loadCharts}
    />
  );
}
