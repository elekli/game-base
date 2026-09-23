type HostedEnvironment = "preview" | "production";

type DeploymentBinding = Readonly<{
  databaseName: string;
  projectRef: string;
  publishableKeySha256: string;
  releaseSmokeCommonNameSha256: string | null;
  releaseSmokeMaxTokenLifetimeSeconds: number | null;
  secretKeySha256: string;
  supavisorHost: string;
  supavisorPort: number;
  supavisorUsername: string;
  supabaseHostname: string;
}>;

export const deploymentBindings: Readonly<
  Record<HostedEnvironment, DeploymentBinding>
> = {
  preview: {
    databaseName: "postgres",
    projectRef: "preview-ref",
    publishableKeySha256:
      "1cf7456a819215322abda0c18be773ade69383230f0071efba7089745f9c9119",
    releaseSmokeCommonNameSha256: null,
    releaseSmokeMaxTokenLifetimeSeconds: null,
    secretKeySha256:
      "4c9635f5dc677bbe6086938c54520c7f7d086852f08a444b4077f8d3a3c80f27",
    supavisorHost: "aws-0-us-east-1.pooler.supabase.com",
    supavisorPort: 6543,
    supavisorUsername: "app_runtime.preview-ref",
    supabaseHostname: "preview-ref.supabase.co",
  },
  production: {
    databaseName: "postgres",
    projectRef: "wbtyuvufhrhybquzwfip",
    publishableKeySha256:
      "4462e410b46df06f21744e9cafcfc75e7eb8975cab8629ce6360be06d08fe557",
    releaseSmokeCommonNameSha256:
      "2cf7b6cc4252a67e02f67bff493cf60aeac98e6436876aff29d74280b874c6b2",
    releaseSmokeMaxTokenLifetimeSeconds: 31_536_000,
    secretKeySha256:
      "902073529a30595a4532129356f6b42a3eff7bf0227e2818280fb0f87f22fdf9",
    supavisorHost: "aws-0-ap-south-1.pooler.supabase.com",
    supavisorPort: 6543,
    supavisorUsername: "app_runtime.wbtyuvufhrhybquzwfip",
    supabaseHostname: "wbtyuvufhrhybquzwfip.supabase.co",
  },
};
