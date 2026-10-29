package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"runtime/debug"
	"strings"
	"testing"
	"time"

	"github.com/caddyserver/caddy/v2"
	"github.com/caddyserver/caddy/v2/caddyconfig/caddyfile"
)

func pinnedBuildInfo() *debug.BuildInfo {
	info := &debug.BuildInfo{GoVersion: "go1.26.10", Deps: []*debug.Module{{Path: "github.com/caddyserver/caddy/v2", Version: "v2.11.7"}}}
	for name, version := range providerVersions {
		info.Deps = append(info.Deps, &debug.Module{Path: "github.com/caddy-dns/" + name, Version: version})
	}
	return info
}

func TestBuildPinsRejectMissingChangedOrReplacedDependency(t *testing.T) {
	if err := checkBuild(pinnedBuildInfo()); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"toolchain", "caddy", "missing-provider", "changed-provider", "replaced-provider"} {
		t.Run(kind, func(t *testing.T) {
			info := pinnedBuildInfo()
			switch kind {
			case "toolchain":
				info.GoVersion = "go1.26.11"
			case "caddy":
				info.Deps[0].Version = "v2.11.6"
			default:
				for index, dependency := range info.Deps {
					if dependency.Path != "github.com/caddy-dns/tencentcloud" {
						continue
					}
					switch kind {
					case "missing-provider":
						info.Deps = append(info.Deps[:index], info.Deps[index+1:]...)
					case "changed-provider":
						dependency.Version = "v0.4.2"
					case "replaced-provider":
						dependency.Replace = &debug.Module{Path: "example.invalid/unreviewed-provider", Version: dependency.Version}
					}
					break
				}
			}
			if err := checkBuild(info); err == nil {
				t.Fatal("unreviewed dependency was accepted")
			}
		})
	}
}

func TestProviderCaddyfileFields(t *testing.T) {
	fields := map[string]string{
		"alidns":       "access_key_id fixture-id\naccess_key_secret fixture-secret",
		"cloudflare":   "api_token fixture-token",
		"digitalocean": "api_token fixture-token",
		"huaweicloud":  "access_key_id fixture-id\nsecret_access_key fixture-secret",
		"route53":      "access_key_id fixture-id\nsecret_access_key fixture-secret\nregion us-east-1",
		"tencentcloud": "secret_id fixture-id\nsecret_key fixture-secret",
	}
	if len(fields) != len(providerVersions) {
		t.Fatal("provider parser coverage differs from the pinned build")
	}
	for name, body := range fields {
		t.Run(name, func(t *testing.T) {
			module, err := caddy.GetModule("dns.providers." + name)
			if err != nil {
				t.Fatal(err)
			}
			parser, ok := module.New().(caddyfile.Unmarshaler)
			if !ok {
				t.Fatal("DNS provider has no Caddyfile parser")
			}
			if err := parser.UnmarshalCaddyfile(caddyfile.NewTestDispenser(name + " {\n" + body + "\n}")); err != nil {
				t.Fatal(err)
			}
		})
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

func response() *http.Response {
	return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("safe response"))}
}

func TestAliDNSDeadlineAndBodyLifetime(t *testing.T) {
	request, _ := http.NewRequest(http.MethodPost, "https://alidns.aliyuncs.com/", nil)
	var observed context.Context
	before := time.Now()
	transport := alidnsDeadlineTransport{roundTripFunc(func(actual *http.Request) (*http.Response, error) {
		observed = actual.Context()
		deadline, exists := observed.Deadline()
		after := time.Now()
		if !exists || deadline.Before(before.Add(30*time.Second)) || deadline.After(after.Add(30*time.Second)) {
			t.Fatal("AliDNS request did not receive the bounded deadline")
		}
		return response(), nil
	})}
	result, err := transport.RoundTrip(request)
	if err != nil || observed.Err() != nil {
		t.Fatal("request was cancelled before the response body could be read")
	}
	if data, err := io.ReadAll(result.Body); err != nil || string(data) != "safe response" {
		t.Fatal("response body was unavailable")
	}
	if err := result.Body.Close(); err != nil || observed.Err() != context.Canceled {
		t.Fatal("body close did not cancel the timer context")
	}
	if request.Context().Err() != nil {
		t.Fatal("wrapper changed the original request context")
	}
}

func TestOtherDestinationsAreUnchanged(t *testing.T) {
	for _, address := range []string{"https://example.invalid/", "http://alidns.aliyuncs.com/", "https://alidns.aliyuncs.com.example.invalid/"} {
		t.Run(address, func(t *testing.T) {
			request, _ := http.NewRequest(http.MethodGet, address, nil)
			transport := alidnsDeadlineTransport{roundTripFunc(func(actual *http.Request) (*http.Response, error) {
				if actual != request {
					t.Fatal("unrelated HTTP destination was modified")
				}
				return response(), nil
			})}
			result, err := transport.RoundTrip(request)
			if err != nil {
				t.Fatal(err)
			}
			result.Body.Close()
		})
	}
}

func TestEarlierParentDeadlineAndCancellationSurvive(t *testing.T) {
	parent, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	request, _ := http.NewRequestWithContext(parent, http.MethodPost, "https://alidns.aliyuncs.com:443/", nil)
	var observed context.Context
	transport := alidnsDeadlineTransport{roundTripFunc(func(actual *http.Request) (*http.Response, error) {
		observed = actual.Context()
		parentDeadline, _ := parent.Deadline()
		deadline, exists := observed.Deadline()
		if !exists || !deadline.Equal(parentDeadline) {
			t.Fatal("wrapper extended the parent's earlier deadline")
		}
		return response(), nil
	})}
	result, err := transport.RoundTrip(request)
	if err != nil {
		t.Fatal(err)
	}
	defer result.Body.Close()
	cancel()
	if observed.Err() != context.Canceled {
		t.Fatal("parent cancellation did not reach the request")
	}
}

func TestTransportFailureCancelsTimer(t *testing.T) {
	request, _ := http.NewRequest(http.MethodPost, "https://alidns.aliyuncs.com/", nil)
	failure := errors.New("fixture transport failure")
	var observed context.Context
	transport := alidnsDeadlineTransport{roundTripFunc(func(actual *http.Request) (*http.Response, error) {
		observed = actual.Context()
		return nil, failure
	})}
	_, err := transport.RoundTrip(request)
	if err != failure || observed.Err() != context.Canceled {
		t.Fatal("failed request did not release its timer context")
	}
}
