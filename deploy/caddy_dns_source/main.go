// The complete reviewed plugin set for the managed DNS Caddy distribution.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"runtime/debug"
	"time"

	_ "github.com/caddy-dns/alidns"
	_ "github.com/caddy-dns/cloudflare"
	_ "github.com/caddy-dns/digitalocean"
	_ "github.com/caddy-dns/huaweicloud"
	_ "github.com/caddy-dns/route53"
	_ "github.com/caddy-dns/tencentcloud"
	"github.com/caddyserver/caddy/v2"
	caddycmd "github.com/caddyserver/caddy/v2/cmd"
	_ "github.com/caddyserver/caddy/v2/modules/standard"
)

var providerVersions = map[string]string{
	"alidns":       "v1.0.29",
	"cloudflare":   "v0.2.4",
	"digitalocean": "v0.0.0-20250606074528-04bde2867106",
	"huaweicloud":  "v1.0.1",
	"route53":      "v1.6.2",
	"tencentcloud": "v0.4.3",
}

func checkBuild(info *debug.BuildInfo) error {
	if info.GoVersion != "go1.26.10" {
		return fmt.Errorf("unexpected Go toolchain")
	}
	versions := map[string]string{}
	for _, dependency := range info.Deps {
		version := dependency.Version
		if dependency.Replace != nil {
			if dependency.Replace.Path != dependency.Path {
				return fmt.Errorf("unexpected module replacement")
			}
			version = dependency.Replace.Version
		}
		versions[dependency.Path] = version
	}
	if versions["github.com/caddyserver/caddy/v2"] != "v2.11.7" {
		return fmt.Errorf("unexpected Caddy version")
	}
	for name, version := range providerVersions {
		if _, err := caddy.GetModule("dns.providers." + name); err != nil {
			return fmt.Errorf("missing DNS provider %s", name)
		}
		if versions["github.com/caddy-dns/"+name] != version {
			return fmt.Errorf("unexpected DNS provider version for %s", name)
		}
	}
	return nil
}

// The pinned AliDNS library discovers domain metadata using context.Background
// and http.DefaultClient. Bound that provider endpoint without changing other
// destinations or the caller's earlier cancellation/deadline.
type alidnsDeadlineTransport struct{ next http.RoundTripper }

type cancelOnClose struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (body cancelOnClose) Close() error {
	defer body.cancel()
	return body.ReadCloser.Close()
}

func (transport alidnsDeadlineTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if request.URL.Scheme != "https" || request.URL.Hostname() != "alidns.aliyuncs.com" {
		return transport.next.RoundTrip(request)
	}
	ctx, cancel := context.WithTimeout(request.Context(), 30*time.Second)
	response, err := transport.next.RoundTrip(request.Clone(ctx))
	if err != nil {
		cancel()
		return response, err
	}
	response.Body = cancelOnClose{response.Body, cancel}
	return response, nil
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "harness-dns-build-check" {
		info, ok := debug.ReadBuildInfo()
		if !ok || checkBuild(info) != nil {
			os.Exit(1)
		}
		if err := json.NewEncoder(os.Stdout).Encode(map[string]any{
			"goVersion": "go1.26.10", "caddyVersion": "v2.11.7", "providers": providerVersions,
		}); err != nil {
			os.Exit(1)
		}
		return
	}
	transport := http.DefaultClient.Transport
	if transport == nil {
		transport = http.DefaultTransport
	}
	http.DefaultClient.Transport = alidnsDeadlineTransport{transport}
	caddycmd.Main()
}
