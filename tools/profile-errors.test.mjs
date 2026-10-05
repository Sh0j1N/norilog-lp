// 仕様 2章の3「知らないもの・あり得ない状態はエラー」を JS の評価器が守ることのテスト。
// iOS の Golden test/CountryProfileEvaluatorErrorTests.swift の移植と、JS 固有の確認（小数の見分け・負数の half_up・桁あふれ）。
//
//   node --test tools/profile-errors.test.mjs   （または LP のルートで node --test）
// JP.json の場所は環境変数 NORILOG_PROFILES_DIR（既定: ~/Desktop/Odomemo/country-profiles）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ProfileError,
  Rational,
  compulsoryInsurancePremium,
  evaluate,
  evaluateTax,
  loadProfile,
  parseJSON,
} from '../simulator/profile/evaluator.js';
import { profilesDir } from './profile-conformance.mjs';
import { taxKey } from './profile-fixture-runner.mjs';

const loadJapan = () => loadProfile(readFileSync(join(profilesDir(), 'JP.json')));

/** 入力 `cc`（int）と `kind`（enum）を持つ最小のプロファイル。`amount` に式の JSON を差し込む。 */
function miniProfile(amount, { derived = '{}', extraInputs = '' } = {}) {
  return loadProfile(`
  {
    "spec_version": 2, "country": "XX", "profile_version": 1,
    "effective_from": "2026-01-01", "verified_at": "2026-10-04",
    "currency": {"code": "XXX", "minor_exponent": 0, "symbol": "X"},
    "age_basis": {"origin": "first_registration", "method": "completed_years"},
    "inputs": [
      {"id": "cc", "type": "int", "label": {"en": "cc"}, "min": 0},
      {"id": "kind", "type": "enum", "label": {"en": "kind"},
       "options": [{"id": "car", "label": {"en": "car"}}, {"id": "bike", "label": {"en": "bike"}}]}
      ${extraInputs}
    ],
    "derived": ${derived},
    "taxes": [{
      "id": "t", "name": {"en": "t"}, "cadence_months": 12, "auto_calculable": true,
      "sources": [{"url": "https://example.com", "title": "t", "verified_at": "2026-10-04", "confidence": "confirmed"}],
      "amount": ${amount}
    }]
  }`);
}

/** 投げられたエラーを { kind, ...info } にする（投げなければ null） */
function thrown(body) {
  try {
    body();
    return null;
  } catch (error) {
    if (!(error instanceof ProfileError)) throw error;
    return { kind: error.kind, ...error.info };
  }
}

const err = (kind, info = {}) => ({ kind, ...info });

// MARK: - 依頼で必須とされたエラー

test('知らない op はエラー', () => {
  assert.deepEqual(
    thrown(() => miniProfile('{"op": "pow", "args": [{"var": "cc"}, {"const": 2}]}')),
    err('unknownOp', { path: '$.taxes[0].amount', op: 'pow' }),
  );
});

test('必須入力の欠落はエラー（JP.json で普通乗用車の排気量を渡さない）', () => {
  const profile = loadJapan();
  const inputs = {
    category: 'passenger', fuel_type: 'regular', is_rotary: false, weight_kg: 1200,
    car_age_years: 3, registration_year: 2023, registration_month: 4,
  };
  const e = thrown(() => evaluate(profile, inputs));
  assert.equal(e?.kind, 'missingInput');
  assert.equal(e.id, 'displacement_cc');
});

test('標準入力（車齢）の欠落もエラー', () => {
  const profile = loadJapan();
  const e = thrown(() => evaluate(profile, { category: 'kei', fuel_type: 'regular', weight_kg: 800 }));
  assert.equal(e?.kind, 'missingInput');
  assert.equal(e.id, 'car_age_years');
});

test('else の無い区分表から外れたらエラー（0 にしない）', () => {
  const profile = miniProfile('{"op": "table", "input": {"var": "cc"}, "brackets": [{"max": 1000, "value": 100}]}');
  assert.deepEqual(evaluate(profile, { cc: 1000 }), { t: 100 });
  assert.deepEqual(thrown(() => evaluate(profile, { cc: 1001 })), err('noMatchingBracket', { path: '$.taxes[0].amount', input: '1001' }));
});

// MARK: - その他の「黙って壊れない」約束

