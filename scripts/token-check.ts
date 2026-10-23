/**
 * token.ts 的自测脚本。
 * 运行：npx tsx scripts/token-check.ts
 *
 * 覆盖：授权码校验位、host_token 签名/到期/防篡改、question_id 往返与过期。
 * 用的是假密钥，不接触真实环境变量。
 */
import {
  decodePayload,
  decodeQuestionId,
  formatExpiryIso,
  generateLicenseCode,
  hostTokenExpiresAt,
  HOST_TOKEN_TTL_DAYS,
  isValidLicenseCode,
  LICENSE_ALPHABET,
  LICENSE_CODE_LENGTH,
  licenseCheckChar,
  normalizeLicenseCode,
  questionExpiry,
  signHostToken,
  signQuestionId,
  type HostTokenPayload,
} from "../src/lib/token";
import { addDays, DAY_MS } from "../src/lib/date";

let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.log(
      `  ❌ ${name}\n     期望 ${JSON.stringify(expected)}\n     实际 ${JSON.stringify(actual)}`
    );
  }
}

const SECRET = "unit-test-secret";
const NOW = Date.parse("2026-10-23T21:00:00+08:00");

console.log("\n【1】授权码归一化");
check("去空格转大写", normalizeLicenseCode(" abcd-2345 "), "ABCD2345");
check("长度不对", normalizeLicenseCode("ABCD234"), null);
check("含易混字符 0", normalizeLicenseCode("ABCD2340"), null);
check("含小写", normalizeLicenseCode("abcd2345"), "ABCD2345");
check("字母表 32 个字符", LICENSE_ALPHABET.length, 32);

console.log("\n【2】授权码校验位");
const code = generateLicenseCode(SECRET);
check("生成码长度 8", code.length, LICENSE_CODE_LENGTH);
check("生成的码通过校验", isValidLicenseCode(code, SECRET), true);
const body = code.slice(0, 7);
check("校验位与手工计算一致", code[7], licenseCheckChar(body, SECRET));
const wrongLast = code.slice(0, 7) + LICENSE_ALPHABET[(LICENSE_ALPHABET.indexOf(code[7]) + 1) % 32];
check("改最后一位即失效", isValidLicenseCode(wrongLast, SECRET), false);
check("换密钥即失效", isValidLicenseCode(code, "another-secret"), false);

console.log("\n【3】host_token 签发与校验");
const signed = signHostToken(code, NOW, SECRET);
const decoded = decodePayload<HostTokenPayload>(signed.hostToken, SECRET, NOW);
check("能解出授权码", decoded.ok && decoded.payload.lic, code);
check(
  "有效期一年",
  decoded.ok ? decoded.payload.exp - decoded.payload.iat : 0,
  HOST_TOKEN_TTL_DAYS * DAY_MS
);
check("到期时间 = 一年后", signed.expiresAt, hostTokenExpiresAt(NOW));
check("到期串格式", formatExpiryIso(Date.parse("2027-10-23T00:00:00+08:00")), "2027-10-23T00:00:00+08:00");
check(
  "到期前 1 秒仍有效",
  decodePayload<HostTokenPayload>(signed.hostToken, SECRET, signed.expiresAt - 1000).ok,
  true
);
const expired = decodePayload<HostTokenPayload>(signed.hostToken, SECRET, signed.expiresAt + 1);
check("到期后拒绝", expired.ok === false && expired.reason, "expired");

console.log("\n【4】防篡改");
const sig = signed.hostToken.split(".")[1];
const forged = JSON.stringify({ v: 1, lic: code, iat: NOW, exp: NOW + 10 * 365 * DAY_MS });
const forgedToken = `${Buffer.from(forged).toString("base64url")}.${sig}`;
const forgedResult = decodePayload<HostTokenPayload>(forgedToken, SECRET, NOW);
check("改 payload 签名对不上", forgedResult.ok === false && forgedResult.reason, "signature");
check("随便编的串", decodePayload("not-a-token", SECRET, NOW).ok, false);
check("空串", decodePayload("", SECRET, NOW).ok, false);

console.log("\n【5】question_id 往返");
const questionInput = {
  d: "2026-10-23",
  k: "Subsequent",
  p: "subsequent",
  t: "cloze" as const,
  a: "subsequent",
  alt: ["subsequents"],
  m: "随后的",
  e: "形近词易混",
  o: ["subsequent", "subsequence", "substantial", "substitute"],
  src: "https://example.com/article",
  s: { st: "review", iv: 3, ea: 2.5, sk: 1, lp: 0, nd: 2 },
};
const questionId = signQuestionId(questionInput, SECRET);
const decodedQuestion = decodeQuestionId(questionId, SECRET, NOW);
check("能解出答案", decodedQuestion.ok && decodedQuestion.payload.a, "subsequent");
check("能解出选项", decodedQuestion.ok && decodedQuestion.payload.o?.length, 4);
check("能解出状态快照", decodedQuestion.ok && decodedQuestion.payload.s.nd, 2);
check("能解出归一化内容", decodedQuestion.ok && decodedQuestion.payload.p, "subsequent");
check(
  "题目长度可控（< 1.5KB）",
  questionId.length < 1536,
  true
);
check(
  "有效期 = 出题日结束 + 48 小时",
  decodedQuestion.ok ? decodedQuestion.payload.exp : 0,
  questionExpiry("2026-10-23")
);
check(
  "过期题目拒绝",
  decodeQuestionId(questionId, SECRET, questionExpiry("2026-10-23") + 1).ok,
  false
);
check(
  "换密钥拒绝",
  decodeQuestionId(questionId, "other-secret", NOW).ok,
  false
);
check(
  "过期时间在次日之后（跨天可补答）",
  questionExpiry("2026-10-23") > Date.parse(`${addDays("2026-10-23", 1)}T00:00:00+08:00`),
  true
);

console.log("\n【6】question_id 载荷形状校验");
const badShape = `${Buffer.from(JSON.stringify({ v: 1, exp: NOW + 60_000 })).toString("base64url")}.x`;
check("缺字段拒绝（签名也不对）", decodeQuestionId(badShape, SECRET, NOW).ok, false);

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
