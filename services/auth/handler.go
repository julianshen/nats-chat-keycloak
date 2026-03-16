package main

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	otelhelper "github.com/example/nats-chat-otelhelper"
	"github.com/nats-io/jwt/v2"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nkeys"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

// AuthHandler processes NATS auth callout requests.
type AuthHandler struct {
	issuerKP        nkeys.KeyPair
	xkeyKP          nkeys.KeyPair
	validator       *KeycloakValidator
	serviceAccounts *ServiceAccountCache
	issuerPub       string
	authCounter     metric.Int64Counter
	authDuration    metric.Float64Histogram
}

// NewAuthHandler creates a new auth handler with the given config and validator.
func NewAuthHandler(cfg Config, validator *KeycloakValidator, serviceAccounts *ServiceAccountCache, meter metric.Meter) (*AuthHandler, error) {
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

	authCounter, _ := meter.Int64Counter("auth_requests_total")
	authDuration, _ := meter.Float64Histogram("auth_request_duration_seconds")

	slog.Info("Auth handler initialized", "issuer", issuerPub)

	return &AuthHandler{
		issuerKP:        issuerKP,
		xkeyKP:          xkeyKP,
		validator:       validator,
		serviceAccounts: serviceAccounts,
		issuerPub:       issuerPub,
		authCounter:     authCounter,
		authDuration:    authDuration,
	}, nil
}

// Handle processes a single auth callout request message.
func (h *AuthHandler) Handle(msg *nats.Msg) {
	_ = h.HandleWithContext(context.Background(), msg)
}

// HandleWithContext processes a single auth callout request message with cancellation support.
func (h *AuthHandler) HandleWithContext(ctx context.Context, msg *nats.Msg) error {
	start := time.Now()
	ctx, span := otelhelper.StartServerSpan(ctx, msg, "auth callout")
	defer span.End()
	defer func() {
		h.authDuration.Record(ctx, time.Since(start).Seconds())
	}()
	if err := ctx.Err(); err != nil {
		return err
	}

	// Step 1: Get the server's ephemeral XKey from message header and decrypt
	serverXKey := msg.Header.Get("Nats-Server-Xkey")
	requestData, err := h.decryptRequest(msg.Data, serverXKey)
	if err != nil {
		slog.ErrorContext(ctx, "Failed to decrypt request", "error", err)
		span.RecordError(err)
		span.SetAttributes(attribute.String("auth.result", "decrypt_error"))
		h.authCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("result", "error")))
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	// Step 2: Decode the authorization request claims
	reqClaims, err := jwt.DecodeAuthorizationRequestClaims(string(requestData))
	if err != nil {
		slog.ErrorContext(ctx, "Failed to decode auth request claims", "error", err)
		span.RecordError(err)
		span.SetAttributes(attribute.String("auth.result", "decode_error"))
		h.authCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("result", "error")))
		return err
	}

	userNKey := reqClaims.UserNkey
	clientInfo := reqClaims.ClientInformation
	connectOpts := reqClaims.ConnectOptions
	serverID := reqClaims.Server.ID
	serverXKey = reqClaims.Server.XKey

	slog.InfoContext(ctx, "Auth request",
		"client", clientInfo.Name,
		"host", clientInfo.Host,
		"user", connectOpts.Username,
		"has_token", connectOpts.Token != "",
	)

	// Step 3: Determine auth type and authenticate
	var username string
	var perms jwt.Permissions
	var expiry int64

	if connectOpts.Token != "" {
		if err := ctx.Err(); err != nil {
			return err
		}
		// Browser auth: validate Keycloak JWT
		claims, err := h.validator.ValidateToken(connectOpts.Token)
		if err != nil {
			slog.WarnContext(ctx, "Invalid Keycloak token", "client", clientInfo.Name, "error", err)
			span.RecordError(err)
			span.SetAttributes(attribute.String("auth.result", "rejected"))
			h.authCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("result", "rejected")))
			return nil
		}

		username = claims.PreferredUsername
		perms = mapPermissions(claims.RealmRoles, username)
		maxExp := time.Now().Add(1 * time.Hour).Unix()
		if claims.ExpiresAt > 0 && claims.ExpiresAt < maxExp {
			expiry = claims.ExpiresAt
		} else {
			expiry = maxExp
		}
		span.SetAttributes(attribute.String("auth.type", "browser"))
		slog.InfoContext(ctx, "Token validated", "user", username, "roles", claims.RealmRoles)

	} else if connectOpts.Username != "" && connectOpts.Password != "" {
		// Service account auth: check against DB-backed cache
		if !h.serviceAccounts.Authenticate(connectOpts.Username, connectOpts.Password) {
			slog.WarnContext(ctx, "Invalid service credentials", "username", connectOpts.Username, "host", clientInfo.Host)
			span.SetAttributes(attribute.String("auth.result", "rejected"))
			h.authCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("result", "rejected")))
			return nil
		}

		username = connectOpts.Username
		perms = servicePermissions()
		expiry = time.Now().Add(24 * time.Hour).Unix()
		span.SetAttributes(attribute.String("auth.type", "service"))
		slog.InfoContext(ctx, "Service account authenticated", "username", username)

	} else {
		slog.WarnContext(ctx, "No valid credentials", "client", clientInfo.Name, "host", clientInfo.Host)
		span.SetAttributes(attribute.String("auth.result", "rejected"))
		h.authCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("result", "rejected")))
		return nil
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	span.SetAttributes(attribute.String("auth.user", username))

	// Step 4: Build the NATS user claims JWT
	userClaims := jwt.NewUserClaims(userNKey)
	userClaims.Name = username
	userClaims.Audience = issuerAccountID()
	userClaims.BearerToken = true
	userClaims.Permissions = perms
	userClaims.Expires = expiry

	// Step 5: Encode and sign the user claims
	userJWT, err := userClaims.Encode(h.issuerKP)
	if err != nil {
		slog.ErrorContext(ctx, "Failed to encode user claims", "error", err)
		span.RecordError(err)
		h.authCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("result", "error")))
		return err
	}

	// Step 6: Build the authorization response
	response := jwt.NewAuthorizationResponseClaims(userNKey)
	response.Audience = serverID
	response.Jwt = userJWT

	responseJWT, err := response.Encode(h.issuerKP)
	if err != nil {
		slog.ErrorContext(ctx, "Failed to encode auth response", "error", err)
		span.RecordError(err)
		h.authCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("result", "error")))
		return err
	}

	// Step 7: Encrypt the response if the server provided an XKey
	responseData := []byte(responseJWT)
	if serverXKey != "" {
		encrypted, err := h.encryptResponse(responseJWT, serverXKey)
		if err != nil {
			slog.ErrorContext(ctx, "Failed to encrypt response", "error", err)
			span.RecordError(err)
			h.authCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("result", "error")))
			return err
		}
		responseData = encrypted
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	// Step 8: Publish the response
	if err := msg.Respond(responseData); err != nil {
		slog.ErrorContext(ctx, "Failed to send auth response", "error", err)
		span.RecordError(err)
		h.authCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("result", "error")))
		return err
	}

	span.SetAttributes(attribute.String("auth.result", "authorized"))
	h.authCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("result", "authorized")))
	slog.InfoContext(ctx, "Authorized", "user", username, "nkey", userNKey[:16]+"...")
	return nil
}

