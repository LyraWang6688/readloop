/**
 * 签名与令牌：纯函数、只用 node:crypto，不碰网络与存储。
 *
 * 这里有三种「服务端无状态」的凭证（见 docs/API_IMPLEMENTATION.md §2）：
 *
 * 1. 授权码（8 位，用户购买后线下发放）：7 位随机 + 1 位 HMAC 校验位。
 *    服务端不存码表，用 LICENSE_SECRET 现场校验，所以「发码」就是一次离线计算。
 * 2. host_token：激活后签发，内含授权码与到期时间；服务端不存会话。
 * 3. question_id：出题时签发，内含知识点、正确答案与作答前的状态快照；
 *    submit 时验签解出，保证「判分与状态更新由服务端决定、客户端改不了」。
 *
 * 三者都走同一个构造：`base64url(JSON) . base64url(HMAC-SHA256)`。
 */

import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { DAY_MS, endOfDayMs } from "./date";

// ============================================================
// 通用签名
// ============================================================

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64url(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64");
}

function hmac(secret: string, data: string): string {
  return base64url(createHmac("sha256", secret).update(data).digest());
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** 签一个 payload，返回 `body.signature` */
export function signPayload(payload: unknown, secret: string): string {
  const body = base64url(JSON.stringify(payload));
  return `${body}.${hmac(secret, body)}`;
}

export type DecodeFailure = "malformed" | "signature" | "expired";

export type DecodeResult<T> =
  | { ok: true; payload: T }
  | { ok: false; reason: DecodeFailure };

/** 验签并解出 payload；`expiresAtMs` 由各 payload 自己提供 */
export function decodePayload<T extends { exp?: number }>(
  token: unknown,
  secret: string,
  nowMs: number = Date.now()
): DecodeResult<T> {
  if (typeof token !== "string" || token.length === 0 || token.length > 8192) {
    return { ok: false, reason: "malformed" };
  }
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, reason: "malformed" };
  }
  const [body, signature] = parts;
  if (!safeEqual(signature, hmac(secret, body))) {
    return { ok: false, reason: "signature" };
  }

  let payload: T;
  try {
    payload = JSON.parse(fromBase64url(body).toString("utf8")) as T;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!payload || typeof payload !== "object") {
    return { ok: false, reason: "malformed" };
  }
  if (typeof payload.exp === "number" && payload.exp <= nowMs) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, payload };
}

// ============================================================
// 授权码
// ============================================================

/**
 * 授权码字母表：去掉了易混的 0/O/1/I，共 32 个字符。
 * 32 是 2 的幂，HMAC 取模不引入明显偏置。
 */
export const LICENSE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const LICENSE_CODE_LENGTH = 8;

/** 用户输入容错：去空白与分隔符、转大写 */
export function normalizeLicenseCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/[\s-]/g, "").toUpperCase();
  if (cleaned.length !== LICENSE_CODE_LENGTH) return null;
  for (const ch of cleaned) {
    if (!LICENSE_ALPHABET.includes(ch)) return null;
  }
  return cleaned;
}

/** 校验位：HMAC(secret, 前 7 位) 的首字节 % 32 映射到字母表 */
export function licenseCheckChar(body: string, secret: string): string {
  if (body.length !== LICENSE_CODE_LENGTH - 1) {
    throw new Error("授权码校验位的入参长度不对");
  }
  const digest = createHmac("sha256", secret).update(`license:${body}`).digest();
  return LICENSE_ALPHABET[digest[0] % LICENSE_ALPHABET.length];
}

/**
 * 校验授权码。
 * 注意：这只证明「码是我们发的」，不代表没过期——授权码本身不带期限，
 * 期限由激活时签出的 host_token 承载。
 */
export function isValidLicenseCode(code: string, secret: string): boolean {
  const normalized = normalizeLicenseCode(code);
  if (!normalized) return false;
  const body = normalized.slice(0, LICENSE_CODE_LENGTH - 1);
  return safeEqual(normalized, `${body}${licenseCheckChar(body, secret)}`);
}

/** 生成一个可售卖的授权码（发码脚本用） */
export function generateLicenseCode(secret: string): string {
  let body = "";
  for (let i = 0; i < LICENSE_CODE_LENGTH - 1; i += 1) {
    body += LICENSE_ALPHABET[randomInt(0, LICENSE_ALPHABET.length)];
  }
  return `${body}${licenseCheckChar(body, secret)}`;
}

