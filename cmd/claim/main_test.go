package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAssignIssue_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			t.Errorf("expected POST, got %s", r.Method)
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

		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()

	if err := assignIssueWithBase(srv.URL, "owner/repo", "42", "testuser", "token"); err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
}

func TestAssignIssue_Forbidden(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()

	err := assignIssueWithBase(srv.URL, "owner/repo", "42", "testuser", "token")
	if err == nil {
		t.Fatal("expected error for 403, got nil")
	}
}

func TestAssignIssue_NotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	err := assignIssueWithBase(srv.URL, "owner/repo", "99", "testuser", "token")
	if err == nil {
		t.Fatal("expected error for 404, got nil")
	}
}

func TestAssignIssue_SetsAuthHeader(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer mytoken" {
			t.Errorf("expected Bearer mytoken, got %s", r.Header.Get("Authorization"))
		}
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()

	if err := assignIssueWithBase(srv.URL, "owner/repo", "1", "user", "mytoken"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}
