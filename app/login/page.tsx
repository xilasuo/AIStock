import { isAuthConfigured } from "../../lib/auth/auth";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const configured = isAuthConfigured();

  return (
    <main className="login-page">
      <section className="login-card">
        <aside className="login-aside">
          <div className="login-brand"><span>股</span><b>我的复盘助手</b></div>
          <div className="login-statement">
            <span className="eyebrow">私有工作区</span>
            <h1>把每一笔交易，<br />都变成下一次的进步。</h1>
            <p>行情、关注与复盘数据，只在验证身份后开放。本应用只负责把信息讲清楚，买与卖的决定权，始终在你手里。</p>
          </div>
          <ul className="login-points">
            <li>看懂：整理行情、财务与题材</li>
            <li>记录：买卖理由与止损纪律</li>
            <li>复盘：找出最该改的一个动作</li>
          </ul>
          <p className="login-foot">登录状态仅保存在当前浏览器的安全 Cookie 中。</p>
        </aside>
        <div className="login-main">
          {!configured && (
            <div className="login-error">
              尚未配置登录密钥。请在环境变量中设置 APP_AUTH_SECRET（至少 32 位）。首次启动还需设置 APP_USERNAME 与 APP_PASSWORD（至少 12 位）以初始化超级管理员账号。
            </div>
          )}
          {configured && error && <div className="login-error">账号或密码不正确，请重新输入。</div>}
          <div className="login-main-head">
            <span className="eyebrow">登录</span>
            <h2>登录你的个人空间</h2>
          </div>
          <form className="login-form" action="/api/auth/login" method="post">
            <label>
              <span>账号</span>
              <input name="username" className="control" autoComplete="username" required autoFocus />
            </label>
            <label>
              <span>密码</span>
              <input name="password" type="password" className="control" autoComplete="current-password" required />
            </label>
            <button className="btn btn--primary" disabled={!configured}>登录</button>
          </form>
        </div>
      </section>
    </main>
  );
}
