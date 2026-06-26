package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestUnassignIssue_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "DELETE" {
			t.Errorf("expected DELETE, got %s", r.Method)
		}
		if r.URL.Path != "/repos/owner/repo/issues/42/assignees" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}

		var body map[string][]string
		data, _ := io.ReadAll(r.Body)
		json.Unmarshal(data, &body)
		if len(body["assignees"]) != 1 || body["assignees"][0] != "testuser" {
			t.Errorf("unexpected assignees: %v", body["assignees"])
		}

		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	if err := unassignIssueWithBase(srv.URL, "owner/repo", "42", "testuser", "token"); err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
}

func TestUnassignIssue_Forbidden(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()

	err := unassignIssueWithBase(srv.URL, "owner/repo", "42", "testuser", "token")
	if err == nil {
		t.Fatal("expected error for 403, got nil")
	}
}

func TestUnassignIssue_NotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	err := unassignIssueWithBase(srv.URL, "owner/repo", "99", "testuser", "token")
	if err == nil {
		t.Fatal("expected error for 404, got nil")
	}
}

func TestUnassignIssue_SetsAuthHeader(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer mytoken" {
			t.Errorf("expected Bearer mytoken, got %s", r.Header.Get("Authorization"))
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	if err := unassignIssueWithBase(srv.URL, "owner/repo", "1", "user", "mytoken"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}