test('宣言されていない入力・型違い・選択肢に無い値・範囲外はエラー', () => {
  const profile = miniProfile('{"var": "cc"}');
  assert.deepEqual(thrown(() => evaluate(profile, { cc: 1, ccc: 2 })), err('unknownInput', { id: 'ccc' }));
  assert.deepEqual(thrown(() => evaluate(profile, { cc: true })), err('inputTypeMismatch', { id: 'cc', expected: 'int', actual: 'bool' }));
  assert.deepEqual(
    thrown(() => evaluate(profile, { cc: 1, kind: 'truck' })),
    err('invalidEnumValue', { id: 'kind', value: 'truck', options: ['car', 'bike'] }),
  );
  assert.deepEqual(thrown(() => evaluate(profile, { cc: -1 })), err('inputOutOfRange', { id: 'cc', value: -1, min: 0, max: null }));
});

test('ask_when が偽で聞かなかった入力を参照したらエラー', () => {
  const profile = miniProfile('{"var": "seats"}', {
    extraInputs: ', {"id": "seats", "type": "int", "label": {"en": "seats"}, "ask_when": {"eq": ["kind", "bike"]}}',
  });
  assert.deepEqual(evaluate(profile, { kind: 'bike', seats: 2 }), { t: 2 });
  assert.deepEqual(thrown(() => evaluate(profile, { kind: 'car', seats: 2 })), err('inputNotAsked', { id: 'seats', path: '$.taxes[0].amount' }));
});

test('最終値が整数にならなければエラー、round を付ければ通る', () => {
  const unrounded = miniProfile('{"op": "mul", "args": [{"var": "cc"}, {"num": 1, "den": 3}]}');
  assert.deepEqual(thrown(() => evaluate(unrounded, { cc: 100 })), err('nonIntegerAmount', { taxID: 't', value: '100/3' }));
  const rounded = miniProfile('{"op": "mul", "args": [{"var": "cc"}, {"num": 1, "den": 3}], "round": {"mode": "half_up", "to": 10}}');
  assert.deepEqual(evaluate(rounded, { cc: 100 }), { t: 30 });
  assert.deepEqual(evaluate(rounded, { cc: 45 }), { t: 20 }); // 15 → 20（半分は切り上げ）
});

test('小数・知らないキー・知らない条件・else の無い if・未宣言の変数・選択肢に無い定数は読み込み時にエラー', () => {
  assert.deepEqual(thrown(() => miniProfile('{"const": 1.5}')), err('schema', {
    path: '$.taxes[0].amount.const', message: '小数は使えません。{"num": …, "den": …} の分数で書いてください',
  }));
  assert.deepEqual(
    thrown(() => miniProfile('{"var": "cc", "rond": {"mode": "floor", "to": 1}}')),
    err('schema', { path: '$.taxes[0].amount', message: '知らないキー "rond" があります' }),
  );
  assert.deepEqual(thrown(() => miniProfile('{"var": "weight"}')), err('unknownVariable', { path: '$.taxes[0].amount', id: 'weight' }));
  assert.equal(thrown(() => miniProfile('{"op": "if", "cases": [{"when": {"eq": ["kind", "car"]}, "then": {"const": 1}}]}'))?.kind, 'schema');
  assert.equal(
    thrown(() => miniProfile('{"op": "if", "cases": [{"when": {"eq": ["kind", "kar"]}, "then": {"const": 1}}], "else": {"const": 0}}'))?.kind,
    'schema',
  );
  assert.equal(
    thrown(() => miniProfile('{"op": "if", "cases": [{"when": {"like": ["kind", "car"]}, "then": {"const": 1}}], "else": {"const": 0}}'))?.kind,
    'schema',
  );
});

test('派生値の循環参照は読み込み時にエラー', () => {
  assert.deepEqual(
    thrown(() => miniProfile('{"var": "a"}', { derived: '{"a": {"var": "b"}, "b": {"var": "a"}}' })),
    err('derivedCycle', { ids: ['a', 'b', 'a'] }),
  );
});

test('term_months_options に無い保険期間はエラー', () => {
  const profile = loadJapan();
  // 改定前の乗用車は、一次情報で旧料率を確かめた 24・36 か月だけを選択肢にしている（term_rules）
  assert.deepEqual(
    thrown(() => compulsoryInsurancePremium(profile, { category: 'passenger', as_of_date: 20261031 }, 13)),
    err('invalidTermMonths', { value: 13, options: [24, 36] }),
  );
});

