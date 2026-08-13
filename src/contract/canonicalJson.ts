import { types as utilTypes } from "node:util";

/** Native B41 canonical JSON implementation.  This deliberately does not use
 * JSON.parse: JSON.parse accepts duplicate keys, which is unsafe for evidence. */
const enc = new TextEncoder();
const ws = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r";
const hex = (c: string | undefined) => Boolean(c && /[0-9a-f]/i.test(c));
const utf16 = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

const validString = (value: string, where: string): void => {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(i + 1);
      if (low < 0xdc00 || low > 0xdfff) throw new Error(`${where}: lone high surrogate`);
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error(`${where}: lone low surrogate`);
  }
};

const canonical = (value: unknown, seen = new Set<object>(), where = "root"): unknown => {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") { validString(value, where); return value; }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new Error(`${where}: non-canonical number`);
    }
    return value;
  }
  if (typeof value !== "object" || value === null || utilTypes.isProxy(value) || seen.has(value)) {
    throw new Error(`${where}: non-canonical JSON value`);
  }
  seen.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length) {
      throw new Error(`${where}: non-canonical array`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
    const lengthDescriptor = descriptors["length"];
    const length = lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
    const names = Object.getOwnPropertyNames(value);
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0
      || names.some((key) => key !== "length" && !/^(0|[1-9]\d*)$/.test(key))
      || names.length !== length + 1) {
      throw new Error(`${where}: non-canonical array`);
    }
    const out = new Array<unknown>(length);
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new Error(`${where}: sparse/accessor array`);
      }
      out[index] = canonical(descriptor.value, seen, `${where}[${index}]`);
    }
    seen.delete(value); return out;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error(`${where}: non-plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length) throw new Error(`${where}: symbol property`);
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(value).sort(utf16)) {
    const d = descriptors[key];
    if (!d || !("value" in d) || !d.enumerable) throw new Error(`${where}: accessor/non-enumerable property`);
    validString(key, `${where} key`); out[key] = canonical(d.value, seen, `${where}.${key}`);
  }
  seen.delete(value); return out;
};

const write = (value: unknown, out: string[]): void => {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") { out.push(JSON.stringify(value)); return; }
  if (Array.isArray(value)) { out.push("["); value.forEach((entry, i) => { if (i) out.push(","); write(entry, out); }); out.push("]"); return; }
  const object = value as Record<string, unknown>; const keys = Object.keys(object).sort(utf16);
  out.push("{"); keys.forEach((key, i) => { if (i) out.push(","); out.push(JSON.stringify(key), ":"); write(object[key], out); }); out.push("}");
};

export const canonicalJsonStringify = (value: unknown): string => { const out: string[] = []; write(canonical(value), out); return out.join(""); };
export const canonicalJsonBytes = (value: unknown): Uint8Array => enc.encode(canonicalJsonStringify(value));

class StrictParser {
  private i = 0;
  constructor(private readonly text: string) {}
  private skip(): void { while (ws(this.text[this.i])) this.i += 1; }
  private string(where: string): string {
    if (this.text[this.i++] !== '"') throw new Error(`invalid string at ${this.i}`); let out = "";
    while (this.i < this.text.length) { const c = this.text[this.i++];
      if (c === '"') { validString(out, where); return out; }
      if (c === "\\") { const esc = this.text[this.i++]; const map: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        if (esc === "u") { const part = (): number => { let n = 0; for (let j = 0; j < 4; j += 1) { const h = this.text[this.i++]; if (!hex(h)) throw new Error("invalid unicode escape"); n = n * 16 + Number.parseInt(h, 16); } return n; }; const high = part();
          if (high >= 0xd800 && high <= 0xdbff) { if (this.text[this.i++] !== "\\" || this.text[this.i++] !== "u") throw new Error("invalid high surrogate"); const low = part(); if (low < 0xdc00 || low > 0xdfff) throw new Error("invalid low surrogate"); out += String.fromCodePoint(0x10000 + ((high - 0xd800) << 10) + low - 0xdc00); }
          else if (high >= 0xdc00 && high <= 0xdfff) throw new Error("lone low surrogate"); else out += String.fromCharCode(high);
        } else if (esc && Object.prototype.hasOwnProperty.call(map, esc)) out += map[esc]; else throw new Error("invalid escape");
      } else { if (c.charCodeAt(0) <= 0x1f) throw new Error("unescaped control character"); out += c; }
    } throw new Error("unterminated string");
  }
  private value(where: string): unknown { this.skip(); const c = this.text[this.i];
    if (c === "{") return this.object(where); if (c === "[") return this.array(where); if (c === '"') return this.string(where);
    if (c === "-" || (c >= "0" && c <= "9")) { const start = this.i; if (c === "-") this.i += 1; if (this.text[this.i] === "0") this.i += 1; else { if (!(this.text[this.i] >= "1" && this.text[this.i] <= "9")) throw new Error("invalid number"); while (/\d/.test(this.text[this.i] ?? "")) this.i += 1; } if (this.text[this.i] === ".") { this.i += 1; if (!/\d/.test(this.text[this.i] ?? "")) throw new Error("invalid number"); while (/\d/.test(this.text[this.i] ?? "")) this.i += 1; } if (this.text[this.i] === "e" || this.text[this.i] === "E") { this.i += 1; if (this.text[this.i] === "+" || this.text[this.i] === "-") this.i += 1; if (!/\d/.test(this.text[this.i] ?? "")) throw new Error("invalid number"); while (/\d/.test(this.text[this.i] ?? "")) this.i += 1; } const n = Number(this.text.slice(start, this.i)); return canonical(n, new Set(), where); }
    for (const [token, result] of [["true", true], ["false", false], ["null", null]] as const) if (this.text.startsWith(token, this.i)) { this.i += token.length; return result; } throw new Error(`invalid token at ${this.i}`);
  }
  private array(where: string): unknown[] { this.i += 1; const out: unknown[] = []; this.skip(); if (this.text[this.i] === "]") { this.i += 1; return out; } while (true) { out.push(this.value(`${where}[${out.length}]`)); this.skip(); if (this.text[this.i] === "]") { this.i += 1; return out; } if (this.text[this.i++] !== ",") throw new Error("invalid array"); this.skip(); if (this.text[this.i] === "]") throw new Error("trailing comma"); } }
  private object(where: string): Record<string, unknown> { this.i += 1; const out = Object.create(null) as Record<string, unknown>; const keys = new Set<string>(); this.skip(); if (this.text[this.i] === "}") { this.i += 1; return out; } while (true) { this.skip(); const key = this.string(`${where} key`); if (keys.has(key)) throw new Error(`duplicate key ${key}`); keys.add(key); this.skip(); if (this.text[this.i++] !== ":") throw new Error("invalid object"); out[key] = this.value(`${where}.${key}`); this.skip(); if (this.text[this.i] === "}") { this.i += 1; return out; } if (this.text[this.i++] !== ",") throw new Error("invalid object"); this.skip(); if (this.text[this.i] === "}") throw new Error("trailing comma"); } }
  parse(): unknown { const result = this.value("root"); this.skip(); if (this.i !== this.text.length) throw new Error("trailing JSON"); return canonical(result); }
}

export const parseCanonicalJson = (input: string): unknown => { if (!input.trim()) throw new Error("empty JSON"); return new StrictParser(input).parse(); };
export const parseCanonicalJsonBytes = (input: Uint8Array): unknown => { if (input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) throw new Error("leading BOM"); return parseCanonicalJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(input)); };
