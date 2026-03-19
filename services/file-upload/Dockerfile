FROM golang:1.26-alpine AS builder

WORKDIR /app

COPY services/file-upload/go.mod services/file-upload/go.sum ./
COPY pkg/otelhelper/ /pkg/otelhelper/
COPY pkg/mediatoken/ /pkg/mediatoken/
RUN go mod download

COPY services/file-upload/*.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /file-upload-service .

FROM alpine:3.19

RUN apk add --no-cache ca-certificates

COPY --from=builder /file-upload-service /file-upload-service

ENTRYPOINT ["/file-upload-service"]
