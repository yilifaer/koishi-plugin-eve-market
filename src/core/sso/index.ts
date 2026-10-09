// core/sso 对外的接口：EVE SSO v2 的协议部分（oauth.ts）和服务角色的授权档案（auth.ts）。

export { AUTH_TEXT, ESSENTIAL_SCOPES, createAuthService } from './auth'
export type { AuthServiceOptions, ManagedAuthService } from './auth'
export {
  REVOKE_ROUTE,
  SsoClient,
  SsoError,
  TOKEN_ROUTE,
  basicAuth,
  characterIdOf,
  checkAccessToken,
  decodeJwt,
  isSsoError,
  missingScopes,
  normalizeScopes,
} from './oauth'
export type { AccessClaims, CheckOptions, SsoClientOptions, SsoErrorKind, TokenSet } from './oauth'
export { AuthStates } from './states'
