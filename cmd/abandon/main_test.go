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

func TestDeleteClaimComment_FindsAndDeletes(t *testing.T) {
	var deletedID string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == "GET" && r.URL.Path == "/repos/owner/repo/issues/42/comments":
			comments := []map[string]interface{}{
				{"id": 1001, "body": "some other comment"},
				{"id": 1002, "body": "@testuser is working on this."},
			}
			json.NewEncoder(w).Encode(comments)

		case r.Method == "DELETE" && r.URL.Path == "/repos/owner/repo/issues/comments/1002":
			deletedID = "1002"
			w.WriteHeader(http.StatusNoContent)

		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusBadRequest)
		}
	}))
	defer srv.Close()

	if err := deleteClaimCommentWithBase(srv.URL, "owner/repo", "42", "testuser", "token"); err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if deletedID != "1002" {
		t.Errorf("expected comment 1002 to be deleted, got %q", deletedID)
	}
}

func TestDeleteClaimComment_NoComment(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			comments := []map[string]interface{}{
				{"id": 1001, "body": "unrelated comment"},
			}
			json.NewEncoder(w).Encode(comments)
			return
		}
		t.Errorf("unexpected DELETE — should not delete when comment not found")
		w.WriteHeader(http.StatusBadRequest)
	}))
	defer srv.Close()

	if err := deleteClaimCommentWithBase(srv.URL, "owner/repo", "42", "nobody", "token"); err != nil {
		t.Fatalf("expected no error for missing comment, got %v", err)
	}
}

func TestDeleteClaimComment_DeleteFails(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			comments := []map[string]interface{}{
				{"id": 999, "body": "@testuser is working on this."},
			}
			json.NewEncoder(w).Encode(comments)
			return
		}
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()

	err := deleteClaimCommentWithBase(srv.URL, "owner/repo", "42", "testuser", "token")
	if err == nil {
		t.Fatal("expected error when delete returns 403, got nil")
	}
}

func TestRemoveLabel_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "DELETE" {
			t.Errorf("expected DELETE, got %s", r.Method)
		}
		if r.URL.Path != "/repos/owner/repo/issues/42/labels/in-progress" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	if err := removeLabelWithBase(srv.URL, "owner/repo", "42", "token"); err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
}

func TestRemoveLabel_NotFoundIsOk(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	if err := removeLabelWithBase(srv.URL, "owner/repo", "42", "token"); err != nil {
		t.Fatalf("expected no error for 404 (label not on issue), got %v", err)
	}
}

func TestRemoveLabel_ServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	err := removeLabelWithBase(srv.URL, "owner/repo", "42", "token")
	if err == nil {
		t.Fatal("expected error for 500, got nil")
	}
}
