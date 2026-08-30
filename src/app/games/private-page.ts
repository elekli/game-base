import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { requireOwner } from "@/shared/auth/require-owner";
import { AccessDeniedError } from "@/shared/auth/access-denied-error";
import { getPrivateDependencies } from "@/app/api/private/games/_private";

export async function requirePrivatePage(): Promise<void> {
  try {
    await requireOwner(await headers(), getPrivateDependencies().verifyAccessToken);
  } catch (error) {
    if (error instanceof AccessDeniedError) redirect("/security-error");
    throw error;
  }
}
