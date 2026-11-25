declare module "bs58" {
  const bs58: { encode(buffer: Uint8Array | Buffer | number[]): string; decode(str: string): Buffer };
  export default bs58;
}
