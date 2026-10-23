/**
 * date.ts 的自测脚本。
 * 运行：npx tsx scripts/date-check.ts
 */
import {
  addDays,
  dateToMs,
  daysBetween,
  endOfDayMs,
  isDateString,
  msToDate,
  todayInShanghai,
} from "../src/lib/date";

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

console.log("\n【1】日期字符串合法性");
check("正常日期", isDateString("2026-10-23"), true);
check("闰日 2028-02-29", isDateString("2028-02-29"), true);
check("非闰年 2026-02-29", isDateString("2026-02-29"), false);
check("2026-02-30", isDateString("2026-02-30"), false);
check("月份 13", isDateString("2026-13-01"), false);
check("位数不足", isDateString("2026-1-1"), false);
check("带时间", isDateString("2026-10-23T00:00:00Z"), false);
check("非字符串", isDateString(20261023), false);

console.log("\n【2】上海时区解析（不受运行环境 TZ 影响）");
check(
  "上海 2026-10-23 00:00 = UTC 2026-10-22 16:00",
  new Date(dateToMs("2026-10-23")).toISOString(),
  "2026-10-22T16:00:00.000Z"
);
check(
  "UTC 15:59 还是 22 号",
  msToDate(Date.parse("2026-10-22T15:59:59Z")),
  "2026-10-22"
);
check(
  "UTC 16:00 已是 23 号",
  msToDate(Date.parse("2026-10-22T16:00:00Z")),
  "2026-10-23"
);

console.log("\n【3】天数差与加减");
check("10-20 → 10-23 = 3 天", daysBetween("2026-10-20", "2026-10-23"), 3);
check("反向 = -3 天", daysBetween("2026-10-23", "2026-10-20"), -3);
check("同一天 = 0", daysBetween("2026-10-23", "2026-10-23"), 0);
check("跨月 +9", addDays("2026-10-23", 9), "2026-11-01");
check("跨年 +70", addDays("2026-10-23", 70), "2027-01-01");
check("减一天", addDays("2026-03-01", -1), "2026-02-28");
check("闰年跨 2-29", addDays("2028-02-28", 1), "2028-02-29");

console.log("\n【4】当日结束时间");
check(
  "10-23 23:59:59.999 (+08:00)",
  new Date(endOfDayMs("2026-10-23")).toISOString(),
  "2026-10-23T15:59:59.999Z"
);

console.log("\n【5】今天（上海）");
const sample = Date.parse("2026-10-23T13:00:00+08:00");
check("按上海取日期", todayInShanghai(sample), "2026-10-23");
check("UTC 深夜已是上海次日", todayInShanghai(Date.parse("2026-10-23T17:00:00Z")), "2026-10-24");

console.log("\n【6】非法入参直接抛错");
let threw = false;
try {
  dateToMs("2026-13-40");
} catch {
  threw = true;
}
check("非法日期抛错", threw, true);

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
