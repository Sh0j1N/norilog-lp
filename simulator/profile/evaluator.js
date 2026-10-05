// 国別プロファイル（country-profiles/SPEC.md v2）の評価器 — JavaScript 版。
//
// iOS の Swift 実装（おどめも/Services/CountryProfile/*.swift）をそのまま移植したもの。読み込みの厳しさ
// （知らないキー・知らない op はエラー、null はキーが無いのと同じ、小数はエラー）、読み込み時の検証、
// 評価の順番（if は上から、and / or / in は左から短絡、派生値は参照されたときだけ）、エラーの種類まで Swift に合わせてある。
//
// - 依存なしの ES module。ブラウザ（モダンブラウザ）と Node（v18 以降）の両方で動く
// - 計算はすべて BigInt の有理数で厳密に行う。Number の算術・Math.round は金額に使わない（仕様 2章の2・6章の丸め）
// - Swift と同じく、約分した結果の分子・分母が 64 ビット整数に収まらなければ arithmeticOverflow
// - 小数（1.0 / 1e2 も）を見分けるため、JSON はこのファイルの小さなパーサーで読む（JSON.parse は 1.0 を 1 にしてしまう）
//
// 使い方:
//   import { loadProfile, evaluate, evaluateTax, Payment } from './profile/evaluator.js';
//   const profile = loadProfile(await (await fetch('/profiles/JP.json')).text());
//   evaluate(profile, { category: 'passenger', displacement_cc: 1500, ..., as_of_date: 20261005 }); // → { auto_tax: 30500, ... }

export const SUPPORTED_SPEC_VERSION = 2;
export const AS_OF_DATE_INPUT_ID = 'as_of_date';
export const TERM_MONTHS_INPUT_ID = 'term_months';
/** アプリ側が必ず渡す標準入力（宣言不要。仕様 4章） */
export const STANDARD_INPUT_IDS = Object.freeze(['car_age_years', 'registration_year', 'registration_month', AS_OF_DATE_INPUT_ID]);
/** 表示名で必須の言語（仕様 3.1）。読み込みではなく lint で確かめる */
export const REQUIRED_LANGUAGES = Object.freeze(['ja', 'en', 'zh-Hant', 'ko']);

const STANDARD = new Set(STANDARD_INPUT_IDS);
const INT64_MIN = -(1n << 63n);
const INT64_MAX = (1n << 63n) - 1n;
const inInt64 = (b) => b >= INT64_MIN && b <= INT64_MAX;
/** エラーの情報に入れる整数（安全な範囲なら Number、そうでなければ BigInt のまま） */
const plainInt = (b) => (typeof b === 'bigint' && b >= BigInt(Number.MIN_SAFE_INTEGER) && b <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(b) : b);

/** Swift の String の並び（Unicode スカラー値の順）に近い比較 */
function compareStrings(a, b) {
  const x = Array.from(a);
  const y = Array.from(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

// MARK: - エラー

/** Swift の [String] / [Int] の表示（`["car", "bike"]` / `[24, 36]`） */
function swiftList(items) {
  return `[${items.map((v) => (typeof v === 'string' ? JSON.stringify(v) : String(v))).join(', ')}]`;
}

function describeError(kind, i) {
  switch (kind) {
    case 'invalidJSON': return `JSON として読めません: ${i.message}`;
    case 'unsupportedSpecVersion': return `spec_version ${i.version} には対応していません（対応: ${SUPPORTED_SPEC_VERSION}）`;
    case 'schema': return `${i.path}: ${i.message}`;
    case 'unknownOp': return `${i.path}: 知らない op "${i.op}" です（仕様 6章にある op だけ使えます）`;
    case 'unknownVariable': return `${i.path}: "${i.id}" は inputs・derived・標準入力のどれにもありません`;
    case 'derivedCycle': return `派生値が循環参照しています: ${i.ids.join(' → ')}`;
    case 'unknownInput': return `入力 "${i.id}" はこのプロファイルに宣言されていません`;
    case 'inputTypeMismatch': return `入力 "${i.id}" は ${i.expected} のはずが ${i.actual} でした`;
    case 'inputOutOfRange':
      return `入力 "${i.id}" = ${i.value} が範囲外です（min: ${i.min ?? 'なし'}, max: ${i.max ?? 'なし'}）`;
    case 'invalidEnumValue': return `入力 "${i.id}" = "${i.value}" は選択肢 ${swiftList(i.options)} にありません`;
    case 'missingInput': return `${i.path}: 必須の入力 "${i.id}" が渡されていません`;
    case 'inputNotAsked': return `${i.path}: 入力 "${i.id}" は ask_when が偽（この条件では聞かない）なのに参照されました`;
    case 'askWhenCycle': return `ask_when が循環しています: ${i.ids.join(' → ')}`;
    case 'invalidTermMonths': return `保険期間 ${i.value} か月は term_months_options ${swiftList(i.options)} にありません`;
    case 'invalidCadence': return `税 "${i.taxID}" の支払い周期 ${i.months} か月は選択肢 ${swiftList(i.options)} にありません`;
    case 'asOfBeforeEffectiveFrom':
      return `基準日 ${i.asOf} はこのプロファイルの effective_from ${i.effectiveFrom} より前です（計算できません）`;
    case 'explicitFail': return `${i.path}: fail に到達しました（${i.message}）`;
    case 'noMatchingBracket': return `${i.path}: 入力 ${i.input} が区分表のどこにも当たらず、else もありません`;
    case 'nonIntegerAmount': return `税 "${i.taxID}" の金額 ${i.value} が整数になりません（最後に round が必要です）`;
    case 'typeMismatch': return `${i.path}: ${i.message}`;
    case 'arithmeticOverflow': return i.message ?? '計算が整数の範囲を超えました';
    case 'divisionByZero': return '分母が 0 です';
    default: return kind;
  }
}

/**
 * 読み込み・評価のエラー。`kind` は Swift の ProfileError の case 名（`missingInput` など）、
 * `info` はその関連値（`{id, path}` など）。`message` は Swift の description と同じ日本語。
 */
export class ProfileError extends Error {
  constructor(kind, info = {}) {
    super(describeError(kind, info));
    this.name = 'ProfileError';
    this.kind = kind;
    this.info = info;
  }

  get description() { return this.message; }

  toString() { return this.message; }
}

const schemaError = (path, message) => new ProfileError('schema', { path, message });

// MARK: - 有理数

function gcd(a, b) {
  let x = a < 0n ? -a : a;
  let y = b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x === 0n ? 1n : x;
}

/**
 * 有理数（約分済み・分母は正）。Swift の ProfileRational と同じく、約分した結果の分子・分母が
 * 64 ビット整数に収まらなければ arithmeticOverflow を投げる。
 */
export class Rational {
  /** @private 約分済み・範囲内の値だけを渡す */
  constructor(numerator, denominator) {
    this.numerator = numerator;
    this.denominator = denominator;
    Object.freeze(this);
  }

  /** 整数（BigInt / 安全な整数の Number）から作る */
  static of(integer) {
    const n = BigInt(integer);
    if (!inInt64(n)) throw new ProfileError('arithmeticOverflow');
    return new Rational(n, 1n);
  }

  /** 分子・分母から作る（分母 0 はエラー。約分して持つ） */
  static fraction(numerator, denominator) {
    const n = BigInt(numerator);
    const d = BigInt(denominator);
    if (d === 0n) throw new ProfileError('divisionByZero');
    if (!inInt64(n) || !inInt64(d)) throw new ProfileError('arithmeticOverflow');
    return Rational.wide(n, d);
  }

  /** @private 任意の大きさの分子・分母を約分し、64 ビットに収まるか確かめる */
  static wide(num, den) {
    let n = num;
    let d = den;
    if (d < 0n) { n = -n; d = -d; }
    const g = gcd(n, d);
    if (g > 1n) { n /= g; d /= g; }
    if (!inInt64(n) || !inInt64(d)) throw new ProfileError('arithmeticOverflow');
    return new Rational(n, d);
  }

  get isInteger() { return this.denominator === 1n; }

  toString() { return this.isInteger ? `${this.numerator}` : `${this.numerator}/${this.denominator}`; }

  add(o) { return Rational.wide(this.numerator * o.denominator + o.numerator * this.denominator, this.denominator * o.denominator); }

  sub(o) { return Rational.wide(this.numerator * o.denominator - o.numerator * this.denominator, this.denominator * o.denominator); }

  mul(o) { return Rational.wide(this.numerator * o.numerator, this.denominator * o.denominator); }

  div(o) {
    if (o.numerator === 0n) throw new ProfileError('divisionByZero');
    return Rational.wide(this.numerator * o.denominator, this.denominator * o.numerator);
  }

  compare(o) {
    const l = this.numerator * o.denominator;
    const r = o.numerator * this.denominator;
    return l < r ? -1 : l > r ? 1 : 0;
  }

  lt(o) { return this.compare(o) < 0; }

  lte(o) { return this.compare(o) <= 0; }

  gt(o) { return this.compare(o) > 0; }

  gte(o) { return this.compare(o) >= 0; }

  eq(o) { return this.numerator === o.numerator && this.denominator === o.denominator; }

  /** 負の無限大方向への切り捨て（BigInt の `/` は 0 方向なので補正する） */
  floorInteger() {
    const q = this.numerator / this.denominator;
    return this.numerator % this.denominator !== 0n && this.numerator < 0n ? q - 1n : q;
  }

  /** 正の無限大方向への切り上げ */
  ceilInteger() {
    const q = this.numerator / this.denominator;
    return this.numerator % this.denominator !== 0n && this.numerator > 0n ? q + 1n : q;
  }

  /** 四捨五入。ちょうど半分のときは 0 から遠い方へ（-2.5 → -3。Math.round とは違う） */
  halfUpInteger() {
    const half = Rational.fraction(1n, 2n);
    if (this.numerator >= 0n) return this.add(half).floorInteger();
    return -Rational.of(-this.numerator).div(Rational.of(this.denominator)).add(half).floorInteger();
  }
}

const ZERO = new Rational(0n, 1n);
const ONE = new Rational(1n, 1n);
const rmin = (a, b) => (b.lt(a) ? b : a);
const rmax = (a, b) => (a.lt(b) ? b : a);

// MARK: - JSON（小数を見分けて読む）

/** JSON の数値。`integer` は小数点・指数の無い整数の値（BigInt）、小数なら null */
export class JsonNumber {
  constructor(raw, integer) {
    this.raw = raw;
    this.integer = integer;
    Object.freeze(this);
  }

  get isDecimal() { return this.integer === null; }
}

const NUMBER_RE = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/y;

/**
 * JSON の文字列を読む。数値は JsonNumber、オブジェクトはプロトタイプの無いオブジェクトになる。
 * Swift（JSONSerialization）に合わせ、同じキーが2回あれば最初の値を使い、対になっていないサロゲートはエラー。
 */
export function parseJSON(text) {
  const s = text;
  let i = s.charCodeAt(0) === 0xfeff ? 1 : 0;
  const fail = (msg) => { throw new ProfileError('invalidJSON', { message: `${msg}（${i} 文字目）` }); };
  const ws = () => {
    while (i < s.length) {
      const c = s.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
      else break;
    }
  };
  const hex4 = () => {
    const h = s.slice(i, i + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(h)) fail('\\u の後に16進4桁が要ります');
    i += 4;
    return parseInt(h, 16);
  };
  const str = () => {
    i++; // "
    let out = '';
    let start = i;
    for (;;) {
      if (i >= s.length) fail('文字列が閉じていません');
      const c = s.charCodeAt(i);
      if (c === 0x22) { out += s.slice(start, i); i++; return out; }
      if (c < 0x20) fail('文字列に制御文字があります');
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = s.charCodeAt(i + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) fail('対になっていないサロゲートがあります');
        i += 2;
        continue;
      }
      if (c >= 0xdc00 && c <= 0xdfff) fail('対になっていないサロゲートがあります');
      if (c !== 0x5c) { i++; continue; }
      out += s.slice(start, i);
      i++;
      const e = s[i++];
      switch (e) {
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'u': {
          const u = hex4();
          if (u >= 0xd800 && u <= 0xdbff) {
            if (s[i] !== '\\' || s[i + 1] !== 'u') fail('対になっていないサロゲートがあります');
            i += 2;
            const lo = hex4();
            if (!(lo >= 0xdc00 && lo <= 0xdfff)) fail('対になっていないサロゲートがあります');
            out += String.fromCharCode(u, lo);
          } else if (u >= 0xdc00 && u <= 0xdfff) {
            fail('対になっていないサロゲートがあります');
          } else {
            out += String.fromCharCode(u);
          }
          break;
        }
        default: fail('知らないエスケープです');
      }
      start = i;
    }
  };
  const num = () => {
    NUMBER_RE.lastIndex = i;
    const m = NUMBER_RE.exec(s);
    if (!m) fail('数値が読めません');
    i += m[0].length;
    const decimal = m[1] !== undefined || m[2] !== undefined;
    return new JsonNumber(m[0], decimal ? null : BigInt(m[0]));
  };
  const value = () => {
    ws();
    const c = s[i];
    if (c === '{') {
      i++;
      const obj = Object.create(null);
      ws();
      if (s[i] === '}') { i++; return obj; }
      for (;;) {
        ws();
        if (s[i] !== '"') fail('キーは文字列です');
        const key = str();
        ws();
        if (s[i] !== ':') fail(': が要ります');
        i++;
        const v = value();
        if (!Object.hasOwn(obj, key)) obj[key] = v;
        ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === '}') { i++; return obj; }
        fail(', か } が要ります');
      }
    }
    if (c === '[') {
      i++;
      const arr = [];
      ws();
      if (s[i] === ']') { i++; return arr; }
      for (;;) {
        arr.push(value());
        ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === ']') { i++; return arr; }
        fail(', か ] が要ります');
      }
    }
    if (c === '"') return str();
    if (c === '-' || (c >= '0' && c <= '9')) return num();
    if (s.startsWith('true', i)) { i += 4; return true; }
    if (s.startsWith('false', i)) { i += 5; return false; }
    if (s.startsWith('null', i)) { i += 4; return null; }
    return fail(i >= s.length ? '途中で終わっています' : '値が読めません');
  };
  try {
    const result = value();
    ws();
    if (i !== s.length) fail('値の後に余計な文字があります');
    return result;
  } catch (error) {
    if (error instanceof RangeError) throw new ProfileError('invalidJSON', { message: '入れ子が深すぎます' });
    throw error;
  }
}

