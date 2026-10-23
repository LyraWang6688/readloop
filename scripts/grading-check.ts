/**
 * grading.ts 的自测脚本。
 * 运行：npx tsx scripts/grading-check.ts
 */
import {
  allowedDistance,
  damerauLevenshtein,
  judgeChoice,
  judgeCloze,
  normalizeAnswer,
  toGrade,
} from "../src/lib/grading";

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

console.log("\n【1】归一化");
check("大小写", normalizeAnswer("Subsequent"), "subsequent");
check("多余空格", normalizeAnswer("  the   percentage  of "), "the percentage of");
check("包裹标点", normalizeAnswer("(subsequent)."), "subsequent");
check("中文输入不崩", normalizeAnswer("随后的"), "");

console.log("\n【2】编辑距离（含对调算 1 次）");
check("完全相同", damerauLevenshtein("abc", "abc"), 0);
check("recieve → receive（对调）", damerauLevenshtein("recieve", "receive"), 1);
check("插入一个字母", damerauLevenshtein("subsequent", "subsequant"), 1);
check("完全不同的词", damerauLevenshtein("form", "from"), 1);

console.log("\n【3】容错阈值");
check("4 字母词不容错", allowedDistance("form"), 0);
check("7 字母词容 1", allowedDistance("receive"), 1);
check("10 字母词容 2", allowedDistance("subsequent"), 2);

console.log("\n【4】判断题");
check("答对", judgeChoice("B", "b").correct, true);
check("答错", judgeChoice("B", "C").correct, false);

console.log("\n【5】填空题：生成式，自己输入");
check("精确匹配", judgeCloze("subsequent", "subsequent").correct, true);
check("大小写不同", judgeCloze("subsequent", "Subsequent").correct, true);
check("前后空格", judgeCloze("subsequent", "  subsequent  ").correct, true);
check(
  "允许拼写误差",
  judgeCloze("receive", "recieve").reason,
  "typo"
);
check(
  "错得太离谱不通过",
  judgeCloze("subsequent", "consequence").correct,
  false
);
check("短词不容错（form/from）", judgeCloze("form", "from").correct, false);
check("空答案不通过", judgeCloze("subsequent", "   ").correct, false);
check(
  "接受备选写法",
  judgeCloze("percent", "per cent", ["per cent"]).correct,
  true
);

console.log("\n【6】档位映射");
const clozeOk = judgeCloze("subsequent", "subsequent");
const clozeTypo = judgeCloze("receive", "recieve");
const clozeBad = judgeCloze("subsequent", "consequence");
const choiceOk = judgeChoice("B", "B");

check("填空答对 → easy（生成式，信号更强）", toGrade("cloze", clozeOk), "easy");
check("选择答对 → good", toGrade("choice", choiceOk), "good");
check("拼写容错通过 → hard", toGrade("cloze", clozeTypo), "hard");
check("答错 → again", toGrade("cloze", clozeBad), "again");
check("用了提示的选择题 → hard", toGrade("choice", choiceOk, true), "hard");
check("用了提示的填空题 → hard", toGrade("cloze", clozeOk, true), "hard");
check("用了提示又拼错 → again", toGrade("cloze", clozeTypo, true), "again");

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
