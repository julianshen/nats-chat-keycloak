FROM golang:1.26-alpine AS builder

WORKDIR /app

COPY services/user-search/go.mod services/user-search/go.sum ./
COPY pkg/otelhelper/ /pkg/otelhelper/
RUN go mod download

COPY services/user-search/*.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /user-search-service .

FROM alpine:3.19

RUN apk add --no-cache ca-certificates

COPY --from=builder /user-search-service /user-search-service

ENTRYPOINT ["/user-search-service"]
