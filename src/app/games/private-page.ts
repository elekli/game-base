import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { requireOwner } from "@/shared/auth/require-owner";
import { AccessDeniedError } from "@/shared/auth/access-denied-error";
import { getPrivateDependencies } from "@/app/api/private/games/_private";
import type { OwnerIdentity } from "@/shared/auth/verify-access-token";

export async function requirePrivatePage(): Promise<OwnerIdentity> {
  try {
    return await requireOwner(await headers(), getPrivateDependencies().verifyAccessToken);
  } catch (error) {
    if (error instanceof AccessDeniedError) redirect("/security-error");
    throw error;
  }
}
