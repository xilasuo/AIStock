"""拉取云端「策略扫描」配置，供本地引擎使用。

设计定位（与云端分工）：
  - 云端（wrangler 沙箱）不执行选股引擎，只负责配置/展示扫描条件
    （GET /api/strategy-scan/config 返回内置默认或人工维护的配置）。
  - 本地程序（可调用 Python 引擎的真实 Node/PC 环境）启动时可拉取该
    云端配置，作为 overrides 传入 run_hub.py；不提供则回退本地
    strategy_config.yaml（参看 run_hub.py 的 --cloud-config-url 说明）。
  - 多用户隔离：GET 按登录会话身份返回「本人」配置（仅持共享令牌、无登录
    身份时回退全局默认）。故必须以 CLOUD_CFG_USER/CLOUD_CFG_PASS 登录，
    拉到的才是该账号本人设置的条件，而非他人或全局默认。

用法：
  # 推荐：所有私密信息写入项目根 .env（CLOUD_BASE_URL / CLOUD_CFG_USER /
  # CLOUD_CFG_PASS），脚本会自动读取，无需任何命令行参数：
  python pull_cloud_config.py --as-overrides

  # 或显式指定云端基地址（<服务器IP> 替换为你的实际地址，勿硬编码进仓库）：
  python pull_cloud_config.py --url http://<服务器IP>:9003 \
      --user <用户名> --pass '<密码>'

  # 凭据也可走环境变量（避免命令行暴露）：
  export CLOUD_CFG_URL=http://<服务器IP>:9003
  export CLOUD_CFG_USER=<用户名>
  export CLOUD_CFG_PASS='<密码>'
  python pull_cloud_config.py --as-overrides
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen, build_opener, HTTPRedirectHandler

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config as cfg_mod  # 复用 flatten_config 把嵌套配置摊平


def _load_dotenv():
    """加载项目根目录 .env 到 os.environ（若不存在则跳过）。
    这样本地直接运行脚本即可读取 CLOUD_BASE_URL / CLOUD_CFG_USER 等，
    无需手动 export。"""
    here = os.path.dirname(os.path.abspath(__file__))
    for cand in (os.path.join(here, "..", ".env"), os.path.join(here, ".env")):
        if os.path.isfile(cand):
            with open(cand, encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    k, v = k.strip(), v.strip().strip('"').strip("'")
                    os.environ.setdefault(k, v)
            break


_load_dotenv()


class _NoRedirect(HTTPRedirectHandler):
    """不自动跟随 3xx，便于读取登录响应本身下发的 Set-Cookie。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_opener = build_opener(_NoRedirect())


def _http_json(url: str, method: str = "GET", data: bytes | None = None,
               headers: dict | None = None, timeout: int = 20):
    req = Request(url, data=data, method=method,
                  headers=headers or {"Content-Type": "application/json"})
    with urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode("utf-8", "replace")
        return resp.status, (json.loads(body) if body else {})


