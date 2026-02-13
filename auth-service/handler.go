package main

import (
	"fmt"
	"log"
	"time"

	"github.com/nats-io/jwt/v2"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nkeys"
)

// AuthHandler processes NATS auth callout requests.
type AuthHandler struct {
	issuerKP   nkeys.KeyPair
	xkeyKP     nkeys.KeyPair
	validator  *KeycloakValidator
	issuerPub  string
}

// NewAuthHandler creates a new auth handler with the given config and validator.
func NewAuthHandler(cfg Config, validator *KeycloakValidator) (*AuthHandler, error) {
	// Parse the issuer account NKey from seed
	issuerKP, err := nkeys.FromSeed([]byte(cfg.IssuerSeed))
	if err != nil {
		return nil, fmt.Errorf("failed to parse issuer NKey seed: %w", err)
	}

	issuerPub, err := issuerKP.PublicKey()
	if err != nil {
		return nil, fmt.Errorf("failed to get issuer public key: %w", err)
	}

	// Parse the XKey from seed (for decryption)
	xkeyKP, err := nkeys.FromSeed([]byte(cfg.XKeySeed))
	if err != nil {
		return nil, fmt.Errorf("failed to parse XKey seed: %w", err)
	}

	log.Printf("Auth handler initialized with issuer: %s", issuerPub)

	return &AuthHandler{
		issuerKP:  issuerKP,
		xkeyKP:    xkeyKP,
		validator: validator,
		issuerPub: issuerPub,
	}, nil
}

// Handle processes a single auth callout request message.
func (h *AuthHandler) Handle(msg *nats.Msg) {
	// Step 1: Get the server's ephemeral XKey from message header and decrypt
	serverXKey := msg.Header.Get("Nats-Server-Xkey")
	requestData, err := h.decryptRequest(msg.Data, serverXKey)
	if err != nil {
		log.Printf("ERROR: Failed to decrypt request: %v", err)
		// Drop the message — causes timeout and client rejection
		return
	}

	// Step 2: Decode the authorization request claims
	reqClaims, err := jwt.DecodeAuthorizationRequestClaims(string(requestData))
	if err != nil {
		log.Printf("ERROR: Failed to decode auth request claims: %v", err)
		return
	}

	userNKey := reqClaims.UserNkey
	clientInfo := reqClaims.ClientInformation
	connectOpts := reqClaims.ConnectOptions
	serverID := reqClaims.Server.ID
	serverXKey = reqClaims.Server.XKey

	log.Printf("Auth request: client=%s host=%s user=%s has_token=%v",
		clientInfo.Name, clientInfo.Host, connectOpts.Username, connectOpts.Token != "")

	// Step 3: Extract the Keycloak token from connect options
	// The browser client sends the Keycloak access_token as the NATS "token"
	keycloakToken := connectOpts.Token
	if keycloakToken == "" {
		// Also check auth_token field
		keycloakToken = connectOpts.Token
	}

	if keycloakToken == "" {
		log.Printf("REJECT: No token provided by client %s from %s", clientInfo.Name, clientInfo.Host)
		// Drop — no token means unauthorized
		return
	}

	// Step 4: Validate the Keycloak JWT
	claims, err := h.validator.ValidateToken(keycloakToken)
	if err != nil {
		log.Printf("REJECT: Invalid Keycloak token for client %s: %v", clientInfo.Name, err)
		return
	}

	log.Printf("VALIDATED: user=%s roles=%v", claims.PreferredUsername, claims.RealmRoles)

	// Step 5: Map Keycloak claims to NATS permissions
	perms := mapPermissions(claims.RealmRoles)

	// Step 6: Build the NATS user claims JWT
	// Audience = target account name (non-operator mode uses account names, not public keys)
	userClaims := jwt.NewUserClaims(userNKey)
	userClaims.Name = claims.PreferredUsername
	userClaims.Audience = issuerAccountID()
	userClaims.BearerToken = true

	// Set permissions
	userClaims.Permissions = perms

	// Set expiration: min(keycloak exp, now + 1 hour)
	maxExp := time.Now().Add(1 * time.Hour).Unix()
	if claims.ExpiresAt > 0 && claims.ExpiresAt < maxExp {
		userClaims.Expires = claims.ExpiresAt
	} else {
		userClaims.Expires = maxExp
	}

	// Step 7: Encode and sign the user claims
	userJWT, err := userClaims.Encode(h.issuerKP)
	if err != nil {
		log.Printf("ERROR: Failed to encode user claims: %v", err)
		return
	}

	// Step 8: Build the authorization response
	response := jwt.NewAuthorizationResponseClaims(userNKey)
	response.Audience = serverID
	response.Jwt = userJWT

	responseJWT, err := response.Encode(h.issuerKP)
	if err != nil {
		log.Printf("ERROR: Failed to encode auth response: %v", err)
		return
	}

	// Step 9: Encrypt the response if the server provided an XKey
	responseData := []byte(responseJWT)
	if serverXKey != "" {
		encrypted, err := h.encryptResponse(responseJWT, serverXKey)
		if err != nil {
			log.Printf("ERROR: Failed to encrypt response: %v", err)
			return
		}
		responseData = encrypted
	}

	// Step 10: Publish the response
	if err := msg.Respond(responseData); err != nil {
		log.Printf("ERROR: Failed to send auth response: %v", err)
		return
	}

	log.Printf("AUTHORIZED: user=%s nkey=%s roles=%v", claims.PreferredUsername, userNKey[:16]+"...", claims.RealmRoles)
}

// decryptRequest decrypts the auth callout request payload using XKey.
func (h *AuthHandler) decryptRequest(data []byte, serverXKey string) ([]byte, error) {
	// Check if the data looks like it could be a JWT (starts with "ey" base64)
	if len(data) > 2 && data[0] == 'e' && data[1] == 'y' {
		return data, nil
	}

	// Decrypt using our xkey and the server's ephemeral xkey as sender
	decrypted, err := h.xkeyKP.Open(data, serverXKey)
	if err != nil {
		return nil, fmt.Errorf("xkey decryption failed (serverXKey=%s): %w", serverXKey, err)
	}

	return decrypted, nil
}

// encryptResponse encrypts the auth response JWT using the server's one-time XKey.
func (h *AuthHandler) encryptResponse(responseJWT string, serverXKey string) ([]byte, error) {
	encrypted, err := h.xkeyKP.Seal([]byte(responseJWT), serverXKey)
	if err != nil {
		return nil, fmt.Errorf("failed to encrypt response: %w", err)
	}
	return encrypted, nil
}

// issuerAccountID returns a stable audience identifier.
func issuerAccountID() string {
	return "CHAT"
}