test('各 op の計算（steps・bracket_rate・progressive・age_reduction）', () => {
  const steps = miniProfile('{"op": "steps", "input": {"var": "cc"}, "from": 8000, "step": 1000, "per_step": 4700}');
  assert.deepEqual(evaluate(steps, { cc: 8000 }), { t: 0 });
  assert.deepEqual(evaluate(steps, { cc: 8001 }), { t: 4700 });
  assert.deepEqual(evaluate(steps, { cc: 10000 }), { t: 9400 });

  const rate = miniProfile('{"op": "bracket_rate", "input": {"var": "cc"}, "brackets": [{"max": 1000, "rate": 80}, {"rate": 200}]}');
  assert.deepEqual(evaluate(rate, { cc: 1000 }), { t: 80_000 });
  assert.deepEqual(evaluate(rate, { cc: 1001 }), { t: 200_200 });

  const progressive = miniProfile('{"op": "progressive", "input": {"var": "cc"}, "brackets": [{"max": 1600, "base": 9000, "from": 1400, "rate": {"num": 40, "den": 100}}]}');
  assert.deepEqual(evaluate(progressive, { cc: 1500 }), { t: 9040 });

  // 3年目から年5%、最大50%: 2年目 0%、3年目 5%、12年目以降 50%
  const reduction = miniProfile('{"op": "age_reduction", "base": {"const": 100000}, "age": {"var": "cc"}, "start_age": 3, "per_year": {"num": 5, "den": 100}, "max": {"num": 50, "den": 100}}');
  assert.deepEqual(evaluate(reduction, { cc: 2 }), { t: 100_000 });
  assert.deepEqual(evaluate(reduction, { cc: 3 }), { t: 95_000 });
  assert.deepEqual(evaluate(reduction, { cc: 20 }), { t: 50_000 });
});

test('有理数の丸め（負数を含む）', () => {
  const minusSevenHalves = Rational.fraction(-7, 2);
  assert.equal(minusSevenHalves.floorInteger(), -4n);
  assert.equal(minusSevenHalves.ceilInteger(), -3n);
  assert.equal(minusSevenHalves.halfUpInteger(), -4n);
  assert.equal(Rational.fraction(7, 2).halfUpInteger(), 4n);
  assert.equal(Rational.fraction(1308 * 3, 2).floorInteger(), 1962n);
});

// MARK: - 仕様 v2

test('fail に到達したらエラー（振り分けの書き忘れを黙って最後の値にしない）', () => {
  const profile = miniProfile(`
    {"op": "if", "cases": [{"when": {"eq": ["kind", "car"]}, "then": {"const": 100}}],
     "else": {"op": "fail", "message": "bike の分岐が無い"}}`);
  assert.deepEqual(evaluate(profile, { kind: 'car', cc: 0 }), { t: 100 });
  assert.deepEqual(
    thrown(() => evaluate(profile, { kind: 'bike', cc: 0 })),
    err('explicitFail', { path: '$.taxes[0].amount.else', message: 'bike の分岐が無い' }),
  );
});

test('as_of_gte / as_of_lt で改定の前後を切り替える。基準日が無ければエラー', () => {
  const profile = miniProfile('{"op": "if", "cases": [{"when": {"as_of_gte": "2026-11-01"}, "then": {"const": 18560}}], "else": {"const": 17650}}');
  const base = { kind: 'car', cc: 0 };
  assert.deepEqual(evaluate(profile, { ...base, as_of_date: 20261031 }), { t: 17650 });
  assert.deepEqual(evaluate(profile, { ...base, as_of_date: 20261101 }), { t: 18560 });
  assert.deepEqual(thrown(() => evaluate(profile, base)), err('missingInput', { id: 'as_of_date', path: '$.taxes[0].amount.cases[0].then' }));
  // 実在しない日付・effective_from より前はエラー
  assert.deepEqual(
    thrown(() => evaluate(profile, { ...base, as_of_date: 20260231 })),
    err('inputOutOfRange', { id: 'as_of_date', value: 20260231, min: null, max: null }),
  );
  assert.deepEqual(
    thrown(() => evaluate(profile, { ...base, as_of_date: 20251231 })),
    err('asOfBeforeEffectiveFrom', { asOf: 20251231, effectiveFrom: 20260101 }),
  );
});

test('v1 のファイル（spec_version 1）は読み込みエラー', () => {
  assert.deepEqual(thrown(() => loadProfile('{"spec_version": 1}')), err('unsupportedSpecVersion', { version: 1 }));
});

// MARK: - JS 固有（JSON.parse・Number・Math.round の落とし穴）

test('1.0 や 1e2 のように整数に見える小数も読み込みエラー（JSON.parse では見分けられない）', () => {
  for (const literal of ['1.0', '1e2', '1E2', '-0.0', '10E-1']) {
    assert.equal(thrown(() => miniProfile(`{"const": ${literal}}`))?.message, '小数は使えません。{"num": …, "den": …} の分数で書いてください', literal);
  }
  assert.deepEqual(evaluate(miniProfile('{"const": -0}'), { cc: 0 }), { t: 0 });
});

