// 本地引擎守护进程（真实 Node.js，运行在 Cloudflare Workers / Miniflare 沙箱之外）
//
// 背景：vinext dev 的 API 路由跑在 Workers 沙箱里，无法执行 child_process / Python。
// 因此「应用并扫描」按钮在本机也跑不了 Python。本守护进程是一层真实 Node 桥接：
//   - 前端 / Workers 路由把请求转发到 http://127.0.0.1:8787
//   - 这里用真实 Node 调起 python run_hub.py，跑完把 scan_payload.json 回传
//
// 启动：在本机另开一个终端执行 `npm run engine`（或 node trading_agent/local_engine_server.js）
// 可选环境变量：LOCAL_ENGINE_PORT（默认 8787）、LOCAL_ENGINE_HOST（默认 127.0.0.1）、PYTHON_PATH

import http from "node:http";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = __dirname; // trading_agent 目录
const PRE = path.join(BASE, "prefetched.json");
const RUN = path.join(BASE, "run_hub.py");
const PAYLOAD = path.join(BASE, "scan_payload.json");
const DUMP = path.join(BASE, "dump_config.py");
const PORT = Number(process.env.LOCAL_ENGINE_PORT || 8787);
const HOST = process.env.LOCAL_ENGINE_HOST || "127.0.0.1";

// 允许前端传递的字段白名单（与 app/api/strategy-scan/run/route.ts 的 ALLOWED_KEYS 保持一致）。
// 守护进程直接收前端 body 转发给 run_hub.py，必须复用同一白名单，防止未知键直传引擎。
const ALLOWED_KEYS = new Set([
  "preset",
  "top_n", "max_per_sector", "momentum_window",
  "w_momentum", "w_value", "w_liquidity", "w_rsi", "w_macd", "w_trend", "w_size", "w_quality",
  "w_fund_flow",
  "rsi_window", "rsi_direction", "macd_fast", "macd_slow", "macd_signal", "vol_window",
  "min_turnover_pct", "max_pe_ttm", "max_pb",
  "boards", "st_filter", "mcap_min", "mcap_max",
  "fast_ma", "slow_ma", "use_breakout_filter", "breakout_window", "stop_loss_pct", "max_positions",
  "market_enable", "index_code", "ma_window", "mom_window", "short_mom_window",
  "bull_ma_gap", "bear_ma_gap", "bull_mom", "bear_mom",
  "strong_short_mom", "weak_short_mom", "vol_shrink_threshold",
  "neutral_up_factor", "neutral_down_factor",
  "optim_enabled",
]);

