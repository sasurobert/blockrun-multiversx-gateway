import { z } from "zod";
import {
  PaymentErrorCode,
  PaymentErrorCodeSchema,
  MvxAddressSchema,
  MultiversXNetworkSchema,
  PaymentSchemeSchema,
  MvxTransactionPayloadSchema,
  PaymentRequirementsSchema,
  ResourceInfoSchema,
  X402PayloadContainerSchema,
  X402PaymentPayloadSchema,
  VerifyRequestSchema,
  VerifyResponseSchema,
  SettleRequestSchema,
  SettleResponseSchema,
  SupportedKindSchema,
  SupportedResponseSchema,
} from "./schemas.js";

export { PaymentErrorCode };

export type MvxAddress = z.infer<typeof MvxAddressSchema>;
export type MultiversXNetwork = z.infer<typeof MultiversXNetworkSchema>;
export type PaymentScheme = z.infer<typeof PaymentSchemeSchema>;
export type MvxTransactionPayload = z.infer<typeof MvxTransactionPayloadSchema>;
export type PaymentRequirements = z.infer<typeof PaymentRequirementsSchema>;
export type ResourceInfo = z.infer<typeof ResourceInfoSchema>;
export type X402PayloadContainer = z.infer<typeof X402PayloadContainerSchema>;
export type X402PaymentPayload = z.infer<typeof X402PaymentPayloadSchema>;
export type VerifyRequest = z.infer<typeof VerifyRequestSchema>;
export type VerifyResponse = z.infer<typeof VerifyResponseSchema>;
export type SettleRequest = z.infer<typeof SettleRequestSchema>;
export type SettleResponse = z.infer<typeof SettleResponseSchema>;
export type SupportedKind = z.infer<typeof SupportedKindSchema>;
export type SupportedResponse = z.infer<typeof SupportedResponseSchema>;
