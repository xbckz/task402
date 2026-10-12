declare module "viem/accounts" {
  export function privateKeyToAccount(privateKey: `0x${string}`): {
    readonly address: `0x${string}`;
    signTypedData(message: {
      domain: Record<string, unknown>;
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
    }): Promise<`0x${string}`>;
  };
}
