"use client";

import { useState } from "react";
import { parseBrokerCsv, type ParsedImportRow } from "../../lib/domain/trade-import";
import { Button, Hint } from "../components/ui";

type ImportResult = {
  inserted: number;
  skipped: number;
  errors: Array<{ line: number; symbol: string; reason: string }>;
};

/** 下载券商交割单 CSV 模板（表头 + 示例行） */
function downloadTemplate() {
  const header = "日期,代码,名称,方向,价格,数量,手续费";
  const example = "2026-01-02,600000,浦发银行,买入,10.50,1000,5.00";
  const blob = new Blob([`${header}\n${example}\n`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "券商交割单模板.csv";
  link.click();
  URL.revokeObjectURL(url);
}

export function ImportPanel({ onImported }: { onImported: () => void | Promise<void> }) {
  const [csv, setCsv] = useState("");
  const [previewRows, setPreviewRows] = useState<ParsedImportRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState("");

  function preview() {
    setError("");
    setResult(null);
    try {
      setPreviewRows(parseBrokerCsv(csv));
      if (!parseBrokerCsv(csv).length) setError("没有识别到有效成交行，请检查列名（代码/方向/价格/数量/日期）是否正确。");
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
        onChange={(event) => { setCsv(event.target.value); setPreviewRows([]); setResult(null); }}
        rows={6}
      />
      <div className="import-actions">
        <Button variant="ghost" onClick={downloadTemplate}>下载 CSV 模板</Button>
        <Button variant="ghost" onClick={preview} disabled={!csv.trim()}>预览解析</Button>
        <Button variant="primary" onClick={runImport} disabled={!csv.trim() || busy}>
          {busy ? "正在导入…" : "确认导入"}
        </Button>
        {previewRows.length > 0 && !result && <span className="import-count">识别到 {previewRows.length} 条成交</span>}
      </div>
      {error && <p className="form-message" role="alert">{error}</p>}
      {previewRows.length > 0 && !result && (
        <div className="import-preview">
          <p>识别到 <b>{previewRows.length}</b> 条成交，预览前 {Math.min(5, previewRows.length)} 条：</p>
          <table className="import-preview-table">
            <thead>
              <tr><th>日期</th><th>代码</th><th>名称</th><th>方向</th><th>价格</th><th>数量</th><th>手续费</th></tr>
            </thead>
            <tbody>
              {previewRows.slice(0, 5).map((row, index) => (
                <tr key={index}>
                  <td>{row.tradeDate}</td>
                  <td>{row.symbol}</td>
                  <td>{row.name || "—"}</td>
                  <td>{row.side}</td>
                  <td>{row.price}</td>
                  <td>{row.quantity}</td>
                  <td>{row.fee ? row.fee.toFixed(2) : "0.00"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="import-preview-note">确认无误后点击「确认导入」；无法识别的行会在导入结果中列出。</p>
        </div>
      )}
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