/**
 * JSON.parse 済みの値を parseJSON と同じ形にする。1.0 と 1 はもう見分けられないので、
 * 整数に見える小数は整数として通ってしまう（文字列から読むほうが厳密）。
 */
function fromPlain(v) {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
  if (v instanceof JsonNumber) return v;
  if (typeof v === 'number') {
    if (Number.isSafeInteger(v)) return new JsonNumber(String(v), BigInt(v));
    return new JsonNumber(String(v), null);
  }
  if (typeof v === 'bigint') return new JsonNumber(String(v), v);
  if (Array.isArray(v)) return v.map(fromPlain);
  if (typeof v === 'object') {
    const obj = Object.create(null);
    for (const [k, x] of Object.entries(v)) if (x !== undefined) obj[k] = fromPlain(x);
    return obj;
  }
  throw new ProfileError('invalidJSON', { message: `JSON にできない値です（${typeof v}）` });
}

/** 文字列・UTF-8 のバイト列・JSON.parse 済みの値のどれからでも、parseJSON の形にする */
export function toJSONTree(source) {
  if (typeof source === 'string') return parseJSON(source);
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(source);
    } catch {
      throw new ProfileError('invalidJSON', { message: 'UTF-8 として読めません' });
    }
    return parseJSON(text);
  }
  return fromPlain(source);
}

// MARK: - 読み込み（ProfileParser.swift）

const isNumber = (v) => v instanceof JsonNumber;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof JsonNumber);
const has = (obj, key) => Object.hasOwn(obj, key);
/** JSON の null はキーが無いのと同じに扱う */
const present = (v) => (v === undefined || v === null ? undefined : v);
const opt = (v, f) => (present(v) === undefined ? null : f(v));

function object(v, path) {
  if (!isObject(v)) throw schemaError(path, 'オブジェクトが要ります');
  return v;
}

function array(v, path) {
  if (!Array.isArray(v)) throw schemaError(path, '配列が要ります');
  return v;
}

function string(v, path) {
  if (typeof v !== 'string') throw schemaError(path, '文字列が要ります');
  return v;
}

function bool(v, path) {
  if (typeof v !== 'boolean') throw schemaError(path, 'true / false が要ります');
  return v;
}

/** 整数だけを受け付ける（BigInt で返す）。小数（1.5 や 1.0）は分数で書くよう求める（仕様 2章の2） */
function int(v, path) {
  if (!isNumber(v)) throw schemaError(path, '整数が要ります');
  if (v.isDecimal) throw schemaError(path, '小数は使えません。{"num": …, "den": …} の分数で書いてください');
  if (!inInt64(v.integer)) throw schemaError(path, '整数が 64 ビットの範囲を超えています');
  return v.integer;
}

/** 月数・日・車齢など、Number で持つ整数（安全な整数の範囲を超えたらエラー） */
function smallInt(v, path) {
  const b = int(v, path);
  if (b > BigInt(Number.MAX_SAFE_INTEGER) || b < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw schemaError(path, '値が大きすぎます');
  }
  return Number(b);
}

function required(obj, key, path) {
  const v = present(obj[key]);
  if (v === undefined) throw schemaError(path, `"${key}" が要ります`);
  return v;
}

function checkKeys(obj, allowed, path) {
  const set = new Set(allowed);
  const unknown = Object.keys(obj).filter((k) => !set.has(k)).sort(compareStrings);
  if (unknown.length > 0) throw schemaError(path, `知らないキー "${unknown[0]}" があります`);
}

function oneOf(value, allowed, path) {
  if (!allowed.includes(value)) throw schemaError(path, `"${value}" は ${swiftList(allowed)} のどれでもありません`);
}

function fraction(obj, path) {
  const num = int(required(obj, 'num', path), `${path}.num`);
  const den = int(required(obj, 'den', path), `${path}.den`);
  if (den === 0n) throw schemaError(`${path}.den`, '分母が 0 です');
  return Rational.fraction(num, den);
}

/** 整数、または {"num": n, "den": d} */
function rational(v, path) {
  if (isNumber(v)) return Rational.of(int(v, path));
  const obj = object(v, path);
  checkKeys(obj, ['num', 'den'], path);
  return fraction(obj, path);
}

function localized(v, path) {
  const obj = object(v, path);
  const result = {};
  for (const [lang, text] of Object.entries(obj)) {
    // "__proto__" のようなキーでも普通のプロパティとして持つ
    Object.defineProperty(result, lang, { value: string(text, `${path}.${lang}`), enumerable: true, writable: true, configurable: true });
  }
  return result;
}

function intList(v, path) {
  return array(v, path).map((x, i) => smallInt(x, `${path}[${i}]`));
}

function swiftInt(text) {
  if (!/^[+-]?[0-9]+$/.test(text)) return null;
  const b = BigInt(text);
  return inInt64(b) ? b : null;
}

/** YYYYMMDD（BigInt / Number）が実在する日付か */
export function isValidDate(ymd) {
  const b = BigInt(ymd);
  return isValidYMD(b / 10000n, (b / 100n) % 100n, b % 100n);
}

function isValidYMD(year, month, day) {
  if (year < 1900n || year > 2999n || month < 1n || month > 12n || day < 1n) return false;
  const leap = (year % 4n === 0n && year % 100n !== 0n) || year % 400n === 0n;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= BigInt(days[Number(month) - 1]);
}

/** "YYYY-MM-DD" を YYYYMMDD の整数（Number）にする（実在しない日付はエラー） */
function date(text, path) {
  const parts = text.split('-');
  const bad = () => schemaError(path, `日付は実在する "YYYY-MM-DD" で書いてください（"${text}"）`);
  if (parts.length !== 3 || Array.from(parts[0]).length !== 4 || Array.from(parts[1]).length !== 2 || Array.from(parts[2]).length !== 2) throw bad();
  const [y, m, d] = parts.map(swiftInt);
  if (y === null || m === null || d === null || !isValidYMD(y, m, d)) throw bad();
  return Number(y * 10000n + m * 100n + d);
}

