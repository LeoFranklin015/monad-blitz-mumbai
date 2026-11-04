// Mera passkey accounts: a passkey's PRF output becomes a BIP-39 phrase, the phrase a plain EOA.
// Nothing to deploy, no bundler. The private key lives only inside Mera's signing session;
// this module never stores it, and never stores the PRF output.
//
// Pure module (no DOM, no app state) so it runs under `node --test`.
import { AbstractSigner, Transaction, getAddress, hexlify, TypedDataEncoder } from "ethers";
import { createPasskeyWithPrfOutput, getPasskeyPrfOutput, createSecp256k1SigningSession, MeraError } from "@category-labs/mera";
import { toViemAccount } from "@category-labs/mera/viem";
import { HDKey } from "@scure/bip32";
import { entropyToMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

const APP_NAME = "Weekend Options";
const STORE_KEY = "wknd.mera.credential";

/// BIP-44 key for account `index`. Same path as MetaMask, so the phrase imports as the same address.
export function deriveEvmKey(prfOutput, index = 0) {
  const seed = mnemonicToSeedSync(entropyToMnemonic(prfOutput, wordlist));
  const node = HDKey.fromMasterSeed(seed).derive(`m/44'/60'/0'/0/${index}`);
  seed.fill(0);
  if (node.privateKey === null) throw new Error("derivation produced no key");
  return node.privateKey;
}

/// The 24-word phrase behind the account.
export const recoveryPhrase = (prfOutput) => entropyToMnemonic(prfOutput, wordlist);

/// Derive the key, hand it to a signing session, and wipe our copy. Caller ends the session.
export function openSession(prfOutput) {
  const key = deriveEvmKey(prfOutput);
  try {
    const session = createSecp256k1SigningSession({ privateKey: key });
    return { session, account: toViemAccount(session) };
  } finally {
    key.fill(0);
  }
}

// ---- passkey ceremonies ---------------------------------------------------------------

/// Credential metadata only (id, transports, public address). Never key material.
export function storedCredential(storage = globalThis.localStorage) {
  try {
    const v = JSON.parse(storage?.getItem(STORE_KEY) || "null");
    return v && typeof v.credentialId === "string" ? v : null;
  } catch {
    return null;
  }
}
export function saveCredential(meta, storage = globalThis.localStorage) {
  try {
    storage?.setItem(STORE_KEY, JSON.stringify(meta));
  } catch {}
}
export function forgetCredential(storage = globalThis.localStorage) {
  try {
    storage?.removeItem(STORE_KEY);
  } catch {}
}

/// New passkey → new account. Returns { prfOutput, credential }.
export async function createPasskey(rpId) {
  const stamp = new Date().toISOString().slice(0, 10);
  const c = await createPasskeyWithPrfOutput({
    rp: { id: rpId, name: APP_NAME },
    user: { name: `${APP_NAME} · ${stamp}`, displayName: `${APP_NAME} account` },
  });
  return { prfOutput: c.prfOutput, credential: { credentialId: c.credentialId, ...(c.transports ? { transports: [...c.transports] } : {}) } };
}

/// Existing passkey. With `known` it targets that credential; without, the browser lists saved passkeys.
export async function usePasskey(rpId, known) {
  const credential = known ? { credentialId: known.credentialId, ...(known.transports ? { transports: known.transports } : {}) } : undefined;
  const r = await getPasskeyPrfOutput({ rpId, credential });
  const meta = known?.credentialId === r.credentialId ? { credentialId: known.credentialId, transports: known.transports } : { credentialId: r.credentialId };
  return { prfOutput: r.prfOutput, credential: meta };
}

// ---- errors ---------------------------------------------------------------------------

export const isMeraError = (e) => e instanceof MeraError || (e?.name === "MeraError" && typeof e?.code === "string");

const COPY = {
  PRF_UNAVAILABLE: "This passkey manager doesn't support PRF. On desktop Chrome, save the passkey to Google Password Manager; iCloud Keychain and 1Password work too.",
  PASSKEY_CANCELLED: "Passkey prompt dismissed. Nothing was signed.",
  PASSKEY_OPERATION_FAILED: "The passkey prompt failed or was dismissed. Try again.",
  CRYPTO_UNAVAILABLE: "Passkeys need a secure page. Open the app over https or on localhost.",
  SESSION_ENDED: "Your passkey session ended. Sign in again to continue.",
};
/// Plain copy for a Mera error, or null for anything else.
export const meraMessage = (e) => (isMeraError(e) ? COPY[e.code] || e.message : null);
/// Errors where trying the same thing again is the right move.
export const isRetryable = (e) => isMeraError(e) && ["PASSKEY_CANCELLED", "PASSKEY_OPERATION_FAILED"].includes(e.code);

// ---- ethers signer --------------------------------------------------------------------

/// ethers v6 Signer whose signatures come from a Mera viem account.
/// ethers populates (nonce, chainId, EIP-1559 fees); the gas limit is set explicitly at
/// estimate × 1.2 because Monad charges the declared limit, not gas used.
/// Nonces are tracked locally on top of the chain's pending count: ethers caches identical RPC
/// reads for a moment, and on fast chains a second send can read the count from before the first.
export class MeraSigner extends AbstractSigner {
  #account;
  #next = 0;
  constructor(account, provider) {
    super(provider);
    this.#account = account;
    this.address = getAddress(account.address);
  }
  async getAddress() {
    return this.address;
  }
  connect(provider) {
    return new MeraSigner(this.#account, provider);
  }
  async populateTransaction(tx) {
    if (tx.nonce == null) {
      const pending = await this.provider.getTransactionCount(this.address, "pending");
      tx = { ...tx, nonce: Math.max(pending, this.#next) };
    }
    if (tx.gasLimit == null) {
      const est = await this.estimateGas({ ...tx, from: this.address });
      tx = { ...tx, gasLimit: (est * 12n) / 10n };
    }
    return super.populateTransaction(tx);
  }
  async sendTransaction(tx) {
    const sent = await super.sendTransaction(tx);
    this.#next = Math.max(this.#next, sent.nonce + 1); // only a broadcast tx consumes a nonce
    return sent;
  }
  async signTransaction(tx) {
    let t = tx;
    if (!(t instanceof Transaction)) {
      const { from, ...pop } = await this.populateTransaction(tx);
      if (from && getAddress(from) !== this.address) throw new Error("transaction from mismatch");
      t = Transaction.from(pop);
    }
    const base = { chainId: Number(t.chainId), nonce: t.nonce, to: t.to || undefined, value: t.value, data: t.data, gas: t.gasLimit };
    const vtx = t.type === 2
      ? { ...base, type: "eip1559", maxFeePerGas: t.maxFeePerGas, maxPriorityFeePerGas: t.maxPriorityFeePerGas, accessList: t.accessList || [] }
      : t.type === 1
        ? { ...base, type: "eip2930", gasPrice: t.gasPrice, accessList: t.accessList || [] }
        : { ...base, type: "legacy", gasPrice: t.gasPrice };
    const raw = await this.#account.signTransaction(vtx);
    if (Transaction.from(raw).from !== this.address) throw new Error("signature does not match the account");
    return raw;
  }
  async signMessage(message) {
    return this.#account.signMessage({ message: typeof message === "string" ? message : { raw: hexlify(message) } });
  }
  async signTypedData(domain, types, value) {
    const { EIP712Domain, ...rest } = types;
    return this.#account.signTypedData({ domain, types: rest, primaryType: TypedDataEncoder.getPrimaryType(rest), message: value });
  }
}
