import { and, eq } from "drizzle-orm";
import { ensureSchema, getDb } from "../../../db";
import {
  accountSettings,
  alertRules,
  analysisReports,
  announcementNotes,
  capitalFlows,
  reviews,
  strategyFeedback,
  tradeRecords,
  tradingPreferences,
  users,
  watchDetails,
  watchItems,
} from "../../../db/schema";
import { generateSalt, hashPassword, requireSuperAdmin } from "../../../lib/auth/auth";
import { shanghaiIso } from "../../../lib/utils/time";

const MIN_PASSWORD = 12;

function validateUsername(value: unknown): string | null {
  const username = typeof value === "string" ? value.trim() : "";
  if (!username || username.length < 2 || username.length > 40) {
    return "用户名长度需在 2-40 个字符之间";
  }
  return null;
}

function validatePassword(value: unknown): string | null {
  const password = typeof value === "string" ? value : "";
  if (password.length < MIN_PASSWORD) {
    return `密码至少 ${MIN_PASSWORD} 位`;
  }
  return null;
}

export async function GET() {
  try {
    await requireSuperAdmin();
    await ensureSchema();
    const db = getDb();
    const rows = await db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        role: users.role,
        disabled: users.disabled,
        createdAt: users.createdAt,
      })
      .from(users)
      .orderBy(users.id);
    return Response.json({ users: rows });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: "读取用户列表失败" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    await requireSuperAdmin();
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const usernameError = validateUsername(body?.username);
    if (usernameError) return Response.json({ error: usernameError }, { status: 400 });
    const passwordError = validatePassword(body?.password);
    if (passwordError) return Response.json({ error: passwordError }, { status: 400 });

    const username = String(body!.username).trim();
    const displayName = typeof body?.displayName === "string" ? body.displayName.trim() : username;
    const role = body?.role === "super_admin" ? "super_admin" : "user";
    const password = String(body!.password);

    await ensureSchema();
    const db = getDb();
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
    if (existing.length) {
      return Response.json({ error: "用户名已存在" }, { status: 409 });
    }
    const salt = generateSalt();
    const passwordHash = await hashPassword(password, salt);
    const [created] = await db.insert(users).values({
      username,
      displayName: displayName || username,
      passwordHash,
      salt,
      role,
      disabled: false,
      createdAt: shanghaiIso(),
    }).returning({ id: users.id, username: users.username });
    return Response.json({ user: created }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: "创建用户失败" }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const admin = await requireSuperAdmin();
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const id = Number(body?.id);
    if (!Number.isInteger(id) || id <= 0) {
      return Response.json({ error: "用户编号不正确" }, { status: 400 });
    }

    await ensureSchema();
    const db = getDb();
    const [target] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!target) {
      return Response.json({ error: "用户不存在" }, { status: 404 });
    }

    const updates: Partial<typeof users.$inferInsert> = {};
    // 安全敏感变更（改密 / 禁用 / 改角色）必须使该用户已签发的会话立即失效，
    // 否则旧 token 在自然过期前（最长 30 天）仍然可用：改密踢不掉盗号者、
    // 禁用形同虚设、降级后的超管仍能通过 requireSuperAdmin 提权。
    let revokeSessions = false;
    if (body?.newPassword !== undefined) {
      const passwordError = validatePassword(body.newPassword);
      if (passwordError) return Response.json({ error: passwordError }, { status: 400 });
      const salt = generateSalt();
      updates.salt = salt;
      updates.passwordHash = await hashPassword(String(body.newPassword), salt);
      revokeSessions = true;
    }
    if (body?.displayName !== undefined) {
      const displayName = String(body.displayName).trim();
      if (displayName.length > 40) {
        return Response.json({ error: "显示名过长" }, { status: 400 });
      }
      updates.displayName = displayName;
    }
    if (body?.disabled !== undefined) {
      // 禁止管理员禁用自己，避免锁死会话
      if (id === admin.id && body.disabled === true) {
        return Response.json({ error: "不能禁用当前登录的超级管理员账户" }, { status: 400 });
      }
      updates.disabled = Boolean(body.disabled);
      if (updates.disabled) revokeSessions = true;
    }
    if (body?.role !== undefined) {
      const role = body.role === "super_admin" ? "super_admin" : "user";
      // 禁止把唯一超级管理员降级为普通用户
      if (target.role === "super_admin" && role !== "super_admin") {
        const superCount = await db
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.role, "super_admin"), eq(users.disabled, false)));
        if (superCount.length <= 1) {
          return Response.json({ error: "至少需保留一个启用的超级管理员" }, { status: 400 });
        }
      }
      if (role !== target.role) revokeSessions = true;
      updates.role = role;
    }

    if (Object.keys(updates).length === 0) {
      return Response.json({ error: "没有可更新的字段" }, { status: 400 });
    }
    if (revokeSessions) {
      updates.tokenVersion = (target.tokenVersion ?? 0) + 1;
    }
    await db.update(users).set(updates).where(eq(users.id, id));
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: "更新用户失败" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const admin = await requireSuperAdmin();
    const url = new URL(request.url);
    const id = Number(url.searchParams.get("id"));
    if (!Number.isInteger(id) || id <= 0) {
      return Response.json({ error: "用户编号不正确" }, { status: 400 });
    }
    // 禁止删除自己
    if (id === admin.id) {
      return Response.json({ error: "不能删除当前登录的账户" }, { status: 400 });
    }

    await ensureSchema();
    const db = getDb();
    const [target] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!target) {
      return Response.json({ error: "用户不存在" }, { status: 404 });
    }
    // 禁止删除最后一个超级管理员
    if (target.role === "super_admin") {
      const superCount = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.role, "super_admin"), eq(users.disabled, false)));
      if (superCount.length <= 1) {
        return Response.json({ error: "至少需保留一个启用的超级管理员" }, { status: 400 });
      }
    }

    // 级联删除该用户全部业务数据
    await db.batch([
      db.delete(tradeRecords).where(eq(tradeRecords.userId, id)),
      db.delete(watchItems).where(eq(watchItems.userId, id)),
      db.delete(watchDetails).where(eq(watchDetails.userId, id)),
      db.delete(alertRules).where(eq(alertRules.userId, id)),
      db.delete(reviews).where(eq(reviews.userId, id)),
      db.delete(analysisReports).where(eq(analysisReports.userId, id)),
      db.delete(announcementNotes).where(eq(announcementNotes.userId, id)),
      db.delete(accountSettings).where(eq(accountSettings.userId, id)),
      db.delete(capitalFlows).where(eq(capitalFlows.userId, id)),
      db.delete(tradingPreferences).where(eq(tradingPreferences.userId, id)),
      db.delete(strategyFeedback).where(eq(strategyFeedback.userId, id)),
      db.delete(users).where(eq(users.id, id)),
    ]);
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: "删除用户失败" }, { status: 500 });
  }
}