// ============================================================
// host_token（宿主身份）
// ============================================================

export const HOST_TOKEN_TTL_DAYS = 365;

export interface HostTokenPayload {
  v: 1;
  /** 授权码（不含校验位之外的额外信息） */
  lic: string;
  /** 签发时间（UTC 毫秒） */
  iat: number;
  /** 到期时间（UTC 毫秒） */
  exp: number;
}

export function hostTokenExpiresAt(issuedAtMs: number): number {
  return issuedAtMs + HOST_TOKEN_TTL_DAYS * DAY_MS;
}

export function signHostToken(
  license: string,
  issuedAtMs: number,
  secret: string
): { hostToken: string; expiresAt: number } {
  const normalized = normalizeLicenseCode(license);
  if (!normalized) throw new Error("授权码格式不对");
  const expiresAt = hostTokenExpiresAt(issuedAtMs);
  const payload: HostTokenPayload = {
    v: 1,
    lic: normalized,
    iat: issuedAtMs,
    exp: expiresAt,
  };
  return { hostToken: signPayload(payload, secret), expiresAt };
}

/** 到期时间格式化为 `+08:00` 的 ISO 串（对外返回用） */
export function formatExpiryIso(ms: number): string {
  const shifted = new Date(ms + 8 * 60 * 60 * 1000);
  return `${shifted.toISOString().replace(/\.\d{3}Z$/, "")}+08:00`;
}

// ============================================================
// question_id（题目签名）
// ============================================================

export type SignedQuestionType = "choice" | "cloze";

/** 出题时的知识点状态快照：submit 用它算新状态，客户端改不了 */
export interface QuestionStateSnapshot {
  /** 状态机状态 */
  st: string;
  /** intervalDays */
  iv: number;
  /** ease */
  ea: number;
  /** streak */
  sk: number;
  /** lapses */
  lp: number;
  /** need */
  nd: number;
}

export interface QuestionPayload {
  v: 1;
  /** 出题日期 `YYYY-MM-DD` */
  d: string;
  /** 知识点原文 */
  k: string;
  /** 归一化内容（回写时按它匹配行） */
  p: string;
  /** 题型 */
  t: SignedQuestionType;
  /** 正确答案（原文形式，判分时归一化） */
  a: string;
  /** 其它可接受答案 */
  alt?: string[];
  /**
   * 选择题的选项原文（与题面顺序一致）。
   * 有了它，宿主传 "B" 或传选项原文都能判分（见 docs/API_IMPLEMENTATION.md §5）。
   * 填空题不带这个字段。
   */
  o?: string[];
  /** 释义，用于讲解 */
  m?: string;
  /** 解释（为什么容易错） */
  e?: string;
  /** 来源链接 */
  src?: string;
  /** 作答前的状态快照 */
  s: QuestionStateSnapshot;
  /** 到期时间（UTC 毫秒） */
  exp: number;
}

/** 题目有效期：出题日结束 + 48 小时（跨天补答仍然能判分） */
export function questionExpiry(date: string): number {
  return endOfDayMs(date) + 2 * DAY_MS;
}

export function signQuestionId(
  payload: Omit<QuestionPayload, "v" | "exp">,
  secret: string
): string {
  return signPayload(
    { ...payload, v: 1, exp: questionExpiry(payload.d) } satisfies QuestionPayload,
    secret
  );
}

export function decodeQuestionId(
  token: unknown,
  secret: string,
  nowMs: number = Date.now()
): DecodeResult<QuestionPayload> {
  const decoded = decodePayload<QuestionPayload>(token, secret, nowMs);
  if (!decoded.ok) return decoded;
  const payload = decoded.payload;
  if (
    payload.v !== 1 ||
    typeof payload.d !== "string" ||
    typeof payload.p !== "string" ||
    typeof payload.k !== "string" ||
    (payload.t !== "choice" && payload.t !== "cloze") ||
    typeof payload.a !== "string" ||
    (payload.o !== undefined &&
      (!Array.isArray(payload.o) ||
        payload.o.length === 0 ||
        payload.o.some((option) => typeof option !== "string"))) ||
    !payload.s ||
    typeof payload.s.st !== "string"
  ) {
    return { ok: false, reason: "malformed" };
  }
  return decoded;
}
