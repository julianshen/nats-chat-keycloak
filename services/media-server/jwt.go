package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

var b64 = base64.RawURLEncoding

const jwtHeader = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9` // {"alg":"HS256","typ":"JWT"}

// TokenClaims represents the JWT claims for media access tokens.
type TokenClaims struct {
	Action      string `json:"act"`            // "upload" or "download"
	FileID      string `json:"fid"`            // target file ID
	Room        string `json:"room"`           // room the file belongs to
	Username    string `json:"sub"`            // user who requested access
	Filename    string `json:"name,omitempty"` // original filename (for download Content-Disposition)
	ContentType string `json:"ct,omitempty"`   // MIME type (for download Content-Type)
	Exp         int64  `json:"exp"`            // expiry (unix seconds)
}

// SignJWT creates an HS256-signed JWT from claims.
func SignJWT(secret []byte, claims TokenClaims) (string, error) {
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", fmt.Errorf("marshal claims: %w", err)
	}
	payloadEnc := b64.EncodeToString(payload)
	sigInput := jwtHeader + "." + payloadEnc

	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(sigInput))
	sig := b64.EncodeToString(mac.Sum(nil))

	return sigInput + "." + sig, nil
}

// VerifyJWT parses and verifies an HS256-signed JWT, returning its claims.
func VerifyJWT(secret []byte, token string) (*TokenClaims, error) {
	parts := strings.SplitN(token, ".", 3)
	if len(parts) != 3 {
		return nil, fmt.Errorf("malformed JWT: expected 3 parts")
	}

	// Verify signature
	sigInput := parts[0] + "." + parts[1]
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(sigInput))
	expectedSig := b64.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(parts[2]), []byte(expectedSig)) {
		return nil, fmt.Errorf("invalid signature")
	}

	// Decode payload
	payload, err := b64.DecodeString(parts[1])
	if err != nil {
		return nil, fmt.Errorf("decode payload: %w", err)
	}

	var claims TokenClaims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return nil, fmt.Errorf("unmarshal claims: %w", err)
	}
	if time.Now().Unix() > claims.Exp {
		return nil, fmt.Errorf("token expired")
	}
	return &claims, nil
}
