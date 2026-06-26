package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"

	"github.com/joho/godotenv"
	"github.com/slack-go/slack"
)

func main() {
	_ = godotenv.Load()

	issueNumber := os.Getenv("ISSUE_NUMBER")
	githubUsername := os.Getenv("GITHUB_USERNAME")
	githubToken := os.Getenv("GITHUB_TOKEN")
	githubRepo := os.Getenv("GITHUB_REPO")
	slackToken := os.Getenv("SLACK_BOT_TOKEN")
	slackUserID := os.Getenv("SLACK_USER_ID")
	slackChannelID := os.Getenv("SLACK_CHANNEL_ID")

	if issueNumber == "" || githubUsername == "" || githubToken == "" || githubRepo == "" {
		slog.Error("missing required env vars")
		os.Exit(1)
	}

	if err := unassignIssue(githubRepo, issueNumber, githubUsername, githubToken); err != nil {
		slog.Error("failed to unassign issue", "error", err)
		os.Exit(1)
	}
	slog.Info("unassigned issue", "number", issueNumber, "user", githubUsername)

	if err := deleteClaimComment(githubRepo, issueNumber, githubUsername, githubToken); err != nil {
		slog.Warn("failed to delete claim comment", "error", err)
	}

	if err := removeLabel(githubRepo, issueNumber, githubToken); err != nil {
		slog.Warn("failed to remove in-progress label", "error", err)
	}

	if slackToken != "" {
		client := slack.New(slackToken)

		if slackUserID != "" {
			dm := fmt.Sprintf("↩️ You abandoned issue #%s — it's back in the pool.", issueNumber)
			if _, _, err := client.PostMessage(slackUserID, slack.MsgOptionText(dm, false)); err != nil {
				slog.Error("failed to DM user", "error", err)
			}
		}

		if slackChannelID != "" {
			announcement := fmt.Sprintf("<@%s> abandoned issue #%s — it's unclaimed again. :not_stonks:", slackUserID, issueNumber)
			if _, _, err := client.PostMessage(slackChannelID, slack.MsgOptionText(announcement, false)); err != nil {
				slog.Error("failed to post to channel", "error", err)
			}
		}
	}
}

func unassignIssue(repo, number, username, token string) error {
	return unassignIssueWithBase("https://api.github.com", repo, number, username, token)
}

func unassignIssueWithBase(baseURL, repo, number, username, token string) error {
	url := fmt.Sprintf("%s/repos/%s/issues/%s/assignees", baseURL, repo, number)
	body, _ := json.Marshal(map[string][]string{"assignees": {username}})

	req, err := http.NewRequest("DELETE", url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	setGitHubHeaders(req, token)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("GitHub API returned %d", resp.StatusCode)
	}
	return nil
}

func deleteClaimComment(repo, number, githubUsername, token string) error {
	return deleteClaimCommentWithBase("https://api.github.com", repo, number, githubUsername, token)
}

// deleteClaimCommentWithBase finds the "@username is working on this." comment
// posted at claim time and deletes it. If the comment is not found, it's a no-op.
func deleteClaimCommentWithBase(baseURL, repo, number, githubUsername, token string) error {
	listURL := fmt.Sprintf("%s/repos/%s/issues/%s/comments?per_page=100", baseURL, repo, number)
	req, err := http.NewRequest("GET", listURL, nil)
	if err != nil {
		return err
	}
	setGitHubHeaders(req, token)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	var comments []struct {
		ID   int64  `json:"id"`
		Body string `json:"body"`
	}
	data, _ := io.ReadAll(resp.Body)
	if err := json.Unmarshal(data, &comments); err != nil {
		return err
	}

	target := fmt.Sprintf("@%s is working on this.", githubUsername)
	var commentID int64
	for _, c := range comments {
		if c.Body == target {
			commentID = c.ID
			break
		}
	}

	if commentID == 0 {
		return nil
	}

	delURL := fmt.Sprintf("%s/repos/%s/issues/comments/%d", baseURL, repo, commentID)
	delReq, err := http.NewRequest("DELETE", delURL, nil)
	if err != nil {
		return err
	}
	setGitHubHeaders(delReq, token)

	delResp, err := http.DefaultClient.Do(delReq)
	if err != nil {
		return err
	}
	defer delResp.Body.Close()

	if delResp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("GitHub API returned %d on comment delete", delResp.StatusCode)
	}
	return nil
}

func removeLabel(repo, number, token string) error {
	return removeLabelWithBase("https://api.github.com", repo, number, token)
}

func removeLabelWithBase(baseURL, repo, number, token string) error {
	url := fmt.Sprintf("%s/repos/%s/issues/%s/labels/in-progress", baseURL, repo, number)
	req, err := http.NewRequest("DELETE", url, nil)
	if err != nil {
		return err
	}
	setGitHubHeaders(req, token)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	// 404 means the label wasn't on the issue — not an error
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNotFound {
		return fmt.Errorf("GitHub API returned %d", resp.StatusCode)
	}
	return nil
}

func setGitHubHeaders(req *http.Request, token string) {
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "interns-ticket-manager")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
}
