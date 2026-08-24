import { createWalletClient, http, parseUnits, parseEther, parseGwei } from "viem";

const client = createWalletClient({ transport: http("http://127.0.0.1:8545") });

export async function sendTooCheap(to: `0x${string}`) {
  return client.sendTransaction({ to, value: 1n, maxFeePerGas: parseGwei("5") });
}

export async function sendCorrectly(to: `0x${string}`) {
  return client.sendTransaction({ to, value: 1n, maxFeePerGas: parseUnits("20", 9) });
}

export async function payOut(token: any, to: string) {
  // Wrong: the ERC-20 interface on Arc is 6 decimals, not 18.
  return token.write.transfer([to, parseEther("100")]);
}
