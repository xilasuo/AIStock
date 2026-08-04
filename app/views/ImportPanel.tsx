"use client";

import { useState } from "react";
import { parseBrokerCsv } from "../../lib/domain/trade-import";
import { Button, Hint } from "../components/ui";

type ImportResult = {
  inserted: number;
  skipped: number;
  errors: Array<{ line: number; symbol: string; reason: string }>;
};

export function ImportPanel({ onImported }: { onImported: () => void | Promise<void> }) {
  const [csv, setCsv] = useState("");
  const [previewRows, setPreviewRows] = useState<number>(0);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState("");

  function preview() {
    setError("");
    setResult(null);
    try {
      setPreviewRows(parseBrokerCsv(csv).length);
    } catch {
      setError("CSV 解析失败，请确认格式为逗号分隔的交割单。");
    }
  }

  async function runImport() {
    if (busy) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const response = await fetch("/api/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ csv }),
      });
      const payload = await response.json() as (ImportResult & { error?: string });
      if (!response.ok) {
        setError(payload.error ?? "导入失败");
        return;
      }
      setResult({ inserted: payload.inserted, skipped: payload.skipped, errors: payload.errors });
      if (payload.inserted > 0) await onImported();
    } catch {
      setError("导入失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="import-panel">
      <header>
        <div>
          <span className="eyebrow">对账导入</span>
          <h3>从券商交割单导入</h3>
        </div>
        <Hint>粘贴券商导出的 CSV（需包含 代码 / 方向 / 价格 / 数量 / 日期 列），程序会自动识别并写入，省去手工录入。</Hint>
      </header>
      <textarea
        className="import-csv control control--area"
        value={csv}
        placeholder={"日期,代码,名称,方向,价格,数量,手续费\n2026-01-02,600000,浦发银行,买入,10.50,1000,5.00"}
        onChange={(event) => setCsv(event.target.value)}
        rows={6}
      />
      <div className="import-actions">
        <Button variant="ghost" onClick={preview} disabled={!csv.trim()}>预览解析</Button>
        <Button variant="primary" onClick={runImport} disabled={!csv.trim() || busy}>
          {busy ? "正在导入…" : "确认导入"}
        </Button>
        {previewRows > 0 && !result && <span className="import-count">识别到 {previewRows} 条成交</span>}
      </div>
      {error && <p className="form-message" role="alert">{error}</p>}
      {result && (
        <div className="import-result">
          <p><b>成功导入 {result.inserted} 条</b>{result.skipped > 0 ? `，跳过 ${result.skipped} 条` : ""}。</p>
          {result.errors.length > 0 && (
            <ul className="import-errors">
              {result.errors.slice(0, 10).map((item, index) => (
                <li key={index}>第 {item.line} 行 {item.symbol}：{item.reason}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
