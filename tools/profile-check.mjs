#!/usr/bin/env node
// 国別プロファイル（country-profiles/）を JS の評価器で検査する。iOS の scripts/profile-check.sh と同じ検査
// （読み込み・表示名の4言語・正解表）に、実装間の一致（conformance、仕様 12.2）を足したもの。
//
//   node tools/profile-check.mjs          … 全部の国
//   node tools/profile-check.mjs TW KR    … 指定した国だけ
// データの場所は環境変数 NORILOG_PROFILES_DIR（既定: ~/Desktop/Odomemo/country-profiles）。
// conformance/ が無ければ実装間の一致は飛ばす。

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ProfileError, loadProfile } from '../simulator/profile/evaluator.js';
import { lintLanguages, runFixtures } from './profile-fixture-runner.mjs';
import { profilesDir, runConformance } from './profile-conformance.mjs';

const root = profilesDir();
let countries = process.argv.slice(2);
if (countries.length === 0) {
  countries = readdirSync(root).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
}

let failed = false;
for (const country of countries) {
  try {
    const profile = loadProfile(readFileSync(join(root, `${country}.json`)));
    const lint = lintLanguages(profile);
    const report = runFixtures(profile, readFileSync(join(root, 'fixtures', `${country}.json`)));
    const conformancePath = join(root, 'conformance', `${country}.json`);
    const conformance = existsSync(conformancePath) ? runConformance(profile, readFileSync(conformancePath)) : null;
    const ok = lint.length === 0 && report.failures.length === 0 && (!conformance || conformance.failures.length === 0);
    failed ||= !ok;
    const conformanceText = conformance
      ? ` / 実装間の一致 ${conformance.compared} 件中 不一致 ${conformance.failures.length} 件`
      : ' / 実装間の一致なし';
    console.log(`${ok ? '✅' : '❌'} ${country} v${profile.profileVersion}: 正解表 ${report.compared} 件中 不一致 ${report.failures.length} 件 / 表示名の不足 ${lint.length} 件${conformanceText}`);
    for (const line of report.failures.slice(0, 40)) console.log(`   ✗ ${line}`);
    if (report.failures.length > 40) console.log(`   …ほか ${report.failures.length - 40} 件`);
    for (const line of lint.slice(0, 20)) console.log(`   🌐 ${line}`);
    if (lint.length > 20) console.log(`   …ほか ${lint.length - 20} 件`);
    for (const line of conformance?.failures.slice(0, 20) ?? []) console.log(`   ≠ ${line}`);
    if (conformance && conformance.failures.length > 20) console.log(`   …ほか ${conformance.failures.length - 20} 件`);
  } catch (error) {
    failed = true;
    console.log(`❌ ${country}: 読み込めません: ${error instanceof ProfileError ? error.message : error}`);
  }
}
process.exitCode = failed ? 1 : 0;