function rounding(v, path) {
  const obj = object(v, path);
  checkKeys(obj, ['mode', 'to'], path);
  const mode = string(required(obj, 'mode', path), `${path}.mode`);
  if (!['floor', 'ceil', 'half_up'].includes(mode)) {
    throw schemaError(`${path}.mode`, `mode は floor / ceil / half_up のどれかです（"${mode}"）`);
  }
  const step = int(required(obj, 'to', path), `${path}.to`);
  if (step <= 0n) throw schemaError(`${path}.to`, 'to は正の整数にしてください');
  return { mode, step };
}

/** 区分の並び（max の昇順・上限なしは最後に1つだけ）を検証しながら読む */
function bracketList(obj, path, parse) {
  const raw = array(required(obj, 'brackets', path), `${path}.brackets`);
  if (raw.length === 0) throw schemaError(`${path}.brackets`, 'brackets が空です');
  let previousMax = null;
  let sawUnbounded = false;
  return raw.map((item, index) => {
    const itemPath = `${path}.brackets[${index}]`;
    const bracket = object(item, itemPath);
    if (sawUnbounded) throw schemaError(itemPath, 'max を省いた区分（上限なし）の後に区分は置けません');
    const rawMax = present(bracket.max);
    if (rawMax !== undefined) {
      const max = rational(rawMax, `${itemPath}.max`);
      if (previousMax !== null && !previousMax.lt(max)) {
        throw schemaError(`${itemPath}.max`, 'max は昇順（前の区分より大きい値）にしてください');
      }
      previousMax = max;
    } else {
      sawUnbounded = true;
    }
    return parse(bracket, itemPath);
  });
}

const mkNode = (kind, round, path) => Object.freeze({ ...kind, round, path });

/**
 * 式のノード（仕様 6章）。`kind` は var / const / table / bracket_rate / progressive / steps /
 * add・sub・mul・min・max（arithmetic）/ if / age_reduction / fail。
 * @param bareNumber 仕様で「数値かノード」とされている位置（table の value、progressive の base）だけ true
 */
function node(v, path, bareNumber = false) {
  if (bareNumber && isNumber(v)) return mkNode({ kind: 'const', value: Rational.of(int(v, path)) }, null, path);
  const obj = object(v, path);
  const round = opt(obj.round, (r) => rounding(r, `${path}.round`));

  if (has(obj, 'var')) {
    checkKeys(obj, ['var', 'round'], path);
    return mkNode({ kind: 'var', id: string(obj.var, `${path}.var`) }, round, path);
  }
  if (has(obj, 'const')) {
    checkKeys(obj, ['const', 'round'], path);
    return mkNode({ kind: 'const', value: Rational.of(int(obj.const, `${path}.const`)) }, round, path);
  }
  if (has(obj, 'num') || has(obj, 'den')) {
    checkKeys(obj, ['num', 'den', 'round'], path);
    return mkNode({ kind: 'const', value: fraction(obj, path) }, round, path);
  }
  if (!has(obj, 'op')) throw schemaError(path, 'ノードには var / const / num・den / op のどれかが要ります');
  const op = string(obj.op, `${path}.op`);
  let kind;
  switch (op) {
    case 'table': {
      checkKeys(obj, ['op', 'input', 'brackets', 'else', 'round'], path);
      const brackets = bracketList(obj, path, (item, itemPath) => {
        checkKeys(item, ['max', 'value'], itemPath);
        return {
          max: opt(item.max, (m) => rational(m, `${itemPath}.max`)),
          value: node(required(item, 'value', itemPath), `${itemPath}.value`, true),
        };
      });
      kind = {
        kind: 'table',
        input: node(required(obj, 'input', path), `${path}.input`),
        brackets,
        else: opt(obj.else, (e) => node(e, `${path}.else`, true)),
      };
      break;
    }
    case 'bracket_rate': {
      checkKeys(obj, ['op', 'input', 'brackets', 'round'], path);
      const brackets = bracketList(obj, path, (item, itemPath) => {
        checkKeys(item, ['max', 'rate'], itemPath);
        return {
          max: opt(item.max, (m) => rational(m, `${itemPath}.max`)),
          rate: rational(required(item, 'rate', itemPath), `${itemPath}.rate`),
        };
      });
      kind = { kind: 'bracket_rate', input: node(required(obj, 'input', path), `${path}.input`), brackets };
      break;
    }
    case 'progressive': {
      checkKeys(obj, ['op', 'input', 'brackets', 'round'], path);
      const brackets = bracketList(obj, path, (item, itemPath) => {
        checkKeys(item, ['max', 'base', 'from', 'rate'], itemPath);
        return {
          max: opt(item.max, (m) => rational(m, `${itemPath}.max`)),
          base: node(required(item, 'base', itemPath), `${itemPath}.base`, true),
          from: rational(required(item, 'from', itemPath), `${itemPath}.from`),
          rate: rational(required(item, 'rate', itemPath), `${itemPath}.rate`),
        };
      });
      kind = { kind: 'progressive', input: node(required(obj, 'input', path), `${path}.input`), brackets };
      break;
    }
    case 'steps': {
      checkKeys(obj, ['op', 'input', 'from', 'step', 'per_step', 'round'], path);
      const step = rational(required(obj, 'step', path), `${path}.step`);
      if (!step.gt(ZERO)) throw schemaError(`${path}.step`, 'step は正の数にしてください');
      const input = node(required(obj, 'input', path), `${path}.input`);
      const from = rational(required(obj, 'from', path), `${path}.from`);
      const perStep = rational(required(obj, 'per_step', path), `${path}.per_step`);
      kind = { kind: 'steps', input, from, step, perStep };
      break;
    }
    case 'add': case 'sub': case 'mul': case 'min': case 'max': {
      checkKeys(obj, ['op', 'args', 'round'], path);
      const args = array(required(obj, 'args', path), `${path}.args`).map((a, i) => node(a, `${path}.args[${i}]`));
      if (args.length < 2) throw schemaError(`${path}.args`, 'args は2つ以上必要です');
      kind = { kind: 'arithmetic', op, args };
      break;
    }
    case 'if': {
      checkKeys(obj, ['op', 'cases', 'else', 'round'], path);
      const cases = array(required(obj, 'cases', path), `${path}.cases`).map((item, index) => {
        const casePath = `${path}.cases[${index}]`;
        const raw = object(item, casePath);
        checkKeys(raw, ['when', 'then'], casePath);
        const when = condition(required(raw, 'when', casePath), `${casePath}.when`);
        const then = node(required(raw, 'then', casePath), `${casePath}.then`);
        return { when, then };
      });
      if (cases.length === 0) throw schemaError(`${path}.cases`, 'cases が空です');
      const elseRaw = present(obj.else);
      if (elseRaw === undefined) throw schemaError(path, 'if には else が必須です');
      kind = { kind: 'if', cases, else: node(elseRaw, `${path}.else`) };
      break;
    }
    case 'age_reduction': {
      checkKeys(obj, ['op', 'base', 'age', 'start_age', 'per_year', 'max', 'round'], path);
      const base = node(required(obj, 'base', path), `${path}.base`);
      const age = node(required(obj, 'age', path), `${path}.age`);
      const startAge = rational(required(obj, 'start_age', path), `${path}.start_age`);
      const perYear = rational(required(obj, 'per_year', path), `${path}.per_year`);
      const max = rational(required(obj, 'max', path), `${path}.max`);
      kind = { kind: 'age_reduction', base, age, startAge, perYear, max };
      break;
    }
    case 'fail':
      checkKeys(obj, ['op', 'message'], path);
      kind = { kind: 'fail', message: string(required(obj, 'message', path), `${path}.message`) };
      break;
    default:
      throw new ProfileError('unknownOp', { path, op });
  }
  return mkNode(kind, round, path);
}

const intValue = (b) => ({ t: 'int', v: b });

function constantValue(v, path) {
  if (typeof v === 'boolean') return { t: 'bool', v };
  if (isNumber(v)) return intValue(int(v, path));
  if (typeof v === 'string') return { t: 'enum', v };
  throw schemaError(path, '右辺は整数・真偽値・文字列のどれかです');
}

function pair(v, path) {
  const items = array(v, path);
  if (items.length !== 2) throw schemaError(path, '[id, 定数] の2要素です');
  return [string(items[0], `${path}[0]`), items[1]];
}

/** 条件（仕様 7章）。`{op: 'eq', id, value}` などの形にする */
function condition(v, path) {
  const obj = object(v, path);
  const keys = Object.keys(obj);
  if (keys.length !== 1) {
    throw schemaError(path, '条件はキーを1つだけ持つオブジェクトです（例: {"eq": ["category", "kei"]}）');
  }
  const key = keys[0];
  const value = obj[key];
  const keyPath = `${path}.${key}`;
  switch (key) {
    case 'eq': case 'ne': {
      const [id, rhs] = pair(value, keyPath);
      return { op: key, id, value: constantValue(rhs, `${keyPath}[1]`) };
    }
    case 'in': {
      const [id, rhs] = pair(value, keyPath);
      const values = array(rhs, `${keyPath}[1]`).map((x, i) => constantValue(x, `${keyPath}[1][${i}]`));
      if (values.length === 0) throw schemaError(`${keyPath}[1]`, 'in のリストが空です');
      return { op: 'in', id, values };
    }
    case 'gte': case 'gt': case 'lt': case 'lte': {
      const [id, rhs] = pair(value, keyPath);
      return { op: 'compare', cmp: key, id, value: rational(rhs, `${keyPath}[1]`) };
    }
    case 'before_ym': {
      const items = array(value, keyPath);
      if (items.length !== 2) throw schemaError(keyPath, '[年, 月] の2要素です');
      const year = int(items[0], `${keyPath}[0]`);
      const month = int(items[1], `${keyPath}[1]`);
      if (month < 1n || month > 12n) throw schemaError(`${keyPath}[1]`, '月は 1〜12 です');
      return { op: 'before_ym', year, month };
    }
    case 'as_of_gte': case 'as_of_lt':
      return { op: key, date: date(string(value, keyPath), keyPath) };
    case 'and': case 'or': {
      const items = array(value, keyPath).map((x, i) => condition(x, `${keyPath}[${i}]`));
      if (items.length === 0) throw schemaError(keyPath, `${key} の中身が空です`);
      return { op: key, items };
    }
    case 'not':
      return { op: 'not', inner: condition(value, keyPath) };
    default:
      throw schemaError(path, `知らない条件 "${key}" です（仕様 7章にあるものだけ使えます）`);
  }
}

