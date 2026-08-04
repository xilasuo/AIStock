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

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

const server = http.createServer((req, res) => {
  // 允许前端跨端口调用（守护进程独立端口，避免 CORS 阻断）
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
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
      } catch {
        overrides = {};
      }
      try {
        const py = resolvePython();
        const ovStr = JSON.stringify(overrides);
        execFileSync(py, [RUN, "--prefetched", PRE, "--profile", profile, "--overrides", ovStr], {
          cwd: BASE,
          timeout: 60000,
          encoding: "utf-8",
        });
        const payload = JSON.parse(fs.readFileSync(PAYLOAD, "utf-8"));
        sendJson(res, 200, { ok: true, scan: payload, appliedOverrides: overrides, appliedProfile: profile });
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
