import { and, desc, eq } from "drizzle-orm";
import { extractText, getDocumentProxy } from "unpdf";
import { ensureSchema, getDb } from "../../../db";
import { announcementNotes } from "../../../db/schema";
import { isStockCode } from "../../../lib/domain/domain";
import { getAiConfig } from "../../../lib/ai/ai-config";
import { getCurrentUser, requireApiUser } from "../../../lib/auth/auth";
import { isEtfCode } from "../../../lib/domain/stocks";
import { shanghaiIso } from "../../../lib/utils/time";

const allowedHosts = new Set([
  "static.cninfo.com.cn",
  "www.cninfo.com.cn",
  "www.sse.com.cn",
  "static.sse.com.cn",
  "www.szse.cn",
  "disc.static.szse.cn",
]);

type SummaryResult = {
  mode: "deepseek" | "automatic";
  summary: string;
  risks: string[];
};

class RequestError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

function parseRisks(value: string) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

async function closePdf(pdf: Awaited<ReturnType<typeof getDocumentProxy>>) {
  const destroy = (pdf as unknown as { destroy?: () => Promise<void> }).destroy;
  if (typeof destroy === "function") await destroy.call(pdf);
}

function automaticSummary(text: string): SummaryResult {
  const normalized = text.replace(/\s+/g, " ").trim();
  const riskKeywords = ["亏损", "下降", "减持", "诉讼", "处罚", "退市", "质押", "风险", "终止", "异常"];
  const risks = riskKeywords.filter((keyword) => normalized.includes(keyword));
  return {
    mode: "automatic",
    summary: normalized.slice(0, 600) || "PDF中没有提取到可读文字，可能是扫描件。",
    risks: risks.length
      ? risks.map((keyword) => `公告正文出现“${keyword}”，需要结合上下文核验。`)
      : ["未通过关键词发现明显风险，仍应阅读公告原文。"],
  };
}

async function summarizeWithDeepSeek(text: string, isEtf: boolean): Promise<SummaryResult> {
  const ai = getAiConfig();
  if (!ai.configured) return automaticSummary(text);

  try {
    const response = await fetch(`${ai.apiBase}/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(20_000),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ai.apiKey}`,
      },
      body: JSON.stringify({
        model: ai.model,
        response_format: { type: "json_object" },
        temperature: 0.1,
        messages: [
          {
            role: "system",
            content: [
              isEtf
                ? "你是公募基金公告摘要助手，只能使用输入的基金公告文字。使用基金管理人、标的指数、净值、份额、持仓、跟踪误差等基金术语，不使用公司主营、管理层或公司业绩等个股术语。"
                : "你是上市公司公告摘要助手，只能使用输入的公告文字。",
              "输出json对象，包含summary字符串和risks字符串数组。",
              "summary用不超过300字的中文解释公告做了什么、涉及金额或时间、投资者需要关注什么。",
              "不提供买卖建议，缺失信息明确写不确定。",
            ].join("\n"),
          },
          { role: "user", content: `请总结以下公告文字：\n${text.slice(0, 24_000)}` },
        ],
      }),
    });
    if (!response.ok) return automaticSummary(text);
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) return automaticSummary(text);
    const parsed = JSON.parse(content) as { summary?: string; risks?: string[] };
    if (typeof parsed.summary !== "string" || !parsed.summary.trim() || !Array.isArray(parsed.risks)) {
      return automaticSummary(text);
    }
    return {
      mode: "deepseek",
      summary: parsed.summary.slice(0, 600),
      risks: parsed.risks.filter((risk): risk is string => typeof risk === "string").slice(0, 6),
    };
  } catch {
    return automaticSummary(text);
  }
}

async function loadPdf(form: FormData) {
  const uploaded = form.get("file");
  if (uploaded instanceof File && uploaded.size > 0) {
    if (uploaded.size > 8 * 1024 * 1024) {
      throw new RequestError("PDF公告不能超过8MB", 413);
    }
    const bytes = new Uint8Array(await uploaded.arrayBuffer());
    if (String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-") {
      throw new RequestError("上传的文件不是有效PDF");
    }
    return bytes;
  }

  const sourceUrl = String(form.get("sourceUrl") ?? "").trim();
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw new RequestError("请上传PDF或填写官方PDF链接");
  }
  if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) {
    throw new RequestError("只允许读取巨潮资讯、上交所或深交所的HTTPS公告链接");
  }
  let response: Response | null = null;
  for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
    response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    if (!location) throw new RequestError("公告链接返回了无效跳转", 422);
    url = new URL(location, url);
    if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) {
      throw new RequestError("公告链接跳转到了非官方地址");
    }
  }
  if (!response || [301, 302, 303, 307, 308].includes(response.status)) {
    throw new RequestError("公告链接跳转次数过多", 422);
  }
  const length = Number(response.headers.get("content-length") ?? 0);
  if (!response.ok || length > 8 * 1024 * 1024) {
    throw new RequestError("公告PDF暂时无法读取或文件过大", response.ok ? 413 : 422);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 8 * 1024 * 1024) throw new RequestError("公告PDF不能超过8MB", 413);
  if (String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-") {
    throw new RequestError("官方链接返回的内容不是有效PDF", 422);
  }
  return bytes;
}