def login(base: str, user: str, password: str) -> str | None:
    """登录并提取 session cookie。失败返回 None。"""
    url = base.rstrip("/") + "/api/auth/login"
    data = urlencode({"username": user, "password": password}).encode("utf-8")
    req = Request(url, data=data, method="POST",
                  headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with _opener.open(req, timeout=20) as resp:
            sc = resp.headers.get("Set-Cookie", "")
            for part in sc.split(","):
                if part.strip().startswith("stock_assistant_session="):
                    return part.strip().split(";", 1)[0]
            print("登录成功但未下发 session cookie（可能配置异常）。", file=sys.stderr)
            return None
    except HTTPError as e:
        # 登录成功时接口返回 303 重定向到首页，同时下发 Set-Cookie；
        # 因我们禁用了自动重定向，303 会被当作错误抛出，这里特殊处理。
        if e.code in (302, 303) and "stock_assistant_session=" in e.headers.get("Set-Cookie", ""):
            for part in e.headers.get("Set-Cookie", "").split(","):
                if part.strip().startswith("stock_assistant_session="):
                    return part.strip().split(";", 1)[0]
        print(f"登录被拒绝 (HTTP {e.code})，请检查用户名/密码。", file=sys.stderr)
    except URLError as e:
        print(f"登录请求失败（网络/地址错误）: {e.reason}", file=sys.stderr)
    except Exception as e:  # noqa: BLE001
        print(f"登录异常: {e}", file=sys.stderr)
    return None


def fetch_cloud_config_raw(base: str, cookie: str, token: str | None = None):
    """登录态下（或凭推送令牌）GET /api/strategy-scan/config，返回 (status, obj, raw)。

    - 优先使用会话 Cookie（浏览器登录态）；若为空，自动读取环境变量
      CLOUD_SCAN_TOKEN 作为 x-push-token 头下发，使本地程序/自动化在无浏览器
      会话时也能拉取配置（多用户改造后接口要求登录，令牌与扫描/回写推送同源）。
    - raw 为接口原始响应文本，供调用方计算内容指纹（SHA-256）以做云端溯源证明。
    """
    if not token:
        token = os.environ.get("CLOUD_SCAN_TOKEN") or ""
    url = base.rstrip("/") + "/api/strategy-scan/config"
    headers: dict = {}
    if cookie:
        headers["Cookie"] = cookie
    if token:
        headers["x-push-token"] = token
    try:
        req = Request(url, method="GET", headers=headers)
        with urlopen(req, timeout=20) as resp:
            raw = resp.read().decode("utf-8", "replace")
            status = resp.status
    except HTTPError as e:
        raw = e.read().decode("utf-8", "replace") if e.fp else ""
        status = e.code
        return status, {}, raw
    except URLError as e:
        print(f"获取配置失败（网络/地址错误）: {e.reason}", file=sys.stderr)
        return 0, {}, ""
    except Exception as e:  # noqa: BLE001
        print(f"获取配置异常: {e}", file=sys.stderr)
        return 0, {}, ""
    try:
        obj = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        obj = {}
    if not isinstance(obj, dict) or not obj.get("ok"):
        print(f"云端返回异常: {obj}", file=sys.stderr)
        return status, {}, raw
    return status, obj, raw


def fetch_cloud_config(base: str, cookie: str) -> dict | None:
    """原有接口（向后兼容）：仅返回 config 嵌套字典。"""
    _, obj, _ = fetch_cloud_config_raw(base, cookie)
    if not obj:
        return None
    return obj.get("config") or {}


def to_overrides(nested: dict) -> dict:
    """把云端嵌套 config 摊平成 run_hub.apply_config 兼容的扁平键。"""
    return cfg_mod.flatten_config(nested)


def resolve_base_url() -> str:
    """解析云端基地址，优先级：CLOUD_BASE_URL > CLOUD_CFG_URL >
    由 CLOUD_SCAN_URL 去掉末尾 /api/strategy-scan 推导。"""
    base = os.environ.get("CLOUD_BASE_URL") or os.environ.get("CLOUD_CFG_URL") or ""
    if base:
        return base
    scan = os.environ.get("CLOUD_SCAN_URL") or ""
    if scan:
        return scan.replace("/api/strategy-scan", "").rstrip("/")
    return ""


def main():
    ap = argparse.ArgumentParser(description="拉取云端策略扫描配置")
    ap.add_argument("--url", default=resolve_base_url())
    ap.add_argument("--user", default=os.environ.get("CLOUD_CFG_USER") or "")
    ap.add_argument("--pass", dest="password",
                    default=os.environ.get("CLOUD_CFG_PASS") or "")
    ap.add_argument("--as-overrides", action="store_true",
                    help="输出可直接传给 run_hub.py --overrides 的 JSON 字符串")
    args = ap.parse_args()

    if not args.url:
        print("缺少 --url（或环境变量 CLOUD_BASE_URL / CLOUD_CFG_URL）。", file=sys.stderr)
        sys.exit(2)
    if not args.user or not args.password:
        print("缺少 --user/--pass（或环境变量 CLOUD_CFG_USER/CLOUD_CFG_PASS）。",
              file=sys.stderr)
        sys.exit(2)

    cookie = login(args.url, args.user, args.password)
    if not cookie:
        sys.exit(1)

    nested = fetch_cloud_config(args.url, cookie)
    if nested is None:
        sys.exit(1)

    overrides = to_overrides(nested)
    if args.as_overrides:
        print(json.dumps(overrides, ensure_ascii=False))
    else:
        print(f"云端配置（嵌套）:\n{json.dumps(nested, ensure_ascii=False, indent=2)}")
        print(f"\n摊平为 overrides（run_hub.py 兼容）:\n"
              f"{json.dumps(overrides, ensure_ascii=False, indent=2)}")


if __name__ == "__main__":
    main()
