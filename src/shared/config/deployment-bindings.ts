type HostedEnvironment = "preview" | "production";

type DeploymentBinding = Readonly<{
  projectRef: string;
  publishableKeySha256: string;
  secretKeySha256: string;
  supavisorHost: string;
  supavisorUsername: string;
}>;

export const deploymentBindings: Readonly<
  Record<HostedEnvironment, DeploymentBinding>
> = {
  preview: {
    projectRef: "preview-ref",
    publishableKeySha256:
      "1cf7456a819215322abda0c18be773ade69383230f0071efba7089745f9c9119",
    secretKeySha256:
      "4c9635f5dc677bbe6086938c54520c7f7d086852f08a444b4077f8d3a3c80f27",
    supavisorHost: "aws-0-us-east-1.pooler.supabase.com",
    supavisorUsername: "app_runtime.preview-ref",
  },
  production: {
    projectRef: "production-ref",
    publishableKeySha256:
      "852a8617288e4a30f87c03004d9046b4ab736f3b916533f6117be570f364f5b2",
    secretKeySha256:
      "716e8f38289a86fe6d30e068c627bb9ae60a3a949d9f5282c87b58022f8db461",
    supavisorHost: "production.pooler.supabase.com",
    supavisorUsername: "app_runtime.production-ref",
  },
};
