import { z } from "zod";

/**
 * Standard x402 payment error codes.
 */
export enum PaymentErrorCode {
  PAYMENT_UNFUNDED = "PAYMENT_UNFUNDED",
  PAYMENT_REPLAY = "PAYMENT_REPLAY",
  PAYMENT_INVALID = "PAYMENT_INVALID",
  PAYMENT_EXPIRED = "PAYMENT_EXPIRED",
  PAYMENT_BLOCKHASH_STALE = "PAYMENT_BLOCKHASH_STALE",
}

/**
 * Zod schema for PaymentErrorCode enum.
 */
export const PaymentErrorCodeSchema = z.nativeEnum(PaymentErrorCode);

/**
 * MultiversX Bech32 address schema (erd1... exactly 62 characters).
 */
export const MvxAddressSchema = z
  .string()
  .regex(/^erd1[0-9a-z]{58}$/, "Invalid MultiversX bech32 address format");

/**
 * MultiversX CAIP-like network schema (e.g. multiversx:1, multiversx:D, multiversx:T).
 */
export const MultiversXNetworkSchema = z
  .string()
  .regex(/^multiversx:[a-zA-Z0-9_-]+$/, "Invalid MultiversX network format");

/**
 * Payment Scheme schema (currently 'exact' for x402 v2).
 */
export const PaymentSchemeSchema = z.literal("exact");

/**
 * MultiversX transaction payload schema for Relayed V3 and standard transactions.
 */
export const MvxTransactionPayloadSchema = z.object({
  nonce: z.number().int().nonnegative(),
  value: z.string().regex(/^\d+$/, "Value must be an unsigned integer string"),
  receiver: MvxAddressSchema,
  sender: MvxAddressSchema,
  gasPrice: z.number().int().nonnegative(),
  gasLimit: z.number().int().nonnegative(),
  data: z.string().optional(),
  chainID: z.string().min(1),
  version: z.number().int().nonnegative(),
  options: z.number().int().nonnegative(),
  signature: z
    .string()
    .regex(/^[0-9a-fA-F]{128}$/, "Signature must be 64-byte hex string (128 hex chars)"),
  relayer: MvxAddressSchema.optional(),
  relayerSignature: z
    .string()
    .regex(/^[0-9a-fA-F]{128}$/, "Relayer signature must be 64-byte hex string")
    .optional(),
  guardian: MvxAddressSchema.optional(),
  guardianSignature: z
    .string()
    .regex(/^[0-9a-fA-F]{128}$/, "Guardian signature must be 64-byte hex string")
    .optional(),
  validAfter: z.number().int().nonnegative().optional(),
  validBefore: z.number().int().nonnegative().optional(),
});

/**
 * Payment requirements schema for x402 v2.
 */
export const PaymentRequirementsSchema = z.object({
  scheme: PaymentSchemeSchema,
  network: MultiversXNetworkSchema,
  asset: z.string().min(1),
  amount: z.string().regex(/^\d+$/, "Amount must be an unsigned integer string"),
  payTo: MvxAddressSchema,
  maxTimeoutSeconds: z.number().int().positive(),
  extra: z.record(z.unknown()).optional(),
});

/**
 * Resource information schema.
 */
export const ResourceInfoSchema = z.object({
  url: z.string(),
  description: z.string().optional(),
  mimeType: z.string().optional(),
});

/**
 * Payload container schema accepting either { signature, transaction } structure or direct transaction.
 */
export const X402PayloadContainerSchema = z.union([
  z.object({
    signature: z
      .string()
      .regex(/^[0-9a-fA-F]{128}$/, "Signature must be 64-byte hex string")
      .optional(),
    transaction: MvxTransactionPayloadSchema,
  }),
  MvxTransactionPayloadSchema,
]);

/**
 * Standard x402 v2 payment payload structure.
 */
export const X402PaymentPayloadSchema = z.object({
  x402Version: z.literal(2),
  resource: ResourceInfoSchema.optional(),
  accepted: PaymentRequirementsSchema,
  payload: X402PayloadContainerSchema,
  extensions: z.record(z.unknown()).optional(),
});

/**
 * Verification request schema.
 */
export const VerifyRequestSchema = z.object({
  paymentPayload: X402PaymentPayloadSchema,
  paymentRequirements: PaymentRequirementsSchema,
});

/**
 * Verification response schema.
 */
export const VerifyResponseSchema = z.object({
  isValid: z.boolean(),
  invalidReason: z.string().optional(),
  errorCode: PaymentErrorCodeSchema.optional(),
  payer: MvxAddressSchema.optional(),
  extensions: z.record(z.unknown()).optional(),
});

/**
 * Settlement request schema.
 */
export const SettleRequestSchema = z.object({
  paymentPayload: X402PaymentPayloadSchema,
  paymentRequirements: PaymentRequirementsSchema,
});

/**
 * Settlement response schema.
 */
export const SettleResponseSchema = z.object({
  success: z.boolean(),
  errorReason: z.string().optional(),
  errorCode: PaymentErrorCodeSchema.optional(),
  payer: MvxAddressSchema.optional(),
  transaction: z.string().optional(),
  network: MultiversXNetworkSchema.optional(),
  extensions: z.record(z.unknown()).optional(),
});

/**
 * Supported payment kind schema.
 */
export const SupportedKindSchema = z.object({
  x402Version: z.number().int(),
  scheme: z.string(),
  network: MultiversXNetworkSchema,
  extra: z.record(z.unknown()).optional(),
});

/**
 * Facilitator supported capabilities response schema.
 */
export const SupportedResponseSchema = z.object({
  kinds: z.array(SupportedKindSchema),
  extensions: z.array(z.string()),
  signers: z.record(z.array(MvxAddressSchema)),
});
