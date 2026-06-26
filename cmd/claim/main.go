package main

import (
	"bytes"
	"encoding/json"
	"fmt"
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

	if err := assignIssue(githubRepo, issueNumber, githubUsername, githubToken); err != nil {
		slog.Error("failed to assign issue", "error", err)
		os.Exit(1)
	}
	slog.Info("assigned issue", "number", issueNumber, "user", githubUsername)

	if err := postClaimComment(githubRepo, issueNumber, githubUsername, githubToken); err != nil {
		slog.Warn("failed to post claim comment", "error", err)
	}

	if err := addLabel(githubRepo, issueNumber, githubToken); err != nil {
		slog.Warn("failed to add in-progress label", "error", err)
	}

	if slackToken != "" {
		client := slack.New(slackToken)

		if slackUserID != "" {
			dm := fmt.Sprintf("✅ Issue #%s has been assigned to you on GitHub.", issueNumber)
			if _, _, err := client.PostMessage(slackUserID, slack.MsgOptionText(dm, false)); err != nil {
				slog.Error("failed to DM user", "error", err)
			}
		}

		if slackChannelID != "" {
			announcement := fmt.Sprintf(":stonks: <@%s> claimed issue #%s and has been assigned on GitHub.", slackUserID, issueNumber)
			if _, _, err := client.PostMessage(slackChannelID, slack.MsgOptionText(announcement, false)); err != nil {
				slog.Error("failed to post to channel", "error", err)
			}
		}
	}
}

func assignIssue(repo, number, username, token string) error {
	return assignIssueWithBase("https://api.github.com", repo, number, username, token)
}

func assignIssueWithBase(baseURL, repo, number, username, token string) error {
	url := fmt.Sprintf("%s/repos/%s/issues/%s/assignees", baseURL, repo, number)
	body, _ := json.Marshal(map[string][]string{"assignees": {username}})

	req, err := http.NewRequest("POST", url, bytes.NewReader(body))
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

func postClaimComment(repo, number, githubUsername, token string) error {
	return postClaimCommentWithBase("https://api.github.com", repo, number, githubUsername, token)
}

func postClaimCommentWithBase(baseURL, repo, number, githubUsername, token string) error {
	url := fmt.Sprintf("%s/repos/%s/issues/%s/comments", baseURL, repo, number)
	body, _ := json.Marshal(map[string]string{
		"body": fmt.Sprintf("@%s is working on this.", githubUsername),
	})

	req, err := http.NewRequest("POST", url, bytes.NewReader(body))
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

func addLabel(repo, number, token string) error {
	return addLabelWithBase("https://api.github.com", repo, number, token)
}

func addLabelWithBase(baseURL, repo, number, token string) error {
	url := fmt.Sprintf("%s/repos/%s/issues/%s/labels", baseURL, repo, number)
	body, _ := json.Marshal(map[string][]string{"labels": {"in-progress"}})

	req, err := http.NewRequest("POST", url, bytes.NewReader(body))
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

func setGitHubHeaders(req *http.Request, token string) {
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "interns-ticket-manager")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
}
