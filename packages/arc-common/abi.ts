// Minimal ABI encode/decode -- only what the Arc tools in this repo need.
import { keccak256, keccak256Hex, toHex } from "./keccak.ts";

export type Hex = `0x${string}`;

/** 4-byte function selector for a canonical signature, e.g. "balanceOf(address)". */
export function selector(signature: string): Hex {
  return ("0x" + keccak256Hex(signature).slice(2, 10)) as Hex;
}

/** 32-byte event topic0 for a canonical signature. */
export function eventTopic(signature: string): Hex {
  return keccak256Hex(signature) as Hex;
}

function word(hex: string): string {
  return hex.replace(/^0x/, "").padStart(64, "0");
}

export function encodeAddress(addr: string): string {
  return word(addr.toLowerCase());
}

export function encodeUint(value: bigint | number): string {
  return word(BigInt(value).toString(16));
}

/** Build calldata from a signature and already-encoded 32-byte words. */
export function encodeCall(signature: string, ...words: string[]): Hex {
  return (selector(signature) + words.join("")) as Hex;
}

/** Read the nth 32-byte word of an ABI-encoded return blob. */
export function wordAt(data: string, index: number): string {
  const body = data.replace(/^0x/, "");
  return body.slice(index * 64, (index + 1) * 64);
}

export function decodeUint(data: string, index = 0): bigint {
  const w = wordAt(data, index);
  return w ? BigInt("0x" + w) : 0n;
}

export function decodeAddress(data: string, index = 0): Hex {
  return ("0x" + wordAt(data, index).slice(24)) as Hex;
}

export function decodeBool(data: string, index = 0): boolean {
  return decodeUint(data, index) !== 0n;
}

/** Decode a dynamic `string` return where the head word at `index` is its offset. */
export function decodeString(data: string, index = 0): string {
  const body = data.replace(/^0x/, "");
  const offset = Number(decodeUint(data, index)) * 2;
  const length = Number(BigInt("0x" + body.slice(offset, offset + 64)));
  const raw = body.slice(offset + 64, offset + 64 + length * 2);
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = parseInt(raw.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder().decode(bytes);
}

/** Checksum an address per EIP-55, so output is copy-pasteable into explorers. */
export function checksumAddress(addr: string): Hex {
  const lower = addr.replace(/^0x/, "").toLowerCase();
  const hash = toHex(keccak256(new TextEncoder().encode(lower))).slice(2);
  let out = "0x";
  for (let i = 0; i < lower.length; i++) {
    out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  }
  return out as Hex;
}

/**
 * Format a raw integer amount with `decimals` places, without floating point.
 * Arc mixes 6-decimal (ERC-20 view) and 18-decimal (native) USDC, so every
 * display path in this repo goes through here rather than Number().
 */
export function formatUnits(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}