function ageBasis(v, path) {
  const obj = object(v, path);
  checkKeys(obj, ['origin', 'method'], path);
  const origin = string(required(obj, 'origin', path), `${path}.origin`);
  const method = string(required(obj, 'method', path), `${path}.method`);
  if (!['first_registration', 'manufacture'].includes(origin)) {
    throw schemaError(`${path}.origin`, `first_registration / manufacture のどれかです（"${origin}"）`);
  }
  if (!['completed_years', 'year_difference'].includes(method)) {
    throw schemaError(`${path}.method`, `completed_years / year_difference のどれかです（"${method}"）`);
  }
  return { origin, method };
}

function currency(v, path) {
  const obj = object(v, path);
  checkKeys(obj, ['code', 'minor_exponent', 'symbol', 'large_unit'], path);
  const exponent = int(required(obj, 'minor_exponent', path), `${path}.minor_exponent`);
  if (exponent < 0n || exponent > 4n) throw schemaError(`${path}.minor_exponent`, '0〜4 の整数にしてください');
  const code = string(required(obj, 'code', path), `${path}.code`);
  const symbol = string(required(obj, 'symbol', path), `${path}.symbol`);
  const largeUnit = opt(obj.large_unit, (raw) => {
    const unitPath = `${path}.large_unit`;
    const unit = object(raw, unitPath);
    checkKeys(unit, ['value', 'label'], unitPath);
    const value = int(required(unit, 'value', unitPath), `${unitPath}.value`);
    if (value <= 1n) throw schemaError(`${unitPath}.value`, '2 以上にしてください');
    return { value: plainInt(value), label: localized(required(unit, 'label', unitPath), `${unitPath}.label`) };
  });
  return { code, minorExponent: Number(exponent), symbol, largeUnit };
}

function units(v, path) {
  const obj = object(v, path);
  checkKeys(obj, ['distance', 'efficiency'], path);
  const efficiency = string(required(obj, 'efficiency', path), `${path}.efficiency`);
  oneOf(efficiency, ['km_per_l', 'l_per_100km', 'mpg_us', 'mpg_imp'], `${path}.efficiency`);
  return { distance: string(required(obj, 'distance', path), `${path}.distance`), efficiency };
}

/**
 * 入力の宣言。`type` は int / bool / enum。int の `min` / `max` は BigInt（無ければ null）、enum は `options`。
 */
function input(v, path) {
  const obj = object(v, path);
  checkKeys(obj, ['id', 'type', 'unit', 'label', 'min', 'max', 'ask_when', 'options', 'display'], path);
  const id = string(required(obj, 'id', path), `${path}.id`);
  const type = string(required(obj, 'type', path), `${path}.type`);
  const result = { id, type };
  switch (type) {
    case 'int':
      if (has(obj, 'options')) throw schemaError(path, 'int の入力に options は書けません');
      result.unit = opt(obj.unit, (u) => string(u, `${path}.unit`));
      result.min = opt(obj.min, (m) => int(m, `${path}.min`));
      result.max = opt(obj.max, (m) => int(m, `${path}.max`));
      break;
    case 'bool':
      for (const key of ['options', 'min', 'max', 'unit', 'display']) {
        if (has(obj, key)) throw schemaError(path, `bool の入力に ${key} は書けません`);
      }
      break;
    case 'enum': {
      for (const key of ['min', 'max', 'unit', 'display']) {
        if (has(obj, key)) throw schemaError(path, `enum の入力に ${key} は書けません`);
      }
      const options = array(required(obj, 'options', path), `${path}.options`).map((item, index) => {
        const optPath = `${path}.options[${index}]`;
        const o = object(item, optPath);
        checkKeys(o, ['id', 'label'], optPath);
        return {
          id: string(required(o, 'id', optPath), `${optPath}.id`),
          label: localized(required(o, 'label', optPath), `${optPath}.label`),
        };
      });
      if (options.length === 0 || new Set(options.map((o) => o.id)).size !== options.length) {
        throw schemaError(`${path}.options`, '選択肢が空か、id が重複しています');
      }
      result.options = options;
      break;
    }
    default:
      throw schemaError(`${path}.type`, `type は int / bool / enum のどれかです（"${type}"）`);
  }
  result.label = localized(required(obj, 'label', path), `${path}.label`);
  result.display = opt(obj.display, (raw) => {
    const displayPath = `${path}.display`;
    const display = object(raw, displayPath);
    checkKeys(display, ['unit', 'scale'], displayPath);
    const scale = smallInt(required(display, 'scale', displayPath), `${displayPath}.scale`);
    if (scale <= 0) throw schemaError(`${displayPath}.scale`, '正の整数にしてください');
    return { unit: string(required(display, 'unit', displayPath), `${displayPath}.unit`), scale };
  });
  result.askWhen = opt(obj.ask_when, (c) => condition(c, `${path}.ask_when`));
  return result;
}

function sources(v, path) {
  return array(v, path).map((item, index) => {
    const srcPath = `${path}[${index}]`;
    const obj = object(item, srcPath);
    checkKeys(obj, ['url', 'title', 'verified_at', 'confidence', 'note'], srcPath);
    const confidence = string(required(obj, 'confidence', srcPath), `${srcPath}.confidence`);
    if (!['confirmed', 'secondary', 'estimated'].includes(confidence)) {
      throw schemaError(`${srcPath}.confidence`, 'confirmed / secondary / estimated のどれかです');
    }
    return {
      url: string(required(obj, 'url', srcPath), `${srcPath}.url`),
      title: string(required(obj, 'title', srcPath), `${srcPath}.title`),
      verifiedAt: string(required(obj, 'verified_at', srcPath), `${srcPath}.verified_at`),
      confidence,
      note: opt(obj.note, (n) => string(n, `${srcPath}.note`)),
    };
  });
}

function tax(v, path) {
  const obj = object(v, path);
  checkKeys(obj, [
    'id', 'name', 'cadence_months', 'cadence_options', 'default_cadence_months', 'initial', 'due_months',
    'due_day', 'applies_when', 'amount', 'sources', 'auto_calculable', 'local_discretion', 'note',
  ], path);
  const autoCalculable = bool(required(obj, 'auto_calculable', path), `${path}.auto_calculable`);
  const amount = opt(obj.amount, (a) => node(a, `${path}.amount`));
  if (autoCalculable && amount === null) {
    throw schemaError(`${path}.amount`, 'auto_calculable が true の税には amount が要ります');
  }
  const cadenceOptions = opt(obj.cadence_options, (raw) => array(raw, `${path}.cadence_options`).map((item, index) => {
    const optPath = `${path}.cadence_options[${index}]`;
    const o = object(item, optPath);
    checkKeys(o, ['months', 'amount'], optPath);
    return {
      months: smallInt(required(o, 'months', optPath), `${optPath}.months`),
      amount: opt(o.amount, (a) => node(a, `${optPath}.amount`)),
    };
  })) ?? [];
  const id = string(required(obj, 'id', path), `${path}.id`);
  const name = localized(required(obj, 'name', path), `${path}.name`);
  const cadenceMonths = smallInt(required(obj, 'cadence_months', path), `${path}.cadence_months`);
  const defaultCadenceMonths = opt(obj.default_cadence_months, (d) => smallInt(d, `${path}.default_cadence_months`));
  const initial = opt(obj.initial, (raw) => {
    const initialPath = `${path}.initial`;
    const ini = object(raw, initialPath);
    checkKeys(ini, ['cadence_months', 'amount'], initialPath);
    return {
      cadenceMonths: smallInt(required(ini, 'cadence_months', initialPath), `${initialPath}.cadence_months`),
      amount: node(required(ini, 'amount', initialPath), `${initialPath}.amount`),
    };
  });
  const dueMonths = opt(obj.due_months, (raw) => array(raw, `${path}.due_months`).map((m, i) => smallInt(m, `${path}.due_months[${i}]`))) ?? [];
  const dueDay = opt(obj.due_day, (d) => smallInt(d, `${path}.due_day`));
  const appliesWhen = opt(obj.applies_when, (c) => condition(c, `${path}.applies_when`));
  const srcs = sources(required(obj, 'sources', path), `${path}.sources`);
  const localDiscretion = opt(obj.local_discretion, (b) => bool(b, `${path}.local_discretion`)) ?? false;
  const note = opt(obj.note, (n) => localized(n, `${path}.note`));
  return {
    id, name, cadenceMonths, cadenceOptions, defaultCadenceMonths, initial, dueMonths, dueDay, appliesWhen,
    amount, sources: srcs, autoCalculable, localDiscretion, note,
  };
}

function inspection(v, path) {
  const obj = object(v, path);
  checkKeys(obj, ['id', 'kind', 'name', 'applies_when', 'age_basis', 'phases', 'window', 'fee', 'note', 'sources'], path);
  const phases = array(required(obj, 'phases', path), `${path}.phases`).map((item, index) => {
    const phasePath = `${path}.phases[${index}]`;
    const phase = object(item, phasePath);
    checkKeys(phase, ['from_age', 'to_age', 'interval_months'], phasePath);
    if (!has(phase, 'interval_months')) throw schemaError(phasePath, 'interval_months が要ります（検査なしは null）');
    return {
      fromAge: smallInt(required(phase, 'from_age', phasePath), `${phasePath}.from_age`),
      toAge: opt(phase.to_age, (t) => smallInt(t, `${phasePath}.to_age`)),
      intervalMonths: opt(phase.interval_months, (m) => smallInt(m, `${phasePath}.interval_months`)),
    };
  });
  const kind = string(required(obj, 'kind', path), `${path}.kind`);
  if (!['safety', 'emission', 'other'].includes(kind)) {
    throw schemaError(`${path}.kind`, `safety / emission / other のどれかです（"${kind}"）`);
  }
  const id = string(required(obj, 'id', path), `${path}.id`);
  const name = localized(required(obj, 'name', path), `${path}.name`);
  const appliesWhen = opt(obj.applies_when, (c) => condition(c, `${path}.applies_when`));
  const basis = opt(obj.age_basis, (a) => ageBasis(a, `${path}.age_basis`));
  const window = opt(obj.window, (raw) => {
    const windowPath = `${path}.window`;
    const w = object(raw, windowPath);
    checkKeys(w, ['before_months', 'after_months'], windowPath);
    return {
      beforeMonths: smallInt(required(w, 'before_months', windowPath), `${windowPath}.before_months`),
      afterMonths: smallInt(required(w, 'after_months', windowPath), `${windowPath}.after_months`),
    };
  });
  const fee = opt(obj.fee, (f) => node(f, `${path}.fee`));
  const note = opt(obj.note, (n) => localized(n, `${path}.note`));
  const srcs = sources(required(obj, 'sources', path), `${path}.sources`);
  return { id, kind, name, appliesWhen, ageBasis: basis, phases, window, fee, note, sources: srcs };
}

