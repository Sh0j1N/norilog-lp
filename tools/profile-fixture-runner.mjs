// 国別プロファイルの正解表（country-profiles/fixtures/*.json、仕様 v2 12章）を回す共通部分と、表示名の lint（3.1）。
// iOS の Golden test/CountryProfileFixtureRunner.swift の移植。ファイルを読まない（fs に依存しない）ので、
// tools/profile-check.mjs と tools/profile-errors.test.mjs の両方から使う。

import {
  AS_OF_DATE_INPUT_ID,
  JsonNumber,
  ProfileError,
  REQUIRED_LANGUAGES,
  TERM_MONTHS_INPUT_ID,
  compulsoryInsurancePremium,
  compulsoryInsuranceTerms,
  evaluateTax,
  Outcome,
  Payment,
  toJSONTree,
} from '../simulator/profile/evaluator.js';

/** 正解表で `as_of_date` を省いたときの基準日（仕様 12章） */
export const DEFAULT_AS_OF_DATE = 20261005n;
export const COMPULSORY_KEY = 'compulsory_insurance';

const INT64_MIN = -(1n << 63n);
const INT64_MAX = (1n << 63n) - 1n;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof JsonNumber);

/** Swift の split(separator:maxSplits:1)（空の部分は捨てる）と同じ分け方 */
function swiftSplitOnce(text, separator) {
  const result = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== separator) continue;
    const appended = i > start;
    if (appended) result.push(text.slice(start, i));
    start = i + 1;
    if (appended && result.length === 1) break;
  }
  if (start !== text.length) result.push(text.slice(start));
  return result;
}

/** "road_tax"・"road_tax@6"（6か月払い）・"weight_tax@initial"（最初の1回） */
export function taxKey(key) {
  const parts = swiftSplitOnce(key, '@');
  if (parts.length !== 2) return [key, Payment.regular];
  if (parts[1] === 'initial') return [parts[0], Payment.initial];
  const months = /^[+-]?[0-9]+$/.test(parts[1]) ? BigInt(parts[1]) : null;
  if (months === null || months < INT64_MIN || months > INT64_MAX) {
    throw new ProfileError('schema', { path: `expected.${key}`, message: '@ の後は月数か initial です' });
  }
  return [parts[0], Payment.cadence(months)];
}

/** 正解表の値を入力値にする（文字列・真偽値・整数。読めなければ undefined） */
export function profileValue(raw) {
  if (typeof raw === 'string' || typeof raw === 'boolean') return raw;
  if (!(raw instanceof JsonNumber) || raw.isDecimal) return undefined;
  if (raw.integer < INT64_MIN || raw.integer > INT64_MAX) return undefined;
  return raw.integer;
}

/** 期待値（null・"manual"・整数）を Outcome にする（金額は BigInt）。読めなければ undefined */
export function expectedOutcome(raw) {
  if (raw === null) return Outcome.notApplicable;
  if (typeof raw === 'string') return raw === 'manual' ? Outcome.manual : undefined;
  const value = profileValue(raw);
  if (typeof value !== 'bigint') return undefined;
  return Outcome.amount(value);
}

export function sameOutcome(a, b) {
  return a.type === b.type && (a.type !== 'amount' || BigInt(a.amount) === BigInt(b.amount));
}

export function describeOutcome(outcome) {
  switch (outcome.type) {
    case 'notApplicable': return 'null（かからない）';
    case 'manual': return '"manual"';
    default: return `${outcome.amount}`;
  }
}

const compareKeys = (a, b) => {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
};

/**
 * 正解表を1つ回す。評価のエラーも「不一致」として報告し、途中で止めない。
 * @param fixturesSource 正解表の JSON（文字列・バイト列）
 * @returns {{compared: number, failures: string[]}}
 */
