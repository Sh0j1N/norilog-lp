#!/usr/bin/env node
// 実装間の一致（country-profiles/conformance/XX.json、仕様 v2 12.2）を JS の評価器で確かめる。
// データは iOS の Swift 評価器の出力（scripts/profile-conformance/main.swift が作る。公式の正解ではない）。
// 金額・null・"manual"・エラーの種類（missingInput / inputNotAsked / inputOutOfRange は入力 id も）を比べ、
// エラーの文言・path は比べない。
//
//   node tools/profile-conformance.mjs          … 全部の国
//   node tools/profile-conformance.mjs JP TW    … 指定した国だけ
// データの場所は環境変数 NORILOG_PROFILES_DIR（既定: ~/Desktop/Odomemo/country-profiles）。

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  JsonNumber,
  ProfileError,
  Payment,
  compulsoryInsurancePremium,
  compulsoryInsuranceTerms,
  evaluateTax,
  fuels,
  inspections,
  loadProfile,
  toJSONTree,
} from '../simulator/profile/evaluator.js';

export const profilesDir = () => process.env.NORILOG_PROFILES_DIR || join(homedir(), 'Desktop', 'Odomemo', 'country-profiles');

/** Swift の errorJSON と同じ形 */
function errorJSON(error) {
  if (!(error instanceof ProfileError)) return { error: 'other', detail: String(error) };
  switch (error.kind) {
    case 'missingInput': case 'inputNotAsked': case 'inputOutOfRange':
      return { error: error.kind, id: error.info.id };
    case 'noMatchingBracket': case 'explicitFail': case 'nonIntegerAmount': case 'invalidTermMonths':
    case 'invalidCadence': case 'asOfBeforeEffectiveFrom': case 'typeMismatch': case 'arithmeticOverflow':
    case 'divisionByZero':
      return { error: error.kind };
    default:
      // Swift は "\(e)"（description）の "(" より前を種類にしている
      return { error: error.message.split('(')[0] };
  }
}

const capture = (body) => {
  try {
    return body();
  } catch (error) {
    return errorJSON(error);
  }
};

const outcomeJSON = (o) => (o.type === 'notApplicable' ? null : o.type === 'manual' ? 'manual' : BigInt(o.amount));

/** Swift の生成器（main.swift）と同じ呼び方で、1ケースの results を作る */
export function conformanceResults(profile, inputs) {
  const results = {};
  for (const tax of profile.taxes) {
    const payments = [[tax.id, Payment.regular]];
    for (const option of tax.cadenceOptions) payments.push([`${tax.id}@${option.months}`, Payment.cadence(option.months)]);
    if (tax.initial) payments.push([`${tax.id}@initial`, Payment.initial]);
    for (const [key, payment] of payments) {
      results[key] = capture(() => outcomeJSON(evaluateTax(profile, inputs, tax.id, { payment, includeManual: true, bigint: true })));
    }
  }
  try {
    const terms = compulsoryInsuranceTerms(profile, inputs);
    if (terms) {
      results['compulsory_insurance:terms'] = { options: terms.options.map(BigInt), default: BigInt(terms.defaultTermMonths) };
      for (const term of [...terms.options, 7]) {
        results[`compulsory_insurance@${term}`] = capture(() => outcomeJSON(compulsoryInsurancePremium(profile, inputs, term, { bigint: true })));
      }
    } else {
      results['compulsory_insurance:terms'] = null;
    }
  } catch (error) {
    results['compulsory_insurance:terms'] = errorJSON(error);
  }
  results.inspections = capture(() => inspections(profile, inputs).map((i) => i.id));
  results.fuels = capture(() => fuels(profile, inputs).map((f) => f.id));
  return results;
}

/** 比べるための正規形（キーを並べ、整数は BigInt の文字列） */
function canonical(v) {
  if (v === null || v === undefined) return 'null';
  if (v instanceof JsonNumber) return v.isDecimal ? `decimal:${v.raw}` : `${v.integer}`;
  if (typeof v === 'bigint') return `${v}`;
  if (typeof v === 'number') return Number.isInteger(v) ? `${v}` : `decimal:${v}`;
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'boolean') return `${v}`;
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const keys = Object.keys(v).filter((k) => k !== 'detail').sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}

/** 入力の JSON 値を評価器の入力にする（整数は BigInt） */
function toInputs(raw) {
  const inputs = {};
  for (const [k, v] of Object.entries(raw)) inputs[k] = v instanceof JsonNumber ? (v.isDecimal ? Number(v.raw) : v.integer) : v;
  return inputs;
}

/**
 * 1か国の実装間の一致を確かめる。
 * @returns {{cases: number, compared: number, failures: string[]}}
 */
export function runConformance(profile, source) {
  const doc = toJSONTree(source);
  const report = { cases: 0, compared: 0, failures: [] };
  if (doc === null || typeof doc !== 'object' || !Array.isArray(doc.cases)) {
    throw new ProfileError('invalidJSON', { message: 'conformance は {"cases": [...]} のオブジェクトです' });
  }
  if (doc.profile_version instanceof JsonNumber && doc.profile_version.integer !== BigInt(profile.profileVersion)) {
    report.failures.push(`profile_version が違います（conformance ${doc.profile_version.raw}・プロファイル ${profile.profileVersion}）。作り直しが要ります`);
  }
  doc.cases.forEach((c, index) => {
    report.cases += 1;
    const expected = c.results;
    const actual = conformanceResults(profile, toInputs(c.inputs));
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of [...keys].sort()) {
      report.compared += 1;
      const want = Object.hasOwn(expected, key) ? canonical(expected[key]) : '(キー無し)';
      const got = Object.hasOwn(actual, key) ? canonical(actual[key]) : '(キー無し)';
      if (want !== got) {
        const detail = actual[key]?.detail ? ` ${actual[key].detail}` : '';
        report.failures.push(`#${index} ${key}: 期待 ${want} 実際 ${got}${detail} 入力 ${canonical(c.inputs)}`);
      }
    }
  });
  return report;
}

function main(args) {
  const root = profilesDir();
  const dir = join(root, 'conformance');
  if (!existsSync(dir)) {
    console.log(`conformance が見つかりません: ${dir}`);
    return 1;
  }
  const countries = args.length > 0 ? args : readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
  let failed = false;
  for (const country of countries) {
    try {
      const profile = loadProfile(readFileSync(join(root, `${country}.json`)));
      const report = runConformance(profile, readFileSync(join(dir, `${country}.json`)));
      const ok = report.failures.length === 0;
      failed ||= !ok;
      console.log(`${ok ? '✅' : '❌'} ${country} v${profile.profileVersion}: 実装間の一致 ${report.cases} ケース・${report.compared} 件中 不一致 ${report.failures.length} 件`);
      for (const line of report.failures.slice(0, 20)) console.log(`   ✗ ${line}`);
      if (report.failures.length > 20) console.log(`   …ほか ${report.failures.length - 20} 件`);
    } catch (error) {
      failed = true;
      console.log(`❌ ${country}: 読み込めません: ${error instanceof ProfileError ? error.message : error}`);
    }
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