function compulsoryInsurance(v, path) {
  const obj = object(v, path);
  checkKeys(obj, ['name', 'applies_when', 'term_months_options', 'default_term_months', 'term_rules', 'premium', 'sources'], path);
  if (!has(obj, 'premium')) throw schemaError(path, 'premium が要ります（手入力の国は null）');
  const name = localized(required(obj, 'name', path), `${path}.name`);
  const appliesWhen = opt(obj.applies_when, (c) => condition(c, `${path}.applies_when`));
  const termMonthsOptions = intList(required(obj, 'term_months_options', path), `${path}.term_months_options`);
  const defaultTermMonths = smallInt(required(obj, 'default_term_months', path), `${path}.default_term_months`);
  const termRules = opt(obj.term_rules, (raw) => array(raw, `${path}.term_rules`).map((item, index) => {
    const rulePath = `${path}.term_rules[${index}]`;
    const rule = object(item, rulePath);
    checkKeys(rule, ['when', 'options', 'default'], rulePath);
    return {
      when: condition(required(rule, 'when', rulePath), `${rulePath}.when`),
      options: intList(required(rule, 'options', rulePath), `${rulePath}.options`),
      defaultTermMonths: smallInt(required(rule, 'default', rulePath), `${rulePath}.default`),
    };
  })) ?? [];
  const premium = opt(obj.premium, (p) => node(p, `${path}.premium`));
  const srcs = sources(required(obj, 'sources', path), `${path}.sources`);
  return { name, appliesWhen, termMonthsOptions, defaultTermMonths, termRules, premium, sources: srcs };
}

function fuel(v, path) {
  const obj = object(v, path);
  checkKeys(obj, ['id', 'name', 'energy', 'default_price_minor', 'price_unit', 'price_as_of', 'applies_when', 'note'], path);
  const energy = string(required(obj, 'energy', path), `${path}.energy`);
  oneOf(energy, ['gasoline', 'diesel', 'lpg', 'electric', 'hydrogen'], `${path}.energy`);
  const priceUnit = string(required(obj, 'price_unit', path), `${path}.price_unit`);
  oneOf(priceUnit, ['per_l', 'per_kwh', 'per_kg'], `${path}.price_unit`);
  return {
    id: string(required(obj, 'id', path), `${path}.id`),
    name: localized(required(obj, 'name', path), `${path}.name`),
    energy,
    defaultPriceMinor: rational(required(obj, 'default_price_minor', path), `${path}.default_price_minor`),
    priceUnit,
    priceAsOf: string(required(obj, 'price_as_of', path), `${path}.price_as_of`),
    appliesWhen: opt(obj.applies_when, (c) => condition(c, `${path}.applies_when`)),
    note: opt(obj.note, (n) => localized(n, `${path}.note`)),
  };
}

function parseProfile(any) {
  const path = '$';
  const obj = object(any, path);
  const specVersion = int(required(obj, 'spec_version', path), `${path}.spec_version`);
  if (specVersion !== BigInt(SUPPORTED_SPEC_VERSION)) {
    throw new ProfileError('unsupportedSpecVersion', { version: plainInt(specVersion) });
  }
  checkKeys(obj, [
    'spec_version', 'country', 'profile_version', 'effective_from', 'verified_at', 'currency', 'units',
    'age_basis', 'inputs', 'derived', 'taxes', 'inspections', 'compulsory_insurance', 'fuels', 'fuel_sources',
    'disclaimer',
  ], path);

  const inputs = array(required(obj, 'inputs', path), `${path}.inputs`).map((x, i) => input(x, `${path}.inputs[${i}]`));
  const derived = new Map();
  const rawDerived = present(obj.derived);
  if (rawDerived !== undefined) {
    for (const [id, value] of Object.entries(object(rawDerived, `${path}.derived`))) {
      derived.set(id, node(value, `${path}.derived.${id}`));
    }
  }
  const inputsByID = new Map();
  for (const item of inputs) {
    if (inputsByID.has(item.id)) throw schemaError(`${path}.inputs`, `入力 id "${item.id}" が重複しています`);
    inputsByID.set(item.id, item);
  }
  const effectiveFrom = string(required(obj, 'effective_from', path), `${path}.effective_from`);

  const country = string(required(obj, 'country', path), `${path}.country`);
  const profileVersion = smallInt(required(obj, 'profile_version', path), `${path}.profile_version`);
  const effectiveFromDate = date(effectiveFrom, `${path}.effective_from`);
  const verifiedAt = string(required(obj, 'verified_at', path), `${path}.verified_at`);
  const cur = currency(required(obj, 'currency', path), `${path}.currency`);
  const uni = opt(obj.units, (u) => units(u, `${path}.units`));
  const basis = ageBasis(required(obj, 'age_basis', path), `${path}.age_basis`);
  const taxes = array(required(obj, 'taxes', path), `${path}.taxes`).map((x, i) => tax(x, `${path}.taxes[${i}]`));
  const inspections = opt(obj.inspections, (raw) => array(raw, `${path}.inspections`).map((x, i) => inspection(x, `${path}.inspections[${i}]`))) ?? [];
  const insurance = opt(obj.compulsory_insurance, (c) => compulsoryInsurance(c, `${path}.compulsory_insurance`));
  const fuels = opt(obj.fuels, (raw) => array(raw, `${path}.fuels`).map((x, i) => fuel(x, `${path}.fuels[${i}]`))) ?? [];
  const fuelSources = opt(obj.fuel_sources, (s) => sources(s, `${path}.fuel_sources`)) ?? [];
  const disclaimer = opt(obj.disclaimer, (d) => localized(d, `${path}.disclaimer`)) ?? {};

  return {
    specVersion: Number(specVersion), country, profileVersion, effectiveFrom, effectiveFromDate, verifiedAt,
    currency: cur, units: uni, ageBasis: basis, inputs, derived, taxes, inspections,
    compulsoryInsurance: insurance, fuels, fuelSources, disclaimer, inputsByID,
  };
}

// MARK: - 読み込み時の検証（ProfileValidator.swift）

