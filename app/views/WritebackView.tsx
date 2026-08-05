"use client";

import {
  SectionHeader,
  Card,
  CardHeader,
  Tag,
  Banner,
  Hint,
  LoadingState,
} from "../components/ui";
import { useApi } from "../../lib/utils/use-api";
import { formatEngineTime } from "../../lib/utils/time";

/* ----------------------------- 数据类型 ----------------------------- */
export type WritebackSignal = {
  code: string;
  name: string;
  side: "BUY" | "SELL";
  price: number;
  quantity: number;
};

export type WritebackPayload = {
  generatedAt: string;
  dryRun: boolean;
  channel: string;
  signals: WritebackSignal[];
  note?: string;
};

export type WritebackResponse = {
  ok: boolean;
  writeback?: WritebackPayload;
  error?: string;
};

function yuan(v: number): string {
  return `¥${v.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function sideTone(side: string): "up" | "down" {
  return side === "BUY" ? "up" : "down";
}
function sideLabel(side: string): string {
  return side === "BUY" ? "买入" : "卖出";
}

/* ---------- 移动端信号卡片 ---------- */
function SignalCard({ signal }: { signal: WritebackSignal }) {
  const amount = signal.price * signal.quantity;
  return (
    <div className="wb-signal-card">
      <div className="wb-signal-card__top">
        <span className="wb-signal-card__code">{signal.code}</span>
        <Tag tone={sideTone(signal.side)}>{sideLabel(signal.side)}</Tag>
      </div>
      <div className="wb-signal-card__name">{signal.name}</div>
      <dl className="wb-signal-card__meta">
        <div>
          <dt>价格</dt>
          <dd>{yuan(signal.price)}</dd>
        </div>
        <div>
          <dt>数量</dt>
          <dd>{signal.quantity}</dd>
        </div>
      </dl>
      <div className="wb-signal-card__amount">{yuan(amount)}</div>
    </div>
  );
}

/* ------------------------------ 主视图 ------------------------------ */
export function WritebackView() {
  const { data: writeback, loading, error } = useApi<WritebackPayload>(
    async () => {
      const res = await fetch("/api/writeback-signals");
      const json = (await res.json()) as WritebackResponse;
      if (!json.ok || !json.writeback) {
        throw new Error(json.error || "暂时无法读取回写结果");
      }
      return json.writeback;
    },
  );

  if (loading) {
    return <LoadingState label="正在加载回写结果…" />;
  }
  if (error || !writeback) {
    return (
      <Banner tone="warn" title="暂无回写数据">
        {error || "请先在本地运行 trading_agent 生成候选回写信号并推送。"}
      </Banner>
    );
  }

  const totalAmount = writeback.signals.reduce(
    (sum, s) => sum + s.price * s.quantity,
    0,
  );

  return (
    <div className="writeback-view">
      <SectionHeader
        eyebrow="交易回写"
        title="回写结果"
        subtitle={`生成于 ${formatEngineTime(writeback.generatedAt)}（上海时间）｜ 候选信号 ${writeback.signals.length} 笔`}
        desc="由 trading_agent 引擎生成的候选回写信号（当前为模拟回写 dry-run）。"
      />

      {writeback.dryRun ? (
        <Banner tone="warn" title="当前为模拟回写（dry-run）">
          本环境的 tdx-connector 仅暴露查询工具，未提供下单接口，因此信号暂未真实写入券商。
          待接入带下单能力的券商 MCP 后，可切换为真实回写。
        </Banner>
      ) : (
        <Banner tone="success" title="已真实回写">
          信号已推送至券商执行通道。
        </Banner>
      )}

      <div className="stat-grid stat-grid--3 wb-stats">
        <div className="stat">
          <div className="stat__label">候选信号</div>
          <div className="stat__value">{writeback.signals.length} 笔</div>
        </div>
        <div className="stat">
          <div className="stat__label">预估金额合计</div>
          <div className="stat__value">{yuan(totalAmount)}</div>
        </div>
        <div className="stat">
          <div className="stat__label">回写状态</div>
          <div className="stat__value">{writeback.dryRun ? "模拟" : "已执行"}</div>
        </div>
      </div>

      <Card>
        <CardHeader title="候选回写信号" desc="引擎产出的待回写委托（按最新收盘推导）。" />
        {writeback.signals.length === 0 ? (
          <Hint>本次运行未产生候选回写信号。</Hint>
        ) : (
          <>
            {/* 移动端：卡片列表 */}
            <div className="wb-signals-mobile">
              {writeback.signals.map((s, i) => (
                <SignalCard key={`${s.code}-${i}`} signal={s} />
              ))}
            </div>
            {/* 桌面端：表格 */}
            <div className="wb-signals-desktop">
              <table className="wb-table">
                <thead>
                  <tr>
                    <th>代码</th>
                    <th>名称</th>
                    <th>方向</th>
                    <th>价格</th>
                    <th>数量</th>
                    <th>金额</th>
                  </tr>
                </thead>
                <tbody>
                  {writeback.signals.map((s, i) => (
                    <tr key={`${s.code}-${i}`}>
                      <td>{s.code}</td>
                      <td>{s.name}</td>
                      <td>
                        <Tag tone={sideTone(s.side)}>{sideLabel(s.side)}</Tag>
                      </td>
                      <td>{yuan(s.price)}</td>
                      <td>{s.quantity}</td>
                      <td>{yuan(s.price * s.quantity)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>

      <Hint>
        回写通道：{writeback.channel}
        {writeback.note ? ` ｜ ${writeback.note}` : ""}
      </Hint>
    </div>
  );
}