// decryptRequest decrypts the auth callout request payload using XKey.
func (h *AuthHandler) decryptRequest(data []byte, serverXKey string) ([]byte, error) {
	if len(data) > 2 && data[0] == 'e' && data[1] == 'y' {
		return data, nil
	}

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

// RespondAuthError sends an explicit auth error response for early rejection paths.
func (h *AuthHandler) RespondAuthError(msg *nats.Msg, reason string) error {
	ctx := context.Background()

	serverXKey := msg.Header.Get("Nats-Server-Xkey")
	requestData, err := h.decryptRequest(msg.Data, serverXKey)
	if err != nil {
		return fmt.Errorf("decrypt auth request: %w", err)
	}

	reqClaims, err := jwt.DecodeAuthorizationRequestClaims(string(requestData))
	if err != nil {
		return fmt.Errorf("decode auth request claims: %w", err)
	}

	response := jwt.NewAuthorizationResponseClaims(reqClaims.UserNkey)
	response.Audience = reqClaims.Server.ID
	response.Error = reason

	responseJWT, err := response.Encode(h.issuerKP)
	if err != nil {
		return fmt.Errorf("encode auth error response: %w", err)
	}

	responseData := []byte(responseJWT)
	if reqClaims.Server.XKey != "" {
		encrypted, err := h.encryptResponse(responseJWT, reqClaims.Server.XKey)
		if err != nil {
			return fmt.Errorf("encrypt auth error response: %w", err)
		}
		responseData = encrypted
	}

	if err := msg.Respond(responseData); err != nil {
		return fmt.Errorf("send auth error response: %w", err)
	}

	h.authCounter.Add(ctx, 1, metric.WithAttributes(attribute.String("result", "error_response")))
	return nil
}
