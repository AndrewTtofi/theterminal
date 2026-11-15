import { postTokenForm, type AccessToken, type TokenDeps } from "./token.js";

export const AZURE_SCOPE = "https://management.azure.com/.default";

export type AzurePrincipal = { tenantId: string; clientId: string; clientSecret: string };

/** Gets an access token for Azure Resource Manager with the service principal's secret (client credentials grant). */
export function fetchAzureToken(i: AzurePrincipal, deps: TokenDeps): Promise<AccessToken> {
  return postTokenForm(
    `https://login.microsoftonline.com/${encodeURIComponent(i.tenantId)}/oauth2/v2.0/token`,
    { grant_type: "client_credentials", client_id: i.clientId, client_secret: i.clientSecret, scope: AZURE_SCOPE },
    deps,
  );
}
