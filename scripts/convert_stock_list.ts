/**
 * 将 akshare 拉取的 A 股列表转成 TypeScript 模块。
 *
 * 一键更新全量股票列表（5534 只沪深京）：
 *   python -c "import akshare as ak; ak.stock_info_a_code_name().to_json('db/seeds/_temp.json', orient='records', force_ascii=False)" && npx tsx scripts/convert_stock_list.ts db/seeds/_temp.json && rm db/seeds/_temp.json
 */
import * as fs from "node:fs";

interface StockItem {
  code: string;
  name: string;
}

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: npx tsx scripts/convert_stock_list.ts <input.json>");
  console.error("  input.json: akshare stock_info_a_code_name() 输出的 JSON 文件");
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(inputPath, "utf-8")) as StockItem[];

const map: Record<string, string> = {};
for (const { code, name } of raw) {
  if (code && name) map[code] = name.trim();
}

const codes = Object.keys(map).sort();
console.log(`Total unique: ${codes.length}`);

const tsLines = [
  "// Auto-generated from akshare stock_info_a_code_name()",
  `// Generated at: ${new Date().toISOString()}`,
  `// Total: ${codes.length} A-share stocks (沪深京)`,
  "",
  "const A_STOCK_LIST: Record<string, string> = {",
];

for (const code of codes) {
  tsLines.push(`  "${code}": "${map[code]}",`);
}

tsLines.push("};", "", "export default A_STOCK_LIST;");

const tsContent = tsLines.join("\n");
fs.writeFileSync("db/seeds/a_stock_list.ts", tsContent, "utf-8");
console.log(`Written db/seeds/a_stock_list.ts (${codes.length} entries, ${(tsContent.length / 1024).toFixed(0)}KB)`);
