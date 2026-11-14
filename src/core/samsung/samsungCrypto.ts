export type SamsungSecurityLevel = 0 | 1;

export interface SamsungCryptoOptions {
  securityLevel?: SamsungSecurityLevel;
  gzip?: boolean;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
type CryptoBytes = Uint8Array<ArrayBuffer>;

function cryptoBytes(value: Uint8Array | ArrayBuffer): CryptoBytes {
  const source = value instanceof Uint8Array ? value : new Uint8Array(value);
  const result = new Uint8Array(source.byteLength);
  result.set(source);
  return result;
}

function cryptoApi(): Crypto {
  const value = globalThis.crypto;
  if (!value?.subtle) {
    throw new Error("Web Crypto API is not available in this runtime");
  }
  return value;
}

function concat(...parts: Uint8Array[]): CryptoBytes {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

/**
 * Returns true if the byte buffer begins with UTF-8 XML (`<?xml` or `<tag`),
 * which is the format written by Samsung Good Lock Home Up `.AutoBackup/*.exml`.
 */
export function isPlaintextXmlBytes(bytes: Uint8Array | ArrayBuffer): boolean {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let index = 0;
  // Skip UTF-8 BOM if present
  if (input.byteLength >= 3 && input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) {
    index = 3;
  }
  while (
    index < input.byteLength &&
    (input[index] === 0x20 ||
      input[index] === 0x09 ||
      input[index] === 0x0a ||
      input[index] === 0x0d)
  ) {
    index += 1;
  }
  return index < input.byteLength && input[index] === 0x3c; // '<'
}

async function gzip(bytes: Uint8Array): Promise<CryptoBytes> {
  if (typeof CompressionStream === "undefined") {
    throw new Error("CompressionStream is not available for gzip encryption");
  }
  const blob = new Blob([bytes as unknown as BlobPart]);
  const stream = blob.stream().pipeThrough(new CompressionStream("gzip"));
  return cryptoBytes(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes: Uint8Array): Promise<CryptoBytes> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("DecompressionStream is not available for gzip decryption");
  }
  const blob = new Blob([bytes as unknown as BlobPart]);
  const stream = blob.stream().pipeThrough(new DecompressionStream("gzip"));
  return cryptoBytes(await new Response(stream).arrayBuffer());
}

/**
 * Derive AES-CBC key matching Samsung `FileCryptHelper` (Smart Switch BNR):
 * - Level 0: `SHA-256(UTF-8(sessionKey))[0..16]` -> AES-128-CBC
 * - Level 1: `PBKDF2WithHmacSHA1(sessionKey, salt, 1000, 256)` -> AES-256-CBC
 */
async function aesKey(
  sessionKey: string,
  level: SamsungSecurityLevel,
  salt?: CryptoBytes,
): Promise<CryptoKey> {
  const api = cryptoApi();
  const secret = cryptoBytes(textEncoder.encode(sessionKey));
  if (level === 0) {
    const digest = cryptoBytes(await api.subtle.digest("SHA-256", secret));
    return api.subtle.importKey(
      "raw",
      cryptoBytes(digest.slice(0, 16)),
      { name: "AES-CBC" },
      false,
      ["encrypt", "decrypt"],
    );
  }
  if (!salt) throw new Error("Level 1 encryption requires a 16-byte salt");
  const baseKey = await api.subtle.importKey("raw", secret, "PBKDF2", false, ["deriveKey"]);
  return api.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: cryptoBytes(salt),
      iterations: 1000,
      hash: "SHA-1",
    },
    baseKey,
    { name: "AES-CBC", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptSamsung(
  xml: string,
  sessionKey: string,
  options: SamsungCryptoOptions = {},
): Promise<Uint8Array> {
  const api = cryptoApi();
  const level = options.securityLevel ?? 0;
  const iv = cryptoBytes(api.getRandomValues(new Uint8Array(16)));
  const salt = level === 1 ? cryptoBytes(api.getRandomValues(new Uint8Array(16))) : undefined;
  const plaintext = options.gzip
    ? await gzip(textEncoder.encode(xml))
    : cryptoBytes(textEncoder.encode(xml));
  const key = await aesKey(sessionKey, level, salt);
  const ciphertext = new Uint8Array(
    await api.subtle.encrypt({ name: "AES-CBC", iv }, key, plaintext),
  );
  return salt ? concat(iv, salt, ciphertext) : concat(iv, ciphertext);
}

export async function decryptSamsung(
  bytes: Uint8Array | ArrayBuffer,
  sessionKey: string,
  options: SamsungCryptoOptions = {},
): Promise<string> {
  if (isPlaintextXmlBytes(bytes)) {
    return textDecoder.decode(bytes);
  }
  const api = cryptoApi();
  const input = cryptoBytes(bytes);
  const level = options.securityLevel ?? 0;
  const headerLength = level === 1 ? 32 : 16;
  if (input.byteLength <= headerLength) {
    throw new Error("Encrypted Samsung .exml file is too short");
  }
  const iv = cryptoBytes(input.slice(0, 16));
  const salt = level === 1 ? cryptoBytes(input.slice(16, 32)) : undefined;
  const ciphertext = cryptoBytes(input.slice(headerLength));
  const key = await aesKey(sessionKey, level, salt);
  let plaintext: CryptoBytes = cryptoBytes(
    await api.subtle.decrypt({ name: "AES-CBC", iv }, key, ciphertext),
  );
  if (plaintext.byteLength >= 2 && plaintext[0] === 0x1f && plaintext[1] === 0x8b) {
    plaintext = await gunzip(plaintext);
  }
  return textDecoder.decode(plaintext);
}

/**
 * Decode a Samsung `.exml` file automatically:
 * - Home Up `.AutoBackup/*.exml` files are plaintext UTF-8 XML and need no key.
 * - Smart Switch `homescreen.exml` files are AES-CBC encrypted and require `sessionKey`.
 */
export async function decodeSamsungExml(
  bytes: Uint8Array | ArrayBuffer,
  sessionKey?: string,
  options: SamsungCryptoOptions = {},
): Promise<{ xml: string; encrypted: boolean }> {
  if (isPlaintextXmlBytes(bytes)) {
    return {
      xml: textDecoder.decode(bytes),
      encrypted: false,
    };
  }
  if (!sessionKey) {
    throw new Error(
      "This .exml file is AES-encrypted (Smart Switch format) and requires a session key (--key). Note: Home Up .AutoBackup .exml files are plaintext XML and open without a key.",
    );
  }
  return {
    xml: await decryptSamsung(bytes, sessionKey, options),
    encrypted: true,
  };
}