function validateProfile(profile) {
  const reserved = new Set([...STANDARD_INPUT_IDS, TERM_MONTHS_INPUT_ID]);

  const variableType = (id, path, allowTerm) => {
    const inp = profile.inputsByID.get(id);
    if (inp) {
      if (inp.type === 'int') return { t: 'number' };
      if (inp.type === 'bool') return { t: 'bool' };
      return { t: 'enum', options: new Set(inp.options.map((o) => o.id)) };
    }
    if (profile.derived.has(id) || STANDARD.has(id)) return { t: 'number' };
    if (id === TERM_MONTHS_INPUT_ID) {
      if (!allowTerm) throw schemaError(path, 'term_months は compulsory_insurance.premium の中でだけ参照できます');
      return { t: 'number' };
    }
    throw new ProfileError('unknownVariable', { path, id });
  };

  const checkConstant = (value, id, path, allowTerm) => {
    const type = variableType(id, path, allowTerm);
    if ((type.t === 'number' && value.t === 'int') || (type.t === 'bool' && value.t === 'bool')) return;
    if (type.t === 'enum' && value.t === 'enum') {
      if (!type.options.has(value.v)) throw schemaError(path, `"${value.v}" は入力 "${id}" の選択肢にありません`);
      return;
    }
    throw new ProfileError('typeMismatch', { path, message: `入力 "${id}" と定数 ${describeValue(value)} の型が合いません` });
  };

  const checkCondition = (c, path, allowTerm) => {
    switch (c.op) {
      case 'eq': case 'ne': checkConstant(c.value, c.id, path, allowTerm); break;
      case 'in': for (const v of c.values) checkConstant(v, c.id, path, allowTerm); break;
      case 'compare':
        if (variableType(c.id, path, allowTerm).t !== 'number') {
          throw new ProfileError('typeMismatch', { path, message: `${c.cmp} は数値の入力にしか使えません（"${c.id}"）` });
        }
        break;
      case 'and': case 'or': for (const item of c.items) checkCondition(item, path, allowTerm); break;
      case 'not': checkCondition(c.inner, path, allowTerm); break;
      default: break; // before_ym / as_of_*
    }
  };

  const checkNode = (n, allowTerm) => {
    switch (n.kind) {
      case 'var':
        if (variableType(n.id, n.path, allowTerm).t !== 'number') {
          throw new ProfileError('typeMismatch', { path: n.path, message: `"${n.id}" は数値ではないので式に使えません（条件で使ってください）` });
        }
        break;
      case 'table':
        checkNode(n.input, allowTerm);
        for (const b of n.brackets) checkNode(b.value, allowTerm);
        if (n.else) checkNode(n.else, allowTerm);
        break;
      case 'bracket_rate': case 'steps':
        checkNode(n.input, allowTerm);
        break;
      case 'progressive':
        checkNode(n.input, allowTerm);
        for (const b of n.brackets) checkNode(b.base, allowTerm);
        break;
      case 'arithmetic':
        for (const a of n.args) checkNode(a, allowTerm);
        break;
      case 'if':
        for (const item of n.cases) {
          checkCondition(item.when, item.then.path, allowTerm);
          checkNode(item.then, allowTerm);
        }
        checkNode(n.else, allowTerm);
        break;
      case 'age_reduction':
        checkNode(n.base, allowTerm);
        checkNode(n.age, allowTerm);
        break;
      default: break; // const / fail
    }
  };

  // id
  for (const inp of profile.inputs) {
    if (reserved.has(inp.id)) throw schemaError('$.inputs', `"${inp.id}" は標準入力なので宣言できません`);
  }
  for (const id of profile.derived.keys()) {
    if (reserved.has(id) || profile.inputsByID.has(id)) throw schemaError(`$.derived.${id}`, `"${id}" は入力・標準入力と同じ id です`);
  }
  for (const inp of profile.inputs) {
    if (inp.type === 'int' && inp.min !== null && inp.max !== null && inp.min > inp.max) {
      throw schemaError(`$.inputs.${inp.id}`, 'min が max より大きくなっています');
    }
  }

  for (const inp of profile.inputs) if (inp.askWhen) checkCondition(inp.askWhen, `$.inputs.${inp.id}.ask_when`, false);
  for (const n of profile.derived.values()) checkNode(n, false);

  // 循環
  {
    const state = new Map(); // false = 訪問中, true = 済み
    const visit = (id, trail) => {
      if (state.get(id) === true) return;
      if (state.get(id) === false) throw new ProfileError('derivedCycle', { ids: [...trail, id] });
      state.set(id, false);
      const n = profile.derived.get(id);
      if (n) for (const dep of variablesInNode(n)) if (profile.derived.has(dep)) visit(dep, [...trail, id]);
      state.set(id, true);
    };
    for (const id of [...profile.derived.keys()].sort(compareStrings)) visit(id, []);
  }
  {
    const state = new Map();
    const visit = (id, trail) => {
      if (state.get(id) === true) return;
      if (state.get(id) === false) throw new ProfileError('askWhenCycle', { ids: [...trail, id] });
      state.set(id, false);
      const askWhen = profile.inputsByID.get(id)?.askWhen;
      if (askWhen) for (const dep of variablesInCondition(askWhen)) if (profile.inputsByID.has(dep)) visit(dep, [...trail, id]);
      state.set(id, true);
    };
    for (const inp of profile.inputs) visit(inp.id, []);
  }

  // 税
  const seenTaxes = new Set();
  profile.taxes.forEach((t, index) => {
    const path = `$.taxes[${index}]`;
    if (seenTaxes.has(t.id)) throw schemaError(path, `税 id "${t.id}" が重複しています`);
    seenTaxes.add(t.id);
    if (!(t.cadenceMonths > 0)) throw schemaError(`${path}.cadence_months`, '1 以上にしてください');
    if (!t.dueMonths.every((m) => m >= 1 && m <= 12)) throw schemaError(`${path}.due_months`, '月は 1〜12 です');
    if (t.autoCalculable && !t.sources.some((s) => s.confidence !== 'estimated')) {
      throw schemaError(path, '出典が無いか全部 estimated の税は auto_calculable を true にできません');
    }
    if (t.dueDay !== null && !(t.dueDay >= 1 && t.dueDay <= 31)) throw schemaError(`${path}.due_day`, '日は 1〜31 です');
    if (t.localDiscretion && t.note === null) {
      throw schemaError(`${path}.note`, 'local_discretion が true の税には note（どう変わるか）が要ります');
    }
    // cadence
    if (t.cadenceOptions.length === 0) {
      if (t.defaultCadenceMonths !== null) {
        throw schemaError(`${path}.default_cadence_months`, 'cadence_options が無い税には書けません');
      }
    } else {
      const months = t.cadenceOptions.map((o) => o.months);
      if (!months.every((m) => m > 0) || new Set(months).size !== months.length) {
        throw schemaError(`${path}.cadence_options`, 'months は正の整数を重複なく並べてください');
      }
      t.cadenceOptions.forEach((o, i) => {
        if (o.amount) checkNode(o.amount, false);
        else if (o.months !== t.cadenceMonths) {
          throw schemaError(`${path}.cadence_options[${i}]`,
            `cadence_months（${t.cadenceMonths}）と違う月数の選択肢には amount が要ります（比例は仮定しない）`);
        }
      });
      if (t.defaultCadenceMonths === null || !months.includes(t.defaultCadenceMonths)) {
        throw schemaError(`${path}.default_cadence_months`, 'cadence_options の中の月数を書いてください');
      }
    }
    if (t.initial) {
      if (!(t.initial.cadenceMonths > 0)) throw schemaError(`${path}.initial.cadence_months`, '1 以上にしてください');
      checkNode(t.initial.amount, false);
    }
    if (t.appliesWhen) checkCondition(t.appliesWhen, `${path}.applies_when`, false);
    if (t.amount) checkNode(t.amount, false);
  });

  // 強制保険
  const ins = profile.compulsoryInsurance;
  if (ins) {
    const path = '$.compulsory_insurance';
    const validOptions = (o) => o.length > 0 && o.every((m) => m > 0) && new Set(o).size === o.length;
    if (!validOptions(ins.termMonthsOptions)) {
      throw schemaError(`${path}.term_months_options`, '正の整数を重複なく1つ以上並べてください');
    }
    if (!ins.termMonthsOptions.includes(ins.defaultTermMonths)) {
      throw schemaError(`${path}.default_term_months`, 'term_months_options に含まれていません');
    }
    ins.termRules.forEach((rule, index) => {
      const rulePath = `${path}.term_rules[${index}]`;
      if (!validOptions(rule.options)) throw schemaError(`${rulePath}.options`, '正の整数を重複なく1つ以上並べてください');
      if (!rule.options.includes(rule.defaultTermMonths)) throw schemaError(`${rulePath}.default`, 'options に含まれていません');
      checkCondition(rule.when, `${rulePath}.when`, false);
    });
    if (ins.appliesWhen) checkCondition(ins.appliesWhen, `${path}.applies_when`, false);
    if (ins.premium) checkNode(ins.premium, true);
  }

  // 検査
  const seenInspections = new Set();
  profile.inspections.forEach((insp, index) => {
    const path = `$.inspections[${index}]`;
    if (seenInspections.has(insp.id)) throw schemaError(path, `検査 id "${insp.id}" が重複しています`);
    seenInspections.add(insp.id);
    if (insp.phases.length === 0) throw schemaError(`${path}.phases`, 'phases が空です');
    let expectedFrom = 0;
    for (let i = 0; i < insp.phases.length; i++) {
      const phase = insp.phases[i];
      const phasePath = `${path}.phases[${i}]`;
      if (phase.fromAge !== expectedFrom) {
        throw schemaError(phasePath, 'from_age は 0 から始めて、前の to_age と隙間なくつないでください');
      }
      if (phase.intervalMonths !== null && phase.intervalMonths <= 0) {
        throw schemaError(`${phasePath}.interval_months`, '1 以上か null にしてください');
      }
      if (phase.toAge === null) {
        if (i !== insp.phases.length - 1) throw schemaError(phasePath, 'to_age を省けるのは最後の区間だけです');
        break;
      }
      if (!(phase.toAge > phase.fromAge)) throw schemaError(`${phasePath}.to_age`, 'from_age より大きくしてください');
      expectedFrom = phase.toAge;
    }
    if (insp.window && (insp.window.beforeMonths < 0 || insp.window.afterMonths < 0)) {
      throw schemaError(`${path}.window`, '0 以上にしてください');
    }
    if (insp.fee) checkNode(insp.fee, false);
    if (insp.appliesWhen) checkCondition(insp.appliesWhen, `${path}.applies_when`, false);
  });

  // 燃料
  const seenFuels = new Set();
  profile.fuels.forEach((f, index) => {
    const path = `$.fuels[${index}]`;
    if (seenFuels.has(f.id)) throw schemaError(path, `燃料 id "${f.id}" が重複しています`);
    seenFuels.add(f.id);
    if (f.defaultPriceMinor.lt(ZERO)) throw schemaError(`${path}.default_price_minor`, '0 以上にしてください');
    if (f.appliesWhen) checkCondition(f.appliesWhen, `${path}.applies_when`, false);
  });
}

function variablesInNode(n) {
  switch (n.kind) {
    case 'var': return [n.id];
    case 'table': return [...variablesInNode(n.input), ...n.brackets.flatMap((b) => variablesInNode(b.value)), ...(n.else ? variablesInNode(n.else) : [])];
    case 'bracket_rate': case 'steps': return variablesInNode(n.input);
    case 'progressive': return [...variablesInNode(n.input), ...n.brackets.flatMap((b) => variablesInNode(b.base))];
    case 'arithmetic': return n.args.flatMap(variablesInNode);
    case 'if': return [...n.cases.flatMap((c) => [...variablesInCondition(c.when), ...variablesInNode(c.then)]), ...variablesInNode(n.else)];
    case 'age_reduction': return [...variablesInNode(n.base), ...variablesInNode(n.age)];
    default: return [];
  }
}

function variablesInCondition(c) {
  switch (c.op) {
    case 'eq': case 'ne': case 'in': case 'compare': return [c.id];
    case 'before_ym': return ['registration_year', 'registration_month'];
    case 'as_of_gte': case 'as_of_lt': return [AS_OF_DATE_INPUT_ID];
    case 'and': case 'or': return c.items.flatMap(variablesInCondition);
    case 'not': return variablesInCondition(c.inner);
    default: return [];
  }
}

/**
 * JSON からプロファイルを読み込み、形と中身を検証する。知らないキー・知らない op・小数はエラー。
 * @param source JSON の文字列（推奨）、UTF-8 のバイト列（ArrayBuffer / Uint8Array）、または JSON.parse 済みの値
 *   （JSON.parse 済みだと 1.0 と 1 を見分けられないので、小数の検査が甘くなる）
 */
export function loadProfile(source) {
  const profile = parseProfile(toJSONTree(source));
  validateProfile(profile);
  return Object.freeze(profile);
}

// MARK: - 評価（ProfileEvaluator.swift）

function describeValue(v) {
  return v.t === 'enum' ? `"${v.v}"` : `${v.v}`;
}

/** 渡された入力値を { t: 'int' | 'bool' | 'enum', v } にする。読めない値は { t: 'invalid', name } */
function classify(v) {
  if (typeof v === 'boolean') return { t: 'bool', v };
  if (typeof v === 'string') return { t: 'enum', v };
  if (typeof v === 'bigint') return inInt64(v) ? intValue(v) : { t: 'invalid', name: 'int64 の範囲外の整数' };
  if (typeof v === 'number') {
    if (Number.isSafeInteger(v)) return intValue(BigInt(v));
    return { t: 'invalid', name: Number.isInteger(v) ? '安全な範囲外の整数（BigInt で渡してください）' : '小数' };
  }
  return { t: 'invalid', name: v === null ? 'null' : typeof v };
}

