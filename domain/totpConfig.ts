import type { HostTotpConfig } from "./models";
import { isEncryptedCredentialPlaceholder } from "./credentials";

/** Connection payload for a host TOTP secret. Device-bound ciphertext is omitted. */
export function connectionTotpFromHost(
  host: { totp?: HostTotpConfig } | null | undefined,
): HostTotpConfig | undefined {
  const totp = host?.totp;
  const uri = totp?.uri?.trim();
  if (!uri || isEncryptedCredentialPlaceholder(uri)) return undefined;
  const promptPattern = totp?.promptPattern?.trim();
  return {
    uri,
    autoSubmit: totp?.autoSubmit !== false,
    ...(promptPattern ? { promptPattern } : {}),
  };
}

export function connectionTotpFields(
  host: { totp?: HostTotpConfig } | null | undefined,
): { totp?: HostTotpConfig } {
  const totp = connectionTotpFromHost(host);
  return totp ? { totp } : {};
}