export function runFixtures(profile, fixturesSource) {
  const fixtures = toJSONTree(fixturesSource);
  if (!Array.isArray(fixtures) || !fixtures.every(isObject)) {
    throw new ProfileError('invalidJSON', { message: '正解表はオブジェクトの配列です' });
  }
  const report = { compared: 0, failures: [] };
  fixtures.forEach((fixture, index) => {
    const name = typeof fixture.name === 'string' ? fixture.name : `#${index}`;
    if (!Object.hasOwn(fixture, 'source')) {
      report.failures.push(`${name}: source がありません`);
      return;
    }
    const rawInputs = fixture.inputs;
    const expected = fixture.expected;
    if (!isObject(rawInputs) || !isObject(expected) || Object.keys(expected).length === 0) {
      report.failures.push(`${name}: inputs / expected がありません`);
      return;
    }
    const inputs = {};
    let termMonths = null;
    let badInput = false;
    for (const [key, raw] of Object.entries(rawInputs)) {
      const value = profileValue(raw);
      if (value === undefined) {
        report.failures.push(`${name}: 入力 ${key} の型が読めません`);
        badInput = true;
        continue;
      }
      if (key === TERM_MONTHS_INPUT_ID && typeof value === 'bigint') termMonths = value;
      else inputs[key] = value;
    }
    if (badInput) return;
    if (inputs[AS_OF_DATE_INPUT_ID] === undefined) inputs[AS_OF_DATE_INPUT_ID] = DEFAULT_AS_OF_DATE;

    for (const key of Object.keys(expected).sort(compareKeys)) {
      report.compared += 1;
      const want = expectedOutcome(expected[key]);
      if (want === undefined) {
        report.failures.push(`${name}: expected.${key} は整数・null・"manual" のどれかです`);
        continue;
      }
      try {
        let actual;
        if (key === COMPULSORY_KEY) {
          const term = termMonths ?? compulsoryInsuranceTerms(profile, inputs)?.defaultTermMonths ?? null;
          actual = term === null
            ? Outcome.notApplicable
            : compulsoryInsurancePremium(profile, inputs, term, { bigint: true });
        } else {
          const [taxId, payment] = taxKey(key);
          actual = evaluateTax(profile, inputs, taxId, { payment, includeManual: true, bigint: true });
        }
        if (!sameOutcome(actual, want)) {
          report.failures.push(`${name}: ${key} 期待 ${describeOutcome(want)} 実際 ${describeOutcome(actual)}`);
        }
      } catch (error) {
        report.failures.push(`${name}: ${key} でエラー: ${error instanceof ProfileError ? error.message : String(error)}`);
      }
    }
  });
  return report;
}

/** 表示名に必須の4言語（ja・en・zh-Hant・ko）がそろっているか。足りない箇所を返す。 */
export function lintLanguages(profile) {
  const texts = [['disclaimer', profile.disclaimer]];
  if (profile.currency.largeUnit) texts.push(['currency.large_unit', profile.currency.largeUnit.label]);
  for (const input of profile.inputs) {
    texts.push([`inputs.${input.id}`, input.label]);
    if (input.type === 'enum') for (const o of input.options) texts.push([`inputs.${input.id}.${o.id}`, o.label]);
  }
  for (const tax of profile.taxes) {
    texts.push([`taxes.${tax.id}`, tax.name]);
    if (tax.note) texts.push([`taxes.${tax.id}.note`, tax.note]);
  }
  for (const inspection of profile.inspections) {
    texts.push([`inspections.${inspection.id}`, inspection.name]);
    if (inspection.note) texts.push([`inspections.${inspection.id}.note`, inspection.note]);
  }
  if (profile.compulsoryInsurance) texts.push(['compulsory_insurance', profile.compulsoryInsurance.name]);
  for (const fuel of profile.fuels) {
    texts.push([`fuels.${fuel.id}`, fuel.name]);
    if (fuel.note) texts.push([`fuels.${fuel.id}.note`, fuel.note]);
  }
  // Swift の .whitespaces（タブと Unicode の空白 Zs）だけを空とみなす。改行は空白に数えない
  const blank = (s) => /^[\t\p{Zs}]*$/u.test(s);
  return texts.flatMap(([path, text]) => {
    const missing = REQUIRED_LANGUAGES.filter((lang) => blank(Object.hasOwn(text, lang) ? text[lang] : ''));
    return missing.length === 0 ? [] : [`${profile.country} ${path}: ${missing.join(', ')} がありません`];
  });
}
