FROM golang:1.22-alpine AS builder

WORKDIR /app

COPY user-search-service/go.mod user-search-service/go.sum ./
COPY pkg/otelhelper/ /pkg/otelhelper/
RUN go mod download

COPY user-search-service/*.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /user-search-service .

FROM alpine:3.19

RUN apk add --no-cache ca-certificates

COPY --from=builder /user-search-service /user-search-service

ENTRYPOINT ["/user-search-service"]
