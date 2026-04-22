/* ═══════════════════════════════════════════════════════════════
   自動車税シミュレーター — ロジック
   Ported from TaxCalculator.swift (iOS app)
   ═══════════════════════════════════════════════════════════════ */

/* ── 税額テーブル ── */
const TaxConstants = {
  // 令和元年10月以降 新車新規登録
  autoTaxTablePost2019: [
    { maxCC: 1000,     annualTax:  25000, surcharge:  33900 },
    { maxCC: 1500,     annualTax:  30500, surcharge:  39600 },
    { maxCC: 2000,     annualTax:  36000, surcharge:  45400 },
    { maxCC: 2500,     annualTax:  43500, surcharge:  51700 },
    { maxCC: 3000,     annualTax:  50000, surcharge:  58600 },
    { maxCC: 3500,     annualTax:  57000, surcharge:  66700 },
    { maxCC: 4000,     annualTax:  65500, surcharge:  76400 },
    { maxCC: 4500,     annualTax:  75500, surcharge:  87900 },
    { maxCC: 6000,     annualTax:  87000, surcharge: 101200 },
    { maxCC: Infinity, annualTax: 110000, surcharge: 127600 },
  ],
  // 令和元年9月以前 新車新規登録
  autoTaxTablePre2019: [
    { maxCC: 1000,     annualTax:  29500, surcharge:  33900 },
    { maxCC: 1500,     annualTax:  34500, surcharge:  39600 },
    { maxCC: 2000,     annualTax:  39500, surcharge:  45400 },
    { maxCC: 2500,     annualTax:  45000, surcharge:  51700 },
    { maxCC: 3000,     annualTax:  51000, surcharge:  58600 },
    { maxCC: 3500,     annualTax:  58000, surcharge:  66700 },
    { maxCC: 4000,     annualTax:  66500, surcharge:  76400 },
    { maxCC: 4500,     annualTax:  76500, surcharge:  87900 },
    { maxCC: 6000,     annualTax:  88000, surcharge: 101200 },
    { maxCC: Infinity, annualTax: 111000, surcharge: 127600 },
  ],
  evTaxPre2019:  29500,
  evTaxPost2019: 25000,

  keiAutoTax:          10800,
  keiAutoTaxSurcharge: 12900,

  truckAutoTaxTable: [
    { maxKg: 1000, annualTax:  8000, surcharge:  8800 },
    { maxKg: 2000, annualTax: 11500, surcharge: 12600 },
    { maxKg: 3000, annualTax: 16000, surcharge: 17600 },
    { maxKg: 4000, annualTax: 20500, surcharge: 22500 },
    { maxKg: 5000, annualTax: 25500, surcharge: 28000 },
    { maxKg: 6000, annualTax: 30000, surcharge: 33000 },
    { maxKg: 7000, annualTax: 35000, surcharge: 38500 },
    { maxKg: 8000, annualTax: 40500, surcharge: 44500 },
  ],

  weightTaxTable: [
    { maxKg:  500, twoYearTax:  8200 },
    { maxKg: 1000, twoYearTax: 16400 },
    { maxKg: 1500, twoYearTax: 24600 },
    { maxKg: 2000, twoYearTax: 32800 },
    { maxKg: 2500, twoYearTax: 41000 },
    { maxKg: 3000, twoYearTax: 49200 },
  ],
  weightTax13YearSurcharge: 4600,
  weightTax18YearSurcharge: 5000,

  keiWeightTax:        6600,
  keiWeightTax13Year:  8200,
  keiWeightTax18Year:  8800,

  compulsoryInsurance24Months:    17650,
  keiCompulsoryInsurance24Months: 17540,
};

/* ── Fuel Type 判定 ── */
const isEVBased = (ft) => ft === 'electric' || ft === 'phev' || ft === 'fcv';
const isExemptFromAgeSurcharge = isEVBased;

/* ── 税制改正判定 ── */
const isPreOct2019 = (year, month) =>
  year < 2019 || (year === 2019 && month <= 9);

/* ── 自動車税（年額） ── */
function annualAutoTax({ category, displacement, fuelType, carAge, maxPayload, registrationYear, registrationMonth }) {
  const pre2019 = isPreOct2019(registrationYear, registrationMonth);

  if (category === 'kei') {
    if (carAge >= 13 && !isExemptFromAgeSurcharge(fuelType)) {
      return TaxConstants.keiAutoTaxSurcharge;
    }
    return TaxConstants.keiAutoTax;
  }

  if (category === 'smallTruck' || category === 'largeTruck') {
    const isSurcharged = carAge >= 13 && !isExemptFromAgeSurcharge(fuelType);
    const entry = TaxConstants.truckAutoTaxTable.find(e => maxPayload <= e.maxKg);
    if (maxPayload > 8000) {
      const extraTons = Math.ceil((maxPayload - 8000) / 1000);
      return isSurcharged
        ? 44500 + 6900 * extraTons
        : 40500 + 6300 * extraTons;
    }
    if (isSurcharged) return entry?.surcharge ?? 8800;
    return entry?.annualTax ?? 8000;
  }

  // passenger
  if (isEVBased(fuelType)) {
    return pre2019 ? TaxConstants.evTaxPre2019 : TaxConstants.evTaxPost2019;
  }

  const table = pre2019 ? TaxConstants.autoTaxTablePre2019 : TaxConstants.autoTaxTablePost2019;
  const entry = table.find(e => displacement <= e.maxCC);

  const surchargeThreshold = (fuelType === 'diesel') ? 11 : 13;
  if (carAge >= surchargeThreshold && !isExemptFromAgeSurcharge(fuelType)) {
    return entry?.surcharge ?? 127600;
  }
  return entry?.annualTax ?? 110000;
}

