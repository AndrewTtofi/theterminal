/**
 * The only variables a cloud grant may add to a run's environment. This module has no imports, so the child-env
 * builder can use the list without loading any cloud SDK.
 */
export const CLOUD_ENV_ALLOWLIST: readonly string[] = [
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REGION", "AWS_DEFAULT_REGION",
  "CLOUDSDK_AUTH_ACCESS_TOKEN", "GOOGLE_OAUTH_ACCESS_TOKEN", "CLOUDSDK_CORE_PROJECT", "GOOGLE_CLOUD_PROJECT",
  "AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET", "AZURE_SUBSCRIPTION_ID",
  "ARM_TENANT_ID", "ARM_CLIENT_ID", "ARM_CLIENT_SECRET", "ARM_SUBSCRIPTION_ID",
];
