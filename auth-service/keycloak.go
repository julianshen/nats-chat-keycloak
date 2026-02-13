package main

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/MicahParks/keyfunc/v2"
	"github.com/golang-jwt/jwt/v5"
)

// KeycloakClaims represents the relevant claims from a Keycloak access token.
type KeycloakClaims struct {
	PreferredUsername string   `json:"preferred_username"`
	Email            string   `json:"email"`
	RealmRoles       []string `json:"-"` // extracted from realm_access
	ExpiresAt        int64    `json:"-"`
}

// RealmAccess is the nested structure in Keycloak tokens.
type RealmAccess struct {
	Roles []string `json:"roles"`
}

// keycloakTokenClaims extends jwt.RegisteredClaims with Keycloak-specific fields.
type keycloakTokenClaims struct {
	jwt.RegisteredClaims
	PreferredUsername string      `json:"preferred_username"`
	Email             string      `json:"email"`
	EmailVerified     bool        `json:"email_verified"`
	RealmAccessField  RealmAccess `json:"realm_access"`
	Scope             string      `json:"scope"`
	Azp               string      `json:"azp"`
}

// KeycloakValidator validates Keycloak JWTs using JWKS.
type KeycloakValidator struct {
	jwks      *keyfunc.JWKS
	issuerURL string
}

// NewKeycloakValidator creates a new validator that fetches and caches JWKS keys.
// If issuerOverride is non-empty, it is used as the expected token issuer instead
// of deriving it from keycloakURL (needed when the browser-facing URL differs from
// the internal Docker service URL).
func NewKeycloakValidator(keycloakURL, realm, issuerOverride string) (*KeycloakValidator, error) {
	jwksURL := fmt.Sprintf("%s/realms/%s/protocol/openid-connect/certs", keycloakURL, realm)
	issuerURL := fmt.Sprintf("%s/realms/%s", keycloakURL, realm)
	if issuerOverride != "" {
		issuerURL = issuerOverride
	}

	slog.Info("Initializing Keycloak JWKS validator", "jwks_url", jwksURL)

	// Try to fetch JWKS with retries (Keycloak may still be starting)
	var jwks *keyfunc.JWKS
	var err error
	for attempt := 1; attempt <= 30; attempt++ {
		jwks, err = keyfunc.Get(jwksURL, keyfunc.Options{
			Ctx:                 context.Background(),
			RefreshInterval:     5 * time.Minute,
			RefreshRateLimit:    1 * time.Minute,
			RefreshUnknownKID:   true,
			RefreshErrorHandler: func(err error) { slog.Error("JWKS refresh error", "error", err) },
		})
		if err == nil {
			break
		}
		slog.Info("Waiting for Keycloak JWKS", "attempt", attempt, "error", err)
		time.Sleep(2 * time.Second)
	}
	if err != nil {
		return nil, fmt.Errorf("failed to fetch Keycloak JWKS after retries: %w", err)
	}

	slog.Info("Keycloak JWKS loaded successfully", "jwks_url", jwksURL)

	return &KeycloakValidator{
		jwks:      jwks,
		issuerURL: issuerURL,
	}, nil
}

// ValidateToken parses and validates a Keycloak access token JWT.
func (v *KeycloakValidator) ValidateToken(tokenString string) (*KeycloakClaims, error) {
	claims := &keycloakTokenClaims{}

	token, err := jwt.ParseWithClaims(tokenString, claims, v.jwks.Keyfunc,
		jwt.WithIssuer(v.issuerURL),
		jwt.WithExpirationRequired(),
	)
	if err != nil {
		return nil, fmt.Errorf("token validation failed: %w", err)
	}

	if !token.Valid {
		return nil, fmt.Errorf("token is not valid")
	}

	// Extract expiration
	var expiresAt int64
	if claims.ExpiresAt != nil {
		expiresAt = claims.ExpiresAt.Unix()
	}

	return &KeycloakClaims{
		PreferredUsername: claims.PreferredUsername,
		Email:            claims.Email,
		RealmRoles:       claims.RealmAccessField.Roles,
		ExpiresAt:        expiresAt,
	}, nil
}

// Close shuts down the JWKS background goroutine.
func (v *KeycloakValidator) Close() {
	v.jwks.EndBackground()
}
