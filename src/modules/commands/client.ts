export type PendingCommandIdentity = Readonly<{ payloadFingerprint: string; commandId: string }>;

export function commandIdentityForPayload(
  previous: PendingCommandIdentity | null,
  payloadFingerprint: string,
  createCommandId: () => string,
): PendingCommandIdentity {
  return previous?.payloadFingerprint === payloadFingerprint
    ? previous
    : { payloadFingerprint, commandId: createCommandId() };
}
