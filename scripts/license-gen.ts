/**
 * 授权码发码脚本（线下售卖时用）。
 *
 * 用法：
 *   LICENSE_SECRET=你的密钥 npx tsx scripts/license-gen.ts 10
 *   LICENSE_SECRET=你的密钥 npx tsx scripts/license-gen.ts 10 --csv
 *
 * 由于服务端不存码表（见 docs/API_IMPLEMENTATION.md §2.1），
 * 「发码」就是一次离线计算：校验位由 LICENSE_SECRET 派生。
 * 所以：换密钥 = 所有旧授权码同时失效；这批码请自己保管好。
 */
import { generateLicenseCode, isValidLicenseCode } from "../src/lib/token";

function main() {
  const secret = process.env.LICENSE_SECRET;
  if (!secret || secret === "change-me") {
    console.error("❌ 需要环境变量 LICENSE_SECRET（不要用 change-me）");
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const countArg = args.find((arg) => /^\d+$/.test(arg));
  const count = countArg ? Number(countArg) : 1;
  if (!Number.isInteger(count) || count < 1 || count > 1000) {
    console.error("❌ 数量必须是 1–1000 之间的整数");
    process.exit(1);
  }

  const csv = args.includes("--csv");
  if (csv) console.log("license");
  const codes = new Set<string>();
  for (let i = 0; i < count; i += 1) {
    let code = generateLicenseCode(secret);
    // 理论上碰撞概率极低，仍然兜一下
    while (codes.has(code)) code = generateLicenseCode(secret);
    codes.add(code);
    if (!isValidLicenseCode(code, secret)) {
      console.error("❌ 生成后自检失败，说明 LICENSE_SECRET 处理有 bug");
      process.exit(1);
    }
    console.log(csv ? code : `  ${code}`);
  }

  if (!csv) {
    console.log(`\n共 ${count} 个授权码（已自检通过）。发给用户前请留档，密钥轮换后全部失效。`);
  }
}

main();