function sanitizeOverrides(body) {
  const out = {};
  for (const [k, v] of Object.entries(body || {})) {
    if (ALLOWED_KEYS.has(k) && v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

function resolvePython() {
  if (process.env.PYTHON_PATH) return process.env.PYTHON_PATH;
  for (const c of ["python3", "python", "py"]) {
    try {
      execFileSync(c, ["--version"], { timeout: 8000, stdio: "ignore" });
      return c;
    } catch {
      // 尝试下一个候选
    }
  }
  return "python3";
}

function msgOf(e) {
  return e instanceof Error ? e.message : String(e);
}

// —— 按预设重建候选池（修复「切换策略选出同一批票」）——
// 旧实现永远用写死的 prefetched.json（且是 low_pe 池），导致任何预设都在同一批
// 银行/保险里打分。现按预设主导因子构建独立候选池，按预设名缓存、当日复用。
const PROFILE_PRESET_UI = { pre_market: "breakout", intraday: "momentum_chase", post_market: "ma_golden" };

function shDateStr(d) {
  const sh = new Date(d.getTime() + 8 * 3600 * 1000);
  const y = sh.getUTCFullYear();
  const m = String(sh.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(sh.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function isPoolFresh(p) {
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
    const meta = raw._meta;
    if (!meta || !meta.generated_at) return false;
    return shDateStr(new Date(meta.generated_at)) === shDateStr(new Date());
  } catch {
    return false;
  }
}

function ensurePool(py, preset, profile) {
  const presetName = preset || PROFILE_PRESET_UI[profile] || "breakout";
  const universePath = path.join(BASE, `market_universe_${presetName}.json`);
  const prefetchedPath = path.join(BASE, `prefetched_${presetName}.json`);
  if (isPoolFresh(prefetchedPath)) return { prefetchedPath, presetName };
  try {
    // 1) 构建候选池（直连腾讯自选股选股接口）
    execFileSync(py, ["build_universe.py", "--preset", presetName, "--out", universePath, "--limit", "300"], {
      cwd: BASE, timeout: 120000, encoding: "utf-8", env: { ...process.env },
    });
    // 2) 批量本地直连取行情
    execFileSync(py, ["dev/fetch_market_data.py", universePath, "--out", prefetchedPath, "--workers", "16"], {
      cwd: BASE, timeout: 240000, encoding: "utf-8", env: { ...process.env },
    });
    return { prefetchedPath, presetName };
  } catch (e) {
    console.error("[ensurePool] 候选池构建失败(preset=" + presetName + "):", msgOf(e));
    if (fs.existsSync(PRE)) { console.warn("[ensurePool] 回退 legacy prefetched.json"); return { prefetchedPath: PRE, presetName }; }
    throw e;
  }
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

const server = http.createServer((req, res) => {
  // 允许前端跨端口调用（守护进程独立端口，避免 CORS 阻断）
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  // 动态回显浏览器预检声明要用的头（不写死，前端带自定义头也能过预检）
  const reqHeaders = req.headers["access-control-request-headers"];
  res.setHeader("Access-Control-Allow-Headers", reqHeaders || "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // GET /health —— 轻量健康检查（不触发 Python，供前端探测桥接是否在线）
  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, { ok: true, service: "local-engine", pid: process.pid });
    return;
  }

  // GET /config —— 读取 strategy_config.yaml 摊平结果
  if (req.method === "GET" && req.url === "/config") {
    try {
      const py = resolvePython();
      const out = execFileSync(py, [DUMP], {
        cwd: BASE,
        timeout: 15000,
        encoding: "utf-8",
      });
      const cfg = JSON.parse(out.trim().split("\n").pop() || "{}");
      sendJson(res, 200, { ok: true, config: cfg });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: "读取配置失败: " + msgOf(e) });
    }
    return;
  }

  // POST /run —— 用传入的 overrides（+可选 profile 档位）跑引擎
  if (req.method === "POST" && (req.url === "/run" || (req.url && req.url.startsWith("/run?")))) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let overrides = {};
      let profile = "pre_market";
      try {
        const parsed = JSON.parse(body || "{}");
        overrides = parsed.overrides && typeof parsed.overrides === "object" ? parsed.overrides : parsed;
        if (typeof parsed.profile === "string" &&
            ["pre_market", "intraday", "post_market"].includes(parsed.profile)) {
          profile = parsed.profile;
        }
        // 安全边界：只透传白名单内的字段，避免未知键直传 run_hub.py
        overrides = sanitizeOverrides(overrides);
      } catch {
        overrides = {};
      }
      try {
        const py = resolvePython();
        const ovStr = JSON.stringify(overrides);
        // 按所选预设重建（或复用当日缓存的）候选池
        const presetArg = (typeof overrides.preset === "string") ? overrides.preset : undefined;
        const pool = ensurePool(py, presetArg, profile);
        execFileSync(py, [RUN, "--prefetched", pool.prefetchedPath, "--profile", profile, "--overrides", ovStr], {
          cwd: BASE,
          timeout: 300000,
          encoding: "utf-8",
          env: { ...process.env },
        });
        const payload = JSON.parse(fs.readFileSync(PAYLOAD, "utf-8"));
        sendJson(res, 200, {
          ok: true, scan: payload, appliedOverrides: overrides,
          appliedProfile: profile, appliedPreset: pool.presetName, candidatePool: pool.prefetchedPath,
        });
      } catch (e) {
        sendJson(res, 500, { ok: false, error: "引擎执行失败: " + msgOf(e) });
      }
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: "not found" });
});

server.listen(PORT, HOST, () => {
  console.log("[local-engine] 已启动: http://" + HOST + ":" + PORT + "（真实 Node，可调用本机 Python）");
  console.log("[local-engine] PYTHON_PATH=" + (process.env.PYTHON_PATH || "(未设置，将自动探测 python3/python/python/py)"));
});
