declare module "bs58" {
  interface Bs58Codec {
    encode(value: Uint8Array): string;
  }

  const codec: Bs58Codec;
  export default codec;
}
