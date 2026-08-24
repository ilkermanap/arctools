// Minimal Keccak-256 (Ethereum flavour, 0x01 padding) with zero dependencies.
// Node's crypto only ships FIPS SHA3, which uses different padding, so we need our own.

const MASK = (1n << 64n) - 1n;

const RC: bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

// ROT[x][y] -- canonical Keccak rho offsets.
const ROT: number[][] = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

function rotl(v: bigint, n: number): bigint {
  if (n === 0) return v & MASK;
  const b = BigInt(n);
  return ((v << b) | (v >> (64n - b))) & MASK;
}

function permute(a: bigint[]): void {
  for (let round = 0; round < 24; round++) {
    // theta
    const c = new Array<bigint>(5);
    for (let x = 0; x < 5; x++) c[x] = a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20];
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 5; y++) a[x + 5 * y] ^= d;
    }
    // rho + pi
    const b = new Array<bigint>(25).fill(0n);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(a[x + 5 * y], ROT[x][y]);
      }
    }
    // chi
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        a[x + 5 * y] = b[x + 5 * y] ^ (~b[((x + 1) % 5) + 5 * y] & b[((x + 2) % 5) + 5 * y]) & MASK;
      }
    }
    // iota
    a[0] ^= RC[round];
  }
}

/** Keccak-256 of raw bytes. Returns 32 bytes. */
export function keccak256(input: Uint8Array): Uint8Array {
  const RATE = 136;
  const state = new Array<bigint>(25).fill(0n);

  const padLen = RATE - (input.length % RATE);
  const buf = new Uint8Array(input.length + padLen);
  buf.set(input);
  buf[input.length] = 0x01;
  buf[buf.length - 1] |= 0x80;

  for (let off = 0; off < buf.length; off += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      let lane = 0n;
      for (let j = 7; j >= 0; j--) lane = (lane << 8n) | BigInt(buf[off + i * 8 + j]);
      state[i] ^= lane;
    }
    permute(state);
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = state[i];
    for (let j = 0; j < 8; j++) {
      out[i * 8 + j] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Keccak-256 of a UTF-8 string, as a 0x-prefixed hex string. */
export function keccak256Hex(s: string): string {
  return toHex(keccak256(new TextEncoder().encode(s)));
}
