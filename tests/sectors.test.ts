import assert from "node:assert/strict";
import test from "node:test";
import { parseEtfKlines, rankSectorMoves, validateSectorDate, type SectorMove } from "../lib/market/sectors";

function move(name: string, changePercent: number, amount: number): SectorMove {
  return {
    code: `ETF${name}`,
    name,
    date: "2026-07-29",
    close: 1,
    changePercent,
    amount,
    amplitude: 0,
    turnover: 0,
  };
}

test("解析行业ETF日线并计算涨跌幅", () => {
  const result = parseEtfKlines(
    { code: "512480", name: "半导体", symbol: "sh512480" },
    [
      ["2026-07-28", "0.99", "1", "1.01", "0.98", "100"],
      ["2026-07-29", "1.01", "1.05", "1.08", "0.99", "200"],
    ],
    "2026-07-29",
  );

  assert.equal(result?.code, "512480");
  assert.ok(Math.abs((result?.changePercent ?? 0) - 5) < 0.0001);
  assert.equal(result?.amount, 210);
  assert.ok(Math.abs((result?.amplitude ?? 0) - 9) < 0.0001);
});

test("异动榜按涨跌幅绝对值排序并保留涨跌方向", () => {
  const result = rankSectorMoves([
    move("电子", 1.2, 900),
    move("煤炭", -3.1, 300),
    move("银行", 2.4, 400),
    move("通信", -2.4, 800),
    move("汽车", 0.8, 700),
    move("传媒", 4.2, 200),
    move("医药", -1.1, 600),
    move("军工", 1.6, 500),
    move("消费", -0.7, 1_000),
    move("钢铁", 0.5, 300),
    move("电力", -0.2, 200),
  ]);

  assert.deepEqual(
    result.map((item) => item.name),
    ["传媒", "煤炭", "通信", "银行", "军工", "电子", "医药", "汽车", "消费", "钢铁"],
  );
  assert.equal(result.length, 10);
  assert.equal(result[1].changePercent, -3.1);
});

test("板块日期拒绝无效日期和未来日期", () => {
  assert.equal(validateSectorDate("2026-02-30"), "日期格式不正确");
  assert.equal(validateSectorDate("2999-01-01"), "不能查询未来日期");
});