/* ── 重量税（2年分） ── */
function weightTax2Year({ category, weight, fuelType, carAge }) {
  if (category === 'kei') {
    if (carAge >= 18 && !isExemptFromAgeSurcharge(fuelType)) return TaxConstants.keiWeightTax18Year;
    if (carAge >= 13 && !isExemptFromAgeSurcharge(fuelType)) return TaxConstants.keiWeightTax13Year;
    return TaxConstants.keiWeightTax;
  }
  const base = TaxConstants.weightTaxTable.find(e => weight <= e.maxKg)?.twoYearTax ?? 49200;
  if (isExemptFromAgeSurcharge(fuelType)) return base;

  if (carAge >= 18) {
    const brackets = Math.ceil(weight / 500);
    return base + TaxConstants.weightTax18YearSurcharge * brackets;
  }
  if (carAge >= 13) {
    const brackets = Math.ceil(weight / 500);
    return base + TaxConstants.weightTax13YearSurcharge * brackets;
  }
  return base;
}

/* ── 自賠責保険（24ヶ月） ── */
const compulsoryInsurance24Months = (category) =>
  category === 'kei'
    ? TaxConstants.keiCompulsoryInsurance24Months
    : TaxConstants.compulsoryInsurance24Months;

/* ══════════════════════════════════════════════
   UI バインディング
   ══════════════════════════════════════════════ */

const yen = (n) => '¥' + Math.round(n).toLocaleString('ja-JP');

const $ = (id) => document.getElementById(id);

function getCurrentYear() {
  return new Date().getFullYear();
}

function calcAndRender() {
  const category = $('category').value;
  const displacement = parseInt($('displacement').value, 10) || 0;
  const fuelType = $('fuelType').value;
  const maxPayload = parseInt($('maxPayload').value, 10) || 0;
  const registrationYear = parseInt($('registrationYear').value, 10) || 2022;
  const registrationMonth = parseInt($('registrationMonth').value, 10) || 1;
  const weight = parseInt($('weight').value, 10) || 1000;

  const carAge = Math.max(0, getCurrentYear() - registrationYear);

  const autoTax = annualAutoTax({
    category, displacement, fuelType, carAge, maxPayload,
    registrationYear, registrationMonth,
  });

  const weightTax2y = weightTax2Year({ category, weight, fuelType, carAge });
  const weightTaxAnnual = Math.round(weightTax2y / 2);

  const compulsory = compulsoryInsurance24Months(category);
  const compulsoryAnnual = Math.round(compulsory / 2);

  const total = autoTax + weightTaxAnnual + compulsoryAnnual;

  // Render
  $('r-autotax').textContent = yen(autoTax);
  $('r-weighttax').textContent = yen(weightTaxAnnual);
  $('r-compulsory').textContent = yen(compulsoryAnnual);
  $('r-total').textContent = yen(total);

  // Auto-tax note
  let note = '';
  const pre2019 = isPreOct2019(registrationYear, registrationMonth);
  if (isEVBased(fuelType)) {
    note = '電気・PHEV・FCV は一律税額（経年重課の対象外）';
  } else if (category === 'kei') {
    if (carAge >= 13) note = '13年超の重課が適用されています';
    else note = '軽自動車は排気量に関わらず一律';
  } else {
    const surchargeYear = (fuelType === 'diesel') ? 11 : 13;
    if (carAge >= 18) note = `18年超：経年重課（${surchargeYear}年超）継続中`;
    else if (carAge >= surchargeYear) note = `${surchargeYear}年超の経年重課が適用`;
    else note = pre2019 ? '2019年9月以前登録（旧税率）' : '2019年10月以降登録（新税率）';
  }
  $('r-autotax-note').textContent = note;
}

/* ── カテゴリ変更でフォーム切替 ── */
function onCategoryChange() {
  const category = $('category').value;
  const rowDisplacement = $('row-displacement');
  const rowPayload = $('row-payload');

  if (category === 'kei') {
    rowDisplacement.style.display = '';
    rowPayload.style.display = 'none';
    $('displacement').parentElement.style.display = 'none';  // 排気量は不要
  } else if (category === 'smallTruck') {
    rowDisplacement.style.display = '';
    rowPayload.style.display = '';
    $('displacement').parentElement.style.display = '';
  } else {
    // passenger
    rowDisplacement.style.display = '';
    rowPayload.style.display = 'none';
    $('displacement').parentElement.style.display = '';
  }
  calcAndRender();
}

/* ── 初期化 ── */
document.addEventListener('DOMContentLoaded', () => {
  ['category','displacement','fuelType','maxPayload','registrationYear','registrationMonth','weight'].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('input', calcAndRender);
    el.addEventListener('change', calcAndRender);
  });
  $('category').addEventListener('change', onCategoryChange);
  onCategoryChange();
  calcAndRender();
});