const typeName = (value) => (value.t === 'invalid' ? value.name : value.t);

/** API の整数の引数（月数）を BigInt にする */
function intArgument(v, id) {
  const c = classify(v);
  if (c.t !== 'int') throw new ProfileError('inputTypeMismatch', { id, expected: 'int', actual: typeName(c) });
  return c.v;
}

function entriesOf(inputs) {
  if (inputs == null) return [];
  if (inputs instanceof Map) return [...inputs.entries()];
  return Object.entries(inputs);
}

function validateInput(id, value, profile) {
  if (STANDARD.has(id)) {
    if (value.t !== 'int') throw new ProfileError('inputTypeMismatch', { id, expected: 'int', actual: typeName(value) });
    const n = value.v;
    if (id === 'car_age_years' && n < 0n) {
      throw new ProfileError('inputOutOfRange', { id, value: plainInt(n), min: 0, max: null });
    }
    if (id === 'registration_month' && (n < 1n || n > 12n)) {
      throw new ProfileError('inputOutOfRange', { id, value: plainInt(n), min: 1, max: 12 });
    }
    if (id === AS_OF_DATE_INPUT_ID && !isValidDate(n)) {
      throw new ProfileError('inputOutOfRange', { id, value: plainInt(n), min: null, max: null });
    }
    return;
  }
  const inp = profile.inputsByID.get(id);
  if (!inp) throw new ProfileError('unknownInput', { id });
  if (inp.type === 'int' && value.t === 'int') {
    const info = { id, value: plainInt(value.v), min: inp.min === null ? null : plainInt(inp.min), max: inp.max === null ? null : plainInt(inp.max) };
    if (inp.min !== null && value.v < inp.min) throw new ProfileError('inputOutOfRange', info);
    if (inp.max !== null && value.v > inp.max) throw new ProfileError('inputOutOfRange', info);
    return;
  }
  if (inp.type === 'bool' && value.t === 'bool') return;
  if (inp.type === 'enum' && value.t === 'enum') {
    if (!inp.options.some((o) => o.id === value.v)) {
      throw new ProfileError('invalidEnumValue', { id, value: value.v, options: inp.options.map((o) => o.id) });
    }
    return;
  }
  throw new ProfileError('inputTypeMismatch', { id, expected: inp.type, actual: typeName(value) });
}

/** 1回の評価の状態（派生値と ask_when の結果を覚え、循環を検出する） */
class EvaluationContext {
  constructor(profile, inputs, termMonths) {
    this.profile = profile;
    this.termMonths = termMonths; // BigInt | null
    this.inputs = new Map();
    this.derivedCache = new Map();
    this.derivedStack = [];
    this.askedCache = new Map();
    this.askStack = [];
    for (const [id, raw] of entriesOf(inputs)) {
      if (raw === undefined || raw === null) continue; // 渡していないのと同じ
      const value = classify(raw);
      validateInput(id, value, profile);
      this.inputs.set(id, value);
    }
    const asOf = this.inputs.get(AS_OF_DATE_INPUT_ID);
    if (asOf && asOf.t === 'int' && asOf.v < BigInt(profile.effectiveFromDate)) {
      throw new ProfileError('asOfBeforeEffectiveFrom', { asOf: plainInt(asOf.v), effectiveFrom: profile.effectiveFromDate });
    }
  }

  // 税・保険

  tax(t, index, payment, includeManual) {
    const path = `$.taxes[${index}]`;
    if (t.appliesWhen && !this.test(t.appliesWhen, `${path}.applies_when`)) return NOT_APPLICABLE;
    if (!(t.autoCalculable || includeManual)) return MANUAL;
    let n;
    switch (payment.type) {
      case 'regular':
        n = t.amount;
        break;
      case 'cadence': {
        let option = t.cadenceOptions.find((o) => BigInt(o.months) === payment.months);
        if (!option && t.cadenceOptions.length === 0 && payment.months === BigInt(t.cadenceMonths)) option = { amount: null };
        if (!option) {
          throw new ProfileError('invalidCadence', { taxID: t.id, months: plainInt(payment.months), options: cadenceChoices(t) });
        }
        n = option.amount ?? t.amount;
        break;
      }
      case 'initial':
        if (!t.initial) throw schemaError(path, `税 "${t.id}" に initial はありません`);
        n = t.initial.amount;
        break;
      default:
        throw new TypeError(`知らない支払い ${payment.type}`);
    }
    if (!n) return MANUAL;
    const value = this.value(n);
    if (!value.isInteger) throw new ProfileError('nonIntegerAmount', { taxID: t.id, value: value.toString() });
    return { type: 'amount', amount: value.numerator };
  }

  terms(insurance) {
    for (let i = 0; i < insurance.termRules.length; i++) {
      const rule = insurance.termRules[i];
      if (this.test(rule.when, `$.compulsory_insurance.term_rules[${i}].when`)) {
        return { options: rule.options, defaultTermMonths: rule.defaultTermMonths };
      }
    }
    return { options: insurance.termMonthsOptions, defaultTermMonths: insurance.defaultTermMonths };
  }

  // 入力の参照

  inputValue(id, path) {
    const inp = this.profile.inputsByID.get(id);
    if (inp && inp.askWhen && !this.isAsked(inp)) throw new ProfileError('inputNotAsked', { id, path });
    const value = this.inputs.get(id);
    if (value === undefined) throw new ProfileError('missingInput', { id, path });
    return value;
  }

  isAsked(inp) {
    if (!inp.askWhen) return true;
    if (this.askedCache.has(inp.id)) return this.askedCache.get(inp.id);
    if (this.askStack.includes(inp.id)) throw new ProfileError('askWhenCycle', { ids: [...this.askStack, inp.id] });
    this.askStack.push(inp.id);
    try {
      const asked = this.test(inp.askWhen, `$.inputs.${inp.id}.ask_when`);
      this.askedCache.set(inp.id, asked);
      return asked;
    } finally {
      this.askStack.pop();
    }
  }

  /** { number: Rational } か { value: {t, v} }（bool / enum の入力） */
  operand(id, path) {
    if (this.profile.derived.has(id)) return { number: this.derivedValue(id) };
    if (id === TERM_MONTHS_INPUT_ID) {
      if (this.termMonths === null) throw new ProfileError('missingInput', { id, path });
      return { number: Rational.of(this.termMonths) };
    }
    if (!this.profile.inputsByID.has(id) && !STANDARD.has(id)) throw new ProfileError('unknownVariable', { path, id });
    const value = this.inputValue(id, path);
    if (value.t === 'int') return { number: Rational.of(value.v) };
    return { value };
  }

  number(id, path) {
    const o = this.operand(id, path);
    if (!o.number) throw new ProfileError('typeMismatch', { path, message: `"${id}" は数値ではありません` });
    return o.number;
  }

  derivedValue(id) {
    if (this.derivedCache.has(id)) return this.derivedCache.get(id);
    if (this.derivedStack.includes(id)) throw new ProfileError('derivedCycle', { ids: [...this.derivedStack, id] });
    const n = this.profile.derived.get(id);
    if (!n) throw new ProfileError('unknownVariable', { path: '$.derived', id });
    this.derivedStack.push(id);
    try {
      const value = this.value(n);
      this.derivedCache.set(id, value);
      return value;
    } finally {
      this.derivedStack.pop();
    }
  }

  // 条件（and / or / in は左から評価し、結果が決まった時点で止める）

  test(c, path) {
    switch (c.op) {
      case 'eq': return this.matches(c.id, c.value, path);
      case 'ne': return !this.matches(c.id, c.value, path);
      case 'in':
        for (const v of c.values) if (this.matches(c.id, v, path)) return true;
        return false;
      case 'compare': {
        const lhs = this.number(c.id, path);
        switch (c.cmp) {
          case 'gte': return lhs.gte(c.value);
          case 'gt': return lhs.gt(c.value);
          case 'lt': return lhs.lt(c.value);
          default: return lhs.lte(c.value);
        }
      }
      case 'before_ym': {
        const regYear = this.number('registration_year', path);
        const regMonth = this.number('registration_month', path);
        const year = Rational.of(c.year);
        return regYear.lt(year) || (regYear.eq(year) && regMonth.lt(Rational.of(c.month)));
      }
      case 'as_of_gte': return this.number(AS_OF_DATE_INPUT_ID, path).gte(Rational.of(c.date));
      case 'as_of_lt': return this.number(AS_OF_DATE_INPUT_ID, path).lt(Rational.of(c.date));
      case 'and':
        for (const item of c.items) if (!this.test(item, path)) return false;
        return true;
      case 'or':
        for (const item of c.items) if (this.test(item, path)) return true;
        return false;
      case 'not': return !this.test(c.inner, path);
      default: throw new TypeError(`知らない条件 ${c.op}`);
    }
  }

  matches(id, constant, path) {
    const o = this.operand(id, path);
    if (o.number && constant.t === 'int') return o.number.eq(Rational.of(constant.v));
    if (o.value) return o.value.t === constant.t && o.value.v === constant.v;
    throw new ProfileError('typeMismatch', { path, message: `入力 "${id}" と定数 ${describeValue(constant)} の型が合いません` });
  }

  // 式

  value(n) {
    const raw = this.rawValue(n);
    if (!n.round) return raw;
    const step = Rational.of(n.round.step);
    const quotient = raw.div(step);
    let unitsCount;
    switch (n.round.mode) {
      case 'floor': unitsCount = quotient.floorInteger(); break;
      case 'ceil': unitsCount = quotient.ceilInteger(); break;
      default: unitsCount = quotient.halfUpInteger(); break;
    }
    return Rational.of(unitsCount).mul(step);
  }