test('half_up は負数のちょうど半分を 0 から遠い方へ（-2.5 → -3。Math.round なら -2）', () => {
  const profile = miniProfile('{"op": "sub", "args": [{"const": 0}, {"op": "mul", "args": [{"var": "cc"}, {"num": 1, "den": 2}]}], "round": {"mode": "half_up", "to": 1}}');
  assert.deepEqual(evaluate(profile, { cc: 5 }), { t: -3 });
  assert.deepEqual(evaluate(profile, { cc: 3 }), { t: -2 });
  assert.equal(Rational.fraction(-5, 2).halfUpInteger(), -3n);
  assert.equal(Rational.fraction(5, 2).halfUpInteger(), 3n);
  assert.equal(Rational.fraction(-7, 3).halfUpInteger(), -2n);
});

test('64 ビットを超える計算は Swift と同じく arithmeticOverflow（黙って丸めない）', () => {
  const profile = miniProfile('{"op": "mul", "args": [{"var": "cc"}, {"var": "cc"}]}');
  assert.deepEqual(evaluate(profile, { cc: 3037000499 }, { bigint: true }), { t: 9223372030926249001n });
  assert.equal(thrown(() => evaluate(profile, { cc: 3037000500 }))?.kind, 'arithmeticOverflow');
  // 64 ビットに収まっても Number の安全な整数を超える金額は、既定ではエラー（bigint: true なら受け取れる）
  assert.equal(thrown(() => evaluate(profile, { cc: 3037000499 }))?.kind, 'arithmeticOverflow');
  assert.deepEqual(evaluate(profile, { cc: 94906265 }), { t: 9007199136250225 });
  // 大きな入力は BigInt で渡せる
  const ident = miniProfile('{"var": "cc"}');
  assert.deepEqual(evaluate(ident, { cc: 2n ** 62n }, { bigint: true }), { t: 2n ** 62n });
  assert.equal(thrown(() => evaluate(ident, { cc: 2n ** 63n }))?.kind, 'inputTypeMismatch');
  assert.equal(thrown(() => evaluate(ident, { cc: 1.5 }))?.kind, 'inputTypeMismatch');
});

test('null はキーが無いのと同じ・知らないキーはエラー・同じキーは最初の値（JSONSerialization と同じ）', () => {
  assert.deepEqual(evaluate(miniProfile('{"var": "cc", "round": null}'), { cc: 7 }), { t: 7 });
  const dup = parseJSON('{"a": 1, "a": 2}');
  assert.equal(dup.a.integer, 1n);
  assert.equal(thrown(() => parseJSON('{"a": "\\ud800"}'))?.kind, 'invalidJSON');
  assert.equal(thrown(() => parseJSON('[1,]'))?.kind, 'invalidJSON');
  assert.equal(thrown(() => parseJSON('[01]'))?.kind, 'invalidJSON');
  assert.equal(thrown(() => loadProfile(new Uint8Array([0x7b, 0xff, 0x7d])))?.kind, 'invalidJSON');
});

test('支払い周期・最初の1回の指定', () => {
  const profile = miniProfile('{"var": "cc"}');
  assert.deepEqual(evaluateTax(profile, { cc: 5 }, 't', { payment: 12 }), { type: 'amount', amount: 5 });
  assert.deepEqual(
    thrown(() => evaluateTax(profile, { cc: 5 }, 't', { payment: 6 })),
    err('invalidCadence', { taxID: 't', months: 6, options: [12] }),
  );
  assert.equal(thrown(() => evaluateTax(profile, { cc: 5 }, 't', { payment: 'initial' }))?.kind, 'schema');
  assert.equal(thrown(() => evaluateTax(profile, { cc: 5 }, 'nope'))?.kind, 'schema');
  assert.equal(thrown(() => evaluate(profile, { cc: 5 }, { taxIds: ['nope'] }))?.kind, 'schema');
});

test('正解表のキー（Swift の split と同じ分け方）', () => {
  assert.deepEqual(taxKey('road_tax'), ['road_tax', { type: 'regular' }]);
  assert.deepEqual(taxKey('road_tax@6'), ['road_tax', { type: 'cadence', months: 6n }]);
  assert.deepEqual(taxKey('weight_tax@initial'), ['weight_tax', { type: 'initial' }]);
  assert.deepEqual(taxKey('road_tax@'), ['road_tax@', { type: 'regular' }]);
  assert.equal(thrown(() => taxKey('road_tax@six'))?.kind, 'schema');
});
