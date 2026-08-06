"use client";

import React from "react";
import {
  Target,
  ClipboardCheck,
  Scale,
  ShieldAlert,
  ArrowRightCircle,
  TrendingUp,
  TrendingDown,
  PlusCircle,
  MinusCircle,
  Calculator,
  AlertTriangle,
} from "lucide-react";
import { MarkdownMessage } from "./MarkdownMessage";

export const STRATEGY_BLOCK_META: Record<string, { icon: React.ReactNode; cls: string; label: string }> = {
  结论: { icon: <Target size={15} />, cls: "strategy-block--verdict", label: "结论" },
  依据: { icon: <ClipboardCheck size={15} />, cls: "strategy-block--basis", label: "依据" },
  建议仓位: { icon: <Scale size={15} />, cls: "strategy-block--position", label: "建议仓位" },
  仓位与止损: { icon: <Scale size={15} />, cls: "strategy-block--position", label: "仓位与止损" },
  仓位计算: { icon: <Calculator size={15} />, cls: "strategy-block--calc", label: "仓位计算" },
  止盈: { icon: <TrendingUp size={15} />, cls: "strategy-block--take-profit", label: "止盈" },
  止损: { icon: <TrendingDown size={15} />, cls: "strategy-block--stop-loss", label: "止损" },
  加仓: { icon: <PlusCircle size={15} />, cls: "strategy-block--add", label: "加仓" },
  减仓: { icon: <MinusCircle size={15} />, cls: "strategy-block--reduce", label: "减仓" },
  清仓: { icon: <MinusCircle size={15} />, cls: "strategy-block--reduce", label: "清仓" },
  减仓清仓: { icon: <MinusCircle size={15} />, cls: "strategy-block--reduce", label: "减仓/清仓" },
  "减仓/清仓": { icon: <MinusCircle size={15} />, cls: "strategy-block--reduce", label: "减仓/清仓" },
  风险与缺口: { icon: <ShieldAlert size={15} />, cls: "strategy-block--risk", label: "风险与缺口" },
  风险: { icon: <AlertTriangle size={15} />, cls: "strategy-block--risk", label: "风险" },
  下一步: { icon: <ArrowRightCircle size={15} />, cls: "strategy-block--next", label: "下一步" },
};

export function StrategyBlocks({ content }: { content: string }) {
  const knownLabels = Object.keys(STRATEGY_BLOCK_META);
  const blocks: { label?: string; body: string }[] = [];

  for (const rawLine of content.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      // 保留空行以维持段落/表格间距
      if (blocks.length > 0) {
        blocks[blocks.length - 1].body += "\n";
      }
      continue;
    }
    const matchedLabel = knownLabels.find(
      (label) => trimmed.startsWith(`${label}：`) || trimmed.startsWith(`${label}:`),
    );
    if (matchedLabel) {
      const sepIndex = trimmed.indexOf("：") !== -1 ? trimmed.indexOf("：") : trimmed.indexOf(":");
      const body = trimmed.slice(sepIndex + 1).trim();
      blocks.push({ label: matchedLabel, body });
    } else if (blocks.length === 0) {
      blocks.push({ body: rawLine });
    } else {
      blocks[blocks.length - 1].body += "\n" + rawLine;
    }
  }

  return (
    <div className="strategy-blocks">
      {blocks.map((block, index) => {
        const meta = block.label ? STRATEGY_BLOCK_META[block.label] : undefined;
        if (!meta) {
          return (
            <div key={index} className="strategy-block strategy-block--plain">
              <div className="strategy-block__body strategy-table-wrap">
                <MarkdownMessage content={block.body.trim()} />
              </div>
            </div>
          );
        }
        return (
          <div key={index} className={`strategy-block ${meta.cls}`}>
            <div className="strategy-block__head">
              <span className="strategy-block__icon">{meta.icon}</span>
              <span className="strategy-block__label">{meta.label}</span>
            </div>
            <div className="strategy-block__body strategy-table-wrap">
              <MarkdownMessage content={block.body.trim()} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
