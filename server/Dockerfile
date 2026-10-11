# Fix My Linux backend. Build from this directory: docker build -t fml-api .
FROM golang:1.26-bookworm AS build
WORKDIR /src
# The repo's go.work also lists the desktop helper; the server builds alone.
ENV GOWORK=off CGO_ENABLED=0 GOFLAGS=-trimpath
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -ldflags="-s -w" -o /out/api ./cmd/api

# Static binary on distroless: CA certificates and tzdata, no shell, non-root.
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/api /api
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/api"]
