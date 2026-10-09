import type { DesktopVietnamRecommendationSettings } from "@lxe/desktop-protocol";

const FIELDS = ["weight_30d", "weight_15d", "weight_7d", "exchange_rate"] as const;
const DECIMAL_PATTERN = /^[+-]?(?:(?:[0-9]+(?:\.[0-9]*)?)|(?:\.[0-9]+))(?:[eE][+-]?[0-9]+)?$/u;
const MAX_DECIMAL_LENGTH = 128;

export const DEFAULT_VIETNAM_RECOMMENDATION: Readonly<DesktopVietnamRecommendationSettings> = Object.freeze({
  weight_30d: "0.8",
  weight_15d: "0.8",
  weight_7d: "0",
  exchange_rate: "3900",
});

const strictObjectWithExactlyFourKeys = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("vietnam_recommendation must be an object with exactly four fields");
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.length !== FIELDS.length || keys.some((key) => !FIELDS.includes(key as typeof FIELDS[number]))) {
    throw new Error("vietnam_recommendation must contain only weight_30d, weight_15d, weight_7d, exchange_rate");
  }
  return object;
};

interface DecimalParts {
  digits: string;
  exponent: number;
}

// Compare decimal values without expanding exponents or rounding through a JavaScript number.
const decimalParts = (value: string): DecimalParts | null => {
  const match = /^[+-]?(?:(?:([0-9]+)(?:\.([0-9]*))?)|(?:\.([0-9]+)))(?:[eE]([+-]?[0-9]+))?$/u.exec(value);
  if (!match) return null;
  const fractional = match[2] ?? match[3] ?? "";
  const digits = `${match[1] ?? ""}${fractional}`.replace(/^0+/u, "");
  if (!digits) return { digits: "0", exponent: 0 };
  const rawExponent = Number(match[4] ?? "0");
  if (!Number.isSafeInteger(rawExponent)) return null;
  const trailingZeros = /0*$/u.exec(digits)![0].length;
  return {
    digits: digits.slice(0, digits.length - trailingZeros),
    exponent: rawExponent - fractional.length + trailingZeros,
  };
};

const exactExcelDecimal = (value: unknown, field: typeof FIELDS[number], positive: boolean): string => {
  const label = `vietnam_recommendation.${field}`;
  if (typeof value !== "string") throw new Error(`${label} must be a decimal string`);
  const raw = value.trim();
  if (raw.length === 0 || raw.length > MAX_DECIMAL_LENGTH || !DECIMAL_PATTERN.test(raw)) {
    throw new Error(`${label} must be a bounded decimal string`);
  }
  const original = decimalParts(raw);
  if (!original) throw new Error(`${label} has an invalid decimal exponent`);
  if (original.digits.length > 15) {
    throw new Error(`${label} 超出 Excel 精度（15 位有效数字）`);
  }
  const number = Number(raw);
  if (!Number.isFinite(number)) throw new Error(`${label} 超出 Excel 数值范围`);
  if (positive ? number <= 0 : number < 0) {
    throw new Error(`${label} 必须是有限${positive ? "正数" : "非负数"}`);
  }
  if (original.digits !== "0" && number === 0) {
    throw new Error(`${label} 无法精确写入 Excel 数值单元格`);
  }
  const converted = decimalParts(String(number));
  if (!converted || converted.digits !== original.digits || converted.exponent !== original.exponent) {
    throw new Error(`${label} 无法精确写入 Excel 数值单元格`);
  }
  return raw;
};

export const validateVietnamRecommendationSettings = (
  value: unknown,
): DesktopVietnamRecommendationSettings => {
  const raw = strictObjectWithExactlyFourKeys(value);
  return {
    weight_30d: exactExcelDecimal(raw.weight_30d, "weight_30d", false),
    weight_15d: exactExcelDecimal(raw.weight_15d, "weight_15d", false),
    weight_7d: exactExcelDecimal(raw.weight_7d, "weight_7d", false),
    exchange_rate: exactExcelDecimal(raw.exchange_rate, "exchange_rate", true),
  };
};