  rawValue(n) {
    switch (n.kind) {
      case 'var': return this.number(n.id, n.path);
      case 'const': return n.value;
      case 'table': {
        const x = this.value(n.input);
        const bracket = n.brackets.find((b) => b.max === null || x.lte(b.max));
        if (bracket) return this.value(bracket.value);
        if (!n.else) throw new ProfileError('noMatchingBracket', { path: n.path, input: x.toString() });
        return this.value(n.else);
      }
      case 'bracket_rate': {
        const x = this.value(n.input);
        const bracket = n.brackets.find((b) => b.max === null || x.lte(b.max));
        if (!bracket) throw new ProfileError('noMatchingBracket', { path: n.path, input: x.toString() });
        return x.mul(bracket.rate);
      }
      case 'progressive': {
        const x = this.value(n.input);
        const bracket = n.brackets.find((b) => b.max === null || x.lte(b.max));
        if (!bracket) throw new ProfileError('noMatchingBracket', { path: n.path, input: x.toString() });
        const base = this.value(bracket.base);
        return base.add(x.sub(bracket.from).mul(bracket.rate));
      }
      case 'steps': {
        const difference = this.value(n.input).sub(n.from);
        const excess = rmax(difference, ZERO);
        const count = excess.div(n.step).ceilInteger();
        return Rational.of(count).mul(n.perStep);
      }
      case 'arithmetic': {
        let result = this.value(n.args[0]);
        for (const arg of n.args.slice(1)) {
          const next = this.value(arg);
          switch (n.op) {
            case 'add': result = result.add(next); break;
            case 'sub': result = result.sub(next); break;
            case 'mul': result = result.mul(next); break;
            case 'min': result = rmin(result, next); break;
            default: result = rmax(result, next); break;
          }
        }
        return result;
      }
      case 'if':
        for (const item of n.cases) if (this.test(item.when, item.then.path)) return this.value(item.then);
        return this.value(n.else);
      case 'age_reduction': {
        const counted = this.value(n.age).sub(n.startAge).add(ONE);
        const years = rmax(counted, ZERO);
        const uncapped = years.mul(n.perYear);
        const reduction = rmin(uncapped, n.max);
        const base = this.value(n.base);
        return base.mul(ONE.sub(reduction));
      }
      case 'fail': throw new ProfileError('explicitFail', { path: n.path, message: n.message });
      default: throw new TypeError(`知らないノード ${n.kind}`);
    }
  }
}

// MARK: - 公開 API

const NOT_APPLICABLE = Object.freeze({ type: 'notApplicable' });
const MANUAL = Object.freeze({ type: 'manual' });

/** 評価の結果の種類 */
export const Outcome = Object.freeze({
  /** `applies_when` が偽（またはプロファイルに定義が無い） */
  notApplicable: NOT_APPLICABLE,
  /** 金額を自動では出さない（`auto_calculable: false`、`amount: null`、`premium: null`、`fee` 無し） */
  manual: MANUAL,
  amount: (value) => Object.freeze({ type: 'amount', amount: value }),
});

/** どの支払いを評価するか */
export const Payment = Object.freeze({
  /** `cadence_months` の通常の支払い */
  regular: Object.freeze({ type: 'regular' }),
  /** `initial`（最初の1回だけの支払い） */
  initial: Object.freeze({ type: 'initial' }),
  /** `cadence_options` の中の月数 */
  cadence: (months) => Object.freeze({ type: 'cadence', months }),
});

function normalizePayment(p) {
  if (p === undefined || p === null || p === 'regular') return { type: 'regular' };
  if (p === 'initial') return { type: 'initial' };
  if (typeof p === 'number' || typeof p === 'bigint') return { type: 'cadence', months: intArgument(p, 'cadence_months') };
  if (p.type === 'cadence') return { type: 'cadence', months: intArgument(p.months, 'cadence_months') };
  if (p.type === 'regular' || p.type === 'initial') return { type: p.type };
  throw new TypeError(`payment は Payment.regular / Payment.initial / Payment.cadence(月数) のどれかです`);
}

/** 金額（BigInt）を返す形にする。既定は Number（安全な整数の範囲を超えたらエラー）、`bigint: true` なら BigInt */
function exportAmount(value, bigint) {
  if (bigint) return value;
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new ProfileError('arithmeticOverflow', {
      message: `金額 ${value} が JavaScript の安全な整数の範囲を超えました（bigint: true で受け取ってください）`,
    });
  }
  return Number(value);
}

function exportOutcome(outcome, bigint) {
  if (outcome.type !== 'amount') return outcome;
  return Outcome.amount(exportAmount(outcome.amount, bigint));
}

/**
 * 自動計算できる税ごとの1回の支払額（最小通貨単位）。
 * `applies_when` が偽の税と `auto_calculable: false` の税は含めない。
 * @param options.taxIds 指定した税だけを評価する（プロファイルに無い id はエラー）
 * @param options.bigint true なら金額を BigInt で返す
 * @returns {Record<string, number|bigint>}
 */
export function evaluate(profile, inputs, { taxIds = null, bigint = false } = {}) {
  const wanted = taxIds === null || taxIds === undefined ? null : new Set(taxIds);
  if (wanted) {
    const known = new Set(profile.taxes.map((t) => t.id));
    const unknown = [...wanted].filter((id) => !known.has(id)).sort(compareStrings);
    if (unknown.length > 0) throw schemaError('$.taxes', `税 "${unknown[0]}" はこのプロファイルにありません`);
  }
  const context = new EvaluationContext(profile, inputs, null);
  const result = {};
  profile.taxes.forEach((t, index) => {
    if (wanted && !wanted.has(t.id)) return;
    if (!t.autoCalculable) return;
    const outcome = context.tax(t, index, Payment.regular, false);
    if (outcome.type === 'amount') result[t.id] = exportAmount(outcome.amount, bigint);
  });
  return result;
}

/**
 * 1つの税を評価する。
 * @param options.payment Payment.regular（既定）/ Payment.initial / Payment.cadence(月数)。'initial' や月数の数値でもよい
 * @param options.includeManual true なら `auto_calculable: false` の税も `amount` があれば計算する（正解表で式を確かめる用）
 * @returns {{type: 'notApplicable'} | {type: 'manual'} | {type: 'amount', amount: number|bigint}}
 */
export function evaluateTax(profile, inputs, taxId, { payment = Payment.regular, includeManual = false, bigint = false } = {}) {
  const index = profile.taxes.findIndex((t) => t.id === taxId);
  if (index < 0) throw schemaError('$.taxes', `税 "${taxId}" はこのプロファイルにありません`);
  const pay = normalizePayment(payment);
  const context = new EvaluationContext(profile, inputs, null);
  return exportOutcome(context.tax(profile.taxes[index], index, pay, includeManual), bigint);
}

/** 支払い周期の選択肢（月数）。選べない税は `cadence_months` だけ。 */
export function cadenceChoices(t) {
  return t.cadenceOptions.length === 0 ? [t.cadenceMonths] : t.cadenceOptions.map((o) => o.months);
}

/**
 * 強制保険の保険期間の選択肢と初期値（`term_rules` を上から調べる）。定義が無い・かからないなら null。
 * @returns {{options: number[], defaultTermMonths: number} | null}
 */
export function compulsoryInsuranceTerms(profile, inputs) {
  const ins = profile.compulsoryInsurance;
  if (!ins) return null;
  const context = new EvaluationContext(profile, inputs, null);
  if (ins.appliesWhen && !context.test(ins.appliesWhen, '$.compulsory_insurance.applies_when')) return null;
  const terms = context.terms(ins);
  return { options: [...terms.options], defaultTermMonths: terms.defaultTermMonths };
}

/** 強制保険の保険料。`termMonths` はその車の選択肢のどれかでなければエラー。 */
export function compulsoryInsurancePremium(profile, inputs, termMonths, { bigint = false } = {}) {
  const ins = profile.compulsoryInsurance;
  if (!ins) return NOT_APPLICABLE;
  const term = intArgument(termMonths, TERM_MONTHS_INPUT_ID);
  const context = new EvaluationContext(profile, inputs, term);
  if (ins.appliesWhen && !context.test(ins.appliesWhen, '$.compulsory_insurance.applies_when')) return NOT_APPLICABLE;
  const terms = context.terms(ins);
  if (!terms.options.some((m) => BigInt(m) === term)) {
    throw new ProfileError('invalidTermMonths', { value: plainInt(term), options: [...terms.options] });
  }
  if (!ins.premium) return MANUAL;
  const value = context.value(ins.premium);
  if (!value.isInteger) throw new ProfileError('nonIntegerAmount', { taxID: 'compulsory_insurance', value: value.toString() });
  return Outcome.amount(exportAmount(value.numerator, bigint));
}

/** この車にかかる定期検査（複数かかってよい。並びはプロファイルの順）。 */
export function inspections(profile, inputs) {
  const context = new EvaluationContext(profile, inputs, null);
  return profile.inspections.filter((insp, index) => !insp.appliesWhen || context.test(insp.appliesWhen, `$.inspections[${index}].applies_when`));
}

/** 検査手数料。`fee` が無い検査は manual、かからない検査は notApplicable。 */
export function inspectionFee(profile, inputs, inspectionId, { bigint = false } = {}) {
  const index = profile.inspections.findIndex((i) => i.id === inspectionId);
  if (index < 0) throw schemaError('$.inspections', `検査 "${inspectionId}" はこのプロファイルにありません`);
  const insp = profile.inspections[index];
  const context = new EvaluationContext(profile, inputs, null);
  if (insp.appliesWhen && !context.test(insp.appliesWhen, `$.inspections[${index}].applies_when`)) return NOT_APPLICABLE;
  if (!insp.fee) return MANUAL;
  const value = context.value(insp.fee);
  if (!value.isInteger) throw new ProfileError('nonIntegerAmount', { taxID: `inspection:${inspectionId}`, value: value.toString() });
  return Outcome.amount(exportAmount(value.numerator, bigint));
}

/** この車で選べる燃料（`applies_when` が偽のものを除く。並びはプロファイルの順）。 */
export function fuels(profile, inputs) {
  const context = new EvaluationContext(profile, inputs, null);
  return profile.fuels.filter((f, index) => !f.appliesWhen || context.test(f.appliesWhen, `$.fuels[${index}].applies_when`));
}

/** 表示名を言語で引く。足りない言語は en → ja の順に代替する（仕様 3.1） */
export function localize(text, language) {
  if (!text) return '';
  return text[language] ?? text.en ?? text.ja ?? '';
}
