export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getRuntimeConfig } = await import("@/shared/config/get-runtime-config");
    getRuntimeConfig();
  }
}