export async function GET(request: Request) {
  const unauthorized = await requireApiUser();
  if (unauthorized) return unauthorized;
  try {
    const user = await getCurrentUser();
    const symbol = new URL(request.url).searchParams.get("symbol")?.trim() ?? "";
    if (!isStockCode(symbol)) return Response.json({ error: "股票代码不正确" }, { status: 400 });
    await ensureSchema();
    const notes = await getDb()
      .select()
      .from(announcementNotes)
      .where(and(eq(announcementNotes.symbol, symbol), eq(announcementNotes.userId, user.id)))
      .orderBy(desc(announcementNotes.id))
      .limit(20);
    return Response.json({
      notes: notes.map((note) => ({ ...note, risks: parseRisks(note.risksJson) })),
    });
  } catch {
    return Response.json({ error: "公告摘要暂时无法读取" }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const unauthorized = await requireApiUser();
  if (unauthorized) return unauthorized;
  try {
    const user = await getCurrentUser();
    const form = await request.formData();
    const symbol = String(form.get("symbol") ?? "").trim();
    const name = String(form.get("name") ?? "").trim();
    const title = String(form.get("title") ?? "").trim();
    const sourceUrl = String(form.get("sourceUrl") ?? "").trim();
    if (!isStockCode(symbol) || !name || name.length > 30 || !title || title.length > 120) {
      return Response.json({ error: "请填写股票和公告标题" }, { status: 400 });
    }

    const bytes = await loadPdf(form);
    const pdf = await getDocumentProxy(bytes);
    let extracted: Awaited<ReturnType<typeof extractText>>;
    try {
      if (pdf.numPages > 80) {
        return Response.json({ error: "公告超过80页，请选择需要分析的核心公告" }, { status: 400 });
      }
      extracted = await extractText(pdf, { mergePages: true });
    } finally {
      await closePdf(pdf);
    }
    const text = (Array.isArray(extracted.text) ? extracted.text.join("\n") : extracted.text).trim();
    if (text.length < 40) {
      return Response.json({ error: "没有提取到足够文字，扫描版PDF暂不支持" }, { status: 422 });
    }
    const compactText = text.replace(/\s+/g, "");
    const compactName = name.replace(/\s+/g, "");
    if (!compactText.includes(symbol) && !compactText.includes(compactName)) {
      return Response.json({
        error: `PDF正文中没有找到${name}或股票代码${symbol}，请确认公告与股票匹配`,
      }, { status: 422 });
    }

    const result = await summarizeWithDeepSeek(text, isEtfCode(symbol));
    await ensureSchema();
    const [note] = await getDb().insert(announcementNotes).values({
      userId: user.id,
      symbol,
      name,
      title,
      sourceUrl,
      totalPages: extracted.totalPages,
      summary: result.summary,
      risksJson: JSON.stringify(result.risks),
      mode: result.mode,
      createdAt: shanghaiIso(),
    }).returning();
    return Response.json({ note: { ...note, risks: result.risks } }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "公告摘要失败";
    return Response.json({ error: message }, { status: error instanceof RequestError ? error.status : 500 });
  }
}

export async function DELETE(request: Request) {
  const unauthorized = await requireApiUser();
  if (unauthorized) return unauthorized;
  try {
    const user = await getCurrentUser();
    const url = new URL(request.url);
    const symbol = url.searchParams.get("symbol")?.trim() ?? "";
    const id = Number(url.searchParams.get("id"));
    if (!isStockCode(symbol) || !Number.isInteger(id) || id <= 0) {
      return Response.json({ error: "公告摘要记录不正确" }, { status: 400 });
    }
    await ensureSchema();
    const [deleted] = await getDb()
      .delete(announcementNotes)
      .where(and(eq(announcementNotes.id, id), eq(announcementNotes.symbol, symbol), eq(announcementNotes.userId, user.id)))
      .returning();
    return deleted
      ? Response.json({ ok: true })
      : Response.json({ error: "公告摘要不存在" }, { status: 404 });
  } catch {
    return Response.json({ error: "公告摘要删除失败" }, { status: 500 });
  }
}
