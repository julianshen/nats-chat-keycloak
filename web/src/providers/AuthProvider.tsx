import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import Keycloak from 'keycloak-js';
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

    const keycloak = new Keycloak({
      url: KEYCLOAK_URL,
      realm: KEYCLOAK_REALM,
      clientId: KEYCLOAK_CLIENT_ID,
    });

    keycloakRef.current = keycloak;

    keycloak.init({
      onLoad: 'login-required',
      checkLoginIframe: false,
      // PKCE requires Web Crypto API, only available in secure contexts (https or localhost)
      ...(window.crypto?.subtle ? { pkceMethod: 'S256' as const } : {}),
    }).then((auth) => {
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
    }).catch((err) => {
      console.error('[Auth] Keycloak init error:', err);
      setError(`Failed to initialize authentication: ${err}`);
      setLoading(false);
    });
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
