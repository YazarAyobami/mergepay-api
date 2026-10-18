/**
 * SEP-10 (Stellar Web Authentication) — challenge/verify on the server side.
 *
 * The server holds one signing keypair (SEP10_SIGNING_SECRET). It builds a
 * challenge transaction the client signs with their wallet; we then verify the
 * client's signature to prove control of the account.
 */

import { Keypair, WebAuth, Transaction } from "@stellar/stellar-sdk";
import { config } from "../config";
import { Errors } from "../errors";
import { stellar } from "./stellar";

let _serverKeypair: Keypair | null = null;

export function serverKeypair(): Keypair {
  if (_serverKeypair) return _serverKeypair;
  if (config.SEP10_SIGNING_SECRET) {
    _serverKeypair = Keypair.fromSecret(config.SEP10_SIGNING_SECRET);
  } else {
    // Deterministic-enough ephemeral key for dev/test when none is configured.
    _serverKeypair = Keypair.random();
  }
  return _serverKeypair;
}

export function buildChallenge(account: string): {
  transaction: string;
  networkPassphrase: string;
} {
  const transaction = WebAuth.buildChallengeTx(
    serverKeypair(),
    account,
    config.SEP10_HOME_DOMAIN,
    300,
    config.networkPassphrase,
    config.WEB_AUTH_DOMAIN
  );
  return { transaction, networkPassphrase: config.networkPassphrase };
}

/**
 * Verify a signed challenge. Returns the authenticated client public key.
 *
 * Validates:
 * - Server signature matches SEP10_SIGNING_SECRET
 * - Home domain and web auth domain match environment configuration
 * - Time bounds are valid (not expired, not future-dated beyond tolerance)
 * - Client signature is present and valid for the claimed account
 */
export async function verifyChallenge(signedXdr: string): Promise<string> {
  let clientAccountId: string;
  let txTimeBounds: { minTime: string; maxTime: string } | undefined;

  try {
    const read = WebAuth.readChallengeTx(
      signedXdr,
      serverKeypair().publicKey(),
      config.networkPassphrase,
      config.SEP10_HOME_DOMAIN,
      config.WEB_AUTH_DOMAIN
    );
    clientAccountId = read.clientAccountID;
    // Extract time bounds from the transaction for explicit validation.
    const parsedTx = new Transaction(signedXdr, config.networkPassphrase);
    txTimeBounds = {
      minTime: parsedTx.timeBounds?.minTime ?? "0",
      maxTime: parsedTx.timeBounds?.maxTime ?? "0",
    };
  } catch (e: any) {
    const msg = e?.message ?? "";
    // Distinguish between different failure modes for clearer error codes.
    if (msg.toLowerCase().includes("expired") || msg.toLowerCase().includes("time")) {
      throw Errors.badRequest(
        "challenge_expired",
        "Challenge transaction has expired or has invalid time bounds"
      );
    }
    if (msg.toLowerCase().includes("domain") || msg.toLowerCase().includes("home")) {
      throw Errors.badRequest(
        "invalid_domain",
        "Challenge home domain does not match configured domain"
      );
    }
    throw Errors.badRequest("invalid_challenge", msg || "Invalid challenge");
  }

  // Explicit time-bound validation: reject challenges that are too far in the
  // future (clock skew tolerance of 60 seconds) or already expired.
  if (txTimeBounds) {
    const now = Math.floor(Date.now() / 1000);
    const maxTime = Number(txTimeBounds.maxTime);
    const minTime = Number(txTimeBounds.minTime);
    const CLOCK_SKEW_TOLERANCE = 60;

    if (maxTime > 0 && now > maxTime + CLOCK_SKEW_TOLERANCE) {
      throw Errors.badRequest(
        "challenge_expired",
        "Challenge transaction has expired"
      );
    }
    if (minTime > 0 && minTime > now + CLOCK_SKEW_TOLERANCE) {
      throw Errors.badRequest(
        "challenge_future_dated",
        "Challenge transaction is dated too far in the future"
      );
    }
  }

  const snapshot = await stellar.loadAccount(clientAccountId);

  try {
    if (!snapshot.exists) {
      // Unfunded account: verify the master-key signature directly.
      WebAuth.verifyChallengeTxSigners(
        signedXdr,
        serverKeypair().publicKey(),
        config.networkPassphrase,
        [clientAccountId],
        config.SEP10_HOME_DOMAIN,
        config.WEB_AUTH_DOMAIN
      );
    } else {
      const signerSummary = snapshot.signers.map((s) => ({
        key: s.key,
        weight: s.weight,
      }));
      const med = snapshot.thresholds.med || 1;
      WebAuth.verifyChallengeTxThreshold(
        signedXdr,
        serverKeypair().publicKey(),
        config.networkPassphrase,
        med,
        signerSummary as any,
        config.SEP10_HOME_DOMAIN,
        config.WEB_AUTH_DOMAIN
      );
    }
  } catch (e: any) {
    const msg = e?.message ?? "";
    if (msg.toLowerCase().includes("signature") || msg.toLowerCase().includes("signer")) {
      throw Errors.unauthorized(
        "Challenge was not signed by the claimed account"
      );
    }
    throw Errors.unauthorized(
      `Challenge verification failed: ${msg || "unknown"}`
    );
  }

  return clientAccountId;
}

/** Validate the structure of a transaction XDR string (used in tests). */
export function parseTransaction(xdr: string): Transaction {
  return new Transaction(xdr, config.networkPassphrase);
}
