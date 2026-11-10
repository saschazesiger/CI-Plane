# syntax=docker/dockerfile:1
FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/ci-plane ./cmd/ci-plane

FROM alpine:3.22 AS cloudflared
ARG CLOUDFLARED_VERSION=2026.10.7
ARG CLOUDFLARED_SHA256=1f99fb518b83dec2ba8d870a7cc991d82a77e6196295a3d2754ba17ab9f91872
ADD https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64 /cloudflared
RUN echo "${CLOUDFLARED_SHA256}  /cloudflared" | sha256sum -c - && chmod 0755 /cloudflared

FROM alpine:3.22
RUN apk add --no-cache ca-certificates tzdata && adduser -D -u 10001 ciplane && mkdir /data && chown ciplane /data
COPY --from=cloudflared /cloudflared /usr/local/bin/cloudflared
COPY --from=build /out/ci-plane /usr/local/bin/ci-plane
USER ciplane
ENV CI_PLANE_DATA=/data
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["ci-plane"]
