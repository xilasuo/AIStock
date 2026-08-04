"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, Divider, EmptyState, Field, IconButton, Input } from "./ui";

type ManagedUser = {
  id: number;
  username: string;
  displayName: string;
  role: "super_admin" | "user";
  disabled: boolean;
  createdAt: string;
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || `请求失败 (${res.status})`);
  }
  return data as T;
}

function initials(name: string): string {
  const trimmed = (name || "").trim();
  if (!trimmed) return "?";
  // 中文取末 1 位，英文取前 2 位
  if (/[一-龥]/.test(trimmed)) return trimmed.slice(-1);
  return trimmed.slice(0, 2).toUpperCase();
}

function formatDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

export function UsersAdmin({ currentUserId }: { currentUserId: number }) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [flashMsg, setFlashMsg] = useState("");

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [showAdd, setShowAdd] = useState(false);

  const [resetId, setResetId] = useState<number | null>(null);
  const [resetPassword, setResetPassword] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api<{ users: ManagedUser[] }>("/api/users");
      setUsers(data.users);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载用户列表失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const flash = (msg: string) => {
    setFlashMsg(msg);
    window.setTimeout(() => setFlashMsg(""), 2500);
  };

  async function handleCreate() {
    if (!username.trim()) {
      setError("用户名不能为空");
      return;
    }
    if (password.length < 12) {
      setError("密码至少 12 位");
      return;
    }
    setError("");
    try {
      await api("/api/users", {
        method: "POST",
        body: JSON.stringify({
          username: username.trim(),
          password,
          displayName: displayName.trim(),
        }),
      });
      setUsername("");
      setPassword("");
      setDisplayName("");
      setShowAdd(false);
      flash("用户已创建");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建失败");
    }
  }

  async function handlePatch(id: number, body: Record<string, unknown>, okMsg: string) {
    setError("");
    try {
      await api("/api/users", { method: "PATCH", body: JSON.stringify({ id, ...body }) });
      flash(okMsg);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    }
  }

  async function handleDelete(id: number) {
    if (!window.confirm("删除该用户将同时清除其全部交易、关注、提醒与复盘数据，且不可恢复。确认删除？")) {
      return;
    }
    setError("");
    try {
      await api(`/api/users?id=${id}`, { method: "DELETE" });
      flash("用户已删除");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    }
  }

  async function handleReset(id: number) {
    if (resetPassword.length < 12) {
      setError("新密码至少 12 位");
      return;
    }
    setError("");
    try {
      await api("/api/users", {
        method: "PATCH",
        body: JSON.stringify({ id, newPassword: resetPassword }),
      });
      setResetId(null);
      setResetPassword("");
      flash("密码已重置");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "重置失败");
    }
  }

  const hasUsers = users.length > 0;

  return (
    <div className="users-admin">
      <Card padded>
        <div className="users-admin__head">
          <div className="users-admin__head-text">
            <span className="eyebrow">账户与权限</span>
            <h3 className="users-admin__title">用户管理</h3>
            <p className="users-admin__subtitle">
              仅超级管理员可添加或删除用户，每个用户数据完全隔离。
            </p>
          </div>
          <div className="users-admin__head-actions">
            <div className="users-admin__counts">
              <Badge tone="neutral">
                共 <b>{users.length}</b> 个账户
              </Badge>
              {error && (
                <Badge tone="red" title={error}>
                  {error}
                </Badge>
              )}
              {flashMsg && <Badge tone="green">{flashMsg}</Badge>}
            </div>
            <Button
              variant="primary"
              size="sm"
              onClick={() => setShowAdd((v) => !v)}
              aria-expanded={showAdd}
            >
              {showAdd ? "收起表单" : "新增用户"}
            </Button>
          </div>
        </div>

        {showAdd && (
          <div className="users-admin__form" role="region" aria-label="新增用户">
            <Field label="用户名" help="唯一登录标识，创建后不可修改">
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="例如：zhangsan"
                autoComplete="off"
              />
            </Field>
            <Field label="显示名" help="可选，用于界面展示">
              <Input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="例如：张三"
                autoComplete="off"
              />
            </Field>
            <Field label="初始密码" help="至少 12 位，首次登录后建议用户自行修改">
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="≥ 12 位"
                autoComplete="new-password"
              />
            </Field>
            <div className="users-admin__form-actions">
              <Button
                variant="ghost"
                onClick={() => {
                  setShowAdd(false);
                  setUsername("");
                  setPassword("");
                  setDisplayName("");
                  setError("");
                }}
              >
                取消
              </Button>
              <Button variant="primary" onClick={() => void handleCreate()}>
                创建账户
              </Button>
            </div>
          </div>
        )}

        <Divider />

        {loading ? (
          <p className="hint">加载中…</p>
        ) : !hasUsers ? (
          <EmptyState
            icon={<span style={{ fontSize: 24 }} aria-hidden="true">👤</span>}
            title="还没有任何账户"
            hint="点击右上角“新增用户”创建第一个账户。"
          />
        ) : (
          <div className="users-table" role="table" aria-label="用户列表">
          <div className="users-table__head" role="row">
            <span role="columnheader">账户</span>
            <span role="columnheader">角色</span>
            <span role="columnheader">状态</span>
            <span role="columnheader">创建时间</span>
            <span role="columnheader" className="users-table__op-head">操作</span>
          </div>

          {users.map((u) => {
            const isSelf = u.id === currentUserId;
            const displayName = u.displayName || u.username;
            return (
              <div key={u.id} className="users-table__row" role="row">
                <div className="users-table__user" role="cell">
                  <span className="users-avatar" aria-hidden="true">{initials(displayName)}</span>
                  <div className="users-table__user-text">
                    <b className="users-table__name">
                      {displayName}
                      {isSelf && <span className="users-table__self">（你）</span>}
                    </b>
                    <span className="users-table__sub">@{u.username}</span>
                  </div>
                </div>

                <div role="cell">
                  <Badge tone={u.role === "super_admin" ? "amber" : "neutral"}>
                    {u.role === "super_admin" ? "超级管理员" : "普通用户"}
                  </Badge>
                </div>

                <div role="cell">
                  <Badge tone={u.disabled ? "red" : "green"}>
                    {u.disabled ? "已禁用" : "启用"}
                  </Badge>
                </div>

                <span role="cell" className="users-table__date">{formatDate(u.createdAt)}</span>

                <div role="cell" className="users-table__ops">
                  {resetId === u.id ? (
                    <div className="users-table__reset">
                      <Input
                        type="password"
                        placeholder="新密码（≥12位）"
                        value={resetPassword}
                        onChange={(e) => setResetPassword(e.target.value)}
                        aria-label="新密码"
                      />
                      <Button size="sm" variant="primary" onClick={() => void handleReset(u.id)}>
                        确认
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setResetId(null);
                          setResetPassword("");
                        }}
                      >
                        取消
                      </Button>
                    </div>
                  ) : (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setResetId(u.id);
                          setResetPassword("");
                        }}
                      >
                        重置密码
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          void handlePatch(u.id, { disabled: !u.disabled }, u.disabled ? "已启用" : "已禁用")
                        }
                      >
                        {u.disabled ? "启用" : "禁用"}
                      </Button>
                      {u.role === "super_admin" ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void handlePatch(u.id, { role: "user" }, "已降为普通用户")}
                        >
                          降为普通
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void handlePatch(u.id, { role: "super_admin" }, "已升为超管")}
                        >
                          升为超管
                        </Button>
                      )}
                      {isSelf ? (
                        <IconButton
                          label="不能删除自己"
                          variant="danger"
                          disabled
                          aria-label="不能删除自己"
                        >
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            aria-hidden="true"
                          >
                            <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                          </svg>
                        </IconButton>
                      ) : (
                        <Button size="sm" variant="danger" onClick={() => void handleDelete(u.id)}>
                          删除
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      </Card>
    </div>
  );
}
