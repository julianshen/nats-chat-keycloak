import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import type Keycloak from 'keycloak-js';
import type { UserInfo } from '../types';

interface AuthContextType {
  authenticated: boolean;
  token: string | null;
  userInfo: UserInfo | null;
  logout: () => void;
  loading: boolean;
  error: string | null;
}

const AuthContext = createContext<AuthContextType>({
  authenticated: false,
  token: null,
  userInfo: null,
  logout: () => {},
  loading: true,
  error: null,
});

export const useAuth = () => useContext(AuthContext);

const KEYCLOAK_URL = (window as any).__env__?.VITE_KEYCLOAK_URL || import.meta.env.VITE_KEYCLOAK_URL || 'http://localhost:8080';
const KEYCLOAK_REALM = (window as any).__env__?.VITE_KEYCLOAK_REALM || import.meta.env.VITE_KEYCLOAK_REALM || 'nats-chat';
const KEYCLOAK_CLIENT_ID = (window as any).__env__?.VITE_KEYCLOAK_CLIENT_ID || import.meta.env.VITE_KEYCLOAK_CLIENT_ID || 'nats-chat-app';

function patchBrokenURLSearchParams(): void {
  const NativeURLSearchParams = window.URLSearchParams;
  if (!NativeURLSearchParams) return;

  // Some headless engines serialize tuple input as "0=a,1&1=b,2", breaking OIDC query generation.
  const probe = new NativeURLSearchParams([['a', '1'], ['b', '2']] as any).toString();
  if (probe === 'a=1&b=2') return;

  function toQueryStringFromPairs(input: Iterable<[string, string]>): string {
    const parts: string[] = [];
    for (const [key, value] of input) {
      parts.push(`${encodeURIComponent(String(key))}=${encodeURIComponent(String(value))}`);
    }
    return parts.join('&');
  }

  const PatchedURLSearchParams = function (this: URLSearchParams, init?: any) {
    if (Array.isArray(init)) {
      return new NativeURLSearchParams(toQueryStringFromPairs(init as Iterable<[string, string]>));
    }
    if (
      init
      && typeof init !== 'string'
      && typeof init === 'object'
      && !(init instanceof NativeURLSearchParams)
      && typeof (init as any)[Symbol.iterator] === 'function'
    ) {
      return new NativeURLSearchParams(toQueryStringFromPairs(init as Iterable<[string, string]>));
    }
    return new NativeURLSearchParams(init as any);
  } as any;

  PatchedURLSearchParams.prototype = NativeURLSearchParams.prototype;
  (window as any).URLSearchParams = PatchedURLSearchParams;
}

function encodeQuery(pairs: Array<[string, string]>): string {
  return pairs
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

function repairTupleEncodedQuery(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  const repaired: Array<[string, string]> = [];
  let changed = false;

  for (const [key, value] of parsed.searchParams.entries()) {
    if (/^\d+$/.test(key)) {
      const comma = value.indexOf(',');
      if (comma > 0) {
        repaired.push([value.slice(0, comma), value.slice(comma + 1)]);
        changed = true;
        continue;
      }
    }
    repaired.push([key, value]);
  }

  if (!changed) return url;
  const query = encodeQuery(repaired);
  return `${parsed.origin}${parsed.pathname}${query ? `?${query}` : ''}${parsed.hash}`;
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [authenticated, setAuthenticated] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const keycloakRef = useRef<Keycloak | null>(null);
  const initRef = useRef(false);

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    patchBrokenURLSearchParams();
    void (async () => {
      try {
        const { default: KeycloakCtor } = await import('keycloak-js');
        const keycloak = new KeycloakCtor({
          url: KEYCLOAK_URL,
          realm: KEYCLOAK_REALM,
          clientId: KEYCLOAK_CLIENT_ID,
        });
        const originalCreateLoginUrl = keycloak.createLoginUrl.bind(keycloak);
        keycloak.createLoginUrl = async (options) => {
          const generated = await originalCreateLoginUrl(options);
          return repairTupleEncodedQuery(generated);
        };

        keycloakRef.current = keycloak;

        const auth = await keycloak.init({
          onLoad: 'login-required',
          checkLoginIframe: false,
          // PKCE requires Web Crypto API, only available in secure contexts (https or localhost)
          ...(window.crypto?.subtle ? { pkceMethod: 'S256' as const } : {}),
        });

        if (auth) {
          setAuthenticated(true);
          setToken(keycloak.token || null);

          // Extract user info from token
          const parsed = keycloak.tokenParsed as Record<string, any> | undefined;
          if (parsed) {
            const roles: string[] = parsed.realm_access?.roles || [];
            setUserInfo({
              username: parsed.preferred_username || 'unknown',
              email: parsed.email || '',
              roles: roles.filter(
                (r: string) => r !== 'default-roles-nats-chat' && r !== 'offline_access' && r !== 'uma_authorization'
              ),
            });
          }

          // Set up token refresh
          setInterval(() => {
            keycloak.updateToken(30).then((refreshed) => {
              if (refreshed && keycloak.token) {
                setToken(keycloak.token);
                console.log('[Auth] Token refreshed');
              }
            }).catch(() => {
              console.error('[Auth] Token refresh failed, logging out');
              keycloak.logout();
            });
          }, 30000); // Check every 30 seconds
        } else {
          setError('Authentication failed');
        }
        setLoading(false);
      } catch (err) {
        console.error('[Auth] Keycloak init error:', err);
        setError(`Failed to initialize authentication: ${err}`);
        setLoading(false);
      }
    })();
  }, []);

  const logout = useCallback(() => {
    keycloakRef.current?.logout({ redirectUri: window.location.origin });
  }, []);

  return (
    <AuthContext.Provider value={{ authenticated, token, userInfo, logout, loading, error }}>
      {children}
    </AuthContext.Provider>
  );
};
